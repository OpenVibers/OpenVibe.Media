'use strict';
// Tiering of native v2 objects (roadmap WS-G task 11): popularity counted per object and UTC day without an
// IP address or subject id (server/objects/popularity.js), rolled into a 7-day figure; the revisioned policy
// media.object_tier with its activation gate off by default (server/objects/tier-policy.js); and the sweep
// and moves (server/objects/tiering.js): dry runs while the gate is off, thresholds, holds, the verified
// canonical copy, promotion (copy, then size and sha256 of the R2 copy) and demotion (never the last good
// copy), every decision logged and counted, the admin API, the operator views and /o/:id playing from R2.
// A fake S3 (B2 and R2 buckets) is spoken to by the real AWS SDK through the storage engine.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-objtier-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const buckets = { 'b2-bucket': new Map(), 'r2-bucket': new Map() };
const fault = { refusePut: null, corruptPut: null, keepOnDelete: null };
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
            res.writeHead(200, { 'Content-Length': obj.length, ETag: '"e"', 'Content-Type': 'application/octet-stream' });
            return res.end(req.method === 'GET' ? obj : undefined);
        }
        if (req.method === 'PUT') {
            if (fault.refusePut === bucket) { res.writeHead(500, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>InternalError</Code></Error>'); }
            let body = Buffer.concat(chunks);
            if (req.headers['x-amz-decoded-content-length'] || /aws-chunked/.test(req.headers['content-encoding'] || '')) body = decodeAwsChunked(body);
            if (fault.corruptPut === bucket) { body = Buffer.from(body); body[0] ^= 0xff; }     // same size, other bytes
            store.set(key, body);
            res.writeHead(200, { ETag: '"e"' });
            return res.end();
        }
        if (req.method === 'DELETE') { if (fault.keepOnDelete !== bucket) store.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(405); res.end();
    });
});

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

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
    const popularity = require('../server/objects/popularity');
    const policy = require('../server/objects/tier-policy');
    const tiering = require('../server/objects/tiering');
    db.upsertApp({ app_id: 'live', api_key: 'live-key-objtier' });
    db.upsertApp({ app_id: 'games', api_key: 'games-key-objtier' });
    // Keep the VOD sweep's disk-pressure drain out of this test (whatever this machine's disk looks like).
    await storage.setSettings({ hotDiskPressurePct: 100, criticalDiskPct: 100, minFreeGb: 0 }, { reason: 'test: no pressure drain' });

    const today = popularity.dayOf(Date.now());
    const addObject = ({ app = 'live', size = 4096, mime = 'application/octet-stream', verified = true, hash = true, canonical = 'local' } = {}) => {
        const bytes = crypto.randomBytes(size);
        const sum = sha256(bytes);
        const id = model.createObject({ app_id: app, kind: 'file', visibility: 'public', lifecycle_status: 'ready', mime_type: mime, size_bytes: size,
            content_hash: hash ? sum : null, canonical_provider: canonical, metadata: { filename: 'x.bin' } });
        let file = null;
        if (canonical === 'local') {
            file = path.join(process.env.OBJECTS_PATH, app, id);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes);
            model.updateObject(id, { canonical_key: file });
            model.upsertLocation(id, { provider: 'local', key: file, state: verified ? 'present' : 'pending', size_bytes: size, checksum: hash ? sum : null, verified });
        } else {
            const key = `objects/${app}/${id}`;
            buckets['b2-bucket'].set(key, bytes);
            model.updateObject(id, { canonical_key: key });
            model.upsertLocation(id, { provider: 'b2', bucket: 'b2-bucket', key, state: 'present', size_bytes: size, verified: true });
        }
        return { id, bytes, sum, file, app };
    };
    const setViews = (id, entries) => {
        db.run('DELETE FROM media_object_views_daily WHERE object_id = ?', [id]);
        for (const [offset, n] of entries) {
            db.run('INSERT INTO media_object_views_daily (object_id, day, unique_viewers, last_viewed_at) VALUES (?, ?, ?, ?)',
                [id, popularity.addDays(today, offset), n, `${popularity.addDays(today, offset)}T12:00:00.000Z`]);
        }
    };
    const r2Row = (id) => db.get("SELECT * FROM media_locations WHERE object_id = ? AND provider = 'r2'", [id]);
    const ageR2 = (id, days) => db.run("UPDATE media_locations SET created_at = datetime('now', ?) WHERE object_id = ? AND provider = 'r2'", [`-${days} days`, id]);
    const decisions = (id) => db.all('SELECT * FROM media_object_tier_decisions WHERE object_id = ? ORDER BY id', [id]);
    const last = (id) => { const d = decisions(id); return d[d.length - 1]; };
    const fake = (ip, headers = {}, method = 'GET') => ({ method, ip, path: '/o/x', url: '/o/x', headers: { 'user-agent': BROWSER, ...headers } });

    // ── 1. Unique viewers per object and day, with no IP address or subject id stored ──
    const seen = addObject();
    const rec = (ip, headers, method) => popularity.record(model.getObject(seen.id), fake(ip, headers, method));
    assert.deepStrictEqual(rec('203.0.113.5'), { counted: true, reason: null });
    assert.strictEqual(rec('203.0.113.5', { 'user-agent': SAFARI }).reason, 'seen', 'one network is one viewer, whatever its user agent');
    popularity._reset();                                                    // a restart: the same day's salt comes back from the database
    assert.strictEqual(rec('203.0.113.5').reason, 'seen', 'and still once after a restart');
    assert.strictEqual(rec('198.51.100.7').counted, true);
    assert.strictEqual(rec('::ffff:198.51.100.7').reason, 'seen', 'an IPv4-mapped address is the IPv4 address');
    assert.strictEqual(rec('2001:db8:1:2::10').counted, true);
    assert.strictEqual(rec('2001:db8:1:2:aaaa:bbbb:cccc:1').reason, 'seen', 'an IPv6 /64 is one viewer');
    assert.strictEqual(rec('2001:db8:1:3::10').counted, true);
    assert.strictEqual(rec('192.0.2.10', { range: 'bytes=5000-' }).reason, 'range', 'a seek is not a view');
    assert.strictEqual(rec('192.0.2.10', { range: 'bytes=0-' }).counted, true);
    assert.strictEqual(rec('192.0.2.11', {}, 'HEAD').reason, 'method');
    assert.strictEqual(rec('192.0.2.12', { 'sec-gpc': '1' }).reason, 'opted_out');
    assert.strictEqual(rec('192.0.2.13', { dnt: '1' }).reason, 'opted_out');
    assert.strictEqual(rec('192.0.2.14', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }).reason, 'bot');
    assert.strictEqual(rec('192.0.2.15', { 'user-agent': '' }).reason, 'bot');
    const projected = model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready', legacy_ref: 'legacy:live:file:abc' });
    assert.strictEqual(popularity.record(model.getObject(projected), fake('192.0.2.16')).reason, 'not_native');
    const todayRow = db.get('SELECT * FROM media_object_views_daily WHERE object_id = ? AND day = ?', [seen.id, today]);
    assert.strictEqual(todayRow.unique_viewers, 5);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM media_object_viewer_days WHERE object_id = ?', [seen.id]).n, 5, 'an opted-out, bot, HEAD or seek request makes no hash at all');
    const stored = JSON.stringify([db.all('SELECT * FROM media_object_viewer_days'), db.all('SELECT * FROM media_object_views_daily'), db.all('SELECT day FROM media_object_view_salts')]);
    for (const ip of ['203.0.113.5', '198.51.100.7', '2001:db8', '192.0.2.10', 'usr_']) assert.ok(!stored.includes(ip), `nothing stored names ${ip}`);
    for (const v of db.all('SELECT viewer FROM media_object_viewer_days').map((r) => r.viewer)) {
        assert.ok(/^[0-9a-f]{16}$/.test(v));
        assert.notStrictEqual(v, sha256('203.0.113.5').slice(0, 16), 'keyed by the salt of the day, not a plain hash of the address');
    }
    assert.deepStrictEqual(['10.1.2.3', '::ffff:10.1.2.3', '2001:DB8::1', '2001:db8:0:0:ffff::9', 'fe80::1%eth0'].map(popularity.networkOf),
        ['10.1.2.3', '10.1.2.3', '2001:db8:0:0::/64', '2001:db8:0:0::/64', 'fe80:0:0:0::/64']);
    console.log('✅ a viewer counts once per object and UTC day (one network, IPv6 by /64), never a seek, HEAD, bot or opted-out request, and no address is stored');

    // ── 2. Hashes and salt die with their day; counts roll into a 7-day window, kept 30 days ──
    const roll = addObject();
    const yesterday = popularity.addDays(today, -1);
    assert.strictEqual(popularity.record(model.getObject(roll.id), fake('203.0.113.9'), { now: Date.parse(`${yesterday}T12:00:00Z`) }).counted, true);
    const oldHash = db.get('SELECT viewer FROM media_object_viewer_days WHERE object_id = ? AND day = ?', [roll.id, yesterday]).viewer;
    assert.ok(db.get('SELECT 1 AS x FROM media_object_view_salts WHERE day = ?', [yesterday]));
    assert.strictEqual(popularity.record(model.getObject(roll.id), fake('203.0.113.9')).counted, true, 'the same network on the next day is a new viewer-day');
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM media_object_viewer_days WHERE day < ?', [today]).n, 0, 'the first view of a day deletes the finished days\' hashes');
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM media_object_view_salts WHERE day < ?', [today]).n, 0, '...and their salts');
    assert.notStrictEqual(db.get('SELECT viewer FROM media_object_viewer_days WHERE object_id = ? AND day = ?', [roll.id, today]).viewer, oldHash, 'a new salt every day: days cannot be linked');
    assert.strictEqual(db.get('SELECT unique_viewers FROM media_object_views_daily WHERE object_id = ? AND day = ?', [roll.id, yesterday]).unique_viewers, 1, 'the count stays');
    const rs = popularity.stats({ ids: [roll.id] }).get(roll.id);
    assert.deepStrictEqual([rs.unique_viewers, rs.days_viewed, rs.last_viewed_day], [2, 2, today], 'two viewer-days');
    const win = addObject();
    setViews(win.id, [[-8, 100], [-6, 200], [0, 150]]);
    assert.strictEqual(popularity.stats({ ids: [win.id] }).get(win.id).unique_viewers, 350, 'the last 7 UTC days, today included');
    assert.strictEqual(popularity.stats({ ids: [win.id], days: 9 }).get(win.id).unique_viewers, 450);
    db.run('INSERT INTO media_object_views_daily (object_id, day, unique_viewers) VALUES (?, ?, 1), (?, ?, 1)', [win.id, popularity.addDays(today, -30), win.id, popularity.addDays(today, -31)]);
    const rot = popularity.rotate();
    assert.strictEqual(rot.counts, 1);
    assert.deepStrictEqual(db.all('SELECT day FROM media_object_views_daily WHERE object_id = ? ORDER BY day', [win.id]).map((r) => r.day),
        [popularity.addDays(today, -30), popularity.addDays(today, -8), popularity.addDays(today, -6), today], 'daily counts are kept 30 days');
    console.log('✅ a finished day\'s hashes and salt are deleted (counts stay); the 7-day window sums the daily counts; counts go after 30 days');

    // ── 3. The policy: revisioned, validated, the gate off by default ──
    assert.deepStrictEqual(policy.DEFAULTS, { active: false, promoteMinUniqueViewers7d: 500, promoteRecentAccessDays: 3, promoteMinSizeMb: 16,
        promoteMaxSizeMb: 4096, maxPromotionsPerSweep: 3, demoteIdleDays: 14, maxDemotionsPerSweep: 10 });
    assert.strictEqual(policy.settings().active, false);
    const rev0 = policy.get().revision();
    for (const [updates, why] of [
        [{ promoteMinSizeMb: 10, promoteMaxSizeMb: 5 }, /promoteMinSizeMb must be below promoteMaxSizeMb/],
        [{ demoteIdleDays: 3 }, /demoteIdleDays must be above promoteRecentAccessDays/],
        [{ promoteMinUniqueViewers7d: 0 }, /must be >= 1/],
        [{ active: 'yes' }, /must be boolean/],
        [{ maxPromotionsPerSweep: 1.5 }, /must be integer/],
        [{ demoteIdleDays: 31 }, /must be <= 30/],
        [{ surprise: 1 }, /not a known key/],
    ]) {
        await assert.rejects(policy.set(updates, { reason: 'test' }), (e) => e.status === 422 && e.code === 'config.invalid' && why.test(e.message), JSON.stringify(updates));
    }
    assert.strictEqual(policy.get().revision(), rev0, 'a refused change changes nothing');
    await policy.set({ promoteMinSizeMb: 0.001, promoteMaxSizeMb: 1 }, { actor: { type: 'service', id: 'live' }, reason: 'test: small objects' });
    const th = policy.thresholds();
    assert.deepStrictEqual([th.promoteMinSizeMb.source, th.promoteMinUniqueViewers7d.source, th.active.source], ['setting', 'default', 'default']);
    assert.deepStrictEqual(th.promoteMinUniqueViewers7d, { value: 500, default: 500, source: 'default' });
    console.log('✅ media.object_tier: gate off and 500 viewers by default; types, ranges, key order and unknown keys refused (422), nothing changed');

    // ── 4. Gate off: the sweep moves nothing and records what it would do ──
    db.run('DELETE FROM media_object_views_daily');
    const pop = addObject();
    setViews(pop.id, [[0, 600]]);
    const cached = addObject();                                              // a copy in R2 from earlier, idle for a month
    buckets['r2-bucket'].set(`objects/live/${cached.id}`, cached.bytes);
    model.upsertLocation(cached.id, { provider: 'r2', bucket: 'r2-bucket', key: `objects/live/${cached.id}`, storage_class: 'cache', state: 'present', size_bytes: 4096, checksum: cached.sum, verified: true });
    ageR2(cached.id, 30);
    const r2Keys = buckets['r2-bucket'].size;
    let s = await tiering.runSweep();
    assert.deepStrictEqual([s.gate, s.promoted, s.demoted, s.would_promote, s.would_demote], [false, 0, 0, 1, 1], JSON.stringify(s));
    assert.strictEqual(buckets['r2-bucket'].size, r2Keys, 'nothing was copied or deleted');
    assert.ok(!r2Row(pop.id) && r2Row(cached.id));
    let d = last(pop.id);
    assert.deepStrictEqual([d.action, d.outcome, d.trigger, d.from_provider, d.to_provider], ['promote', 'dry_run', 'sweep', 'local', 'r2']);
    assert.ok(/^gate off \(active = false\): would promote: 600 unique viewers in 7 days >= promoteMinUniqueViewers7d 500/.test(d.reason), d.reason);
    const din = JSON.parse(d.inputs);
    assert.deepStrictEqual([din.unique_viewers_7d, din.last_viewed_day, din.gate_active, din.held, din.canonical.provider, din.canonical.checksum_matches], [600, today, false, false, 'local', true]);
    assert.deepStrictEqual(JSON.parse(d.thresholds).active, { value: false, source: 'default' });
    assert.deepStrictEqual([last(cached.id).action, last(cached.id).outcome], ['demote', 'dry_run']);
    s = await tiering.runSweep();
    assert.deepStrictEqual([s.would_promote, s.would_demote, s.repeats], [0, 0, 2], 'a repeated dry run is logged once a day');
    assert.strictEqual(decisions(pop.id).length, 1);
    const manual = await tiering.promote(pop.id, { reason: 'asked by hand' });
    assert.deepStrictEqual([manual.ok, manual.outcome], [false, 'dry_run'], 'the gate holds for a direct call too');
    assert.ok(!r2Row(pop.id));
    console.log('✅ gate off: dry_run decisions (with inputs and thresholds), once a day, and nothing moves, from the sweep or a direct call');

    // ── 5. Thresholds: viewers, recency, window and size ──
    const few = addObject(); setViews(few.id, [[0, 499]]);
    const stale = addObject(); setViews(stale.id, [[-5, 900]]);                     // popular, but not viewed within 3 days
    const outside = addObject(); setViews(outside.id, [[-7, 450], [0, 100]]);       // day -7 is outside the 7-day window
    const spread = addObject(); setViews(spread.id, [[-6, 250], [-3, 150], [0, 100]]);
    const tiny = addObject({ size: 512 }); setViews(tiny.id, [[0, 900]]);           // under promoteMinSizeMb (0.001 MB)
    const huge = addObject({ size: 1100000 }); setViews(huge.id, [[0, 900]]);       // over promoteMaxSizeMb (1 MB)
    const projectId = 'prj_01J8Z3Q4X5Y6Z7A8B9C0D1E2F3';
    db.ensureProjectTenant(projectId, 'sandbox', 0);
    const sandboxed = addObject({ app: `${projectId}-sandbox` }); setViews(sandboxed.id, [[0, 900]]);
    const ids = tiering.promotionCandidates(policy.settings()).map((c) => c.id);
    assert.ok(ids.includes(pop.id) && ids.includes(spread.id), 'at 500 or more within the window');
    for (const o of [few, stale, outside, tiny, huge]) assert.ok(!ids.includes(o.id), `not a candidate: ${o.id}`);
    s = await tiering.runSweep();
    assert.ok(!decisions(sandboxed.id).length, 'a sandbox object is never considered');
    assert.strictEqual(tiering.candidates().find((c) => c.object_id === sandboxed.id).blocked_by, 'developer sandbox objects are never tiered');
    assert.strictEqual(last(spread.id).outcome, 'dry_run');
    for (const o of [few, stale, outside, tiny, huge]) assert.strictEqual(decisions(o.id).length, 0);
    console.log('✅ thresholds: 7-day viewers (sum of the window), recent view, size bounds; sandbox tenants never tier');

    // ── 6. Gate on: holds and an unverified canonical copy refuse; a released hold promotes ──
    await policy.set({ active: true }, { actor: { type: 'service', id: 'live' }, reason: 'test: gate on' });
    db.run('DELETE FROM media_object_views_daily');
    const hot = addObject(); setViews(hot.id, [[0, 700]]);
    const hold = model.placeHold({ object_id: hot.id, kind: 'admin', reason: 'test' });
    const unchecked = addObject({ verified: false }); setViews(unchecked.id, [[0, 700]]);
    const nohash = addObject({ hash: false }); setViews(nohash.id, [[0, 700]]);
    const tampered = addObject(); setViews(tampered.id, [[0, 700]]);
    const other = Buffer.from(tampered.bytes); other[10] ^= 0xff; fs.writeFileSync(tampered.file, other);   // on record verified; on disk not
    s = await tiering.runSweep();
    assert.deepStrictEqual([s.gate, s.promoted, s.refused], [true, 0, 4], JSON.stringify(s));
    assert.ok(/retention hold/.test(last(hot.id).reason) && JSON.parse(last(hot.id).inputs).held === true);
    assert.ok(/never checked/.test(last(unchecked.id).reason), last(unchecked.id).reason);
    assert.ok(/no sha256 on record/.test(last(nohash.id).reason), last(nohash.id).reason);
    assert.ok(/does not match the sha256 on record/.test(last(tampered.id).reason), last(tampered.id).reason);
    for (const o of [hot, unchecked, nohash, tampered]) { assert.ok(!r2Row(o.id)); assert.ok(!buckets['r2-bucket'].has(`objects/live/${o.id}`)); }
    s = await tiering.runSweep();
    assert.strictEqual(decisions(hot.id).length, 1, 'a repeated refusal is logged once a day');
    model.releaseHold(hold.id, 'test');
    s = await tiering.runSweep();
    assert.strictEqual(s.promoted, 1);
    console.log('✅ gate on: a hold, a canonical copy never checked, no sha256 or bytes that no longer match refuse the promotion; released, it promotes');

    // ── 7. Promotion: copy, verify size and sha256, record; /o/:id plays from R2 ──
    let r = r2Row(hot.id);
    assert.deepStrictEqual([r.state, r.storage_class, r.key, r.checksum, r.size_bytes, !!r.verified_at], ['present', 'cache', `objects/live/${hot.id}`, hot.sum, 4096, true]);
    assert.ok(buckets['r2-bucket'].get(`objects/live/${hot.id}`).equals(hot.bytes), 'the R2 copy is the same bytes');
    assert.ok(fs.existsSync(hot.file) && db.get("SELECT state FROM media_locations WHERE object_id = ? AND provider = 'local'", [hot.id]).state === 'present', 'the canonical copy stays');
    d = last(hot.id);
    assert.deepStrictEqual([d.action, d.outcome, d.trigger, d.from_provider, d.to_provider, d.error], ['promote', 'done', 'sweep', 'local', 'r2', null]);

    const express = require('express');
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use('/api/v1/:app/admin/storage', require('../server/admin/routes'));
    app.use('/o', require('../server/objects/routes').publicRouter);
    const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (url, headers = {}) => new Promise((resolve, reject) => {
        http.get(url, { headers: { 'User-Agent': BROWSER, ...headers } }, (res) => {
            const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b) }));
        }).on('error', reject);
    });
    const call = async (p, key = 'live-key-objtier') => { const x = await get(base + p, { Authorization: `Bearer ${key}` }); return { status: x.status, body: JSON.parse(x.body.toString() || '{}') }; };

    const web = addObject();
    let g = await get(`${base}/o/${web.id}`, { 'X-Forwarded-For': '192.0.2.44' });
    assert.strictEqual(g.status, 200);
    assert.ok(g.body.equals(web.bytes), 'served from the local canonical copy before');
    await get(`${base}/o/${web.id}`, { 'X-Forwarded-For': '192.0.2.45', 'Sec-GPC': '1' });
    assert.strictEqual(popularity.stats({ ids: [web.id] }).get(web.id).unique_viewers, 1, '/o/:id counts its viewers (not the opted-out one)');
    assert.strictEqual((await tiering.promote(web.id, { trigger: 'manual', reason: 'test' })).outcome, 'done');
    g = await get(`${base}/o/${web.id}`, { 'X-Forwarded-For': '192.0.2.46' });
    assert.strictEqual(g.status, 302);
    const loc = new URL(g.headers.location);
    assert.ok(loc.pathname.endsWith(`/r2-bucket/objects/live/${web.id}`), g.headers.location);
    assert.ok(/^attachment; filename="x\.bin"$/.test(loc.searchParams.get('response-content-disposition')), 'the presigned answer keeps the headers /o would send');
    assert.strictEqual(loc.searchParams.get('response-content-type'), 'application/octet-stream');
    assert.ok((await get(g.headers.location)).body.equals(web.bytes), 'and R2 serves the same bytes');
    assert.strictEqual(popularity.stats({ ids: [web.id] }).get(web.id).unique_viewers, 2);

    fault.corruptPut = 'r2-bucket';
    const bad = addObject();
    let m = await tiering.promote(bad.id, { reason: 'test' });
    fault.corruptPut = null;
    assert.deepStrictEqual([m.ok, m.outcome], [false, 'failed']);
    assert.ok(/does not match the sha256/.test(m.error), m.error);
    assert.ok(!buckets['r2-bucket'].has(`objects/live/${bad.id}`) && !r2Row(bad.id), 'an R2 copy that does not verify is removed and never recorded');
    assert.ok(last(bad.id).error);
    fault.refusePut = 'r2-bucket';
    const refusedPut = addObject();
    m = await tiering.promote(refusedPut.id, { reason: 'test' });
    fault.refusePut = null;
    assert.deepStrictEqual([m.outcome, !!r2Row(refusedPut.id)], ['failed', false]);
    db.run('DELETE FROM media_object_views_daily WHERE object_id != ?', [bad.id]);
    setViews(bad.id, [[0, 700]]);
    s = await tiering.runSweep();
    assert.deepStrictEqual([s.skipped_backoff, s.promoted, decisions(bad.id).length], [1, 0, 1], 'a failed object waits before the next try');

    const fromB2 = addObject({ canonical: 'b2' });
    m = await tiering.promote(fromB2.id, { reason: 'test' });
    assert.strictEqual(m.outcome, 'done', JSON.stringify(m));
    assert.ok(buckets['r2-bucket'].get(`objects/live/${fromB2.id}`).equals(fromB2.bytes), 'a B2 canonical copy is copied to R2 under its key');
    assert.strictEqual(last(fromB2.id).from_provider, 'b2');
    assert.strictEqual((await tiering.promote(fromB2.id, { reason: 'again' })).outcome, 'already');
    console.log('✅ promotion copies the canonical copy, checks the R2 copy\'s size and sha256 before recording it; /o/:id then redirects to R2 with its own headers; failures leave nothing and back off');

    // ── 8. Demotion: idle or not ready; never the last good copy; holds; purge waits for it ──
    db.run('DELETE FROM media_object_views_daily');
    setViews(hot.id, [[-20, 900]]); ageR2(hot.id, 20);                                // idle 20 days, in R2 20 days
    const fresh = addObject(); await tiering.promote(fresh.id, { reason: 'test' });   // no viewer, but in R2 since now
    setViews(web.id, [[0, 3]]); ageR2(web.id, 20);                                    // viewed today
    const lost = addObject(); await tiering.promote(lost.id, { reason: 'test' }); ageR2(lost.id, 20);
    fs.unlinkSync(lost.file);                                                         // the canonical copy is gone: R2 is the last good copy
    const drifted = addObject(); await tiering.promote(drifted.id, { reason: 'test' }); ageR2(drifted.id, 20);
    const flipped = Buffer.from(drifted.bytes); flipped[0] ^= 0xff; fs.writeFileSync(drifted.file, flipped);
    const pinned = addObject(); await tiering.promote(pinned.id, { reason: 'test' }); ageR2(pinned.id, 20);
    const pin = model.placeHold({ object_id: pinned.id, kind: 'creator_pin', reason: 'test' });
    const gone = addObject(); await tiering.promote(gone.id, { reason: 'test' }); setViews(gone.id, [[0, 900]]);
    model.softDelete(model.getObject(gone.id), { by: 'test' });
    const sticky = addObject(); await tiering.promote(sticky.id, { reason: 'test' }); ageR2(sticky.id, 20);
    fault.keepOnDelete = 'r2-bucket';
    // Only the sticky object sees the store keep its bytes: demote it on its own first.
    m = await tiering.demote(sticky.id, { reason: 'test' });
    fault.keepOnDelete = null;
    assert.deepStrictEqual([m.outcome, !!r2Row(sticky.id)], ['failed', true]);
    assert.ok(/still there/.test(m.error));
    // Seven hours ago: past the back-off, so the sweep below tries again (and still within the 24-hour counts).
    db.run("UPDATE media_object_tier_decisions SET decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 hours') WHERE object_id = ? AND outcome = 'failed'", [sticky.id]);
    await policy.set({ maxDemotionsPerSweep: 20 }, { reason: 'test: room for every demotion' });
    s = await tiering.runSweep();
    assert.ok(!r2Row(hot.id) && !buckets['r2-bucket'].has(`objects/live/${hot.id}`), 'an idle object leaves R2');
    assert.ok(fs.existsSync(hot.file) && db.get("SELECT state FROM media_locations WHERE object_id = ? AND provider = 'local'", [hot.id]).state === 'present');
    d = last(hot.id);
    assert.deepStrictEqual([d.action, d.outcome, d.from_provider, d.to_provider], ['demote', 'done', 'r2', 'local']);
    assert.ok(/idle for demoteIdleDays 14/.test(d.reason), d.reason);
    assert.ok(r2Row(fresh.id) && r2Row(web.id), 'an object in R2 for less than demoteIdleDays, or viewed, stays');
    assert.ok(r2Row(lost.id) && buckets['r2-bucket'].has(`objects/live/${lost.id}`), 'the last good copy is never removed');
    assert.deepStrictEqual([last(lost.id).outcome, /the canonical local file is missing; the R2 copy is kept/.test(last(lost.id).reason)], ['refused', true]);
    assert.ok(r2Row(drifted.id) && /does not match the sha256/.test(last(drifted.id).reason), 'nor one whose canonical copy no longer hashes right');
    assert.ok(r2Row(pinned.id) && /retention hold/.test(last(pinned.id).reason), 'a hold blocks the demotion');
    assert.ok(!r2Row(gone.id) && /the object is deleted/.test(last(gone.id).reason), 'a deleted object leaves R2 however popular');
    assert.ok(!r2Row(cached.id), 'the month-idle copy from before goes too');
    assert.ok(!r2Row(sticky.id), 'and the one the store kept once, now that it lets go');
    g = await get(`${base}/o/${lost.id}`);
    assert.strictEqual(g.status, 302, 'the object whose canonical copy is lost still plays from R2');
    g = await get(`${base}/o/${hot.id}`);
    assert.strictEqual(g.status, 200, 'a demoted object plays from its canonical copy again');
    model.releaseHold(pin.id, 'test');

    const purged = addObject(); await tiering.promote(purged.id, { reason: 'test' });
    model.softDelete(model.getObject(purged.id), { by: 'test' });
    db.run("UPDATE media_objects SET deleted_at = datetime('now', '-40 days') WHERE id = ?", [purged.id]);
    model.purgeExpired();
    assert.ok(fs.existsSync(purged.file) && r2Row(purged.id), 'the purge waits while the object still has an R2 copy');
    await tiering.demote(purged.id, { trigger: 'sweep', reason: 'the object is deleted' });
    model.purgeExpired();
    assert.ok(!fs.existsSync(purged.file) && !r2Row(purged.id), 'and purges once the R2 copy is gone');
    console.log('✅ demotion: idle (and settled) or not ready; refused under a hold or when the canonical copy does not check out; a failed delete keeps the row; the purge waits for it');

    // ── 9. The decision log: admin API, metric, operator views ──
    const gamesObj = addObject({ app: 'games' });
    await tiering.promote(gamesObj.id, { reason: 'games' });
    const cand = addObject(); setViews(cand.id, [[0, 800]]);
    let a = await call('/api/v1/live/admin/storage/tiers/objects/policy');
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.deepStrictEqual([a.body.gate.active, a.body.gate.source], [true, 'setting']);
    assert.deepStrictEqual(a.body.thresholds.promoteMinUniqueViewers7d, { value: 500, default: 500, source: 'default' });
    assert.ok(/promoteMinUniqueViewers7d \(500\)/.test(a.body.rules.promote) && /last good copy/.test(a.body.rules.demote));
    assert.deepStrictEqual(a.body.candidates.map((c) => [c.object_id, c.unique_viewers_7d, c.blocked_by]), [[cand.id, 800, null]]);
    assert.strictEqual(a.body.provider.r2.configured, true);
    const c24 = a.body.decisions.last_24h;
    assert.ok(c24.promote.dry_run >= 3 && c24.promote.done >= 10 && c24.promote.refused >= 4 && c24.promote.failed >= 2 && c24.promote.already === 1, JSON.stringify(c24));
    assert.ok(c24.demote.done >= 4 && c24.demote.refused >= 3 && c24.demote.failed === 1 && c24.demote.dry_run === 1, JSON.stringify(c24));
    assert.ok(a.body.decisions.recent.every((x) => x.app_id === 'live') && a.body.decisions.recent[0].inputs && a.body.decisions.recent[0].thresholds);
    a = await call('/api/v1/live/admin/storage/tiers/objects/decisions?outcome=dry_run&limit=2');
    assert.deepStrictEqual([a.body.decisions.length, a.body.decisions.every((x) => x.outcome === 'dry_run'), a.body.next_before_id != null], [2, true, true]);
    a = await call(`/api/v1/live/admin/storage/tiers/objects/decisions?object_id=${bad.id}`);
    assert.deepStrictEqual(a.body.decisions.map((x) => x.outcome), ['failed']);
    assert.strictEqual((await call('/api/v1/live/admin/storage/tiers/objects/decisions?action=move')).status, 400);
    assert.strictEqual((await call('/api/v1/live/admin/storage/tiers/objects/decisions?outcome=nope')).status, 400);
    a = await call('/api/v1/games/admin/storage/tiers/objects/decisions', 'games-key-objtier');
    assert.deepStrictEqual(a.body.decisions.map((x) => x.object_id), [gamesObj.id], 'each app sees its own');
    assert.ok((await call('/api/v1/live/admin/storage/tiers/objects/policy', 'wrong-key')).status >= 401);
    a = await call('/api/v1/live/admin/storage/config');
    const ns = a.body.namespaces.find((n) => n.namespace === 'media.object_tier');
    assert.ok(ns && ns.values.active === true && ns.values.promoteMinUniqueViewers7d === 500, 'the policy is in the config routes');
    a = await call('/api/v1/live/admin/storage/config/media.object_tier/history');
    assert.deepStrictEqual(a.body.snapshots.map((x) => x.state), ['active', 'superseded', 'superseded', 'superseded']);
    const post = (p, body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const rq = http.request(base + p, { method: 'POST', headers: { Authorization: 'Bearer live-key-objtier', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
            (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
        rq.on('error', reject);
        rq.end(data);
    });
    a = await post('/api/v1/live/admin/storage/config/media.object_tier', { values: { active: false }, merge: true, reason: 'gate off through the route' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(policy.settings().active, false);
    a = await post('/api/v1/live/admin/storage/config/media.object_tier', { values: { active: true }, merge: true, reason: 'and on again' });
    assert.deepStrictEqual([a.status, policy.settings().active, policy.thresholds().active.source], [200, true, 'setting']);
    a = await post('/api/v1/live/admin/storage/config/media.object_tier', { values: { demoteIdleDays: 2 }, merge: true, reason: 'flapping' });
    assert.deepStrictEqual([a.status, policy.settings().demoteIdleDays], [422, 14], 'the route refuses what the rules refuse');

    db.run("INSERT INTO media_tier_decisions (vod_id, app_id, action, outcome, trigger, reason) VALUES (1, 'live', 'promote', 'done', 'admin', 'test')");
    const registry = require('openvibe-shared/metrics').createRegistry();
    require('../server/observability').domainMetrics(registry, { db, recorder: { activeCount: () => 0 }, events: { status: () => ({ enabled: false }) } });
    const text = registry.metrics();
    const all24 = tiering.counts24h();
    assert.ok(text.includes(`media_tier_decisions_24h{target="object",action="promote",outcome="done"} ${all24.promote.done}`), text);
    assert.ok(text.includes(`media_tier_decisions_24h{target="object",action="promote",outcome="dry_run"} ${all24.promote.dry_run}`));
    assert.ok(text.includes('media_tier_decisions_24h{target="vod",action="promote",outcome="done"} 1'));

    const report = require('../server/me/ops').report({ appId: 'live' });
    const no = report.tiering.native_objects;
    const liveR2 = db.get("SELECT COUNT(*) AS n FROM media_locations l JOIN media_objects o ON o.id = l.object_id WHERE l.provider = 'r2' AND l.state = 'present' AND o.app_id = 'live'").n;
    assert.deepStrictEqual([no.gate.active, no.r2_copies.count, no.eligible_to_promote, no.decisions_24h.promote.done], [true, liveR2, 1, c24.promote.done]);
    assert.ok(no.recent.length && no.sweep.last_result && no.sweep.last_run_at);
    assert.ok(!/until roadmap WS-G task 11/.test(report.tiering.note));
    const html = require('../server/me/pages').renderOps({ person: { subject: 'usr_01J8Z3Q4X5Y6Z7A8B9C0D1E2F3' }, report, canRecompute: false });
    assert.ok(/Native objects/.test(html) && /Activation gate/.test(html) && html.includes(bad.id), 'the /me/ops page shows the gate and the recent decisions');
    console.log('✅ decisions: /tiers/objects/policy and /decisions (filters, pages, app-scoped), the config routes, media_tier_decisions_24h{target}, and the operator views');

    // ── 10. The storage sweep runs it (step 4); a restore drill never does ──
    const vodSweep = await storage.runSweep();
    assert.ok(vodSweep.objects && vodSweep.objects.gate === true && typeof vodSweep.objects.promoted === 'number', JSON.stringify(vodSweep));
    assert.strictEqual(r2Row(cand.id) && r2Row(cand.id).state, 'present', 'the storage sweep promoted the candidate');
    // The storage engine's upload is exported (the scheduled verification's default re-upload calls it too).
    assert.deepStrictEqual(['uploadFile', 'copyBetweenProviders', 'sha256Object', 'providerAvailable'].map((f) => typeof storage[f]), ['function', 'function', 'function', 'function']);
    const drill = require('../server/drill');
    drill.enabled = true;
    assert.deepStrictEqual(await tiering.runSweep(), { skipped: true, reason: 'restore drill (MEDIA_DRILL)' });
    drill.enabled = false;
    console.log('✅ the storage sweep runs the object tiering as its step 4; under MEDIA_DRILL it does nothing');

    server.close();
    s3.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All object tiering tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
