'use strict';
// Canonical object model (roadmap Wave 4): the backfill projects every vod, clip, file, screenshot,
// avatar and thumbnail row onto media_objects + media_locations without touching bytes or providers;
// it is idempotent; the write hooks keep the model current; holds block deletion and tier moves on
// every path; the public object-size invariant is recorded as policy.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-objects-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.FILES_PATH = dir('files');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.MEDIA_B2_BUCKET = 'bkt-b2';     // bucket name only: no endpoint, so B2 is not configured
process.env.MEDIA_R2_BUCKET = 'bkt-r2';
process.env.MEDIA_PUBLIC_OBJECT_TARGET_MB = '1';
process.env.MEDIA_PUBLIC_OBJECT_WARN_MB = '2';
process.env.MEDIA_PUBLIC_OBJECT_MAX_MB = '3';

const contracts = require('openvibe-contracts');
const db = require('../server/db/database');
const model = require('../server/objects/model');
const { backfill } = require('../server/objects/backfill');
const invariant = require('../server/objects/invariant');
const vodStorage = require('../server/vod/vod-storage');

const MB = 1024 * 1024;
const MED = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const d = db.getDb();
const write = (p, bytes) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 7)); return p; };
const objOf = (table, id) => model.getObject(d.prepare(`SELECT object_id FROM ${table} WHERE ${table === 'files' ? 'key' : 'id'} = ?`).get(id).object_id);
const locs = (o) => Object.fromEntries(model.listLocations(o.id).map(l => [l.provider, l]));

// ── Inherited rows, inserted raw (no hooks), the way the cutover import left them ──
const vodFile = write(path.join(process.env.VOD_PATH, 'vod-live-1.webm'), 1000);
write(path.join(process.env.THUMBNAILS_PATH, 'vod-1-111.jpg'), 50);
const insVod = d.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, duration_seconds, visibility, is_public, storage_provider, storage_key, thumbnail_url, clips_only, is_recording, created_at)
                          VALUES (@id, @app, @user, @title, @file, @size, @dur, @vis, @pub, @prov, @key, @thumb, @co, 0, @at)`);
const V = (o) => insVod.run({ app: 'live', user: 5, title: 'V', file: null, size: 0, dur: 60, vis: 'public', pub: 1, prov: 'local', key: null, thumb: null, co: 0, at: '2025-06-01 10:00:00', ...o });
V({ id: 1, file: vodFile, size: 1000, thumb: '/t/vod-1-111.jpg', at: '2025-01-01 00:00:00' });              // local, present
V({ id: 2, file: '/old/host/vods/old.webm', size: 5 * MB, vis: 'unlisted', pub: 0, prov: 'b2', key: 'vods/old.webm' });   // offloaded
V({ id: 3, file: '/old/host/vods/pop.mp4', size: 2.5 * MB, prov: 'r2', key: 'vods/pop.mp4', thumb: 'https://elsewhere.example/x.jpg' });
V({ id: 4, file: '/opt/hobostreamer/data/vods/gone.webm', size: 50 });                                 // local but gone
V({ id: 5, file: path.join(process.env.VOD_PATH, 'eph.webm'), co: 1 });                                  // clips-only
V({ id: 6, dur: 0 });                                                                                  // ghost: no file yet
V({ id: 7, app: 'games', file: vodFile, size: 1000, vis: 'private', pub: 0 });
const clipFile = write(path.join(process.env.CLIPS_PATH, 'clip-1.webm'), 300);
d.prepare("INSERT INTO clips (id, app_id, vod_id, user_id, title, file_path, status, visibility, is_public, start_time, end_time) VALUES (1, 'live', 1, 9, 'C', ?, 'ready', 'public', 1, 5, 15)").run(clipFile);
d.prepare("INSERT INTO clips (id, app_id, vod_id, user_id, title, file_path, status) VALUES (2, 'live', 1, 9, 'C2', '', 'processing')").run();
write(path.join(process.env.FILES_PATH, 'live', 'abc123-a.txt'), 12);
d.prepare("INSERT INTO files (key, app_id, user_id, original_name, size, mime, sha256) VALUES ('abc123-a.txt', 'live', 3, 'a.txt', 12, 'text/plain', ?)").run('a'.repeat(64));
const shot = write(path.join(process.env.PASTES_PATH, 'screenshots', 's1.png'), 40);
const avatar = write(path.join(process.env.PASTES_PATH, 'screenshots', 'avatar-n4.webp'), 30);
d.prepare("INSERT INTO pastes (id, app_id, slug, user_id, type, title, content, visibility, screenshot_path, metadata) VALUES (1, 'live', 'shot-one', 2, 'screenshot', 'S', '', 'public', ?, NULL)").run(shot);
d.prepare("INSERT INTO pastes (id, app_id, slug, user_id, type, title, content, visibility, screenshot_path, metadata) VALUES (2, 'network', 'avatar-four', 4, 'screenshot', 'Avatar', '', 'unlisted', ?, ?)").run(avatar, JSON.stringify({ kind: 'avatar', mime_type: 'image/webp' }));
d.prepare("INSERT INTO pastes (id, app_id, slug, type, title, content, visibility) VALUES (3, 'live', 'text-three', 'paste', 'T', 'hello', 'public')").run();
d.prepare("INSERT INTO pastes (id, app_id, slug, type, title, content, visibility, screenshot_path) VALUES (4, 'live', 'shot-nopath', 'screenshot', 'S', '', 'public', NULL)").run();
const mtimes = [vodFile, clipFile, shot, avatar].map(p => fs.statSync(p).mtimeMs);

// ── Dry run: a full report, nothing written ──
const dry = backfill({ dryRun: true });
assert.strictEqual(dry.dry_run, true);
assert.deepStrictEqual(dry.counts.vod, { seen: 7, created: 6, updated: 0, skipped: 1 });
assert.strictEqual(d.prepare('SELECT COUNT(*) c FROM media_objects').get().c, 0, 'dry run writes no objects');
assert.strictEqual(d.prepare('SELECT COUNT(*) c FROM vods WHERE object_id IS NOT NULL').get().c, 0, 'dry run links no rows');
assert.strictEqual(model.parseJson(d.prepare("SELECT value FROM media_settings WHERE key = 'objects.backfill.last_report'").get()?.value, null), null, 'dry run stores no report');
console.log('✅ dry run reports without writing');

// ── Real run ──
const r = backfill();
assert.deepStrictEqual(r.counts.vod, { seen: 7, created: 6, updated: 0, skipped: 1 });
assert.deepStrictEqual(r.counts.clip, { seen: 2, created: 2, updated: 0, skipped: 0 });
assert.deepStrictEqual(r.counts.file, { seen: 1, created: 1, updated: 0, skipped: 0 });
assert.deepStrictEqual(r.counts.screenshot, { seen: 2, created: 1, updated: 0, skipped: 1 });
assert.deepStrictEqual(r.counts.avatar, { seen: 1, created: 1, updated: 0, skipped: 0 });
assert.deepStrictEqual(r.counts.thumbnail, { seen: 2, created: 1, updated: 0, skipped: 1 });
assert.deepStrictEqual(r.skipped.map(s => s.reason).sort(), ['clips-only recording (ephemeral, never published)', 'external thumbnail url', 'screenshot paste without a file path']);
assert.deepStrictEqual(r.errors, []);
assert.ok(d.prepare("SELECT value FROM media_settings WHERE key = 'objects.backfill.last_report'").get(), 'report recorded');
assert.deepStrictEqual([vodFile, clipFile, shot, avatar].map(p => fs.statSync(p).mtimeMs), mtimes, 'no bytes touched');

const v1 = objOf('vods', 1), v2 = objOf('vods', 2), v3 = objOf('vods', 3), v4 = objOf('vods', 4), v6 = objOf('vods', 6), v7 = objOf('vods', 7);
for (const o of [v1, v2, v3, v4, v6, v7]) {
    assert.ok(MED.test(o.id), o.id);
    assert.ok(contracts.validate('media.media-ref@1', { media_id: o.id }).valid, 'canonical id is a valid media-ref');
    assert.ok(contracts.validate('media.media-ref@1', { media_id: o.legacy_ref }).valid, `legacy ref valid: ${o.legacy_ref}`);
}
assert.ok(v1.id < v2.id, 'ids sort by the original creation time');
assert.strictEqual(v1.legacy_ref, 'legacy:live:vod:1');
assert.deepStrictEqual([v1.kind, v1.visibility, v1.lifecycle_status, v1.size_bytes, v1.owner_app, v1.owner_user_id, v1.mime_type], ['vod', 'public', 'ready', 1000, 'live', 5, 'video/webm']);
assert.strictEqual(locs(v1).local.state, 'present');
assert.strictEqual(locs(v1).local.key, vodFile);
assert.ok(locs(v1).local.verified_at, 'a local file that exists is verified present');
assert.deepStrictEqual([v1.canonical_provider, v1.canonical_key], ['local', vodFile]);
assert.deepStrictEqual(Object.keys(locs(v2)), ['b2'], 'offloaded vod: B2 copy only');
assert.deepStrictEqual([locs(v2).b2.state, locs(v2).b2.bucket, locs(v2).b2.key, locs(v2).b2.storage_class, v2.canonical_provider], ['pending', 'bkt-b2', 'vods/old.webm', 'cold', 'b2']);
assert.deepStrictEqual(Object.keys(locs(v3)).sort(), ['b2', 'r2'], 'R2 cache implies the B2 canonical');
assert.deepStrictEqual([locs(v3).r2.state, locs(v3).r2.storage_class, v3.canonical_provider], ['pending', 'cache', 'b2']);
assert.strictEqual(locs(v4).local.state, 'missing', 'a local file that is not on disk is recorded missing');
assert.strictEqual(model.listLocations(v6.id).length, 0);
assert.strictEqual(v6.lifecycle_status, 'uploading');
assert.deepStrictEqual([v7.app_id, v7.namespace, v7.visibility], ['games', 'games', 'private']);
assert.strictEqual(d.prepare('SELECT object_id FROM vods WHERE id = 5').get().object_id, null, 'clips-only row stays unprojected');

const c1 = objOf('clips', 1), c2 = objOf('clips', 2);
assert.deepStrictEqual([c1.kind, c1.lifecycle_status, c1.size_bytes, locs(c1).local.state], ['clip', 'ready', 300, 'present']);
assert.strictEqual(c2.lifecycle_status, 'uploading', 'a clip still being cut is uploading');
const rel = d.prepare("SELECT * FROM media_relationships WHERE from_object_id = ? AND relation = 'clip_of'").get(c1.id);
assert.strictEqual(rel.to_object_id, v1.id, 'clip_of links the clip to its vod');
assert.deepStrictEqual(JSON.parse(rel.metadata), { start_time: 5, end_time: 15 });

const f = objOf('files', 'abc123-a.txt');
assert.deepStrictEqual([f.kind, f.visibility, f.content_hash, f.mime_type, f.legacy_ref, locs(f).local.checksum], ['file', 'public', 'a'.repeat(64), 'text/plain', 'legacy:live:file:abc123-a.txt', 'a'.repeat(64)]);
const s1 = objOf('pastes', 1), av = objOf('pastes', 2);
assert.deepStrictEqual([s1.kind, s1.legacy_ref, s1.size_bytes], ['screenshot', 'legacy:live:paste:shot-one', 40]);
assert.deepStrictEqual([av.kind, av.app_id, av.legacy_ref, av.visibility, av.mime_type], ['avatar', 'network', 'legacy:network:avatar:avatar-four', 'unlisted', 'image/webp']);
assert.strictEqual(d.prepare('SELECT object_id FROM pastes WHERE id = 3').get().object_id, null, 'text pastes have no bytes object');

const tv = model.getVariant(v1.id, 'thumbnail');
const th = model.getObject(tv.derived_object_id);
assert.deepStrictEqual([th.kind, th.legacy_ref, th.visibility, locs(th).local.state], ['thumbnail', 'legacy:live:thumbnail:vod-1-111.jpg', 'public', 'present']);
assert.ok(d.prepare("SELECT 1 FROM media_relationships WHERE from_object_id = ? AND relation = 'thumbnail_of' AND to_object_id = ?").get(th.id, v1.id));
console.log('✅ backfill: one object per row, locations mirror where the bytes are, relationships + thumbnail variants');

// ── Idempotent ──
const countAll = () => ['media_objects', 'media_locations', 'media_relationships', 'media_variants'].map(t => d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
const before = countAll();
const again = backfill();
assert.strictEqual(again.totals.created, 0, 'a re-run creates nothing');
assert.strictEqual(again.counts.vod.updated, 6);
assert.deepStrictEqual(countAll(), before);
assert.strictEqual(objOf('vods', 1).id, v1.id, 'ids are stable');
assert.strictEqual(backfill({ onlyMissing: true }).totals.created, 0, 'only-missing finds nothing new');
console.log('✅ backfill is idempotent');

// ── Remote knowledge survives a re-projection ──
model.setLocationState(locs(v2).b2.id, { state: 'present', size_bytes: 5 * MB });
model.sync('vod', 2);
assert.strictEqual(locs(v2).b2.state, 'present', 'a verified remote copy is not downgraded to pending');
console.log('✅ verified remote state is kept across syncs');

// ── Write hooks on the inherited APIs ──
write(path.join(process.env.FILES_PATH, 'live', 'def456-b.png'), 20);
db.createFile({ key: 'def456-b.png', app_id: 'live', user_id: 3, original_name: 'b.png', size: 20, mime: 'image/png', sha256: 'b'.repeat(64) });
assert.strictEqual(objOf('files', 'def456-b.png').content_hash, 'b'.repeat(64), 'file upload creates its object');
db.setVodVisibility(1, 'private');
assert.strictEqual(model.getObject(v1.id).visibility, 'private', 'visibility follows');
assert.strictEqual(model.getObject(th.id).visibility, 'unlisted', 'a private vod thumbnail is still reachable by name: unlisted');
// Thumbnail regenerated: same object, new file.
write(path.join(process.env.THUMBNAILS_PATH, 'vod-1-222.jpg'), 60);
db.run("UPDATE vods SET thumbnail_url = '/t/vod-1-222.jpg' WHERE id = 1");
model.sync('vod', 1);
const th2 = model.getObject(model.getVariant(v1.id, 'thumbnail').derived_object_id);
assert.strictEqual(th2.id, th.id, 'one thumbnail object per parent, updated in place');
assert.deepStrictEqual([th2.legacy_ref, th2.size_bytes], ['legacy:live:thumbnail:vod-1-222.jpg', 60]);
const newClip = db.createClip({ app_id: 'live', vod_id: 1, user_id: 9, title: 'N', file_path: clipFile, status: 'ready' }).lastInsertRowid;
assert.strictEqual(objOf('clips', newClip).kind, 'clip', 'clip creation creates its object');
db.run('DELETE FROM clips WHERE id = ?', [newClip]);
const deadClip = d.prepare('SELECT * FROM media_objects WHERE legacy_ref = ?').get(`legacy:live:clip:${newClip}`);
assert.strictEqual(deadClip.lifecycle_status, 'deleted', 'deleting the row marks its object deleted (trigger — every delete path)');
assert.ok(deadClip.deleted_at);
console.log('✅ inherited writes keep the model current');

// ── Tier move re-projection ──
const v4row = d.prepare('SELECT * FROM vods WHERE id = 4').get();
db.run("UPDATE vods SET storage_provider = 'b2', storage_key = 'vods/gone.webm' WHERE id = 4");
model.afterTierMove(4, ['b2']);
assert.deepStrictEqual(Object.keys(locs(v4)), ['b2'], 'after offload: the local row goes, the B2 copy appears');
assert.strictEqual(locs(v4).b2.state, 'present', 'the copy the move verified is present');
assert.ok(locs(v4).b2.verified_at);
assert.ok(v4row);
console.log('✅ tier moves update media_locations');

(async () => {
    // ── Retention holds ──
    const hold = model.placeHold({ object_id: v1.id, kind: 'dmca', reason: 'notice #1', created_by: 'admin:alex' });
    assert.strictEqual(model.isHeld(v1.id), true);
    assert.throws(() => db.run('DELETE FROM vods WHERE id = 1'), /retention hold/, 'a held row cannot be deleted by any path');
    assert.ok(d.prepare('SELECT 1 FROM vods WHERE id = 1').get(), 'row still there');
    assert.throws(() => db.run("UPDATE media_objects SET lifecycle_status = 'deleted' WHERE id = ?", [v1.id]), /retention hold/);
    await vodStorage.deleteVodObjects(d.prepare('SELECT * FROM vods WHERE id = 1').get());
    assert.ok(fs.existsSync(vodFile), 'held bytes are not deleted');
    const cold = await vodStorage.moveToCold(1);
    assert.deepStrictEqual([cold.ok, cold.held], [false, true], 'held objects are not demoted to B2');
    const prom = await vodStorage.promoteToR2(1);
    assert.strictEqual(prom.held, true, 'nor promoted');
    db.run("UPDATE vods SET storage_provider = 'r2' WHERE id = 1");
    assert.strictEqual((await vodStorage.demoteFromR2(1)).held, true, 'nor demoted from R2');
    db.run("UPDATE vods SET storage_provider = 'local' WHERE id = 1");
    assert.throws(() => model.placeHold({ object_id: v1.id, kind: 'whim' }), /hold kind/);
    model.releaseHold(hold.id, 'admin:alex');
    assert.strictEqual(model.isHeld(v1.id), false);
    assert.strictEqual(model.listHolds(v1.id, { includeReleased: true })[0].released_by, 'admin:alex');
    console.log('✅ holds block deletion and tier moves until released');

    // ── Invariant (thresholds from env: target 1, warn 2, max 3 MB) ──
    assert.strictEqual(invariant.classify(0.5 * MB), 'ok');
    assert.strictEqual(invariant.classify(1.5 * MB), 'above_target');
    assert.strictEqual(invariant.classify(2.5 * MB), 'warn');
    assert.strictEqual(invariant.classify(5 * MB), 'violation');
    assert.strictEqual(invariant.wouldViolate({ kind: 'vod', visibility: 'private', size_bytes: 9 * MB }), false, 'private objects are not public playback');
    assert.strictEqual(invariant.wouldViolate({ kind: 'file', visibility: 'public', size_bytes: 9 * MB }), false, 'only playback kinds');
    const rows = () => d.prepare('SELECT o.legacy_ref, v.level, v.resolved_at FROM media_invariant_violations v JOIN media_objects o ON o.id = v.object_id ORDER BY o.legacy_ref').all();
    assert.deepStrictEqual(rows().map(x => [x.legacy_ref, x.level, x.resolved_at]), [['legacy:live:vod:2', 'violation', null], ['legacy:live:vod:3', 'warn', null]], 'sync records public playback objects over warn/max');
    const scan = invariant.scan({ record: false });
    assert.deepStrictEqual(scan.counts, { ok: 2, above_target: 0, warn: 1, violation: 1 });   // ok: clip 1, vod 4 (vod 1 is private now)
    db.setVodVisibility(3, 'private');
    assert.ok(rows().find(x => x.legacy_ref === 'legacy:live:vod:3').resolved_at, 'making it private resolves the row');
    console.log('✅ public object-size invariant is policy: classified, recorded, resolved');

    // ── Native soft delete + purge ──
    const nid = model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready', visibility: 'private', size_bytes: 4 });
    const npath = write(model.objectFilePath(model.getObject(nid)), 4);
    model.upsertLocation(nid, { provider: 'local', key: npath, state: 'present', size_bytes: 4 });
    const heldId = model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready', size_bytes: 4 });
    const hpath = write(model.objectFilePath(model.getObject(heldId)), 4);
    model.upsertLocation(heldId, { provider: 'local', key: hpath, state: 'present' });
    const deleted = model.softDelete(model.getObject(nid), { by: 'test' });
    assert.strictEqual(deleted.lifecycle_status, 'deleted');
    assert.ok(model.parseJson(deleted.metadata).retention_until, 'retention recorded');
    assert.ok(fs.existsSync(npath), 'soft delete keeps the bytes');
    assert.strictEqual(model.purgeExpired({ retentionDays: 1 }), 0, 'inside the retention period nothing is purged');
    const h2 = model.placeHold({ object_id: heldId, kind: 'evidence' });
    assert.throws(() => model.softDelete(model.getObject(heldId)), (e) => e.code === 'media.object.held');
    model.releaseHold(h2.id);
    model.softDelete(model.getObject(heldId));
    model.placeHold({ object_id: heldId, kind: 'evidence' });   // held after deletion: still kept
    assert.strictEqual(model.purgeExpired({ retentionDays: 0 }), 1);
    assert.ok(!fs.existsSync(npath), 'expired native bytes are purged');
    assert.ok(fs.existsSync(hpath), 'held bytes survive the purge');
    assert.ok(model.parseJson(model.getObject(nid).metadata).purged_at);
    assert.strictEqual(model.restore(model.getObject(nid)), null, 'a purged object cannot be restored');
    console.log('✅ native soft delete keeps bytes for the retention period; purge skips held objects');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('objects model + backfill: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
