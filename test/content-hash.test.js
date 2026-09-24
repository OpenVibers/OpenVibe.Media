'use strict';
// object.hash (server/jobs/content-hash.js): ready objects with a present local copy and no hash get
// sha256 on the object (content_hash + metadata.hash_basis) and on the local location (checksum), in
// bounded batches (count and bytes); files still changing or of another size than the object are
// skipped; a re-projection that finds the local file changed drops the job's hash (a remux never
// leaves a stale one) while a move to B2 keeps it; scheduled copy verification then checks against it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-hash-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
    MEDIA_INVARIANT_SCAN_HOURS: '0', MEDIA_HASH_SETTLE_S: '60', MEDIA_HASH_INTERVAL_MIN: '15',
});

const db = require('../server/db/database');
const model = require('../server/objects/model');
const queue = require('../server/jobs/queue');
const worker = require('../server/jobs/worker');
const hashJob = require('../server/jobs/content-hash');
const verify = require('../server/objects/verify-job');

db.upsertApp({ app_id: 'live', api_key: 'live-key' });
db.upsertApp({ app_id: 'games', api_key: 'games-key' });

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const age = (file, s = 3600) => { const t = (Date.now() - s * 1000) / 1000; fs.utimesSync(file, t, t); };
function vodWith(name, bytes, { app = 'live', old = true } = {}) {
    const file = path.join(process.env.VOD_PATH, name);
    fs.writeFileSync(file, bytes);
    if (old) age(file);
    const id = Number(db.run(`INSERT INTO vods (app_id, title, file_path, file_size, duration_seconds, is_public, visibility, health_status) VALUES (?, 't', ?, ?, 60, 1, 'public', 'ok')`,
        [app, file, bytes.length]).lastInsertRowid);
    model.sync('vod', id);
    return { id, file, obj: () => model.getObject(db.get('SELECT object_id FROM vods WHERE id = ?', [id]).object_id) };
}
const localLoc = (objId) => db.get("SELECT * FROM media_locations WHERE object_id = ? AND provider = 'local'", [objId]);

(async () => {
    const a = vodWith('a.mp4', Buffer.alloc(300000, 1));
    const b = vodWith('b.mp4', Buffer.alloc(200000, 2));
    const fresh = vodWith('fresh.mp4', Buffer.alloc(1000, 3), { old: false });
    const other = vodWith('other.mp4', Buffer.alloc(5000, 4));
    db.run('UPDATE media_objects SET size_bytes = 999 WHERE id = ?', [other.obj().id]);   // the local copy is another version
    const games = vodWith('g.mp4', Buffer.alloc(4000, 5), { app: 'games' });
    assert.strictEqual(a.obj().content_hash, null);
    const before = hashJob.remaining('live');
    assert.strictEqual(before, 4);

    // ── 1. A batch hashes local copies onto the object and the location, and skips what it must ──
    const r = await hashJob.hashBatch({ appId: 'live' });
    assert.deepStrictEqual([r.hashed, r.bytes], [2, 500000]);
    assert.deepStrictEqual(r.skipped, { recently_changed: 1, size_differs_from_object: 1 });
    assert.strictEqual(r.remaining, 2);
    const oa = a.obj();
    assert.strictEqual(oa.content_hash, sha(fs.readFileSync(a.file)));
    assert.strictEqual(localLoc(oa.id).checksum, oa.content_hash, 'the location carries it too');
    assert.ok(localLoc(oa.id).verified_at);
    assert.deepStrictEqual([JSON.parse(oa.metadata).hash_basis.key, JSON.parse(oa.metadata).hash_basis.size], [path.resolve(a.file), 300000]);
    assert.strictEqual(games.obj().content_hash, null, 'one tenant per run');
    console.log('✅ sha256 of local copies recorded on object and location; changing files and other versions skipped');

    // ── 2. Bounded by bytes: a run stops at its budget (the first file always fits), the next continues ──
    const big1 = vodWith('big1.mp4', Buffer.alloc(3 * 1048576, 6));
    const big2 = vodWith('big2.mp4', Buffer.alloc(3 * 1048576, 7));
    const r2 = await hashJob.hashBatch({ appId: 'live', budgetMb: 4 });
    assert.deepStrictEqual([r2.hashed, r2.skipped.budget], [1, 1]);
    assert.strictEqual([big1, big2].filter(v => v.obj().content_hash).length, 1, 'one of the two 3 MB files fits a 4 MB budget');
    const r3 = await hashJob.hashBatch({ appId: 'live', budgetMb: 4 });
    assert.strictEqual(r3.hashed, 1);
    assert.ok(big1.obj().content_hash && big2.obj().content_hash, 'the next run takes the other');
    const r4 = await hashJob.hashBatch({ appId: 'live', limit: 1 });
    assert.strictEqual(r4.hashed + Object.values(r4.skipped).reduce((x, y) => x + y, 0), 1, 'limit bounds the count');
    console.log('✅ bounded batches: object count and byte budget');

    // ── 3. A changed local file drops the job's hash on re-projection; a move to B2 keeps it ──
    fs.appendFileSync(b.file, Buffer.alloc(1000, 9));                  // a remux in place: new size
    db.run('UPDATE vods SET file_size = ? WHERE id = ?', [201000, b.id]);
    model.sync('vod', b.id);
    const ob = b.obj();
    assert.strictEqual(ob.content_hash, null, 'stale hash dropped');
    assert.strictEqual(localLoc(ob.id).checksum, null);
    assert.strictEqual(JSON.parse(ob.metadata).hash_basis, undefined);
    age(b.file);
    await hashJob.hashBatch({ appId: 'live', objectId: ob.id });
    assert.strictEqual(b.obj().content_hash, sha(fs.readFileSync(b.file)), 'hashed again from the new bytes');
    const kept = oa.content_hash;
    fs.unlinkSync(a.file);                                             // offloaded: local copy gone, B2 canonical
    db.run("UPDATE vods SET storage_provider = 'b2', storage_key = 'vods/a.mp4' WHERE id = ?", [a.id]);
    model.sync('vod', a.id);
    assert.strictEqual(a.obj().content_hash, kept, 'the bytes moved; the hash stays');
    console.log('✅ a remuxed local file loses the stale hash (and is re-hashed); a move to B2 keeps it');

    // ── 4. Verification uses it: a corrupted local copy of the same size is caught ──
    const c = vodWith('c.mp4', Buffer.alloc(100000, 8));
    await hashJob.hashBatch({ appId: 'live', objectId: c.obj().id });
    const good = await verify.verifyObject(c.obj(), { head: async () => undefined, upload: async () => undefined, hashMaxBytes: 64 * 1048576, repairCorrupt: false, budget: { left: 0 } });
    assert.strictEqual(good.locations.find(l => l.provider === 'local').state, 'present');
    const fd = fs.openSync(c.file, 'r+'); fs.writeSync(fd, Buffer.from([0]), 0, 1, 500); fs.closeSync(fd);
    const bad = await verify.verifyObject(c.obj(), { head: async () => undefined, upload: async () => undefined, hashMaxBytes: 64 * 1048576, repairCorrupt: false, budget: { left: 0 } });
    assert.strictEqual(bad.locations.find(l => l.provider === 'local').state, 'corrupt', 'bit rot of the same size is now visible');
    console.log('✅ scheduled verification checks local copies against the recorded hash');

    // ── 5. As a job: scheduled per tenant with work, run through the worker, pruned like thumbnails ──
    assert.throws(() => hashJob.spec.validate({ obj: null, params: { limit: 0 } }), /limit/);
    const n = hashJob.schedule(Date.now());
    assert.strictEqual(n, 2, 'one per tenant with unhashed local copies (live, games)');
    assert.strictEqual(hashJob.schedule(Date.now()), 0, 'once per period');
    const gj = queue.list('games', { type: 'object.hash' }).jobs[0];
    const done = await worker.runNow(gj.id);
    assert.strictEqual(done.status, 'succeeded');
    assert.strictEqual(JSON.parse(done.result).hashed, 1);
    assert.ok(games.obj().content_hash);
    db.run("UPDATE media_jobs SET finished_at = datetime('now', '-40 days') WHERE id = ?", [gj.id]);
    assert.strictEqual(queue.prune({ days: 30 }), 1, 'finished hash jobs are pruned');
    console.log('✅ object.hash runs as a scheduled job per tenant and is pruned when finished');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All content-hash tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
