'use strict';
// POST /internal/community/legacy-paste-screenshots/:id/retire (server/objects/legacy-paste-retire.js):
// the narrow legacy-retire door for OpenVibe.Community. Only a legacy:live:paste:<slug> screenshot is
// retired, only for svc:community with media.object.delete; the delete is the ordinary soft delete
// (410 at /o/:id, retention_until, one media.object.deleted event) and a repeat call is a no-op.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-legacy-retire-'));
    process.env.OBJECTS_PATH = path.join(tmp, 'objects');
    fs.mkdirSync(process.env.OBJECTS_PATH, { recursive: true });
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';

    // A stub Network/Events: token redemption for the outbox, every delivery refused so the queued
    // event stays in event_outbox for the assertion.
    const stub = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
            res.statusCode = 503;
            res.end('{}');
        });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const stubBase = `http://127.0.0.1:${stub.address().port}`;

    const express = require('express');
    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const model = require('../server/objects/model');
    const objectRoutes = require('../server/objects/routes');
    const events = require('../server/events');
    const retire = require('../server/objects/legacy-paste-retire');
    const { guard } = require('../server/service-guard');
    const { serviceAuth, ids } = require('openvibe-contracts');
    const actorLimits = require('../server/actor-limits');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.upsertApp({ app_id: 'community', api_key: 'community-key' });
    events.init({ eventsUrl: stubBase, clientSecret: 's', networkUrl: stubBase, intervalMs: 3600000 });

    const now = Math.floor(Date.now() / 1000);
    const tok = (sub, cap = [retire.CAPABILITY]) => serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub, actor_type: 'service', aud: ['openvibe.media'], cap,
        ns: ['live'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`,
    }, keys.privateKey);

    const app = express();
    app.use(express.json());
    app.post(retire.PATH, guard(retire.CAPABILITY), ...retire.handlers());
    app.use('/o', objectRoutes.publicRouter);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (id, bearer) => {
        const res = await fetch(`${base}/internal/community/legacy-paste-screenshots/${encodeURIComponent(id)}/retire`, {
            method: 'POST', headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        });
        const text = await res.text();
        let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, body };
    };
    const insert = async ({ appId = 'live', kind = 'screenshot', ref, visibility = 'public', lifecycle = 'ready' } = {}) => {
        const id = ids.newId('media');
        await db.run('INSERT INTO media_objects (id, app_id, namespace, kind, visibility, lifecycle_status, legacy_ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, appId, appId, kind, visibility, lifecycle, ref || null]);
        return id;
    };
    const row = async (id) => await db.get('SELECT * FROM media_objects WHERE id = ?', [id]);
    const eventsOf = async (id) => (await db.all("SELECT envelope FROM event_outbox WHERE envelope::text LIKE ?", [`%${id}%`]))
        .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))
        .filter((e) => e.event_type === 'media.object.deleted' && e.payload.object_id === id);
    const stagedOf = async (id) => Number((await db.get('SELECT COUNT(*) AS n FROM media_object_changes WHERE object_id = ?', [id])).n);

    try {
        const community = tok('svc:community');
        const live = tok('svc:live');

        // ── The right kind is retired: soft delete, 410, retention and one event ──
        const paste = await insert({ ref: 'legacy:live:paste:old-shot' });
        let r = await call(paste, community);
        assert.deepStrictEqual([r.status, r.body.changed, r.body.lifecycle_status], [200, true, 'deleted'], JSON.stringify(r.body));
        assert.ok(Date.parse(r.body.retention_until) > Date.now(), 'the ordinary retention window is set');
        const gone = await row(paste);
        assert.strictEqual(gone.lifecycle_status, 'deleted');
        assert.ok(gone.deleted_at, 'deleted_at is set');
        assert.strictEqual(JSON.parse(gone.metadata).deleted_by, 'svc:community');
        const served = await fetch(`${base}/o/${paste}`);
        assert.strictEqual(served.status, 410, '/o/:id answers 410 at once');
        let evs = await eventsOf(paste);
        assert.strictEqual(evs.length, 1, 'one media.object.deleted event, like any other delete');
        assert.deepStrictEqual([evs[0].payload.kind, evs[0].payload.legacy_ref], ['screenshot', 'legacy:live:paste:old-shot']);
        assert.ok(Date.parse(evs[0].payload.deleted_at), 'the event carries the change time');
        console.log('✅ a legacy Live paste screenshot is soft-deleted: 410, retention, one media.object.deleted');

        // ── Idempotent: the second call changes nothing and queues no second event ──
        r = await call(paste, community);
        assert.deepStrictEqual([r.status, r.body.changed, r.body.lifecycle_status], [200, false, 'deleted'], JSON.stringify(r.body));
        assert.strictEqual((await eventsOf(paste)).length, 1, 'no second event');
        assert.strictEqual(await stagedOf(paste), 0, 'nothing left staged');
        console.log('✅ a second call is a no-op (changed:false, no event)');

        // ── A Community-era v1 file (a screenshot paste's old bytes) is retired too ──
        const file = await insert({ appId: 'community', kind: 'file', ref: 'legacy:community:file:old-shot.jpg' });
        r = await call(file, community);
        assert.deepStrictEqual([r.status, r.body.changed, r.body.lifecycle_status], [200, true, 'deleted'], JSON.stringify(r.body));
        assert.ok(Date.parse(r.body.retention_until) > Date.now(), 'the ordinary retention window is set');
        const goneFile = await row(file);
        assert.strictEqual(goneFile.lifecycle_status, 'deleted');
        assert.strictEqual(JSON.parse(goneFile.metadata).deleted_by, 'svc:community');
        const servedFile = await fetch(`${base}/o/${file}`);
        assert.strictEqual(servedFile.status, 410, '/o/:id answers 410 at once');
        const fileEvs = await eventsOf(file);
        assert.strictEqual(fileEvs.length, 1, 'one media.object.deleted event, like any other delete');
        assert.deepStrictEqual([fileEvs[0].payload.kind, fileEvs[0].payload.legacy_ref], ['file', 'legacy:community:file:old-shot.jpg']);
        r = await call(file, community);
        assert.deepStrictEqual([r.status, r.body.changed], [200, false], 'a second call is a no-op');
        assert.strictEqual((await eventsOf(file)).length, 1, 'no second event');
        console.log('✅ a legacy Community file is soft-deleted: 410, retention, one event, idempotent');

        // ── Another kind is refused, never touched ──
        for (const [kind, ref] of [['avatar', 'legacy:live:avatar:old-avatar'], ['vod', 'legacy:live:vod:7'], ['clip', 'legacy:live:clip:9'], ['file', 'legacy:live:file:k']]) {
            const other = await insert({ kind, ref });
            r = await call(other, community);
            assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.legacy_managed'], `${kind}: ${JSON.stringify(r.body)}`);
            assert.strictEqual((await row(other)).lifecycle_status, 'ready', `${kind} stays ready`);
        }
        const native = await insert({ ref: null });
        r = await call(native, community);
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.legacy_managed'], 'a native screenshot is not a legacy retire');
        console.log('✅ avatars, VODs, clips, files and native objects are refused');

        // ── Another principal is refused, even with the capability ──
        const second = await insert({ ref: 'legacy:live:paste:other-principal' });
        r = await call(second, live);
        assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], JSON.stringify(r.body));
        r = await call(second, tok('svc:community', ['media.object.upload']));
        assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'the capability is still required');
        assert.strictEqual((await row(second)).lifecycle_status, 'ready');
        console.log('✅ only svc:community with media.object.delete may retire');

        // ── Unknown id, a legacy shape this route does not own, and a hold ──
        r = await call(ids.newId('media'), community);
        assert.deepStrictEqual([r.status, r.body.code], [404, 'media.object.not_found']);
        const foreign = await insert({ appId: 'community', ref: 'legacy:community:paste:foreign' });
        r = await call(foreign, community);
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.legacy_managed'], 'only the two retirable shapes');
        const held = await insert({ ref: 'legacy:live:paste:held' });
        await db.run("INSERT INTO media_holds (object_id, kind, reason, created_by) VALUES (?, 'dmca', 'test', 'staff:test')", [held]);
        r = await call(held, community);
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.held'], JSON.stringify(r.body));
        assert.strictEqual((await row(held)).lifecycle_status, 'ready');
        const heldFile = await insert({ appId: 'community', kind: 'file', ref: 'legacy:community:file:held' });
        await db.run("INSERT INTO media_holds (object_id, kind, reason, created_by) VALUES (?, 'dmca', 'test', 'staff:test')", [heldFile]);
        r = await call(heldFile, community);
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.held'], JSON.stringify(r.body));
        assert.strictEqual((await row(heldFile)).lifecycle_status, 'ready');
        console.log('✅ unknown ids 404, other legacy shapes are refused, a hold refuses either retire');

        // ── Rate-limited like DELETE /:id ──
        const limit = actorLimits.registered().find((l) => l.id === 'media.object.legacy_paste.retire');
        assert.deepStrictEqual([limit && limit.minute, limit && limit.hour], [60, 1200]);
        console.log('✅ the route declares the DELETE /:id budget');
    } finally {
        events._reset();
        await new Promise((r) => server.close(r));
        await new Promise((r) => stub.close(r));
    }
    console.log('legacy paste retire: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
