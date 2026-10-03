'use strict';
// Demand rollups (F2.4): reads per object × region × 5-minute bucket, on Valkey or in this process; hotness over
// the window; media.object.hot staged once per object per hour; a Valkey failure never touches the read path.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-placement-demand-'));
    const dir = (name) => { const p = path.join(tmp, name); fs.mkdirSync(p, { recursive: true }); return p; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
    });
    const demand = require('../server/placement/demand');
    const router = require('../server/placement/router');
    const B = demand.BUCKET_MS;
    const T0 = 1_800_000_000_000;                 // a fixed instant, the start of a bucket
    assert.strictEqual(T0 % B, 0);

    // 1. Bucket math and key layout (in-process: no Valkey handle).
    assert.strictEqual(B, 300000);
    assert.strictEqual(demand.bucketOf(T0), T0 / B);
    assert.strictEqual(demand.bucketOf(T0 + B - 1), T0 / B);
    assert.strictEqual(demand.bucketOf(T0 + B), T0 / B + 1);
    assert.strictEqual(demand.region(), 'local');
    assert.strictEqual(demand.counterKey('local', 7, 'obj-a'), 'demand:local:7:obj-a');
    assert.strictEqual(demand.hotKey('local', 7), 'hot:local:7');
    assert.strictEqual(demand.KEY_TTL_S, 7200);
    assert.ok(demand.KEY_TTL_S * 1000 > demand.WINDOW_BUCKETS * B, 'a key outlives the window it is read in');
    console.log('✅ bucket math and key layout');

    // 2. hotness() sums across the window's buckets; a bucket older than the window is out; top() orders.
    demand._reset();
    for (let i = 0; i < 3; i++) demand.record({ objectId: 'obj-a', now: T0 });
    demand.record({ objectId: 'obj-a', now: T0 - 4 * B });                         // an earlier bucket, inside the hour
    demand.record({ objectId: 'obj-b', now: T0 + 1000 });
    demand.record({ objectId: 'obj-c', now: T0 - demand.WINDOW_BUCKETS * B });     // 13th bucket back: outside
    demand.record({ objectId: 'obj-a', region: 'eu', now: T0 });                   // another region
    let heat = await demand.hotness({ now: T0 + 2000 });
    assert.deepStrictEqual([...heat].sort(), [['obj-a', 4], ['obj-b', 1]]);
    assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ now: T0, objectIds: ['obj-a', 'obj-c', 'obj-z'] })), { 'obj-a': 4, 'obj-c': 0, 'obj-z': 0 });
    assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ now: T0, buckets: 1 })), { 'obj-a': 3, 'obj-b': 1 });
    assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ region: 'eu', now: T0 })), { 'obj-a': 1 });
    assert.deepStrictEqual(await demand.top({ now: T0 }), [{ object_id: 'obj-a', reads: 3 }, { object_id: 'obj-b', reads: 1 }]);
    // Past the TTL, the in-process counters are gone as Valkey's would be.
    assert.strictEqual((await demand.hotness({ now: T0 + demand.KEY_TTL_S * 1000 + B, buckets: 100 })).size, 0);
    console.log('✅ hotness() sums the window per object and region; top() orders the bucket; TTL expires counts');

    // 3. On Valkey: the exact keys inside the service prefix, and a TTL set once per key.
    const calls = [];
    const store = new Map(), zsets = new Map(), ttls = new Map();
    const fake = {
        prefix: 'ov:media:',
        key: (...parts) => 'ov:media:' + parts.join(':'),
        client: {
            async incr(k) { calls.push(['incr', k]); store.set(k, (Number(store.get(k)) || 0) + 1); return store.get(k); },
            async expire(k, s) { calls.push(['expire', k, s]); ttls.set(k, s); return 1; },
            async zincrby(k, by, m) { calls.push(['zincrby', k, by, m]); const z = zsets.get(k) || new Map(); z.set(m, (z.get(m) || 0) + by); zsets.set(k, z); return String(z.get(m)); },
            async zrange(k, start, stop, ws) { assert.deepStrictEqual([start, stop, ws], [0, -1, 'WITHSCORES']); return [...(zsets.get(k) || new Map())].flatMap(([m, n]) => [m, String(n)]); },
            async mget(...keys) { return keys.map((k) => (store.has(k) ? String(store.get(k)) : null)); },
            async set(k, v, ex, s, nx) { assert.deepStrictEqual([ex, s, nx], ['EX', demand.ANNOUNCE_S, 'NX']); if (store.has(k)) return null; store.set(k, v); ttls.set(k, s); return 'OK'; },
            async del(k) { store.delete(k); return 1; },
        },
    };
    demand.useValkey(fake);
    const b = demand.bucketOf(T0);
    demand.record({ objectId: 'obj-a', now: T0 });
    demand.record({ objectId: 'obj-a', now: T0 });
    demand.record({ objectId: 'obj-b', now: T0 - B });
    await new Promise((resolve) => setImmediate(resolve));
    const ck = `ov:media:demand:local:${b}:obj-a`, hk = `ov:media:hot:local:${b}`;
    assert.strictEqual(store.get(ck), 2);
    assert.deepStrictEqual([...zsets.get(hk)], [['obj-a', 2]]);
    assert.strictEqual(ttls.get(ck), 7200);
    assert.strictEqual(ttls.get(hk), 7200);
    assert.strictEqual(ttls.get(`ov:media:hot:local:${b - 1}`), 7200);
    assert.strictEqual(calls.filter((c) => c[0] === 'expire' && c[1] === ck).length, 1, 'TTL set on the first hit only');
    assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ now: T0 })), { 'obj-a': 2, 'obj-b': 1 });
    assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ now: T0, objectIds: ['obj-a', 'obj-b'] })), { 'obj-a': 2, 'obj-b': 1 });
    console.log('✅ Valkey keys ov:media:demand:<region>:<bucket>:<id> and ov:media:hot:<region>:<bucket>, TTL 7200 s');

    // 4. The router records one hit per served viewer read; none for a derive job or when nothing is served.
    const file = path.join(tmp, 'objects', 'obj-r');
    fs.writeFileSync(file, 'bytes');
    const served = { id: 'obj-r', locations: [{ provider: 'local', state: 'present', key: file }] };
    store.clear(); zsets.clear(); calls.length = 0;
    let decision = await router.route({ object: served, purpose: 'playback' });
    assert.strictEqual(decision.provider, 'local');
    await router.route({ vod: { id: 9, object_id: 'obj-v' }, locations: served.locations, purpose: 'download' });
    await router.route({ object: served, purpose: 'derive' });
    await router.route({ object: { id: 'obj-none', locations: [] }, purpose: 'playback' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'incr').map((c) => c[1]).map((k) => k.split(':').pop()), ['obj-r', 'obj-v']);
    console.log('✅ router: one demand hit per served playback/download, none for derive or no copy');

    // 5. A failing Valkey (rejecting, throwing, hanging) leaves the read path untouched.
    const unhandled = [];
    process.on('unhandledRejection', (err) => unhandled.push(err));
    const broken = {
        key: fake.key,
        client: {
            incr: () => Promise.reject(new Error('ECONNREFUSED')),
            zincrby: () => { throw new Error('socket closed'); },
            mget: () => Promise.reject(new Error('ECONNREFUSED')),
            zrange: () => new Promise(() => {}),             // never answers
        },
    };
    demand.useValkey(broken);
    const before = Date.now();
    decision = await router.route({ object: served, purpose: 'playback' });
    assert.strictEqual(decision.provider, 'local');
    assert.strictEqual(decision.key, file);
    assert.doesNotThrow(() => demand.record({ objectId: 'obj-a' }));
    assert.doesNotThrow(() => demand.record({ objectId: null }));
    assert.doesNotThrow(() => demand.record());
    assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ objectIds: ['obj-a'] })), { 'obj-a': 0 });
    assert.strictEqual((await demand.hotness()).size, 0);            // the hung read times out
    assert.ok(Date.now() - before < 5000);
    assert.strictEqual((await demand.rollup()).announced, 0);
    // strict (the tiering sweep): a failure throws instead of answering zeros, so the caller can fall back.
    assert.strictEqual(demand.available(), true);
    await assert.rejects(demand.hotness({ objectIds: ['obj-a'], strict: true }), /ECONNREFUSED/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(unhandled, []);
    console.log('✅ a Valkey failure never throws into a read; reads answer no demand; a strict read throws');

    // 6. rollup(): media.object.hot through the placement outbox, at most once per object per hour.
    demand.useValkey(null);
    demand._reset();
    assert.strictEqual(demand.available(), false);
    await assert.rejects(demand.hotness({ objectIds: ['obj-a'], strict: true }), /Valkey is not configured/);
    const stub = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
            res.statusCode = 503; res.end('{}');          // keep every envelope in the outbox for inspection
        });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const events = require('../server/events');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-placement-demand' });
    const addObject = async () => model.createObject({ app_id: 'live', kind: 'file', visibility: 'public', lifecycle_status: 'ready',
        mime_type: 'video/mp4', size_bytes: 5, content_hash: crypto.randomBytes(32).toString('hex'), canonical_provider: 'local' });
    const hotId = String(await addObject()), coolId = String(await addObject());
    assert.ok(events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 3600000 }));
    const hotRows = async () => (await db.getDb().prepare('SELECT envelope FROM event_outbox ORDER BY id').all())
        .map((row) => (typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope))
        .filter((e) => e.event_type === 'media.object.hot');

    const now = Date.now();
    for (let i = 0; i < demand.HOT_READS; i++) demand.record({ objectId: hotId, now: now - (i % 6) * B });
    for (let i = 0; i < 5; i++) demand.record({ objectId: coolId, now });
    demand.record({ objectId: 'gone-object', now });
    let r = await demand.rollup({ now, threshold: demand.HOT_READS });
    assert.deepStrictEqual(r, { region: 'local', window_s: 3600, threshold: 100, objects: 3, hot: 1, announced: 1 });
    let rows = await hotRows();
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].subject, { type: 'object', id: hotId });
    assert.deepStrictEqual(Object.keys(rows[0].payload).sort(), ['app_id', 'bucket', 'object_id', 'reads', 'region', 'since', 'threshold', 'window_s']);
    assert.deepStrictEqual([rows[0].payload.object_id, rows[0].payload.app_id, rows[0].payload.region, rows[0].payload.reads], [hotId, 'live', 'local', 100]);
    // Still hot later in the same hour: not announced again.
    for (let i = 0; i < 50; i++) demand.record({ objectId: hotId, now: now + 20 * 60 * 1000 });
    r = await demand.rollup({ now: now + 20 * 60 * 1000 });
    assert.strictEqual(r.announced, 0);
    assert.strictEqual((await hotRows()).length, 1);
    // An hour after the first announcement, still hot: announced once more.
    for (let i = 0; i < demand.HOT_READS; i++) demand.record({ objectId: hotId, now: now + 61 * 60 * 1000 });
    r = await demand.rollup({ now: now + 61 * 60 * 1000 });
    assert.strictEqual(r.announced, 1);
    assert.strictEqual((await hotRows()).length, 2);
    console.log('✅ rollup(): media.object.hot for objects over the threshold, once per object per hour');

    events._reset();
    stub.close();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('placement-demand: all six cases passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
