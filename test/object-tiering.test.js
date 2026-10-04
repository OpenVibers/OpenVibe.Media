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

(async () => {
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
            VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
            THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
            MEDIA_B2_ENDPOINT: endpoint, MEDIA_B2_BUCKET: 'b2-bucket', MEDIA_B2_KEY_ID: 'k', MEDIA_B2_APP_KEY: 's', MEDIA_B2_REGION: 'us-west-004',
            MEDIA_R2_ENDPOINT: endpoint, MEDIA_R2_BUCKET: 'r2-bucket', MEDIA_R2_ACCESS_KEY_ID: 'k', MEDIA_R2_SECRET_ACCESS_KEY: 's',
            AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED', AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
        });
        const db = require('../server/db/database');
        const model = require('../server/objects/model');
        const storage = require('../server/vod/vod-storage');
        // The revisioned tier policies load once the database is open (server/index.js does this at boot).
        await storage.tierConfig.init(storage.DEFAULTS);
        await require('../server/objects/tier-policy').init();
        await require('../server/placement/storage-policy').init();
        const popularity = require('../server/objects/popularity');
        const policy = require('../server/objects/tier-policy');
        const tiering = require('../server/objects/tiering');
        await db.upsertApp({ app_id: 'live', api_key: 'live-key-objtier' });
        await db.upsertApp({ app_id: 'games', api_key: 'games-key-objtier' });
        // Keep the VOD sweep's disk-pressure drain out of this test (whatever this machine's disk looks like).
        await storage.setSettings({ hotDiskPressurePct: 100, criticalDiskPct: 100, minFreeGb: 0 }, { reason: 'test: no pressure drain' });

        const today = popularity.dayOf(Date.now());
        const addObject = async ({ app = 'live', size = 4096, mime = 'application/octet-stream', verified = true, hash = true, canonical = 'local' } = {}) => {
            const bytes = crypto.randomBytes(size);
            const sum = sha256(bytes);
            const id = await model.createObject({ app_id: app, kind: 'file', visibility: 'public', lifecycle_status: 'ready', mime_type: mime, size_bytes: size,
                content_hash: hash ? sum : null, canonical_provider: canonical, metadata: { filename: 'x.bin' } });
            let file = null;
            if (canonical === 'local') {
                file = path.join(process.env.OBJECTS_PATH, app, id);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, bytes);
                await model.updateObject(id, { canonical_key: file });
                await model.upsertLocation(id, { provider: 'local', key: file, state: verified ? 'present' : 'pending', size_bytes: size, checksum: hash ? sum : null, verified });
            } else {
                const key = `objects/${app}/${id}`;
                buckets['b2-bucket'].set(key, bytes);
                await model.updateObject(id, { canonical_key: key });
                await model.upsertLocation(id, { provider: 'b2', bucket: 'b2-bucket', key, state: 'present', size_bytes: size, verified: true });
            }
            return { id, bytes, sum, file, app };
        };
        const setViews = async (id, entries) => {
            await db.run('DELETE FROM media_object_views_daily WHERE object_id = ?', [id]);
            for (const [offset, n] of entries) {
                await db.run('INSERT INTO media_object_views_daily (object_id, day, unique_viewers, last_viewed_at) VALUES (?, ?, ?, ?)',
                    [id, popularity.addDays(today, offset), n, `${popularity.addDays(today, offset)}T12:00:00.000Z`]);
            }
        };
        const r2Row = async (id) => await db.get("SELECT * FROM media_locations WHERE object_id = ? AND provider = 'r2'", [id]);
        const ageR2 = async (id, days) => await db.run("UPDATE media_locations SET created_at = datetime('now', ?) WHERE object_id = ? AND provider = 'r2'", [`-${days} days`, id]);
        const decisions = async (id) => await db.all('SELECT * FROM media_object_tier_decisions WHERE object_id = ? ORDER BY id', [id]);
        const last = async (id) => { const d = await decisions(id); return d[d.length - 1]; };
        const fake = (ip, headers = {}, method = 'GET') => ({ method, ip, path: '/o/x', url: '/o/x', headers: { 'user-agent': BROWSER, ...headers } });

        // ── 1. Unique viewers per object and day, with no IP address or subject id stored ──
        const seen = await addObject();
        const rec = async (ip, headers, method) => await popularity.record(await model.getObject(seen.id), fake(ip, headers, method));
        assert.deepStrictEqual(await rec('203.0.113.5'), { counted: true, reason: null });
        assert.strictEqual((await rec('203.0.113.5', { 'user-agent': SAFARI })).reason, 'seen', 'one network is one viewer, whatever its user agent');
        popularity._reset();                                                    // a restart: the same day's salt comes back from the database
        assert.strictEqual((await rec('203.0.113.5')).reason, 'seen', 'and still once after a restart');
        assert.strictEqual((await rec('198.51.100.7')).counted, true);
        assert.strictEqual((await rec('::ffff:198.51.100.7')).reason, 'seen', 'an IPv4-mapped address is the IPv4 address');
        assert.strictEqual((await rec('2001:db8:1:2::10')).counted, true);
        assert.strictEqual((await rec('2001:db8:1:2:aaaa:bbbb:cccc:1')).reason, 'seen', 'an IPv6 /64 is one viewer');
        assert.strictEqual((await rec('2001:db8:1:3::10')).counted, true);
        assert.strictEqual((await rec('192.0.2.10', { range: 'bytes=5000-' })).reason, 'range', 'a seek is not a view');
        assert.strictEqual((await rec('192.0.2.10', { range: 'bytes=0-' })).counted, true);
        assert.strictEqual((await rec('192.0.2.11', {}, 'HEAD')).reason, 'method');
        assert.strictEqual((await rec('192.0.2.12', { 'sec-gpc': '1' })).reason, 'opted_out');
        assert.strictEqual((await rec('192.0.2.13', { dnt: '1' })).reason, 'opted_out');
        assert.strictEqual((await rec('192.0.2.14', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })).reason, 'bot');
        assert.strictEqual((await rec('192.0.2.15', { 'user-agent': '' })).reason, 'bot');
        const projected = await model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready', legacy_ref: 'legacy:live:file:abc' });
        assert.strictEqual((await popularity.record(await model.getObject(projected), fake('192.0.2.16'))).reason, 'not_native');
        const todayRow = await db.get('SELECT * FROM media_object_views_daily WHERE object_id = ? AND day = ?', [seen.id, today]);
        assert.strictEqual(todayRow.unique_viewers, 5);
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_object_viewer_days WHERE object_id = ?', [seen.id])).n, 5, 'an opted-out, bot, HEAD or seek request makes no hash at all');
        const stored = JSON.stringify([await db.all('SELECT * FROM media_object_viewer_days'), await db.all('SELECT * FROM media_object_views_daily'), await db.all('SELECT day FROM media_object_view_salts')]);
        for (const ip of ['203.0.113.5', '198.51.100.7', '2001:db8', '192.0.2.10', 'usr_']) assert.ok(!stored.includes(ip), `nothing stored names ${ip}`);
        for (const v of (await db.all('SELECT viewer FROM media_object_viewer_days')).map((r) => r.viewer)) {
            assert.ok(/^[0-9a-f]{16}$/.test(v));
            assert.notStrictEqual(v, sha256('203.0.113.5').slice(0, 16), 'keyed by the salt of the day, not a plain hash of the address');
        }
        assert.deepStrictEqual(['10.1.2.3', '::ffff:10.1.2.3', '2001:DB8::1', '2001:db8:0:0:ffff::9', 'fe80::1%eth0'].map(popularity.networkOf),
            ['10.1.2.3', '10.1.2.3', '2001:db8:0:0::/64', '2001:db8:0:0::/64', 'fe80:0:0:0::/64']);
        console.log('✅ a viewer counts once per object and UTC day (one network, IPv6 by /64), never a seek, HEAD, bot or opted-out request, and no address is stored');

        // ── 2. Hashes and salt die with their day; counts roll into a 7-day window, kept 30 days ──
        const roll = await addObject();
        const yesterday = popularity.addDays(today, -1);
        assert.strictEqual((await popularity.record(await model.getObject(roll.id), fake('203.0.113.9'), { now: Date.parse(`${yesterday}T12:00:00Z`) })).counted, true);
        const oldHash = (await db.get('SELECT viewer FROM media_object_viewer_days WHERE object_id = ? AND day = ?', [roll.id, yesterday])).viewer;
        assert.ok(await db.get('SELECT 1 AS x FROM media_object_view_salts WHERE day = ?', [yesterday]));
        assert.strictEqual((await popularity.record(await model.getObject(roll.id), fake('203.0.113.9'))).counted, true, 'the same network on the next day is a new viewer-day');
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_object_viewer_days WHERE day < ?', [today])).n, 0, 'the first view of a day deletes the finished days\' hashes');
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_object_view_salts WHERE day < ?', [today])).n, 0, '...and their salts');
        assert.notStrictEqual((await db.get('SELECT viewer FROM media_object_viewer_days WHERE object_id = ? AND day = ?', [roll.id, today])).viewer, oldHash, 'a new salt every day: days cannot be linked');
        assert.strictEqual((await db.get('SELECT unique_viewers FROM media_object_views_daily WHERE object_id = ? AND day = ?', [roll.id, yesterday])).unique_viewers, 1, 'the count stays');
        const rs = (await popularity.stats({ ids: [roll.id] })).get(roll.id);
        assert.deepStrictEqual([rs.unique_viewers, rs.days_viewed, rs.last_viewed_day], [2, 2, today], 'two viewer-days');
        const win = await addObject();
        await setViews(win.id, [[-8, 100], [-6, 200], [0, 150]]);
        assert.strictEqual((await popularity.stats({ ids: [win.id] })).get(win.id).unique_viewers, 350, 'the last 7 UTC days, today included');
        assert.strictEqual((await popularity.stats({ ids: [win.id], days: 9 })).get(win.id).unique_viewers, 450);
        await db.run('INSERT INTO media_object_views_daily (object_id, day, unique_viewers) VALUES (?, ?, 1), (?, ?, 1)', [win.id, popularity.addDays(today, -30), win.id, popularity.addDays(today, -31)]);
        const rot = await popularity.rotate();
        assert.strictEqual(rot.counts, 1);
        assert.deepStrictEqual((await db.all('SELECT day FROM media_object_views_daily WHERE object_id = ? ORDER BY day', [win.id])).map((r) => r.day),
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
        await db.run('DELETE FROM media_object_views_daily');
        const pop = await addObject();
        await setViews(pop.id, [[0, 600]]);
        const cached = await addObject();                                              // a copy in R2 from earlier, idle for a month
        buckets['r2-bucket'].set(`objects/live/${cached.id}`, cached.bytes);
        await model.upsertLocation(cached.id, { provider: 'r2', bucket: 'r2-bucket', key: `objects/live/${cached.id}`, storage_class: 'cache', state: 'present', size_bytes: 4096, checksum: cached.sum, verified: true });
        await ageR2(cached.id, 30);
        const r2Keys = buckets['r2-bucket'].size;
        let s = await tiering.runSweep();
        assert.deepStrictEqual([s.gate, s.promoted, s.demoted, s.would_promote, s.would_demote], [false, 0, 0, 1, 1], JSON.stringify(s));
        assert.strictEqual(buckets['r2-bucket'].size, r2Keys, 'nothing was copied or deleted');
        assert.ok(!await r2Row(pop.id) && await r2Row(cached.id));
        let d = await last(pop.id);
        assert.deepStrictEqual([d.action, d.outcome, d.trigger, d.from_provider, d.to_provider], ['promote', 'dry_run', 'sweep', 'local', 'r2']);
        assert.ok(/^gate off \(active = false\): would promote: 600 unique viewers in 7 days >= promoteMinUniqueViewers7d 500/.test(d.reason), d.reason);
        const din = JSON.parse(d.inputs);
        assert.deepStrictEqual([din.unique_viewers_7d, din.last_viewed_day, din.gate_active, din.held, din.canonical.provider, din.canonical.checksum_matches], [600, today, false, false, 'local', true]);
        assert.strictEqual(din.class, 'download', 'every decision row records the class that set its budget');
        assert.deepStrictEqual(JSON.parse(d.thresholds).active, { value: false, source: 'default' });
        assert.deepStrictEqual([(await last(cached.id)).action, (await last(cached.id)).outcome], ['demote', 'dry_run']);
        s = await tiering.runSweep();
        assert.deepStrictEqual([s.would_promote, s.would_demote, s.repeats], [0, 0, 2], 'a repeated dry run is logged once a day');
        assert.strictEqual((await decisions(pop.id)).length, 1);
        const manual = await tiering.promote(pop.id, { reason: 'asked by hand' });
        assert.deepStrictEqual([manual.ok, manual.outcome], [false, 'dry_run'], 'the gate holds for a direct call too');
        assert.ok(!await r2Row(pop.id));
        console.log('✅ gate off: dry_run decisions (with inputs and thresholds), once a day, and nothing moves, from the sweep or a direct call');

        // ── 5. Thresholds: viewers, recency, window and size ──
        const few = await addObject(); await setViews(few.id, [[0, 499]]);
        const stale = await addObject(); await setViews(stale.id, [[-5, 900]]);                     // popular, but not viewed within 3 days
        const outside = await addObject(); await setViews(outside.id, [[-7, 450], [0, 100]]);       // day -7 is outside the 7-day window
        const spread = await addObject(); await setViews(spread.id, [[-6, 250], [-3, 150], [0, 100]]);
        const tiny = await addObject({ size: 512 }); await setViews(tiny.id, [[0, 900]]);           // under promoteMinSizeMb (0.001 MB)
        const huge = await addObject({ size: 1100000 }); await setViews(huge.id, [[0, 900]]);       // over promoteMaxSizeMb (1 MB)
        const projectId = 'prj_01J8Z3Q4X5Y6Z7A8B9C0D1E2F3';
        await db.ensureProjectTenant(projectId, 'sandbox', 0);
        const sandboxed = await addObject({ app: `${projectId}-sandbox` }); await setViews(sandboxed.id, [[0, 900]]);
        const ids = (await tiering.promotionCandidates(policy.settings())).map((c) => c.id);
        assert.ok(ids.includes(pop.id) && ids.includes(spread.id), 'at 500 or more within the window');
        for (const o of [few, stale, outside, tiny, huge]) assert.ok(!ids.includes(o.id), `not a candidate: ${o.id}`);
        s = await tiering.runSweep();
        assert.ok(!(await decisions(sandboxed.id)).length, 'a sandbox object is never considered');
        assert.strictEqual((await tiering.candidates()).find((c) => c.object_id === sandboxed.id).blocked_by, 'developer sandbox objects are never tiered');
        assert.strictEqual((await last(spread.id)).outcome, 'dry_run');
        for (const o of [few, stale, outside, tiny, huge]) assert.strictEqual((await decisions(o.id)).length, 0);
        console.log('✅ thresholds: 7-day viewers (sum of the window), recent view, size bounds; sandbox tenants never tier');

        // ── 6. Gate on: holds and an unverified canonical copy refuse; a released hold promotes ──
        await policy.set({ active: true }, { actor: { type: 'service', id: 'live' }, reason: 'test: gate on' });
        await db.run('DELETE FROM media_object_views_daily');
        const hot = await addObject(); await setViews(hot.id, [[0, 700]]);
        const hold = await model.placeHold({ object_id: hot.id, kind: 'admin', reason: 'test' });
        const unchecked = await addObject({ verified: false }); await setViews(unchecked.id, [[0, 700]]);
        const nohash = await addObject({ hash: false }); await setViews(nohash.id, [[0, 700]]);
        const tampered = await addObject(); await setViews(tampered.id, [[0, 700]]);
        const other = Buffer.from(tampered.bytes); other[10] ^= 0xff; fs.writeFileSync(tampered.file, other);   // on record verified; on disk not
        s = await tiering.runSweep();
        assert.deepStrictEqual([s.gate, s.promoted, s.refused], [true, 0, 4], JSON.stringify(s));
        assert.ok(/retention hold/.test((await last(hot.id)).reason) && JSON.parse((await last(hot.id)).inputs).held === true);
        assert.ok(/never checked/.test((await last(unchecked.id)).reason), (await last(unchecked.id)).reason);
        assert.ok(/no sha256 on record/.test((await last(nohash.id)).reason), (await last(nohash.id)).reason);
        assert.ok(/does not match the sha256 on record/.test((await last(tampered.id)).reason), (await last(tampered.id)).reason);
        for (const o of [hot, unchecked, nohash, tampered]) { assert.ok(!await r2Row(o.id)); assert.ok(!buckets['r2-bucket'].has(`objects/live/${o.id}`)); }
        s = await tiering.runSweep();
        assert.strictEqual((await decisions(hot.id)).length, 1, 'a repeated refusal is logged once a day');
        await model.releaseHold(hold.id, 'test');
        s = await tiering.runSweep();
        assert.strictEqual(s.promoted, 1);
        console.log('✅ gate on: a hold, a canonical copy never checked, no sha256 or bytes that no longer match refuse the promotion; released, it promotes');

        // ── 7. Promotion: copy, verify size and sha256, record; /o/:id plays from R2 ──
        let r = await r2Row(hot.id);
        assert.deepStrictEqual([r.state, r.storage_class, r.key, r.checksum, r.size_bytes, !!r.verified_at], ['present', 'cache', `objects/live/${hot.id}`, hot.sum, 4096, true]);
        assert.ok(buckets['r2-bucket'].get(`objects/live/${hot.id}`).equals(hot.bytes), 'the R2 copy is the same bytes');
        assert.ok(fs.existsSync(hot.file) && (await db.get("SELECT state FROM media_locations WHERE object_id = ? AND provider = 'local'", [hot.id])).state === 'present', 'the canonical copy stays');
        d = await last(hot.id);
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

        const web = await addObject();
        let g = await get(`${base}/o/${web.id}`, { 'X-Forwarded-For': '192.0.2.44' });
        assert.strictEqual(g.status, 200);
        assert.ok(g.body.equals(web.bytes), 'served from the local canonical copy before');
        await get(`${base}/o/${web.id}`, { 'X-Forwarded-For': '192.0.2.45', 'Sec-GPC': '1' });
        assert.strictEqual((await popularity.stats({ ids: [web.id] })).get(web.id).unique_viewers, 1, '/o/:id counts its viewers (not the opted-out one)');
        assert.strictEqual((await tiering.promote(web.id, { trigger: 'manual', reason: 'test' })).outcome, 'done');
        g = await get(`${base}/o/${web.id}`, { 'X-Forwarded-For': '192.0.2.46' });
        assert.strictEqual(g.status, 302);
        const loc = new URL(g.headers.location);
        assert.ok(loc.pathname.endsWith(`/r2-bucket/objects/live/${web.id}`), g.headers.location);
        assert.ok(/^attachment; filename="x\.bin"$/.test(loc.searchParams.get('response-content-disposition')), 'the presigned answer keeps the headers /o would send');
        assert.strictEqual(loc.searchParams.get('response-content-type'), 'application/octet-stream');
        assert.ok((await get(g.headers.location)).body.equals(web.bytes), 'and R2 serves the same bytes');
        assert.strictEqual((await popularity.stats({ ids: [web.id] })).get(web.id).unique_viewers, 2);

        fault.corruptPut = 'r2-bucket';
        const bad = await addObject();
        let m = await tiering.promote(bad.id, { reason: 'test' });
        fault.corruptPut = null;
        assert.deepStrictEqual([m.ok, m.outcome], [false, 'failed']);
        assert.ok(/does not match the sha256/.test(m.error), m.error);
        assert.ok(!buckets['r2-bucket'].has(`objects/live/${bad.id}`) && !await r2Row(bad.id), 'an R2 copy that does not verify is removed and never recorded');
        assert.ok((await last(bad.id)).error);
        fault.refusePut = 'r2-bucket';
        const refusedPut = await addObject();
        m = await tiering.promote(refusedPut.id, { reason: 'test' });
        fault.refusePut = null;
        assert.deepStrictEqual([m.outcome, !!await r2Row(refusedPut.id)], ['failed', false]);
        await db.run('DELETE FROM media_object_views_daily WHERE object_id != ?', [bad.id]);
        await setViews(bad.id, [[0, 700]]);
        s = await tiering.runSweep();
        assert.deepStrictEqual([s.skipped_backoff, s.promoted, (await decisions(bad.id)).length], [1, 0, 1], 'a failed object waits before the next try');

        const fromB2 = await addObject({ canonical: 'b2' });
        m = await tiering.promote(fromB2.id, { reason: 'test' });
        assert.strictEqual(m.outcome, 'done', JSON.stringify(m));
        assert.ok(buckets['r2-bucket'].get(`objects/live/${fromB2.id}`).equals(fromB2.bytes), 'a B2 canonical copy is copied to R2 under its key');
        assert.strictEqual((await last(fromB2.id)).from_provider, 'b2');
        assert.strictEqual((await tiering.promote(fromB2.id, { reason: 'again' })).outcome, 'already');
        console.log('✅ promotion copies the canonical copy, checks the R2 copy\'s size and sha256 before recording it; /o/:id then redirects to R2 with its own headers; failures leave nothing and back off');

        // ── 8. Demotion: idle or not ready; never the last good copy; holds; purge waits for it ──
        await db.run('DELETE FROM media_object_views_daily');
        await setViews(hot.id, [[-20, 900]]); await ageR2(hot.id, 20);                                // idle 20 days, in R2 20 days
        const fresh = await addObject(); await tiering.promote(fresh.id, { reason: 'test' });   // no viewer, but in R2 since now
        await setViews(web.id, [[0, 3]]); await ageR2(web.id, 20);                                    // viewed today
        const lost = await addObject(); await tiering.promote(lost.id, { reason: 'test' }); await ageR2(lost.id, 20);
        fs.unlinkSync(lost.file);                                                         // the canonical copy is gone: R2 is the last good copy
        const drifted = await addObject(); await tiering.promote(drifted.id, { reason: 'test' }); await ageR2(drifted.id, 20);
        const flipped = Buffer.from(drifted.bytes); flipped[0] ^= 0xff; fs.writeFileSync(drifted.file, flipped);
        const pinned = await addObject(); await tiering.promote(pinned.id, { reason: 'test' }); await ageR2(pinned.id, 20);
        const pin = await model.placeHold({ object_id: pinned.id, kind: 'creator_pin', reason: 'test' });
        const gone = await addObject(); await tiering.promote(gone.id, { reason: 'test' }); await setViews(gone.id, [[0, 900]]);
        await model.softDelete(await model.getObject(gone.id), { by: 'test' });
        const sticky = await addObject(); await tiering.promote(sticky.id, { reason: 'test' }); await ageR2(sticky.id, 20);
        fault.keepOnDelete = 'r2-bucket';
        // Only the sticky object sees the store keep its bytes: demote it on its own first.
        m = await tiering.demote(sticky.id, { reason: 'test' });
        fault.keepOnDelete = null;
        assert.deepStrictEqual([m.outcome, !!await r2Row(sticky.id)], ['failed', true]);
        assert.ok(/still there/.test(m.error));
        // Seven hours ago: past the back-off, so the sweep below tries again (and still within the 24-hour counts).
        await db.run("UPDATE media_object_tier_decisions SET decided_at = ov_now_iso('-7 hours') WHERE object_id = ? AND outcome = 'failed'", [sticky.id]);
        await require('../server/placement/storage-policy').set({ classes: { download: { maxDemotionsPerSweep: 20 } } }, { reason: 'test: room for every demotion' });
        s = await tiering.runSweep();
        assert.ok(!await r2Row(hot.id) && !buckets['r2-bucket'].has(`objects/live/${hot.id}`), 'an idle object leaves R2');
        assert.ok(fs.existsSync(hot.file) && (await db.get("SELECT state FROM media_locations WHERE object_id = ? AND provider = 'local'", [hot.id])).state === 'present');
        d = await last(hot.id);
        assert.deepStrictEqual([d.action, d.outcome, d.from_provider, d.to_provider], ['demote', 'done', 'r2', 'local']);
        assert.ok(/idle for demoteIdleDays 14/.test(d.reason), d.reason);
        assert.ok(await r2Row(fresh.id) && await r2Row(web.id), 'an object in R2 for less than demoteIdleDays, or viewed, stays');
        assert.ok(await r2Row(lost.id) && buckets['r2-bucket'].has(`objects/live/${lost.id}`), 'the last good copy is never removed');
        assert.deepStrictEqual([(await last(lost.id)).outcome, /the canonical local file is missing; the R2 copy is kept/.test((await last(lost.id)).reason)], ['refused', true]);
        assert.ok(await r2Row(drifted.id) && /does not match the sha256/.test((await last(drifted.id)).reason), 'nor one whose canonical copy no longer hashes right');
        assert.ok(await r2Row(pinned.id) && /retention hold/.test((await last(pinned.id)).reason), 'a hold blocks the demotion');
        assert.ok(!await r2Row(gone.id) && /the object is deleted/.test((await last(gone.id)).reason), 'a deleted object leaves R2 however popular');
        assert.ok(!await r2Row(cached.id), 'the month-idle copy from before goes too');
        assert.ok(!await r2Row(sticky.id), 'and the one the store kept once, now that it lets go');
        g = await get(`${base}/o/${lost.id}`);
        assert.strictEqual(g.status, 302, 'the object whose canonical copy is lost still plays from R2');
        g = await get(`${base}/o/${hot.id}`);
        assert.strictEqual(g.status, 200, 'a demoted object plays from its canonical copy again');
        await model.releaseHold(pin.id, 'test');

        const purged = await addObject(); await tiering.promote(purged.id, { reason: 'test' });
        await model.softDelete(await model.getObject(purged.id), { by: 'test' });
        await db.run("UPDATE media_objects SET deleted_at = datetime('now', '-40 days') WHERE id = ?", [purged.id]);
        await model.purgeExpired();
        assert.ok(fs.existsSync(purged.file) && await r2Row(purged.id), 'the purge waits while the object still has an R2 copy');
        await tiering.demote(purged.id, { trigger: 'sweep', reason: 'the object is deleted' });
        await model.purgeExpired();
        assert.ok(!fs.existsSync(purged.file) && !await r2Row(purged.id), 'and purges once the R2 copy is gone');
        console.log('✅ demotion: idle (and settled) or not ready; refused under a hold or when the canonical copy does not check out; a failed delete keeps the row; the purge waits for it');

        // ── 9. The decision log: admin API, metric, operator views ──
        const gamesObj = await addObject({ app: 'games' });
        await tiering.promote(gamesObj.id, { reason: 'games' });
        const cand = await addObject(); await setViews(cand.id, [[0, 800]]);
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
        assert.deepStrictEqual(a.body.snapshots.map((x) => x.state), ['active', 'superseded', 'superseded']);
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

        await db.run("INSERT INTO media_tier_decisions (vod_id, app_id, action, outcome, trigger, reason) VALUES (1, 'live', 'promote', 'done', 'admin', 'test') RETURNING id");
        const registry = require('openvibe-shared/metrics').createRegistry();
        require('../server/observability').domainMetrics(registry, { db, recorder: { activeCount: () => 0 }, events: { status: () => ({ enabled: false }) } });
        const text = await registry.metricsAsync();
        const all24 = await tiering.counts24h();
        assert.ok(text.includes(`media_tier_decisions_24h{target="object",action="promote",outcome="done"} ${all24.promote.done}`), text);
        assert.ok(text.includes(`media_tier_decisions_24h{target="object",action="promote",outcome="dry_run"} ${all24.promote.dry_run}`));
        assert.ok(text.includes('media_tier_decisions_24h{target="vod",action="promote",outcome="done"} 1'));

        const report = await require('../server/me/ops').report({ appId: 'live' });
        const no = report.tiering.native_objects;
        const liveR2 = (await db.get("SELECT COUNT(*) AS n FROM media_locations l JOIN media_objects o ON o.id = l.object_id WHERE l.provider = 'r2' AND l.state = 'present' AND o.app_id = 'live'")).n;
        assert.deepStrictEqual([no.gate.active, no.r2_copies.count, no.eligible_to_promote, no.decisions_24h.promote.done], [true, liveR2, 1, c24.promote.done]);
        assert.ok(no.recent.length && no.sweep.last_result && no.sweep.last_run_at);
        assert.ok(!/until roadmap WS-G task 11/.test(report.tiering.note));
        const html = require('../server/me/pages').renderOps({ person: { subject: 'usr_01J8Z3Q4X5Y6Z7A8B9C0D1E2F3' }, report, canRecompute: false });
        assert.ok(/Native objects/.test(html) && /Activation gate/.test(html) && html.includes(bad.id), 'the /me/ops page shows the gate and the recent decisions');
        console.log('✅ decisions: /tiers/objects/policy and /decisions (filters, pages, app-scoped), the config routes, media_tier_decisions_24h{target}, and the operator views');

        // ── 9b. Per-class budgets and residency come from media.storage_policy ──
        const sp = require('../server/placement/storage-policy');
        await db.run('DELETE FROM media_object_views_daily WHERE object_id != ?', [cand.id]);
        // vids[0] is the most viewed but nearly 1 MB; vids[1] has fewer viewers at 4 KB, so more value per dollar.
        const vids = [await addObject({ mime: 'video/mp4', size: 1000000 }), await addObject({ mime: 'video/mp4' })];
        const imgs = [await addObject({ mime: 'image/png' }), await addObject({ mime: 'image/png' })];
        const dl = await addObject();
        for (const o of [...vids, ...imgs, dl]) await setViews(o.id, [[0, o === vids[0] ? 950 : 900]]);
        const ranked = (await tiering.promotionCandidates(policy.settings())).filter((c) => c.class === 'video').map((c) => c.id);
        assert.deepStrictEqual(ranked, [vids[1].id, vids[0].id], 'ranked by value per dollar, not by viewers');
        await sp.set({ classes: { video: { maxPromotionsPerSweep: 1 }, image: { maxPromotionsPerSweep: 2, minResidencyMs: 86400000 }, download: { maxPromotionsPerSweep: 0 } } },
            { reason: 'test: per-class budgets' });
        s = await tiering.runSweep();
        const promotedOf = async (list) => (await Promise.all(list.map(async (o) => !!await r2Row(o.id)))).filter(Boolean).length;
        assert.deepStrictEqual([await promotedOf(vids), await promotedOf(imgs), await promotedOf([dl])], [1, 2, 0], 'each class spends its own promotion budget');
        assert.strictEqual((await decisions(dl.id)).length, 0, 'a class with a zero budget is not tried');
        assert.ok(await r2Row(vids[1].id) && !await r2Row(vids[0].id), "the video budget of 1 goes to the higher value per dollar");
        assert.strictEqual((await decisions(vids[0].id)).length, 0, 'the rest of the class waits for the next sweep');
        assert.strictEqual(JSON.parse((await last(imgs[0].id)).inputs).class, 'image');
        d = await last(vids[1].id);
        assert.strictEqual(JSON.parse(d.inputs).class, 'video');
        assert.ok(JSON.parse(d.inputs).value_per_dollar > 0, d.inputs);
        assert.ok(/; class video, value per dollar [0-9.e+]+, 1 of budget 1 \(maxPromotionsPerSweep, media\.storage_policy\)$/.test(d.reason), d.reason);
        // Residency: the images were just promoted, so an idle demotion is suppressed and logged as refused.
        await db.run('DELETE FROM media_object_views_daily WHERE object_id != ?', [cand.id]);
        for (const o of imgs) await ageR2(o.id, 30);
        s = await tiering.runSweep();
        assert.ok(await r2Row(imgs[0].id) && await r2Row(imgs[1].id), 'residency keeps the fresh copies');
        d = await last(imgs[0].id);
        assert.deepStrictEqual([d.action, d.outcome, JSON.parse(d.inputs).class], ['demote', 'refused', 'image']);
        assert.ok(/minimum residency of 86400000 ms for class image/.test(d.reason), d.reason);
        assert.ok(/idle for demoteIdleDays 14\).*; class image, value per dollar 0, 1 of budget 10 \(maxDemotionsPerSweep/.test(d.reason), d.reason);
        await sp.set({ classes: { image: { minResidencyMs: 0 }, download: { maxPromotionsPerSweep: 3 } } }, { reason: 'test: residency off, budgets back' });
        s = await tiering.runSweep();
        assert.ok(!await r2Row(imgs[0].id) && !await r2Row(imgs[1].id), 'with no residency the idle copies leave');
        console.log('✅ per-class budgets and residency from media.storage_policy; every decision row shows its class; a residency-suppressed demotion logs refused');

        // ── 9c. Every eligible object is scored, not only the 1,000 most viewed ──
        // 1,001 larger, more viewed videos would fill a most-viewed prefix; the small one is worth more per dollar.
        const crowd = [];
        for (let i = 0; i < 1001; i++) {
            const id = await model.createObject({ app_id: 'live', kind: 'file', visibility: 'public', lifecycle_status: 'ready', mime_type: 'video/mp4', size_bytes: 1000000 });
            await setViews(id, [[0, 900]]);
            crowd.push(id);
        }
        const small = await addObject({ mime: 'video/mp4' });
        await setViews(small.id, [[0, 500]]);
        const all = await tiering.promotionCandidates(policy.settings(), { limit: Infinity });
        assert.ok(all.length >= 1002, `every eligible object is ranked (${all.length})`);
        assert.strictEqual(all[0].id, small.id, 'the fewest viewers but the most value per dollar ranks first');
        assert.strictEqual((await tiering.promotionCandidates(policy.settings(), { limit: 1 }))[0].id, small.id, 'the limit applies after scoring');
        await db.run('DELETE FROM media_object_views_daily WHERE object_id != ?', [cand.id]);
        console.log('✅ promotion candidates are scored in full before the class budgets and limits apply');

        // ── 9d. Gate off: a move residency or a hold blocks is still logged (refused) and spends no slot ──
        await policy.set({ active: false }, { actor: { type: 'service', id: 'live' }, reason: 'test: gate off with blocked moves' });
        await sp.set({ classes: { video: { maxPromotionsPerSweep: 1, minResidencyMs: 86400000 } } }, { reason: 'test: video residency, budget 1' });
        const settling = await addObject({ mime: 'video/mp4' }); await setViews(settling.id, [[0, 900]]);      // the highest score, but moved an hour ago
        await db.run(`INSERT INTO media_object_tier_decisions (object_id, app_id, action, from_provider, to_provider, outcome, trigger, reason, inputs, thresholds)
                      VALUES (?, 'live', 'demote', 'r2', 'local', 'done', 'manual', 'test: a recent move', '{}', '{}')`, [settling.id]);
        const heldVid = await addObject({ mime: 'video/mp4' }); await setViews(heldVid.id, [[0, 800]]);
        const heldVidHold = await model.placeHold({ object_id: heldVid.id, kind: 'admin', reason: 'test' });
        const nextVid = await addObject({ mime: 'video/mp4', size: 100000 }); await setViews(nextVid.id, [[0, 700]]);
        assert.deepStrictEqual((await tiering.promotionCandidates(policy.settings())).filter((c) => c.class === 'video').map((c) => c.id),
            [settling.id, heldVid.id, nextVid.id], 'the blocked ones rank first');
        const before = Number((await db.get('SELECT MAX(id) AS id FROM media_object_tier_decisions')).id);
        s = await tiering.runSweep();
        const written = await db.all('SELECT object_id, action, outcome FROM media_object_tier_decisions WHERE id > ? ORDER BY id', [before]);
        assert.ok(written.some((r) => r.outcome === 'dry_run') && written.some((r) => r.outcome === 'refused'), `gate off logs proposals and refusals: ${JSON.stringify(written)}`);
        assert.deepStrictEqual([(await last(settling.id)).outcome, (await last(heldVid.id)).outcome], ['refused', 'refused'], 'a blocked move is logged');
        assert.deepStrictEqual([(await decisions(settling.id)).length, (await decisions(heldVid.id)).length], [2, 1]);
        d = await last(nextVid.id);
        assert.deepStrictEqual([d.action, d.outcome], ['promote', 'dry_run']);
        assert.ok(/, 1 of budget 1 \(maxPromotionsPerSweep/.test(d.reason), 'the blocked ones spent no slot, so the next in line has it: ' + d.reason);
        assert.ok(s.refused >= 2 && s.would_promote >= 1, JSON.stringify(s));
        const direct = await tiering.promote(heldVid.id, { reason: 'asked by hand' });
        assert.deepStrictEqual([direct.outcome, direct.logged, (await decisions(heldVid.id)).length], ['refused', undefined, 2], 'a direct call is answered and logged');
        await model.releaseHold(heldVidHold.id, 'test');
        await sp.set({ classes: { video: { maxPromotionsPerSweep: 3, minResidencyMs: 0 } } }, { reason: 'test: video back' });
        await policy.set({ active: true }, { actor: { type: 'service', id: 'live' }, reason: 'test: gate on again' });
        await db.run('DELETE FROM media_object_views_daily WHERE object_id != ?', [cand.id]);
        console.log('✅ gate off: residency- or hold-blocked moves are logged as refused and spend no slot');

        // ── 9e. Demand from Valkey (F2.5): hourly reads against each class's band; the daily counts when Valkey fails ──
        const demand = require('../server/placement/demand');
        const sweepWarns = [];
        const warn0 = console.warn;
        const vkReads = new Map();
        const mgets = [];
        let vkMode = 'up';
        demand.useValkey({ key: (...p) => 'ov:media:' + p.join(':'), client: {
            async mget(...keys) {
                mgets.push(keys.length);
                if (vkMode === 'down') throw new Error('ECONNREFUSED');
                if (vkMode === 'hung') return await new Promise(() => {});
                return keys.map((k) => (vkReads.has(k) ? String(vkReads.get(k)) : null));
            },
            async zrange() { return []; },
            async set() { return 'OK'; },
            async del() { return 1; },
        } });
        const setReads = (id, n) => vkReads.set(demand.counterKey(demand.region(), demand.bucketOf(Date.now()), id), n);
        const inR2 = async (o, days) => {
            buckets['r2-bucket'].set(`objects/live/${o.id}`, o.bytes);
            await model.upsertLocation(o.id, { provider: 'r2', bucket: 'r2-bucket', key: `objects/live/${o.id}`, storage_class: 'cache', state: 'present', size_bytes: o.bytes.length, checksum: o.sum, verified: true });
            await ageR2(o.id, days);
        };
        const candViews = await db.all('SELECT object_id, day, unique_viewers, last_viewed_at FROM media_object_views_daily WHERE object_id = ?', [cand.id]);
        await db.run('DELETE FROM media_object_views_daily');          // no daily counts: only Valkey can move anything
        const hotVid = await addObject({ mime: 'video/mp4' }); setReads(hotVid.id, 75);              // >= video promoteReadsPerHour 60
        const warmVid = await addObject({ mime: 'video/mp4' }); setReads(warmVid.id, 30);            // in the band: stays local
        const warmR2 = await addObject({ mime: 'video/mp4' }); setReads(warmR2.id, 30); await inR2(warmR2, 30);   // in the band: keeps R2
        const coldVid = await addObject({ mime: 'video/mp4' }); setReads(coldVid.id, 2); await inR2(coldVid, 30); // < video demoteReadsPerHour 6
        const sz = policy.settings();
        const scanned = Number((await db.get(`SELECT COUNT(*) AS n FROM media_objects o WHERE o.legacy_ref IS NULL AND o.lifecycle_status = 'ready' AND o.size_bytes >= ? AND o.size_bytes <= ?
            AND NOT EXISTS (SELECT 1 FROM media_locations l WHERE l.object_id = o.id AND l.provider = 'r2' AND l.state = 'present')
            AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.app_id = o.app_id AND a.env = 'sandbox')`, [Math.ceil(sz.promoteMinSizeMb * 1048576), Math.floor(sz.promoteMaxSizeMb * 1048576)])).n);
        const copies = Number((await db.get("SELECT COUNT(*) AS n FROM media_locations l JOIN media_objects o ON o.id = l.object_id WHERE l.provider = 'r2' AND o.legacy_ref IS NULL")).n);
        console.warn = (...a) => { sweepWarns.push(a.join(' ')); };
        s = await tiering.runSweep();
        console.warn = warn0;
        assert.deepStrictEqual([s.demand_source, s.demand_fallback], ['valkey', undefined], JSON.stringify(s));
        assert.ok(scanned > 1000, `the scan spans several pages (${scanned} objects)`);
        assert.strictEqual(mgets.length, Math.ceil(copies / 500) + Math.ceil(scanned / 500), `one MGET per page, never one per object: ${mgets}`);
        assert.ok(mgets.every((n) => n <= 500 * demand.WINDOW_BUCKETS), 'a page reads its objects\' hour of buckets in one MGET');
        assert.ok(!sweepWarns.some((w) => /PostgreSQL counts/.test(w)), sweepWarns.join('\n'));
        assert.ok(await r2Row(hotVid.id), 'hot in Valkey: promoted');
        d = await last(hotVid.id);
        assert.deepStrictEqual([d.action, d.outcome], ['promote', 'done']);
        assert.ok(/^75 reads in the last hour \(demand valkey, region local\) >= promoteReadsPerHour 60 \(class video\); .*1 of budget 3 \(maxPromotionsPerSweep/.test(d.reason), d.reason);
        assert.deepStrictEqual(JSON.parse(d.inputs).demand, { source: 'valkey', metric: 'reads_1h', value: 75, threshold: 60, region: 'local', window_s: 3600 });
        assert.ok(!await r2Row(coldVid.id), 'cold in Valkey: demoted');
        d = await last(coldVid.id);
        assert.deepStrictEqual([d.action, d.outcome], ['demote', 'done']);
        assert.ok(/^2 reads in the last hour \(demand valkey, region local\) < demoteReadsPerHour 6 \(class video\)/.test(d.reason), d.reason);
        assert.deepStrictEqual(JSON.parse(d.inputs).demand, { source: 'valkey', metric: 'reads_1h', value: 2, threshold: 6, region: 'local', window_s: 3600 });
        assert.ok(!await r2Row(warmVid.id) && await r2Row(warmR2.id), 'between the thresholds nothing moves (hysteresis)');
        assert.deepStrictEqual([(await decisions(warmVid.id)).length, (await decisions(warmR2.id)).length], [0, 0]);
        let mtext = await registry.metricsAsync();
        assert.ok(/media_sweep_demand_source_total\{source="valkey"\} 1\b/.test(mtext), mtext.split('\n').filter((l) => /demand_source/.test(l)).join('\n'));
        const pgSweeps = () => Number((/media_sweep_demand_source_total\{source="pg"\} (\d+)/.exec(mtext) || [])[1]);
        const pgBefore = pgSweeps();

        // Valkey refuses: the whole sweep reads the daily counts, exactly today's candidates and reasons, logged once.
        const pgHot = await addObject(); await setViews(pgHot.id, [[0, 900]]);
        const pgPromote = (await tiering.promotionCandidates(policy.settings(), { limit: 500, excludeSandbox: true })).map((c) => c.id);
        const pgDemote = (await tiering.demotionCandidates(policy.settings())).map((c) => c.row.id);
        assert.ok(pgPromote.includes(pgHot.id) && pgDemote.includes(warmR2.id), 'by the daily counts pgHot is popular and warmR2 idle');
        vkMode = 'down';
        mgets.length = 0;
        console.warn = (...a) => { sweepWarns.push(a.join(' ')); };
        s = await tiering.runSweep();
        console.warn = warn0;
        assert.deepStrictEqual([s.demand_source, s.demand_fallback], ['pg', 'Valkey read failed: ECONNREFUSED'], JSON.stringify(s));
        assert.strictEqual(mgets.length, 1, 'the first failed read ends the Valkey scan');
        assert.deepStrictEqual([s.candidates.promote, s.candidates.demote], [pgPromote.length, pgDemote.length], 'the same candidates as the daily counts give');
        assert.strictEqual(sweepWarns.filter((w) => /Sweep eligibility reads the daily PostgreSQL counts: Valkey read failed: ECONNREFUSED/.test(w)).length, 1, 'logged once per sweep');
        assert.ok(await r2Row(pgHot.id) && !await r2Row(warmR2.id), 'the daily counts decide: pgHot promoted, idle warmR2 demoted');
        d = await last(pgHot.id);
        assert.ok(/^900 unique viewers in 7 days >= promoteMinUniqueViewers7d 500/.test(d.reason), d.reason);
        assert.deepStrictEqual(JSON.parse(d.inputs).demand, { source: 'pg', metric: 'unique_viewers_7d', value: 900, threshold: 500 });
        d = await last(warmR2.id);
        assert.ok(/^no viewer since the kept counts began \(idle for demoteIdleDays 14\)/.test(d.reason), d.reason);
        assert.deepStrictEqual([JSON.parse(d.inputs).demand.source, JSON.parse(d.inputs).demand.metric], ['pg', 'last_viewed_day']);
        mtext = await registry.metricsAsync();
        assert.strictEqual(pgSweeps(), pgBefore + 1, 'counted as a pg sweep');

        // Valkey hangs: the read times out and the sweep still finishes on the daily counts.
        vkMode = 'hung';
        console.warn = () => {};
        const t0 = Date.now();
        s = await tiering.runSweep();
        console.warn = warn0;
        assert.deepStrictEqual([s.demand_source, s.demand_fallback], ['pg', 'Valkey read failed: valkey read timeout'], JSON.stringify(s));
        assert.ok(Date.now() - t0 < 10000, 'a stuck Valkey never stalls the sweep');
        demand.useValkey(null);
        s = await tiering.runSweep();
        assert.deepStrictEqual([s.demand_source, s.demand_fallback], ['pg', 'Valkey is not configured']);
        await db.run('DELETE FROM media_object_views_daily');
        for (const v of candViews) await db.run('INSERT INTO media_object_views_daily (object_id, day, unique_viewers, last_viewed_at) VALUES (?, ?, ?, ?)', [v.object_id, v.day, v.unique_viewers, v.last_viewed_at]);
        console.log('✅ demand from Valkey: hot promotes, cold demotes, the band holds; one MGET per page; a failed or stuck Valkey falls back to the daily counts for the whole sweep');

        // ── 9f. Constraints (F2.6): the provider class gate and each class's monthly R2 storage ceiling ──
        const providersMod = require('../server/placement/providers');
        const signals = require('../server/placement/signals');
        await db.run('DELETE FROM media_object_views_daily');
        await sp.set({ classes: { video: { maxPromotionsPerSweep: 1, maxDemotionsPerSweep: 500 } } }, { reason: 'test: video budget 1' });
        // R2's breaker is open: the best video is refused (its slot spent, so the next waits) and nothing moves.
        const gA = [await addObject({ mime: 'video/mp4' }), await addObject({ mime: 'video/mp4' })];
        await setViews(gA[0].id, [[0, 900]]); await setViews(gA[1].id, [[0, 800]]);
        signals.openBreaker('r2');
        s = await tiering.runSweep();
        signals.closeBreaker('r2');
        assert.ok(!await r2Row(gA[0].id) && !await r2Row(gA[1].id), 'no promotion while R2 is not eligible for online-hot');
        d = await last(gA[0].id);
        assert.deepStrictEqual([d.action, d.outcome], ['promote', 'refused']);
        assert.ok(/; refused: r2 is not eligible for online-hot: its circuit breaker is open \(provider class gate\)$/.test(d.reason), d.reason);
        assert.deepStrictEqual((({ provider, class: c, eligible, breaker }) => [provider, c, eligible, breaker])(JSON.parse(d.inputs).provider_gate), ['r2', 'online-hot', false, 'open']);
        assert.strictEqual((await decisions(gA[1].id)).length, 0, 'the refusal spent the class slot');
        assert.deepStrictEqual([s.constraints.promote_gate.eligible, s.constraints.refused.provider >= 1], [false, true], JSON.stringify(s.constraints));
        // A completed probe found a capability online-hot needs missing: refused the same way, naming it.
        for (const o of gA) await db.run('DELETE FROM media_object_views_daily WHERE object_id = ?', [o.id]);
        const gB = await addObject({ mime: 'video/mp4' }); await setViews(gB.id, [[0, 900]]);
        providersMod._setCapabilities('r2', { provider: 'r2', passed: true, capabilities: { range: true, range_206: false }, lastChecked: Date.now(), lastError: null });
        s = await tiering.runSweep();
        providersMod._setCapabilities('r2', { provider: 'r2', passed: null, capabilities: {}, lastChecked: null, lastError: null });
        d = await last(gB.id);
        assert.ok(!await r2Row(gB.id) && d.outcome === 'refused' && /r2 is not eligible for online-hot: the capability probe found range_206 missing/.test(d.reason), d.reason);
        assert.deepStrictEqual([JSON.parse(d.inputs).provider_gate.probe, JSON.parse(d.inputs).provider_gate.missing], ['failed', ['range_206']]);
        await db.run('DELETE FROM media_object_views_daily WHERE object_id = ?', [gB.id]);
        // A ready object's R2 copy stays while its canonical copy's provider (B2, online-canonical) is failing. The
        // refusal spends no demotion slot (the gate is per object): the smaller idle copy over a local canonical leaves.
        await sp.set({ classes: { video: { maxDemotionsPerSweep: 1 } } }, { reason: 'test: video demotion budget 1' });
        const gC = await addObject({ mime: 'video/mp4', canonical: 'b2' }); await inR2(gC, 30);
        const gL = await addObject({ mime: 'video/mp4', size: 2048 }); await inR2(gL, 30);
        signals.openBreaker('b2');
        s = await tiering.runSweep();
        signals.closeBreaker('b2');
        await sp.set({ classes: { video: { maxDemotionsPerSweep: 500 } } }, { reason: 'test: video demotion budget back' });
        assert.ok(!await r2Row(gL.id), 'a demotion refused by its own canonical provider leaves the slot to the next in line');
        d = await last(gC.id);
        assert.ok(await r2Row(gC.id), 'the R2 copy is kept while B2 is not eligible');
        assert.deepStrictEqual([d.action, d.outcome], ['demote', 'refused']);
        assert.ok(/; refused: b2 is not eligible for online-canonical: its circuit breaker is open \(provider class gate\); the R2 copy is kept$/.test(d.reason), d.reason);
        assert.deepStrictEqual([JSON.parse(d.inputs).provider_gate.provider, JSON.parse(d.inputs).provider_gate.eligible], ['b2', false]);
        // A corrupt R2 copy was never counted in the class's spend, so demoting it subtracts nothing.
        const gX = await addObject({ mime: 'video/mp4' }); await inR2(gX, 30);
        await db.run("UPDATE media_locations SET state = 'corrupt' WHERE object_id = ? AND provider = 'r2'", [gX.id]);
        s = await tiering.runSweep();
        assert.ok(!await r2Row(gC.id), 'B2 eligible again: the idle copy leaves');
        assert.ok(!await r2Row(gX.id), 'the corrupt copy leaves');
        assert.ok(Math.abs(s.constraints.hot_usd_per_month.video.spend - (await tiering.hotSpend()).video) < 1e-12, JSON.stringify(s.constraints));
        assert.deepStrictEqual(Object.keys(s.constraints.hot_usd_per_month).sort(), [...sp.CLASSES].sort(), 'every class is reported');
        assert.deepStrictEqual(JSON.parse((await last(gC.id)).inputs).provider_gate, { provider: 'b2', class: 'online-canonical', eligible: true, breaker: 'closed', probe: 'pending' });
        // The ceiling: room for one more 4 KB video copy; the first in line takes it, the next is refused and closes the class.
        const spend0 = (await tiering.hotSpend()).video;
        const one = tiering.hotUsdPerMonth(4096);
        assert.ok(one > 0 && Math.abs(one - 4096 / 1073741824 * 0.015) < 1e-15, `R2 Standard list price of 4 KB a month: ${one}`);
        const ceiling = spend0 + one * 1.5;
        await sp.set({ classes: { video: { maxPromotionsPerSweep: 3, maxHotUsdPerMonth: ceiling } } }, { reason: 'test: a video storage ceiling' });
        const gD = [await addObject({ mime: 'video/mp4' }), await addObject({ mime: 'video/mp4' }), await addObject({ mime: 'video/mp4' })];
        await setViews(gD[0].id, [[0, 900]]); await setViews(gD[1].id, [[0, 800]]); await setViews(gD[2].id, [[0, 700]]);
        s = await tiering.runSweep();
        assert.deepStrictEqual([!!await r2Row(gD[0].id), !!await r2Row(gD[1].id), !!await r2Row(gD[2].id)], [true, false, false], 'one copy fits under the ceiling');
        assert.deepStrictEqual(JSON.parse((await last(gD[0].id)).inputs).budget, { class: 'video', usd_per_month: spend0, copy_usd_per_month: one, ceiling });
        d = await last(gD[1].id);
        assert.deepStrictEqual([d.action, d.outcome], ['promote', 'refused']);
        assert.ok(/; refused: class video R2 storage would reach \$[0-9.e-]+\/month \(\$[0-9.e-]+ now \+ \$[0-9.e-]+ for this copy\) > maxHotUsdPerMonth \$[0-9.e-]+ \(media\.storage_policy\); the class promotes nothing more this sweep$/.test(d.reason), d.reason);
        assert.strictEqual((await decisions(gD[2].id)).length, 0, 'a cheaper lower-ranked object does not jump the queue: the class is closed');
        assert.strictEqual(s.constraints.refused.budget, 1);
        assert.ok(Math.abs(s.constraints.hot_usd_per_month.video.spend - (spend0 + one)) < 1e-12 && s.constraints.hot_usd_per_month.video.ceiling === ceiling, JSON.stringify(s.constraints));
        assert.strictEqual(s.constraints.hot_usd_per_month.video.projected, s.constraints.hot_usd_per_month.video.spend, 'with the gate on, projected is actual');
        // Gate off: a dry run holds the ceiling against the projected spend (what it would move) and leaves the actual spend alone.
        await policy.set({ active: false }, { actor: { type: 'service', id: 'live' }, reason: 'test: gate off under a ceiling' });
        const spend1 = (await tiering.hotSpend()).video;
        await sp.set({ classes: { video: { maxHotUsdPerMonth: spend1 + one * 1.5 } } }, { reason: 'test: a video storage ceiling, dry run' });
        const gE = [await addObject({ mime: 'video/mp4' }), await addObject({ mime: 'video/mp4' }), await addObject({ mime: 'video/mp4' })];
        await setViews(gE[0].id, [[0, 990]]); await setViews(gE[1].id, [[0, 980]]); await setViews(gE[2].id, [[0, 970]]);
        s = await tiering.runSweep();
        assert.strictEqual(s.would_demote, 0, JSON.stringify(s));
        assert.ok(!await r2Row(gE[0].id) && !await r2Row(gE[1].id), 'a dry run moves nothing');
        const e0 = await last(gE[0].id), e1 = await last(gE[1].id);
        assert.deepStrictEqual([e0.outcome, e1.outcome], ['dry_run', 'refused']);
        assert.ok(/maxHotUsdPerMonth/.test(e1.reason), e1.reason);
        assert.ok(Math.abs(JSON.parse(e1.inputs).budget.usd_per_month - (JSON.parse(e0.inputs).budget.usd_per_month + one)) < 1e-12, e1.inputs);
        assert.strictEqual((await decisions(gE[2].id)).length, 0, 'the projected spend closed the class');
        const hv = s.constraints.hot_usd_per_month.video;
        assert.ok(Math.abs(hv.spend - spend1) < 1e-12 && Math.abs(hv.spend - (await tiering.hotSpend()).video) < 1e-12, `a dry run spends nothing: ${JSON.stringify(hv)}`);
        assert.ok(Math.abs(hv.projected - (spend1 + one)) < 1e-12, `the projected spend counts the dry run: ${JSON.stringify(hv)}`);
        // A second dry-run sweep the same day logs nothing new but still counts the repeated dry run, so the ceiling holds as before.
        s = await tiering.runSweep();
        assert.deepStrictEqual([(await decisions(gE[0].id)).length, (await decisions(gE[1].id)).length, (await decisions(gE[2].id)).length], [1, 1, 0], JSON.stringify(s));
        assert.strictEqual((await last(gE[1].id)).outcome, 'refused', 'a repeated dry run still closes the class: the next candidate is refused again, not proposed');
        const hv2 = s.constraints.hot_usd_per_month.video;
        assert.ok(Math.abs(hv2.projected - (spend1 + one)) < 1e-12 && Math.abs(hv2.spend - spend1) < 1e-12, `the repeat counts in projected: ${JSON.stringify(hv2)}`);
        // A dry-run demotion frees projected cost only when a live one could run: here the canonical file is gone, so it is refused.
        const lostCanon = await addObject({ mime: 'video/mp4' });
        buckets['r2-bucket'].set(`objects/live/${lostCanon.id}`, lostCanon.bytes);
        await model.upsertLocation(lostCanon.id, { provider: 'r2', bucket: 'r2-bucket', key: `objects/live/${lostCanon.id}`, storage_class: 'cache', state: 'present', size_bytes: 4096, checksum: lostCanon.sum, verified: true });
        await ageR2(lostCanon.id, 30);
        fs.unlinkSync(lostCanon.file);
        const goodCanon = await addObject({ mime: 'video/mp4' });
        buckets['r2-bucket'].set(`objects/live/${goodCanon.id}`, goodCanon.bytes);
        await model.upsertLocation(goodCanon.id, { provider: 'r2', bucket: 'r2-bucket', key: `objects/live/${goodCanon.id}`, storage_class: 'cache', state: 'present', size_bytes: 4096, checksum: goodCanon.sum, verified: true });
        await ageR2(goodCanon.id, 30);
        s = await tiering.runSweep();
        assert.strictEqual((await last(lostCanon.id)).outcome, 'refused');
        assert.ok(/the canonical local file is missing; the R2 copy is kept/.test((await last(lostCanon.id)).reason), (await last(lostCanon.id)).reason);
        assert.strictEqual((await last(goodCanon.id)).outcome, 'dry_run');
        const hv3 = s.constraints.hot_usd_per_month.video, freed = tiering.hotUsdPerMonth(4096);
        assert.ok(Math.abs(hv3.spend - (spend1 + 2 * freed)) < 1e-12, JSON.stringify(hv3));
        // (the two extra R2 copies now fill the ceiling, so the held-over promotion is refused and adds nothing)
        assert.ok(Math.abs(hv3.projected - (hv3.spend - freed)) < 1e-12, `only the demotion a live sweep could make frees projected cost: ${JSON.stringify(hv3)}`);
        await db.run("DELETE FROM media_object_tier_decisions WHERE object_id = ? AND outcome = 'refused'", [gE[0].id]);   // the zero-ceiling refusal below is logged afresh
        // A zero ceiling closes the class even at a zero R2 price (where every copy would cost $0 and fit any ceiling).
        await policy.set({ active: true }, { actor: { type: 'service', id: 'live' }, reason: 'test: gate on' });
        const ct = require('../server/placement/cost-tiers');
        await ct.init();
        const prices = ct.settings();
        await ct.get().apply({ ...prices, r2: { ...prices.r2, standard: { ...prices.r2.standard, storagePerGbMonth: 0 }, infrequentAccess: { ...prices.r2.infrequentAccess, storagePerGbMonth: 0 } } }, { reason: 'test: free R2 storage' });
        await sp.set({ classes: { video: { maxHotUsdPerMonth: 0 } } }, { reason: 'test: a zero video ceiling' });
        assert.strictEqual(tiering.hotUsdPerMonth(4096), 0);
        s = await tiering.runSweep();
        await ct.get().apply(prices, { reason: 'test: R2 price back' });
        assert.ok(!await r2Row(gE[0].id) && !await r2Row(gE[1].id), 'a zero ceiling promotes nothing');
        d = await last(gE[0].id);
        assert.deepStrictEqual([d.action, d.outcome], ['promote', 'refused']);
        assert.ok(/; refused: class video has maxHotUsdPerMonth \$0 \(media\.storage_policy\): it never promotes; the class promotes nothing more this sweep$/.test(d.reason), d.reason);
        assert.deepStrictEqual([s.constraints.refused.budget, s.constraints.hot_usd_per_month.video.ceiling], [1, 0], JSON.stringify(s.constraints));
        console.log('✅ ceiling: a dry run projects its spend without spending; a zero ceiling closes the class at any price');
        await sp.set({ classes: { video: { maxHotUsdPerMonth: 1e9, maxDemotionsPerSweep: 10 } } }, { reason: 'test: no video ceiling' });
        await db.run('DELETE FROM media_object_views_daily');
        for (const v of candViews) await db.run('INSERT INTO media_object_views_daily (object_id, day, unique_viewers, last_viewed_at) VALUES (?, ?, ?, ?)', [v.object_id, v.day, v.unique_viewers, v.last_viewed_at]);
        console.log('✅ constraints: a provider failing its class (breaker or probe) refuses the move and keeps every copy; the monthly R2 storage ceiling closes a class in value order');

        // ── 10. The storage sweep runs it (step 4); a restore drill never does ──
        const vodSweep = await storage.runSweep();
        assert.ok(vodSweep.objects && vodSweep.objects.gate === true && typeof vodSweep.objects.promoted === 'number', JSON.stringify(vodSweep));
        assert.strictEqual(await r2Row(cand.id) && (await r2Row(cand.id)).state, 'present', 'the storage sweep promoted the candidate');
        // The storage engine's upload is exported (the scheduled verification's default re-upload calls it too).
        assert.deepStrictEqual(['uploadFile', 'copyBetweenProviders', 'sha256Object', 'providerAvailable'].map((f) => typeof storage[f]), ['function', 'function', 'function', 'function']);
        const drill = require('../server/drill');
        drill.enabled = true;
        assert.deepStrictEqual(await tiering.runSweep(), { skipped: true, reason: 'restore drill (MEDIA_DRILL)' });
        drill.enabled = false;
        console.log('✅ the storage sweep runs the object tiering as its step 4; under MEDIA_DRILL it does nothing');

        server.close();
        s3.close();
        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('\n✅ All object tiering tests passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
