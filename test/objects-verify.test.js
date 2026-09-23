'use strict';
// Scheduled copy verification (server/objects/verify-job.js) against a fake B2/R2 provider:
// bounded batches that rotate through every ready object, verdicts recorded on media_locations,
// media_verifications and media_verify_runs, a missing remote copy restored from a good local copy,
// nothing ever deleted, the no-good-copy count on /metrics and as a degraded (still ready) check in
// /api/ready, and scripts/no-good-copy-report.js listing those objects read-only.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-verify-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const env = {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
    MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'http://127.0.0.1:9',
};
for (const k of ['MEDIA_B2_ENDPOINT', 'MEDIA_B2_BUCKET', 'MEDIA_R2_ENDPOINT', 'MEDIA_R2_BUCKET', 'EVENTS_URL', 'MEDIA_VERIFY_ENABLED', 'MEDIA_VERIFY_REPAIR_CORRUPT']) process.env[k] = '';
Object.assign(process.env, env);

const db = require('../server/db/database');
const config = require('../server/config');
const model = require('../server/objects/model');
const job = require('../server/objects/verify-job');
const copyReport = require('../server/objects/copy-report');

const d = db.getDb();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const put = (name, content) => { const p = path.join(env.OBJECTS_PATH, 'live', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
function obj(name, { size, hash = null, status = 'ready', locs = [], owner = 7 }) {
    const id = model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: status, size_bytes: size, content_hash: hash,
        owner_user_id: owner, owner_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', mime_type: 'application/octet-stream', metadata: { filename: name } });
    for (const l of locs) model.upsertLocation(id, l);
    return id;
}

// Fake provider: bucket[provider][key] = size (absent → 404). r2 is "not configured" (HEAD undefined).
const bucket = { b2: {} };
const heads = [], uploads = [];
const head = async (provider, key) => { heads.push(`${provider}:${key}`); if (!bucket[provider]) return undefined; const s = bucket[provider][key]; return s === undefined ? null : { size: s }; };
const upload = async (provider, key, file) => { uploads.push(`${provider}:${key}`); if (!bucket[provider]) return undefined; const size = fs.statSync(file).size; bucket[provider][key] = size; return { size }; };

const A = Buffer.from('aaaaaaaaaa'), B = Buffer.from('bbbbbbbbbbbb'), E = Buffer.from('eeee'), G = Buffer.from('gggggg');
const ids = {
    good: obj('a', { size: A.length, hash: sha(A), locs: [{ provider: 'local', key: put('a', A), state: 'present' }] }),
    restore: obj('b', { size: B.length, locs: [{ provider: 'local', key: put('b', B), state: 'present' }, { provider: 'b2', key: 'objs/b', state: 'pending' }] }),
    remoteCorrupt: obj('c', { size: 300, locs: [{ provider: 'b2', key: 'objs/c', state: 'pending' }] }),
    localGone: obj('d', { size: 40, locs: [{ provider: 'local', key: path.join(env.OBJECTS_PATH, 'live', 'd-gone'), state: 'present' }] }),
    localBadHash: obj('e', { size: E.length, hash: '0'.repeat(64), locs: [{ provider: 'local', key: put('e', E), state: 'present' }, { provider: 'b2', key: 'objs/e', state: 'pending' }] }),
    unverifiable: obj('f', { size: 50, locs: [{ provider: 'r2', key: 'objs/f', state: 'pending' }] }),
    corruptNoRepair: obj('g', { size: G.length, locs: [{ provider: 'local', key: put('g', G), state: 'present' }, { provider: 'b2', key: 'objs/g', state: 'pending' }] }),
    noLocations: obj('h', { size: 10 }),
};
bucket.b2['objs/c'] = 12345;           // wrong size → corrupt
bucket.b2['objs/e'] = E.length;        // the remote copy of e is fine
bucket.b2['objs/g'] = 999;             // corrupt, and MEDIA_VERIFY_REPAIR_CORRUPT is off
obj('deleted', { size: 1, status: 'deleted', locs: [{ provider: 'local', key: '/nowhere', state: 'missing' }] });
obj('uploading', { size: 1, status: 'uploading' });
// Legacy row that points at the object whose local file is gone (the report must show it).
d.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, visibility, is_public, storage_provider, object_id) VALUES (41, 'live', 7, 'Lost stream', ?, 40, 'public', 1, 'local', ?)")
    .run(path.join(env.OBJECTS_PATH, 'live', 'd-gone'), ids.localGone);
const READY = Object.keys(ids).length;

const loc = (id, p) => d.prepare('SELECT * FROM media_locations WHERE object_id = ? AND provider = ?').get(id, p);
const ver = (id) => d.prepare('SELECT * FROM media_verifications WHERE object_id = ?').get(id);
const snapshot = () => ({
    objects: d.prepare('SELECT COUNT(*) c FROM media_objects').get().c,
    locations: d.prepare('SELECT COUNT(*) c FROM media_locations').get().c,
    vods: d.prepare('SELECT COUNT(*) c FROM vods').get().c,
    files: fs.readdirSync(path.join(env.OBJECTS_PATH, 'live')).sort().join(','),
});

function request(base, p) {
    return new Promise((resolve, reject) => {
        http.get(base + p, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
    });
}

(async () => {
    const before = snapshot();
    // Nothing may unlink or remove anything while the job runs.
    const deletes = [];
    const orig = { unlinkSync: fs.unlinkSync, unlink: fs.unlink, rmSync: fs.rmSync, rm: fs.rm };
    fs.unlinkSync = (...a) => { deletes.push(a[0]); return orig.unlinkSync(...a); };
    fs.unlink = (...a) => { deletes.push(a[0]); return orig.unlink(...a); };
    fs.rmSync = (...a) => { deletes.push(a[0]); return orig.rmSync(...a); };
    fs.rm = (...a) => { deletes.push(a[0]); return orig.rm(...a); };

    // ── Bounded batches, rotating: never-verified first, then least recently verified ──
    const r1 = await job.runOnce({ batch: 3, head, upload });
    assert.strictEqual(r1.objects_checked, 3, 'a run never checks more than the batch');
    assert.strictEqual(d.prepare('SELECT COUNT(*) c FROM media_verifications').get().c, 3);
    const firstBatch = r1.objects.map(o => o.object_id);
    const r2 = await job.runOnce({ batch: 3, head, upload });
    assert.ok(r2.objects.every(o => !firstBatch.includes(o.object_id)), 'the next run takes objects not verified yet');
    const r3 = await job.runOnce({ batch: 3, head, upload });
    assert.strictEqual(d.prepare('SELECT COUNT(*) c FROM media_verifications').get().c, READY, `${READY} ready objects covered in ceil(${READY}/3) runs`);
    assert.ok(r3.objects.slice(READY - 6).every(o => firstBatch.includes(o.object_id)), 'once all are verified, the oldest verified come round again');
    assert.ok(!d.prepare("SELECT 1 FROM media_verifications v JOIN media_objects o ON o.id = v.object_id WHERE o.lifecycle_status != 'ready'").get(), 'only ready objects are verified');
    console.log('✅ bounded batches rotate through every ready object (never-verified first, then oldest)');

    // ── Verdicts recorded ──
    assert.strictEqual(ver(ids.good).status, 'good');
    assert.strictEqual(loc(ids.good, 'local').state, 'present');
    assert.ok(loc(ids.good, 'local').verified_at);
    assert.strictEqual(loc(ids.remoteCorrupt, 'b2').state, 'corrupt');
    assert.strictEqual(loc(ids.remoteCorrupt, 'b2').size_bytes, 12345);
    assert.strictEqual(ver(ids.remoteCorrupt).status, 'no_good_copy');
    assert.strictEqual(loc(ids.localGone, 'local').state, 'missing');
    assert.strictEqual(ver(ids.localGone).status, 'no_good_copy');
    assert.strictEqual(loc(ids.localBadHash, 'local').state, 'corrupt', 'a local copy whose sha256 differs is corrupt');
    assert.strictEqual(loc(ids.localBadHash, 'b2').state, 'present');
    assert.strictEqual(ver(ids.localBadHash).good_providers, 'b2');
    assert.strictEqual(ver(ids.unverifiable).status, 'unverifiable', 'an unconfigured provider is unverifiable, never missing');
    assert.strictEqual(loc(ids.unverifiable, 'r2').state, 'pending');
    assert.strictEqual(ver(ids.noLocations).status, 'no_good_copy');
    const runs = d.prepare('SELECT * FROM media_verify_runs ORDER BY id').all();
    assert.strictEqual(runs.length, 3);
    assert.ok(runs.every(r => r.finished_at && r.objects_checked >= 1 && r.no_good_copy_total != null));
    assert.strictEqual(runs.reduce((n, r) => n + r.objects_checked, 0), 9);
    console.log('✅ verdicts recorded on media_locations, media_verifications and media_verify_runs');

    // ── Re-upload of a missing remote copy from the good local copy ──
    assert.ok(uploads.includes('b2:objs/b'), 'missing b2 copy re-uploaded');
    assert.strictEqual(bucket.b2['objs/b'], B.length);
    assert.strictEqual(loc(ids.restore, 'b2').state, 'present');
    // The run that first checked it did the re-upload. (media_verifications keeps only the latest verdict,
    // and a later run may re-verify it once batches rotate, with no re-upload left to do.)
    const firstRestore = [r1, r2, r3].flatMap(r => r.objects).find(o => o.object_id === ids.restore);
    assert.strictEqual(firstRestore.reuploads, 1, 'the run that first checked it re-uploaded the missing copy');
    assert.ok(!uploads.includes('b2:objs/g'), 'a corrupt remote copy is not overwritten unless MEDIA_VERIFY_REPAIR_CORRUPT=1');
    assert.strictEqual(loc(ids.corruptNoRepair, 'b2').state, 'corrupt');
    assert.ok(!uploads.includes('b2:objs/e'), 'never re-uploads from a local copy that failed its hash');
    assert.strictEqual(runs.reduce((n, r) => n + r.reuploaded, 0), 1);
    // The per-run budget: with none left the restore is deferred, not attempted.
    delete bucket.b2['objs/b'];
    const deferred = await job.verifyObject(model.getObject(ids.restore), { head, upload, hashMaxBytes: 1e9, repairCorrupt: false, budget: { left: 0 } });
    assert.match(deferred.reuploads[0].error, /^deferred/);
    assert.strictEqual(loc(ids.restore, 'b2').state, 'missing');
    // Opt-in corrupt repair.
    const repaired = await job.verifyObject(model.getObject(ids.corruptNoRepair), { head, upload, hashMaxBytes: 1e9, repairCorrupt: true, budget: { left: 1 } });
    assert.strictEqual(repaired.reuploads[0].ok, true);
    assert.strictEqual(bucket.b2['objs/g'], G.length);
    bucket.b2['objs/b'] = B.length;
    console.log('✅ missing remote copy restored from a verified-good local copy (budgeted; corrupt only when opted in)');

    // ── Never deletes ──
    fs.unlinkSync = orig.unlinkSync; fs.unlink = orig.unlink; fs.rmSync = orig.rmSync; fs.rm = orig.rm;
    assert.deepStrictEqual(deletes, [], 'no unlink/rm during verification');
    assert.deepStrictEqual(snapshot(), before, 'every object, location, legacy row and file is still there');
    assert.ok(model.getObject(ids.remoteCorrupt) && model.getObject(ids.localGone), 'objects with no good copy are kept');
    assert.strictEqual(model.getObject(ids.localGone).lifecycle_status, 'ready', 'and their lifecycle is untouched');
    console.log('✅ never deletes: files, objects, locations and legacy rows all remain');

    // ── Count, /metrics and /api/ready ──
    assert.strictEqual(copyReport.countNoGoodCopy(db), 3, 'c (remote corrupt), d (local gone), h (no locations)');
    const st = job.status();
    assert.strictEqual(st.no_good_copy, 3);
    assert.strictEqual(st.verified_objects, READY);
    assert.ok(st.last_run.finished_at);

    const express = require('express');
    const observability = require('../server/observability');
    const app = express();
    const inst = observability.instrument(app, { release: 'test' });
    observability.mountReady(app, inst.registry, {
        release: 'test', db, config, auth: { jwksLoaded: () => true }, recorder: { activeCount: () => 0 },
        events: { status: () => ({ enabled: false }) }, remote: { configured: () => false, probe: async () => true },
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ready = await request(base, '/api/ready');
    const body = JSON.parse(ready.body);
    assert.strictEqual(ready.status, 200, 'no good copy never fails readiness');
    assert.strictEqual(body.ready, true);
    assert.strictEqual(body.status, 'degraded');
    assert.deepStrictEqual(body.degraded, ['object_copies']);
    assert.strictEqual(body.checks.object_copies.required, false);
    assert.strictEqual(body.checks.object_copies.detail.no_good_copy, 3);
    assert.match(body.checks.object_copies.error, /^3 ready object\(s\) with no good copy/);
    const m = await request(base, '/metrics');
    assert.ok(m.body.includes('media_objects_no_good_copy 3\n'), m.body);
    assert.match(m.body, /media_verify_last_run_timestamp_seconds \d{10}\n/);
    server.close(); inst.stop();
    console.log('✅ no-good-copy count on /metrics and as a degraded, never-failing /api/ready check');

    // ── Report script (read-only) ──
    const script = path.join(__dirname, '..', 'scripts', 'no-good-copy-report.js');
    const run = (a) => { try { return { code: 0, out: execFileSync(process.execPath, [script, ...a], { env: { ...process.env, ...env }, encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) }; } };
    const snapBefore = JSON.stringify(d.prepare('SELECT * FROM media_locations ORDER BY id').all()) + JSON.stringify(d.prepare('SELECT * FROM media_verifications ORDER BY object_id').all());
    const js = run(['--json', '--db', env.DB_PATH]);
    assert.strictEqual(js.code, 1, `objects found → exit 1 ${js.err || ''}`);
    const rep = JSON.parse(js.out);
    assert.strictEqual(rep.count, 3);
    assert.deepStrictEqual(rep.objects.map(o => o.object_id).sort(), [ids.remoteCorrupt, ids.localGone, ids.noLocations].sort());
    const gone = rep.objects.find(o => o.object_id === ids.localGone);
    assert.deepStrictEqual(gone.owner, { app: 'live', user_id: 7, subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' });
    assert.strictEqual(gone.references.vods[0].id, 41);
    assert.strictEqual(gone.references.vods[0].title, 'Lost stream');
    assert.strictEqual(gone.locations[0].state, 'missing');
    assert.strictEqual(gone.last_verification.status, 'no_good_copy');
    assert.strictEqual(rep.objects.find(o => o.object_id === ids.noLocations).locations.length, 0);
    const txt = run(['--db', env.DB_PATH]);
    assert.strictEqual(txt.code, 1);
    assert.ok(txt.out.includes('3 ready object(s) with no good copy'));
    assert.ok(txt.out.includes(ids.localGone) && txt.out.includes('vods#41') && txt.out.includes('locations: (none recorded)'));
    assert.ok(run(['--db', env.DB_PATH, '--app', 'games']).out.startsWith('0 ready object(s)'), '--app filters');
    assert.strictEqual(JSON.stringify(d.prepare('SELECT * FROM media_locations ORDER BY id').all()) + JSON.stringify(d.prepare('SELECT * FROM media_verifications ORDER BY object_id').all()), snapBefore, 'the report writes nothing');
    console.log('✅ no-good-copy report: owners, legacy references, locations; text + --json; read-only');

    // ── Scheduling: disabled by env; start/stop are idempotent ──
    config.verify.enabled = false;
    assert.strictEqual(job.start(), false);
    config.verify.enabled = true;
    assert.strictEqual(job.start({ initialDelayMs: 60 * 60 * 1000 }), true);
    job.stop();

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('objects-verify: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
