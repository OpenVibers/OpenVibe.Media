'use strict';
// Object-first writes (WS-G task 1, retiring compatibility shim C-75): every write to an inherited
// vods/clips/files/pastes row makes or updates its media_object in the SAME SQLite transaction
// (objects/model.js withObject). For each main write path the object is there, linked and agreeing
// with the row, as soon as the write returns; when the object cannot be written, the row write
// rolls back with it (neither row); and the drift report (server/objects/drift.js,
// scripts/object-drift-report.js) writes nothing and finds drift planted behind the model's back.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const sharp = require('sharp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-object-first-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
});

const db = require('../server/db/database');
require('../server/views/service').ensureSchema();
const model = require('../server/objects/model');
const drift = require('../server/objects/drift');
const tools = require('../server/vod/media-tools');
const thumbService = require('../server/thumbnails/thumbnail-service');
const cutter = require('../server/vod/clip-cutter');
const vodStorage = require('../server/vod/vod-storage');
const clipJobs = require('../server/vod/clip-jobs');
const { finalizeVod } = require('../server/vod/finalize');

db.upsertApp({ app_id: 'live', api_key: 'live-key-object-first' });
const raw = db.getDb();
const q = { all: (sql, p = []) => raw.prepare(sql).all(...p), get: (sql, p = []) => raw.prepare(sql).get(...p) };
const count = (table) => raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// No ffmpeg in these paths: the thumbnail generators and the probes answer as a real file would.
thumbService.generateVodThumbnail = async () => null;
thumbService.generateClipThumbnail = async () => null;
tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 30, error: null });
tools.probeDuration = async () => ({ ok: true, seconds: 30, format: {}, streams: [], error: null });
tools.remuxForSeeking = async () => true;
tools.probeVodInfo = async () => ({ duration: 12 });

/** The row, and the object its object_id names; asserts the pair agrees on every field a sync writes. */
function linked(table, keyCol, key, label) {
    const row = db.get(`SELECT * FROM ${table} WHERE ${keyCol} = ?`, [key]);
    assert.ok(row, `${label}: row exists`);
    assert.ok(row.object_id, `${label}: row names its object`);
    const obj = model.getObject(row.object_id);
    assert.ok(obj, `${label}: object exists right after the write`);
    const p = { vods: model.vodProjection, clips: model.clipProjection, files: model.fileProjection, pastes: model.pasteProjection }[table](row);
    const want = drift.expectedFields(p);
    for (const f of drift.FIELDS) assert.strictEqual(String(obj[f] ?? ''), String(want[f] ?? ''), `${label}: object ${f}`);
    return { row, obj };
}
const noDrift = (label) => {
    const r = drift.buildReport(q);
    assert.strictEqual(r.total_drift, 0, `${label}:\n${drift.formatReport(r)}`);
    return r;
};

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/v1/:app/vods', require('../server/vod/routes'));
app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
app.use('/api/v1/:app/files', require('../server/files/routes'));
app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
app.use('/api/v1/:app/pastes', require('../server/pastes/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1/live`;
    const auth = { authorization: 'Bearer live-key-object-first' };
    const call = async (method, p, body) => {
        const headers = { ...auth };
        if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
        const r = await fetch(base + p, { method, headers, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const form = (field, bytes, type, name, extra = {}) => {
        const f = new FormData();
        for (const [k, v] of Object.entries(extra)) f.append(k, String(v));
        f.append(field, new Blob([bytes], { type }), name);
        return f;
    };
    const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#3366ff' } }).png().toBuffer();

    // ── 1. VOD: create, chunk upload, metadata/visibility, finalize, thumbnail, health, tier move ──
    let r = await call('POST', '/vods', { title: 'First', user_id: 7, visibility: 'unlisted' });
    assert.strictEqual(r.status, 201);
    const vodId = r.body.id;
    let { obj } = linked('vods', 'id', vodId, 'vod create');
    assert.deepStrictEqual([obj.kind, obj.visibility, obj.lifecycle_status, obj.legacy_ref], ['vod', 'unlisted', 'uploading', `legacy:live:vod:${vodId}`]);

    r = await call('POST', '/vods', { title: 'Clips only', clips_only: true });
    assert.strictEqual(r.status, 201);
    const clipsOnly = db.get('SELECT * FROM vods WHERE id = ?', [r.body.id]);
    assert.strictEqual(clipsOnly.clips_only, 1, 'clips_only written with the row');
    assert.strictEqual(clipsOnly.object_id, null, 'a clips-only recording has no object (skipped by design)');

    r = await call('POST', `/vods/${vodId}/chunks`, form('chunk', Buffer.alloc(40000, 1), 'video/webm', 'a.webm'));
    assert.strictEqual(r.body.status, 'created');
    ({ obj } = linked('vods', 'id', vodId, 'first chunk'));
    const loc = () => model.listLocations(obj.id).find(l => l.provider === 'local');
    assert.strictEqual(loc().state, 'present', 'the recording file is a present local copy at once');
    assert.strictEqual(obj.size_bytes, 40000);
    r = await call('POST', `/vods/${vodId}/chunks`, form('chunk', Buffer.alloc(8000, 2), 'video/webm', 'b.webm'));
    assert.strictEqual(r.body.status, 'appended');
    ({ obj } = linked('vods', 'id', vodId, 'chunk progress'));
    assert.strictEqual(obj.size_bytes, 48000, 'progress updates carry the object size with them');

    r = await call('PUT', `/vods/${vodId}`, { title: 'Renamed', visibility: 'private' });
    assert.strictEqual(r.status, 200);
    ({ obj } = linked('vods', 'id', vodId, 'vod update'));
    assert.strictEqual(obj.visibility, 'private');
    assert.strictEqual(model.parseJson(obj.metadata, {}).title, 'Renamed');

    const done = await finalizeVod(vodId);
    assert.ok(done && done.health_status === 'ok');
    ({ obj } = linked('vods', 'id', vodId, 'finalize'));
    assert.strictEqual(obj.lifecycle_status, 'ready', 'the ready transition commits with its object');
    assert.strictEqual(model.parseJson(obj.metadata, {}).duration_seconds, 30);

    r = await call('POST', `/thumbnails/vod/${vodId}`, { image: png.toString('base64') });
    assert.strictEqual(r.status, 200);
    ({ obj } = linked('vods', 'id', vodId, 'thumbnail'));
    const thumbName = path.basename(r.body.url);
    const thumbObj = model.getObjectByLegacyRef(`legacy:live:thumbnail:${thumbName}`);
    assert.ok(thumbObj, 'the thumbnail object is written with the row');
    assert.strictEqual(model.getVariant(obj.id, 'thumbnail').derived_object_id, thumbObj.id);
    assert.deepStrictEqual([thumbObj.visibility, thumbObj.size_bytes], ['unlisted', png.length], 'a private VOD\'s thumbnail is unlisted');

    db.updateVodHealth(vodId, { status: 'corrupt', issues: ['test'], quarantine: true });
    assert.strictEqual(linked('vods', 'id', vodId, 'health').obj.lifecycle_status, 'failed');
    db.updateVodHealth(vodId, { status: 'ok', issues: [] });

    model.afterTierMove(vodId, ['b2'], () => db.run("UPDATE vods SET storage_provider = 'b2', storage_key = 'vods/x.webm' WHERE id = ?", [vodId]));
    ({ obj } = linked('vods', 'id', vodId, 'tier move'));
    assert.strictEqual(obj.canonical_provider, 'b2');
    assert.strictEqual(model.listLocations(obj.id).find(l => l.provider === 'b2').state, 'present', 'the verified copy is marked with the flip');

    // A ghost row (a recording that never produced a file) gets its object as it is quarantined.
    raw.prepare("INSERT INTO vods (id, app_id, title, created_at) VALUES (500, 'live', 'ghost', datetime('now', '-2 hours'))").run();
    assert.strictEqual(vodStorage.reconcileGhosts(), 1);
    assert.strictEqual(linked('vods', 'id', 500, 'ghost quarantine').obj.lifecycle_status, 'failed');
    console.log('✅ VOD writes (create, chunks, update, finalize, thumbnail, health, tier move, ghost quarantine) commit with their object');

    // ── 2. Clips: upload, create + re-cut (processing -> ready | failed), update, delete ──
    r = await call('POST', '/clips', form('video', Buffer.alloc(5000, 3), 'video/webm', 'c.webm', { title: 'Up', vod_id: vodId, visibility: 'private' }));
    assert.strictEqual(r.status, 201);
    const upId = r.body.id;
    ({ obj } = linked('clips', 'id', upId, 'clip upload'));
    assert.deepStrictEqual([obj.kind, obj.visibility, obj.lifecycle_status, obj.size_bytes], ['clip', 'private', 'ready', 5000]);

    const cutId = Number(db.createClip({ app_id: 'live', vod_id: vodId, user_id: 7, title: 'Cut', start_time: 1, end_time: 6, duration_seconds: 5, visibility: 'unlisted', status: 'processing' }).lastInsertRowid);
    ({ obj } = linked('clips', 'id', cutId, 'clip create'));
    assert.deepStrictEqual([obj.visibility, obj.lifecycle_status], ['unlisted', 'uploading']);
    const cutFile = path.join(process.env.CLIPS_PATH, 'cut.webm');
    fs.writeFileSync(cutFile, Buffer.alloc(6000, 4));
    const realResolve = vodStorage.resolveMediaSource;
    const realCut = cutter.cutClipFile;
    vodStorage.resolveMediaSource = async () => ({ kind: 'file', value: '/src.webm' });
    cutter.cutClipFile = async () => ({ ok: true, filePath: cutFile, duration: 5 });
    assert.strictEqual((await clipJobs.recutClip(cutId)).ok, true);
    ({ obj } = linked('clips', 'id', cutId, 'clip ready'));
    assert.deepStrictEqual([obj.lifecycle_status, obj.size_bytes], ['ready', 6000], 'the ready transition (announce) commits with its object');
    vodStorage.resolveMediaSource = async () => null;
    assert.strictEqual((await clipJobs.recutClip(cutId)).ok, false);
    assert.strictEqual(linked('clips', 'id', cutId, 'clip failed').obj.lifecycle_status, 'failed');
    vodStorage.resolveMediaSource = realResolve;
    cutter.cutClipFile = realCut;

    r = await call('PUT', `/clips/${upId}`, { title: 'Better', visibility: 'public', auto_generated: 1 });
    assert.strictEqual(r.status, 200);
    ({ obj } = linked('clips', 'id', upId, 'clip update'));
    assert.strictEqual(obj.visibility, 'public');
    assert.deepStrictEqual([model.parseJson(obj.metadata, {}).title, model.parseJson(obj.metadata, {}).auto_generated], ['Better', true]);

    const doomedFile = path.join(process.env.CLIPS_PATH, 'doomed.webm');
    fs.writeFileSync(doomedFile, Buffer.alloc(700, 5));
    const doomed = Number(db.createClip({ app_id: 'live', vod_id: vodId, title: 'Doomed', file_path: doomedFile, status: 'ready' }).lastInsertRowid);
    const doomedObj = linked('clips', 'id', doomed, 'clip to delete').obj.id;
    assert.strictEqual((await call('DELETE', `/clips/${doomed}`)).status, 200);
    assert.strictEqual(model.getObject(doomedObj).lifecycle_status, 'deleted', 'a deleted row takes its object with it (trigger, same statement)');
    console.log('✅ clip writes (upload, create, re-cut ready/failed, update, delete) commit with their object');

    // ── 3. Files, screenshot pastes, avatars ──
    r = await call('POST', '/files', form('file', Buffer.from('hello object model'), 'text/plain', 'notes.txt'));
    assert.strictEqual(r.status, 201);
    const fileKey = r.body.key;
    ({ obj } = linked('files', 'key', fileKey, 'file upload'));
    assert.strictEqual(obj.content_hash, crypto.createHash('sha256').update('hello object model').digest('hex'));
    const spare = await call('POST', '/files', form('file', Buffer.from('spare'), 'text/plain', 'spare.txt'));
    const spareObj = linked('files', 'key', spare.body.key, 'file to delete').obj.id;
    assert.strictEqual((await call('DELETE', `/files/${encodeURIComponent(spare.body.key)}`)).status, 200);
    assert.strictEqual(model.getObject(spareObj).lifecycle_status, 'deleted');

    r = await call('POST', '/pastes', form('screenshot', png, 'image/png', 'shot.png', { title: 'Shot', visibility: 'unlisted' }));
    assert.strictEqual(r.status, 201);
    const slug = r.body.slug;
    ({ obj } = linked('pastes', 'slug', slug, 'screenshot paste'));
    assert.deepStrictEqual([obj.kind, obj.visibility, obj.legacy_ref], ['screenshot', 'unlisted', `legacy:live:paste:${slug}`]);
    assert.strictEqual((await call('PUT', `/pastes/${slug}`, { title: 'Shot 2', visibility: 'private' })).status, 200);
    assert.strictEqual(linked('pastes', 'slug', slug, 'paste update').obj.visibility, 'private');
    assert.strictEqual((await call('POST', '/pastes/bulk', { slugs: [slug], action: 'public' })).status, 200);
    assert.strictEqual(linked('pastes', 'slug', slug, 'paste bulk').obj.visibility, 'public');
    const censor = await call('POST', `/pastes/${slug}/censor`, form('screenshot', png, 'image/png', 'censored.png'));
    assert.strictEqual(censor.status, 200);
    assert.strictEqual(linked('pastes', 'slug', slug, 'paste censor').obj.size_bytes, png.length);
    const text = await call('POST', '/pastes', { content: 'just text' });
    assert.strictEqual(db.get('SELECT object_id FROM pastes WHERE slug = ?', [text.body.slug]).object_id, null, 'a text paste has no bytes and no object');

    // Avatar ingest's write (server/avatars/ingest.js): the avatar row and its object together.
    const avatarFile = path.join(process.env.PASTES_PATH, 'avatar.webp');
    fs.writeFileSync(avatarFile, png);
    const avatarId = Number(db.withObject('paste', (x) => x.lastInsertRowid, () => db.run(`INSERT INTO pastes (app_id, slug, user_id, type, title, content, language, visibility, screenshot_path, metadata)
        VALUES ('network', 'av1', 42, 'screenshot', 'Avatar', '', 'text', 'unlisted', ?, ?)`, [avatarFile, JSON.stringify({ kind: 'avatar', mime_type: 'image/webp' })])).lastInsertRowid);
    assert.deepStrictEqual([linked('pastes', 'id', avatarId, 'avatar').obj.kind, linked('pastes', 'id', avatarId, 'avatar').obj.legacy_ref], ['avatar', 'legacy:network:avatar:av1']);
    console.log('✅ file, screenshot-paste and avatar writes commit with their object; deletes mark it deleted');

    const clean = noDrift('after every write path');
    assert.ok(clean.total_rows >= 8, 'the report checked the rows written above');

    // ── 4. Atomicity: an object write that fails takes the row write with it ──
    raw.exec(`CREATE TEMP TRIGGER t_refuse_object_insert BEFORE INSERT ON main.media_objects BEGIN SELECT RAISE(ABORT, 'object write refused (test)'); END;
              CREATE TEMP TRIGGER t_refuse_object_update BEFORE UPDATE ON main.media_objects BEGIN SELECT RAISE(ABORT, 'object write refused (test)'); END;`);
    const before = { vods: count('vods'), clips: count('clips'), files: count('files'), pastes: count('pastes'), objects: count('media_objects') };
    const unchanged = (label) => assert.deepStrictEqual({ vods: count('vods'), clips: count('clips'), files: count('files'), pastes: count('pastes'), objects: count('media_objects') }, before, label);

    assert.throws(() => db.createVod({ app_id: 'live', title: 'No object' }), /object write refused/);
    unchanged('createVod: neither row');
    assert.strictEqual((await call('POST', '/vods', { title: 'No object' })).status, 500);
    unchanged('POST /vods: neither row');
    assert.throws(() => db.createClip({ app_id: 'live', vod_id: vodId, title: 'No object', status: 'processing' }), /object write refused/);
    unchanged('createClip: neither row');
    assert.strictEqual((await call('POST', '/files', form('file', Buffer.from('never stored'), 'text/plain', 'never.txt'))).status, 500);
    unchanged('POST /files: neither row');
    assert.strictEqual((await call('POST', '/pastes', form('screenshot', png, 'image/png', 'never.png'))).status, 500);
    unchanged('POST /pastes screenshot: neither row');

    // Updates: the row keeps its old values when its object cannot follow.
    assert.throws(() => db.setVodVisibility(vodId, 'public'), /object write refused/);
    assert.strictEqual(db.get('SELECT visibility FROM vods WHERE id = ?', [vodId]).visibility, 'private', 'visibility change rolled back');
    assert.strictEqual((await call('PUT', `/clips/${upId}`, { title: 'Lost' })).status, 500);
    assert.strictEqual(db.get('SELECT title FROM clips WHERE id = ?', [upId]).title, 'Better', 'clip title rolled back');
    // The announce() path: a finalize whose object cannot be written commits no ready transition (and no event).
    raw.prepare("UPDATE vods SET is_recording = 1, health_status = 'unknown' WHERE id = ?").run(vodId);
    await assert.rejects(finalizeVod(vodId, { fromJob: true }), /object write refused/);
    assert.strictEqual(db.get('SELECT is_recording FROM vods WHERE id = ?', [vodId]).is_recording, 1, 'ready transition rolled back with its object');

    // A write that throws after its projection insert leaves neither row.
    assert.throws(() => db.withObject('vod', (x) => x.lastInsertRowid, () => {
        db.run("INSERT INTO vods (app_id, title) VALUES ('live', 'half')");
        throw new Error('crash after the insert');
    }), /crash after the insert/);
    unchanged('thrown after the insert: neither row');
    raw.exec('DROP TRIGGER temp.t_refuse_object_insert; DROP TRIGGER temp.t_refuse_object_update;');
    await finalizeVod(vodId, { fromJob: true });
    noDrift('after the refused writes');
    console.log('✅ a write whose object cannot be written leaves neither row (inserts, updates, announce path, a throw after the insert)');

    // ── 5. Drift report: read-only, finds planted drift ──
    raw.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path) VALUES (900, 'live', 3, 'Planted: no object', NULL)").run();
    const upObj = db.get('SELECT object_id FROM clips WHERE id = ?', [upId]).object_id;
    raw.prepare("UPDATE media_objects SET visibility = 'private' WHERE id = ?").run(upObj);
    const fileObj = db.get('SELECT object_id FROM files WHERE key = ?', [fileKey]).object_id;
    raw.prepare('UPDATE media_objects SET size_bytes = 1, owner_user_id = 99 WHERE id = ?').run(fileObj);
    raw.prepare('UPDATE pastes SET object_id = NULL WHERE slug = ?').run(slug);
    const cutObj = db.get('SELECT object_id FROM clips WHERE id = ?', [cutId]).object_id;
    raw.prepare("UPDATE media_objects SET lifecycle_status = 'deleted' WHERE id = ?").run(cutObj);

    const snapshot = () => ['vods', 'clips', 'files', 'pastes', 'media_objects', 'media_locations', 'media_variants', 'media_relationships']
        .map(t => JSON.stringify(raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).join('|');
    const snap = snapshot();
    const writesBefore = raw.prepare('SELECT total_changes() AS n').get().n;
    const rep = drift.buildReport(q, { limit: 5 });
    assert.strictEqual(raw.prepare('SELECT total_changes() AS n').get().n, writesBefore, 'the report issues no write');
    assert.strictEqual(snapshot(), snap, 'nothing changed');

    assert.strictEqual(rep.total_drift, 5, drift.formatReport(rep));
    assert.deepStrictEqual([rep.kinds.vod.missing, rep.kinds.clip.mismatch, rep.kinds.file.mismatch, rep.kinds.screenshot.unlinked], [1, 2, 1, 1]);
    assert.deepStrictEqual([rep.field_counts.visibility, rep.field_counts.size_bytes, rep.field_counts.owner_user_id, rep.field_counts.lifecycle_status], [1, 1, 1, 1]);
    const ex = (kind, id) => rep.kinds[kind].examples.find(e => String(e.id) === String(id));
    assert.deepStrictEqual(ex('vod', 900).problems, ['missing']);
    assert.deepStrictEqual(ex('clip', upId).diff.visibility, { row: 'public', object: 'private' });
    assert.deepStrictEqual(ex('clip', cutId).diff.lifecycle_status, { row: 'failed', object: 'deleted' });
    assert.deepStrictEqual(Object.keys(ex('file', fileKey).diff).sort(), ['owner_user_id', 'size_bytes']);
    assert.deepStrictEqual(ex('screenshot', db.get('SELECT id FROM pastes WHERE slug = ?', [slug]).id).problems, ['unlinked']);
    assert.strictEqual(rep.kinds.vod.skipped, 1, 'the clips-only recording is skipped, not drift');
    assert.strictEqual(drift.buildReport(q, { appId: 'network' }).total_drift, 0, '--app narrows the report');
    assert.match(drift.formatReport(rep), /total drift: 5 of \d+ row\(s\)/);

    // The script: the database opened read-only, exit 0 whatever it finds (and on an error).
    const script = path.join(__dirname, '..', 'scripts', 'object-drift-report.js');
    const out = JSON.parse(execFileSync(process.execPath, [script, '--db', process.env.DB_PATH, '--json', '--limit', '1'], { env: process.env, encoding: 'utf8' }));
    assert.strictEqual(out.total_drift, 5);
    assert.ok(Object.values(out.kinds).every(k => k.examples.length <= 1), '--limit caps the examples per kind');
    assert.match(execFileSync(process.execPath, [script, '--db', process.env.DB_PATH], { env: process.env, encoding: 'utf8' }), /clip examples \(2 of 2\)/);
    execFileSync(process.execPath, [script, '--db', path.join(tmp, 'missing.db')], { env: process.env, stdio: 'ignore' });   // throws on a non-zero exit
    assert.strictEqual(snapshot(), snap, 'the script changed nothing either');

    // Re-projecting the planted rows clears the drift the report listed.
    for (const id of [900]) model.sync('vod', id);
    model.sync('clip', upId); model.sync('clip', cutId); model.sync('file', fileKey);
    model.sync('paste', db.get('SELECT id FROM pastes WHERE slug = ?', [slug]).id);
    noDrift('after re-projecting the planted drift');
    console.log('✅ drift report: read-only (report and script), counts per kind with examples, finds missing / unlinked / mismatched objects');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('✅ All object-first write tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
