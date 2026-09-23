'use strict';
// Reconciliation of the object model against the bytes, with a fake B2/R2 provider: read-only by
// default, --verify records what the HEADs found; it detects missing canonical copies, lost local
// files, size/hash mismatches, orphan locations, deleted-but-still-served objects and unprojected
// rows. Plus the three scripts end to end (backfill --dry-run, reconcile, invariant).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-reconcile-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const env = {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
    MEDIA_PUBLIC_OBJECT_TARGET_MB: '1', MEDIA_PUBLIC_OBJECT_WARN_MB: '2', MEDIA_PUBLIC_OBJECT_MAX_MB: '3',
};
Object.assign(process.env, env);

const db = require('../server/db/database');
const model = require('../server/objects/model');
const { reconcile, summarize } = require('../server/objects/reconcile');

const MB = 1024 * 1024;
const d = db.getDb();
const write = (p, content) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
const V = d.prepare(`INSERT INTO vods (id, app_id, file_path, file_size, duration_seconds, visibility, is_public, storage_provider, storage_key)
                     VALUES (?, 'live', ?, ?, 60, 'public', 1, ?, ?)`);

// Rows: a healthy local vod; an offloaded one whose B2 copy is fine; one whose B2 copy is gone but
// R2 still has it; one whose B2 copy has the wrong size; a local vod whose file vanished.
V.run(1, write(path.join(env.VOD_PATH, 'a.webm'), Buffer.alloc(100)), 100, 'local', null);
V.run(2, '/gone/b.webm', 200, 'b2', 'vods/b.webm');
V.run(3, '/gone/c.webm', 300, 'r2', 'vods/c.webm');
V.run(4, '/gone/d.webm', 400, 'b2', 'vods/d.webm');
V.run(5, write(path.join(env.VOD_PATH, 'e.webm'), Buffer.alloc(10)), 10, 'local', null);
const fileBytes = Buffer.from('file-bytes');
write(path.join(env.FILES_PATH, 'live', 'k1-f.bin'), fileBytes);
d.prepare("INSERT INTO files (key, app_id, size, mime, sha256) VALUES ('k1-f.bin', 'live', ?, 'application/octet-stream', ?)").run(fileBytes.length, crypto.createHash('sha256').update(fileBytes).digest('hex'));

// Scripts: a dry-run backfill reports and writes nothing.
const run = (script, args = []) => {
    try { return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout) }; }
};
const dry = JSON.parse(run('backfill-objects.js', ['--dry-run', '--json']).out);
assert.deepStrictEqual([dry.dry_run, dry.counts.vod.created, dry.counts.file.created], [true, 5, 1]);
assert.strictEqual(d.prepare('SELECT COUNT(*) c FROM media_objects').get().c, 0, 'dry-run script wrote nothing');
const real = run('backfill-objects.js');
assert.strictEqual(real.code, 0, real.out);
assert.match(real.out, /vod 5\+\/0~\/0 skipped/);
assert.strictEqual(d.prepare('SELECT COUNT(*) c FROM media_objects').get().c, 6);
console.log('✅ backfill script: --dry-run reports only; a real run projects');

fs.unlinkSync(path.join(env.VOD_PATH, 'e.webm'));                               // vod 5 loses its file after backfill
const objId = (vodId) => d.prepare('SELECT object_id FROM vods WHERE id = ?').get(vodId).object_id;
// Anomalies the reconciler must notice:
d.prepare("INSERT INTO media_locations (object_id, provider, key, state) VALUES ('med_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'local', '/nowhere', 'present')").run();   // orphan location
db.run("UPDATE media_objects SET size_bytes = 999 WHERE id = ?", [objId(1)]);                                   // local size mismatch
db.run("UPDATE media_objects SET content_hash = ? WHERE legacy_ref = 'legacy:live:file:k1-f.bin'", ['0'.repeat(64)]);   // hash mismatch
db.run("UPDATE media_objects SET lifecycle_status = 'deleted' WHERE id = ?", [objId(2)]);                      // deleted, but /v/2 still serves it
d.prepare("INSERT INTO clips (id, app_id, file_path, status) VALUES (9, 'live', '/x.webm', 'ready')").run();     // row with no object
const ready = model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready' });                  // ready object, no location

// Fake provider: key → size (absent = 404). B2 lost c.webm (R2 still has it) and holds a wrong-size d.webm.
const bucket = { b2: { 'vods/b.webm': 200, 'vods/d.webm': 12345 }, r2: { 'vods/c.webm': 300 } };
const heads = [];
const fakeHead = async (provider, key) => { heads.push(`${provider}:${key}`); const s = bucket[provider][key]; return s === undefined ? null : { size: s, etag: 'x' }; };

(async () => {
    const snapshot = () => JSON.stringify(d.prepare('SELECT * FROM media_locations ORDER BY id').all());
    const before = snapshot();
    const ro = await reconcile({ head: fakeHead, hash: true });
    assert.strictEqual(snapshot(), before, 'default mode writes nothing');
    assert.strictEqual(heads.length, 0, 'default mode calls no provider');
    const count = (rep, k) => rep.issues[k].count;
    assert.strictEqual(count(ro, 'orphan_location'), 1);
    assert.strictEqual(count(ro, 'missing_local_file'), 1);
    assert.strictEqual(ro.issues.missing_local_file.items[0].legacy_ref, 'legacy:live:vod:5');
    assert.strictEqual(count(ro, 'size_mismatch'), 1, 'local size mismatch');
    assert.strictEqual(count(ro, 'hash_mismatch'), 1);
    assert.strictEqual(count(ro, 'deleted_publicly_reachable'), 1);
    assert.strictEqual(ro.issues.deleted_publicly_reachable.items[0].table, 'vods');
    assert.strictEqual(count(ro, 'missing_projection'), 1);
    assert.deepStrictEqual(ro.issues.missing_projection.items[0], { table: 'clips', id: 9 });
    assert.strictEqual(count(ro, 'no_canonical_location'), 1);
    assert.strictEqual(ro.issues.no_canonical_location.items[0].object_id, ready);
    assert.strictEqual(count(ro, 'canonical_missing_replica_present'), 0, 'remote copies are unverified until --verify');
    assert.strictEqual(ro.counts.remote_unverified, 4, 'b2 ×3 + r2 ×1 pending');
    assert.ok(summarize(ro).includes('orphan_location: 1'));
    console.log('✅ read-only pass: local checks, orphans, projections, deleted-but-served — no writes, no provider calls');

    const v = await reconcile({ verify: true, head: fakeHead });
    assert.strictEqual(heads.length, 4, 'every remote location HEADed once');
    assert.strictEqual(count(v, 'remote_missing'), 1, 'vod 3 canonical B2 copy is gone');
    assert.strictEqual(v.issues.remote_missing.items[0].key, 'vods/c.webm');
    assert.strictEqual(count(v, 'canonical_missing_replica_present'), 1);
    assert.deepStrictEqual(v.issues.canonical_missing_replica_present.items[0].present, ['r2'], 'the R2 cache still has it');
    assert.strictEqual(count(v, 'size_mismatch'), 2, 'local vod 1 + remote vod 4');
    assert.strictEqual(count(v, 'no_present_copy'), 2, 'vod 4 (only copy corrupt) and vod 5 (only copy missing)');
    const st = (vodId, p) => d.prepare('SELECT state, verified_at, size_bytes FROM media_locations WHERE object_id = ? AND provider = ?').get(objId(vodId), p);
    assert.strictEqual(st(3, 'b2').state, 'missing');
    assert.strictEqual(st(3, 'r2').state, 'present');
    assert.strictEqual(st(4, 'b2').state, 'corrupt');
    assert.strictEqual(st(4, 'b2').size_bytes, 12345);
    assert.strictEqual(st(5, 'local').state, 'missing');
    assert.ok(st(3, 'r2').verified_at, '--verify records verified_at');
    assert.ok(v.counts.locations_updated >= 6);
    console.log('✅ --verify: HEADs remotes (fake provider), records states; detects lost canonical with a surviving replica');

    // An unconfigured provider is "unverifiable", never "missing".
    const u = await reconcile({ verify: true, head: async () => undefined });
    assert.strictEqual(u.counts.remote_unverifiable, 4);
    assert.strictEqual(count(u, 'remote_missing'), 0);

    // The scripts against the same database.
    const rc = run('reconcile-objects.js', ['--json']);
    assert.strictEqual(rc.code, 1, 'issues → exit 1');
    assert.ok(JSON.parse(rc.out).issues.orphan_location.count === 1);
    // A deleted object's thumbnail that is still served is reachable too.
    write(path.join(env.THUMBNAILS_PATH, 'vod-1-5.jpg'), 'jpg');
    db.run("UPDATE vods SET thumbnail_url = '/t/vod-1-5.jpg' WHERE id = 1");
    model.sync('vod', 1);
    db.run('DELETE FROM vods WHERE id = 1');
    const t = await reconcile({});
    assert.ok(t.issues.deleted_publicly_reachable.items.some(i => i.reason.startsWith('derivative')), 'thumbnail of a deleted vod is flagged');

    db.run('UPDATE vods SET file_size = ? WHERE id = 3', [5 * MB]);
    model.sync('vod', 3);
    const inv = run('object-invariant.js', ['--json']);
    const invReport = JSON.parse(inv.out);
    assert.strictEqual(invReport.counts.violation, 1);
    assert.strictEqual(invReport.objects[0].legacy_ref, 'legacy:live:vod:3');
    assert.strictEqual(d.prepare("SELECT level FROM media_invariant_violations WHERE object_id = ? AND resolved_at IS NULL").get(objId(3)).level, 'violation');
    assert.match(run('object-invariant.js', ['--dry-run']).out, /violation 1/);
    console.log('✅ scripts: reconcile exit codes + JSON, invariant report records violations');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('objects reconciliation: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
