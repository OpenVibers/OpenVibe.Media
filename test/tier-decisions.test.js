'use strict';
// R2 tier decisions (media_tier_decisions; server/vod/vod-storage.js) and the staff policy endpoint
// (GET /api/v1/:app/admin/storage/tiers/policy, /tiers/decisions): every promotion to and demotion
// from R2, whoever asked (the sweep, an admin move, a clip hot-fetch, the eviction drill), is logged
// with the inputs it saw, the thresholds in force (each with its source) and the reason, whatever the
// outcome (done, already, refused, failed). The thresholds themselves are unchanged. A fake S3 (B2 and
// R2 buckets) is spoken to by the real AWS SDK through the storage engine.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-tierlog-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };

const buckets = { 'b2-bucket': new Map(), 'r2-bucket': new Map() };
let refusePutTo = null;
function decodeAwsChunked(buf) {
    const out = [];
    let i = 0;
    for (;;) {
        const nl = buf.indexOf('\r\n', i);
        const size = parseInt(buf.subarray(i, nl).toString().split(';')[0], 16);
        if (!size) break;
        out.push(buf.subarray(nl + 2, nl + 2 + size));
        i = nl + 2 + size + 2;
    }
    return Buffer.concat(out);
}
const s3 = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/');
        const key = rest.join('/');
        const store = buckets[bucket];
        if (!store) { res.writeHead(404); return res.end(); }
        if (!key && req.method === 'HEAD') { res.writeHead(200); return res.end(); }
        const obj = store.get(key);
        if (req.method === 'HEAD' || req.method === 'GET') {
            if (!obj) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end(req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : undefined); }
            res.writeHead(200, { 'Content-Length': obj.length, ETag: '"e"', 'Content-Type': 'video/webm' });
            return res.end(req.method === 'GET' ? obj : undefined);
        }
        if (req.method === 'PUT') {
            if (refusePutTo === bucket) { res.writeHead(500, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>InternalError</Code></Error>'); }
            let body = Buffer.concat(chunks);
            if (req.headers['x-amz-decoded-content-length'] || /aws-chunked/.test(req.headers['content-encoding'] || '')) body = decodeAwsChunked(body);
            store.set(key, body);
            res.writeHead(200, { ETag: '"e"' });
            return res.end();
        }
        if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(405); res.end();
    });
});

(async () => {
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${s3.address().port}`;
    Object.assign(process.env, {
        DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
        MEDIA_B2_ENDPOINT: endpoint, MEDIA_B2_BUCKET: 'b2-bucket', MEDIA_B2_KEY_ID: 'k', MEDIA_B2_APP_KEY: 's', MEDIA_B2_REGION: 'us-west-004',
        MEDIA_R2_ENDPOINT: endpoint, MEDIA_R2_BUCKET: 'r2-bucket', MEDIA_R2_ACCESS_KEY_ID: 'k', MEDIA_R2_SECRET_ACCESS_KEY: 's',
        AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED', AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
    });
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const storage = require('../server/vod/vod-storage');
    db.upsertApp({ app_id: 'live', api_key: 'live-key-tierlog' });
    db.upsertApp({ app_id: 'games', api_key: 'games-key-tierlog' });

    // The thresholds are not changed by this work.
    assert.deepStrictEqual([storage.DEFAULTS.r2Enabled, storage.DEFAULTS.r2MinViews, storage.DEFAULTS.r2RecentAccessDays, storage.DEFAULTS.r2MaxIdleDays, storage.DEFAULTS.r2MaxPerSweep],
        [true, 20, 3, 14, 5]);
    // Keep the sweep's disk-pressure drain out of this test (whatever this machine's disk looks like).
    storage.setSetting('hotDiskPressurePct', 101);
    storage.setSetting('criticalDiskPct', 101);
    storage.setSetting('minFreeGb', 0);

    const bytes = crypto.randomBytes(200000);
    const addVod = (id, { app = 'live', provider = 'local', views = 0, accessed = null } = {}) => {
        const name = `vod-${app}-${id}-1726900000000.webm`;
        const key = `vods/${name}`;
        if (provider === 'local') fs.writeFileSync(path.join(process.env.VOD_PATH, name), bytes);
        else { buckets['b2-bucket'].set(key, bytes); if (provider === 'r2') buckets['r2-bucket'].set(key, bytes); }
        db.run(`INSERT INTO vods (id, app_id, title, file_path, file_size, is_public, visibility, duration_seconds, storage_provider, storage_key, view_count, last_accessed_at, created_at)
                VALUES (?, ?, 't', ?, ?, 1, 'public', 60, ?, ?, ?, ${accessed ? `datetime('now', '${accessed}')` : 'NULL'}, datetime('now'))`,
        [id, app, path.join(process.env.VOD_PATH, name), bytes.length, provider, provider === 'local' ? null : key, views]);
        model.sync('vod', id);
        return key;
    };
    const decisions = (vodId) => db.all('SELECT * FROM media_tier_decisions WHERE vod_id = ? ORDER BY id', [vodId]);

    // ── 1. The sweep: a popular VOD is promoted, an idle R2 VOD demoted, each with its reason ──
    addVod(1, { views: 25, accessed: '-1 hours' });
    addVod(2, { provider: 'r2', views: 3, accessed: '-30 days' });
    addVod(3, { views: 5, accessed: '-1 hours' });                          // below the threshold: no decision
    const sweep = await storage.runSweep();
    assert.deepStrictEqual([sweep.promoted, sweep.demoted], [1, 1], JSON.stringify(sweep));
    const [p] = decisions(1);
    assert.deepStrictEqual([p.action, p.from_provider, p.to_provider, p.outcome, p.trigger], ['promote', 'local', 'r2', 'done', 'sweep']);
    assert.ok(/view_count 25 >= r2MinViews 20/.test(p.reason) && /r2RecentAccessDays 3/.test(p.reason), p.reason);
    const pin = JSON.parse(p.inputs);
    assert.deepStrictEqual([pin.view_count, pin.storage_provider, pin.is_recording, pin.held], [25, 'local', false, false]);
    assert.deepStrictEqual(JSON.parse(p.thresholds).r2MinViews, { value: 20, source: 'default' });
    const [d] = decisions(2);
    assert.deepStrictEqual([d.action, d.from_provider, d.to_provider, d.outcome, d.trigger], ['demote', 'r2', 'b2', 'done', 'sweep']);
    assert.ok(/idle longer than r2MaxIdleDays 14/.test(d.reason), d.reason);
    assert.strictEqual(decisions(3).length, 0);
    console.log('✅ sweep promotions and demotions are logged with inputs, thresholds (and their source) and the reason');

    // ── 2. Every other path and outcome: admin move (refused: held; failed: R2 down), clip hot-fetch, drill ──
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/admin/storage', require('../server/admin/routes'));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = (method, p, body, key = 'live-key-tierlog') => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
        req.on('error', reject);
        req.end(data);
    });
    addVod(4, { views: 1 });
    const hold = model.placeHold({ object_id: db.get('SELECT object_id FROM vods WHERE id = 4').object_id, kind: 'creator_pin', reason: 'test' });
    let r = await call('POST', '/api/v1/live/admin/storage/tiers/move', { vod_id: 4, target: 'r2' });
    assert.strictEqual(r.body.held, true);
    assert.deepStrictEqual([decisions(4)[0].outcome, decisions(4)[0].trigger], ['refused', 'admin']);
    assert.ok(/admin move to r2/.test(decisions(4)[0].reason));
    assert.strictEqual(JSON.parse(decisions(4)[0].inputs).held, true);
    model.releaseHold(hold.id, 'test');
    refusePutTo = 'r2-bucket';
    r = await call('POST', '/api/v1/live/admin/storage/tiers/move', { vod_id: 4, target: 'r2' });
    refusePutTo = null;
    assert.strictEqual(r.body.ok, false);
    const failed = decisions(4)[1];
    assert.deepStrictEqual([failed.outcome, failed.action], ['failed', 'promote']);
    assert.ok(failed.error);
    r = await call('POST', '/api/v1/live/admin/storage/tiers/move', { vod_id: 1, target: 'r2' });
    assert.strictEqual(decisions(1)[1].outcome, 'already', 'a promotion that finds it already there is logged too');
    // Restoring an R2 VOD to local drops its R2 copy: a demotion.
    await storage.moveToHot(1, { trigger: 'clip', reason: 'fetched to local disk to cut clip 9' });
    const hot = decisions(1)[2];
    assert.deepStrictEqual([hot.action, hot.from_provider, hot.to_provider, hot.outcome, hot.trigger], ['demote', 'r2', 'local', 'done', 'clip']);
    await storage.demoteFromR2(2, { trigger: 'drill', reason: 'R2 eviction drill: evict the R2 copy' });
    assert.deepStrictEqual([decisions(2)[1].outcome, decisions(2)[1].trigger], ['already', 'drill']);
    addVod(50, { app: 'games', views: 30, accessed: '-1 hours' });
    await storage.promoteToR2(50, { trigger: 'admin', reason: 'games' });
    console.log('✅ admin moves, clip hot-fetches and the drill are logged; refused (held), failed and already outcomes too');

    // ── 3. The read-only staff policy endpoint and the decision list (app-scoped) ──
    r = await call('GET', '/api/v1/live/admin/storage/tiers/policy');
    assert.strictEqual(r.status, 200);
    const pol = r.body;
    assert.deepStrictEqual(pol.r2.thresholds.r2MinViews, { value: 20, default: 20, source: 'default' });
    assert.deepStrictEqual(pol.r2.thresholds.r2MaxIdleDays, { value: 14, default: 14, source: 'default' });
    assert.strictEqual(pol.r2.enabled, true);
    assert.ok(/view_count >= r2MinViews \(20\)/.test(pol.r2.promote) && /r2MaxIdleDays \(14 days\)/.test(pol.r2.demote));
    assert.strictEqual(pol.r2.provider.configured, true);
    assert.deepStrictEqual(pol.decisions.last_24h.promote, { done: 1, already: 1, refused: 1, failed: 1 });
    assert.deepStrictEqual(pol.decisions.last_24h.demote, { done: 2, already: 1, refused: 0, failed: 0 });
    assert.ok(pol.decisions.recent.every(x => x.vod_id !== 50), 'another app\'s decisions are not listed');
    assert.ok(pol.decisions.recent[0].inputs && pol.decisions.recent[0].thresholds, 'each decision carries its inputs and thresholds');
    await call('PUT', '/api/v1/live/admin/storage/tiers/settings', { r2MinViews: 20 });
    r = await call('GET', '/api/v1/live/admin/storage/tiers/policy');
    assert.deepStrictEqual(r.body.r2.thresholds.r2MinViews, { value: 20, default: 20, source: 'setting' }, 'an override shows as a setting');
    r = await call('GET', '/api/v1/live/admin/storage/tiers/decisions?action=demote&limit=2');
    assert.deepStrictEqual([r.body.decisions.length, r.body.decisions.every(x => x.action === 'demote'), r.body.next_before_id != null], [2, true, true]);
    const next = await call('GET', `/api/v1/live/admin/storage/tiers/decisions?action=demote&limit=2&before_id=${r.body.next_before_id}`);
    assert.strictEqual(next.body.decisions.length, 1);
    r = await call('GET', '/api/v1/live/admin/storage/tiers/decisions?vod_id=4');
    assert.deepStrictEqual(r.body.decisions.map(x => x.outcome), ['failed', 'refused']);
    assert.strictEqual((await call('GET', '/api/v1/live/admin/storage/tiers/decisions?action=move')).status, 400);
    assert.strictEqual((await call('GET', '/api/v1/games/admin/storage/tiers/decisions', null, 'games-key-tierlog')).body.decisions.length, 1);
    assert.strictEqual((await call('GET', '/api/v1/live/admin/storage/tiers/policy', null, 'wrong-key')).status >= 401, true, 'staff only (the app key)');
    console.log('✅ GET /tiers/policy: thresholds with their source, the rules, 24 h counts and recent decisions; /tiers/decisions filters and pages');

    server.close();
    s3.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All tier decision tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
