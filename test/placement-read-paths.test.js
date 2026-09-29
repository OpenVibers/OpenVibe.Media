'use strict';
// Every former read path now goes through the placement router (F1, part 3, end-of-task check):
// `resolvePlayback` (vod-storage.js), `/o/:id` (server/objects/routes.js), `resolveSource` (jobs/derive.js),
// clip cutting (vod/clips-routes.js), clip jobs (vod/clip-jobs.js), duration reconcile (vod/duration-reconcile.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const dir = (n) => { const d = path.join(os.tmpdir(), `ov-media-rp-${n}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), PASTES_PATH: dir('pastes'),
        THUMBNAILS_PATH: dir('thumbnails'), FILES_PATH: dir('files'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
        MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'http://127.0.0.1:9', RELEASE_COMMIT: 'abcdef1234567',
    });
    for (const k of ['MEDIA_B2_ENDPOINT', 'MEDIA_B2_BUCKET', 'MEDIA_R2_ENDPOINT', 'MEDIA_R2_BUCKET', 'EVENTS_URL']) process.env[k] = '';

    const router = require('../server/placement/router');
    router.reset();

    let routerCalls = [], routerSessions = [];
    const realRoute = router.route;
    router.route = async function (opts) {
        routerCalls.push(opts.purpose || 'unknown');
        routerSessions.push(opts.session || null);
        return await realRoute(opts);
    };

    // Init the necessary config stores that the read paths expect to be loaded.
    const db = require('../server/db/database');
    db.getDb();
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await require('../server/vod/tier-config').init(require('../server/vod/vod-storage').DEFAULTS);
    await require('../server/objects/tier-policy').init();
    await require('../server/placement/cost-tiers').init({ log: { info() {}, warn() {}, error() {} } });

    // Build a VOD row that's local-only.
    const vodStorage = require('../server/vod/vod-storage');
    const vodPath = path.join(process.env.VOD_PATH, 'vod-1.webm');
    fs.writeFileSync(vodPath, Buffer.alloc(1024, 0));
    const inserted = await db.run(`INSERT INTO vods (app_id, file_path, file_size, storage_provider, storage_tier) VALUES (?, ?, ?, ?, ?) RETURNING id`,
        ['live', vodPath, 1024, 'local', 'hot']);
    const vodId = inserted.lastInsertRowid || (inserted.rows && inserted.rows[0] && inserted.rows[0].id) || (inserted[0] && inserted[0].id);

    // (1) vod-storage.resolvePlayback goes through the router.
    routerCalls = [];
    const plan = await vodStorage.resolvePlayback({ id: vodId, file_path: vodPath, storage_provider: 'local', storage_tier: 'hot' });
    assert.ok(plan && plan.kind === 'file', `local resolves to a file: ${JSON.stringify(plan)}`);
    assert.ok(routerCalls.includes('playback'), `resolvePlayback called the router: ${routerCalls.join(',')}`);

    // (2) duration-reconcile.sourceFor: when local is gone, it falls through to resolvePlayback → router.
    // We don't need to assert on the resolved source — that depends on which providers are configured.
    // The router is invoked regardless.
    const dr = require('../server/vod/duration-reconcile');
    fs.unlinkSync(vodPath);
    routerCalls = [];
    await dr.sourceFor({ id: vodId, file_path: vodPath, storage_provider: 'b2', storage_tier: 'hot', storage_key: 'vods/vod-1.webm' });
    assert.ok(routerCalls.includes('playback'), `sourceFor called the router when remote-only: ${routerCalls.join(',')}`);
    // Re-create the local file for the rest of the tests.
    fs.writeFileSync(vodPath, Buffer.alloc(1024, 0));

    // (3) clip cutting path: clip-jobs.js calls resolveMediaSource → resolvePlayback → router. We
    // exercise resolveMediaSource directly on a remote VOD so the router is consulted.
    const clipJobs = require('../server/vod/clip-jobs');
    fs.unlinkSync(vodPath);
    routerCalls = [];
    const ms = await vodStorage.resolveMediaSource({ id: vodId, file_path: vodPath, storage_provider: 'b2', storage_tier: 'hot', storage_key: 'vods/vod-1.webm' });
    assert.ok(routerCalls.includes('playback'), `resolveMediaSource → resolvePlayback → router: ${routerCalls.join(',')}`);
    fs.writeFileSync(vodPath, Buffer.alloc(1024, 0));

    // (4) jobs/derive.js: resolveSource goes through the router when it's a native object.
    const derive = require('../server/jobs/derive');
    const model = require('../server/objects/model');
    // Create a native object + a local location.
    const objId = `obj-${Date.now()}`;
    const namespace = 'media';
    await db.run(`INSERT INTO media_objects (id, app_id, namespace, kind, lifecycle_status, visibility, mime_type, size_bytes, canonical_provider, canonical_key, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ov_now())`, [objId, 'live', namespace, 'asset', 'ready', 'public', 'video/webm', 1024, 'local', vodPath]);
    await db.run(`INSERT INTO media_locations (object_id, provider, state, key, size_bytes, verified_at) VALUES (?, ?, ?, ?, ?, ov_now())`,
        [objId, 'local', 'present', vodPath, 1024]);
    routerCalls = [];
    const source = await derive.resolveSource({ id: objId, kind: 'asset', mime_type: 'video/webm', canonical_key: vodPath });
    assert.ok(source && source.input === vodPath, `derive.resolveSource local: ${JSON.stringify(source)}`);
    assert.ok(routerCalls.includes('derive'), `derive.resolveSource called the router with purpose=derive: ${routerCalls.join(',')}`);

    // (5) objects/routes.js GET /o/:id — bring up the public router and stub presignGet.
    const originalPresign = vodStorage.presignGet;
    vodStorage.presignGet = async () => 'https://example.com/signed';
    try {
        const objectsRoutes = require('../server/objects/routes');
        const express = require('express');
        const app = express();
        app.use('/o', objectsRoutes.publicRouter);
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const fetch = (url, opts = {}) => new Promise((resolve, reject) => {
            const lib = url.startsWith('https') ? require('https') : require('http');
            lib.get(url, opts, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
        });

        routerCalls = [];
        const r = await fetch(`${base}/o/${objId}`);
        assert.ok(r.status === 200 || r.status === 302, `native /o/:id returned 200 (local stream) or 302 (presign): got ${r.status}`);
        assert.ok(routerCalls.includes('playback'), `/o/:id called the router: ${routerCalls.join(',')}`);
        assert.ok(routerSessions.some((s) => typeof s === 'string' && s.length >= 16), `/o/:id passes the viewer's session: ${routerSessions.join(',')}`);
        server.close();
    } finally {
        vodStorage.presignGet = originalPresign;
    }

    // (6) Grep the repo for any remaining hard-coded provider order in a read path. The only legitimate
    // `['r2','b2']` / `['b2','r2']` literals are: placement internals (providers, metrics-binding),
    // REMOTE_PROVIDERS constant, verify-job (verification, not reads), the readiness check, and the
    // orphans-report script — none of those are read paths.
    // (6) The end-of-task grep: zero hard-coded provider orders anywhere under server/. The read
    // paths ask the router; the router ranks by class/tier, never by a literal provider list.
    const { execSync } = require('child_process');
    const grepFiles = (pattern) => {
        try { return execSync(`grep -rln --include='*.js' -E "${pattern}" server/`, { cwd: path.join(__dirname, '..') }).toString(); }
        catch (err) { if (err.status === 1) return ''; throw err; }   // grep exits 1 on no match
    };
    // Quoted literals, single or double: ['r2','b2'], [ "b2", "r2" ] (an unquoted pattern matched nothing).
    const lists = grepFiles("\\[ *['\\\"](r2|b2)['\\\"] *, *['\\\"](b2|r2)['\\\"] *\\]").trim();
    const orders = grepFiles("=== *['\\\"](r2|b2)['\\\"] *\\? *['\\\"](r2|b2)['\\\"]").trim();   // provider === 'r2' ? 'r2' : 'b2'
    // The patterns must be able to fail: they match a sample of what they forbid.
    const sample = (re) => execSync(`printf '%s\\n' "x = ['r2', 'b2']" "y = p === 'r2' ? 'r2' : 'b2'" | grep -cE "${re}"`).toString().trim();
    assert.strictEqual(sample("\\[ *['\\\"](r2|b2)['\\\"] *, *['\\\"](b2|r2)['\\\"] *\\]"), '1', 'the list pattern matches a quoted provider list');
    assert.strictEqual(sample("=== *['\\\"](r2|b2)['\\\"] *\\? *['\\\"](r2|b2)['\\\"]"), '1', 'the ternary pattern matches a provider ternary');
    assert.strictEqual(lists, '', `no provider-ordered array literal in server/: ${lists}`);
    assert.strictEqual(orders, '', `no provider-ordered ternary in server/: ${orders}`);

    router.route = realRoute;
    console.log('placement-read-paths: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });