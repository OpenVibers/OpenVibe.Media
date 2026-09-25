'use strict';
// Readiness levels (server/objects/readiness.js): metadata, bytes_verified and playable, computed from
// the object row and its copies' recorded checks, never assumed. An unverified copy (a B2 copy still
// `pending`, a missing or corrupt one, a checksum that contradicts the content hash) is not verified; a
// recording, a clip still being cut, a failed or deleted object and a non-playback kind are not
// playable. The same rule as SQL (the sitemap) agrees with compute(). The v1 VOD/clip JSON and the v2
// object JSON carry `readiness`; the public watch page offers a player only when it is playable and
// otherwise says why, while the bytes route keeps serving what is on disk (Live's DVR).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-readiness-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    OBJECTS_PATH: dir('objects'), THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'),
    MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'https://openvibe.network',
});
for (const k of Object.keys(process.env)) if (/^MEDIA_(B2|R2)_/.test(k)) delete process.env[k];

const db = require('../server/db/database');
require('../server/views/service').ensureSchema();
const model = require('../server/objects/model');
const readiness = require('../server/objects/readiness');
const verifyJob = require('../server/objects/verify-job');
const express = require('express');

db.upsertApp({ app_id: 'live', api_key: 'live-key' });
db.upsertApp({ app_id: 'games', api_key: 'games-key' });
const raw = db.getDb();
const vodFile = (n, bytes = 64) => { const p = path.join(process.env.VOD_PATH, n); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); return p; };
const clipFile = (n) => { const p = path.join(process.env.CLIPS_PATH, n); fs.writeFileSync(p, Buffer.alloc(32, 2)); return p; };
const insVod = raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, file_size, is_public, visibility, duration_seconds, is_recording, storage_provider, health_status)
                            VALUES (?, ?, ?, ?, ?, 1, 'public', ?, ?, ?, ?)`);
const insClip = raw.prepare(`INSERT INTO clips (id, app_id, vod_id, title, file_path, is_public, visibility, status, duration_seconds)
                             VALUES (?, 'games', 1, ?, ?, 1, 'public', ?, 5)`);

insVod.run(1, 'games', 'Local and finished', vodFile('vod-games-1.webm'), 64, 60, 0, 'local', 'ok');
insVod.run(2, 'games', 'Offloaded, never checked', '/old/vod-games-2.webm', 64, 60, 0, 'b2', 'ok');
insVod.run(3, 'games', 'Still recording', vodFile('vod-games-3.webm'), 0, 0, 1, 'local', 'unknown');
insVod.run(4, 'games', 'Broken', vodFile('vod-games-4.webm'), 64, 60, 0, 'local', 'corrupt');
insVod.run(5, 'games', 'File gone', '/nowhere/vod-games-5.webm', 64, 60, 0, 'local', 'ok');
insClip.run(11, 'Cut', clipFile('clip-11.webm'), 'ready');
insClip.run(12, 'Being cut', '', 'processing');
insClip.run(13, 'Cut failed', '', 'failed');
for (const id of [1, 2, 3, 4, 5]) model.sync('vod', id);
for (const id of [11, 12, 13]) model.sync('clip', id);
const vod = (id) => db.get('SELECT * FROM vods WHERE id = ?', [id]);
const clip = (id) => db.get('SELECT * FROM clips WHERE id = ?', [id]);
const r = (row) => readiness.forRow(row);

// ── compute(): from the object and its copies ──
assert.deepStrictEqual(readiness.forRow({ id: 99 }), { metadata: false, bytes_verified: false, playable: false, hash_verified: false, verified_copies: [], reason: 'no_object' });
assert.deepStrictEqual(r(vod(1)), { metadata: true, bytes_verified: true, playable: true, hash_verified: false, verified_copies: ['local'], reason: null },
    'a finished VOD whose local file was checked is playable');
assert.deepStrictEqual([r(vod(2)).bytes_verified, r(vod(2)).playable, r(vod(2)).reason], [false, false, 'verification_pending'],
    'a B2 copy nobody has checked yet is not verified bytes');
assert.deepStrictEqual([r(vod(3)).playable, r(vod(3)).reason], [false, 'recording'], 'a recording in progress is not complete');
assert.strictEqual(r(vod(3)).bytes_verified, true, 'its bytes on disk are verified all the same');
assert.deepStrictEqual([r(vod(4)).playable, r(vod(4)).reason], [false, 'failed']);
assert.deepStrictEqual([r(vod(5)).bytes_verified, r(vod(5)).reason], [false, 'no_verified_copy'], 'a missing local file is no copy at all');
assert.deepStrictEqual([r(clip(11)).playable, r(clip(12)).reason, r(clip(13)).reason], [true, 'processing', 'failed']);
console.log('✅ readiness: playable only for a finished vod/clip with a verified copy; the reason otherwise');

// Hashes: a checksum that contradicts content_hash is not a verified copy; a matching one is hash-verified.
const o1 = vod(1).object_id;
const loc1 = db.get("SELECT * FROM media_locations WHERE object_id = ? AND provider = 'local'", [o1]);
raw.prepare('UPDATE media_objects SET content_hash = ? WHERE id = ?').run('a'.repeat(64), o1);
raw.prepare('UPDATE media_locations SET checksum = ? WHERE id = ?').run('b'.repeat(64), loc1.id);
assert.deepStrictEqual([r(vod(1)).bytes_verified, r(vod(1)).playable, r(vod(1)).reason], [false, false, 'no_verified_copy'], 'a copy whose sha256 disagrees is not verified');
raw.prepare('UPDATE media_locations SET checksum = ? WHERE id = ?').run('a'.repeat(64), loc1.id);
assert.deepStrictEqual([r(vod(1)).playable, r(vod(1)).hash_verified], [true, true]);
raw.prepare("UPDATE media_locations SET state = 'corrupt' WHERE id = ?").run(loc1.id);
assert.strictEqual(r(vod(1)).playable, false, 'a copy the verification found corrupt is not verified');
// Back to the truth: the file's real sha256 on the object and its copy (what the object.hash job records).
const realHash = require('crypto').createHash('sha256').update(fs.readFileSync(loc1.key)).digest('hex');
raw.prepare("UPDATE media_objects SET content_hash = ? WHERE id = ?").run(realHash, o1);
raw.prepare("UPDATE media_locations SET state = 'present', checksum = ? WHERE id = ?").run(realHash, loc1.id);

// Deleted, and kinds that do not play.
const fileId = model.createObject({ app_id: 'games', kind: 'file', lifecycle_status: 'ready', visibility: 'public', size_bytes: 3 });
const fp = model.objectFilePath(model.getObject(fileId));
fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, 'abc');
model.upsertLocation(fileId, { provider: 'local', key: fp, state: 'present', size_bytes: 3, verified: true });
assert.deepStrictEqual([readiness.compute(model.getObject(fileId)).bytes_verified, readiness.compute(model.getObject(fileId)).reason], [true, 'not_playback_kind']);
const gone = model.createObject({ app_id: 'games', kind: 'vod', lifecycle_status: 'deleted', visibility: 'public', size_bytes: 3 });
assert.strictEqual(readiness.compute(model.getObject(gone)).reason, 'deleted');

// The SQL form (sitemap) agrees with compute() on every object.
for (const o of db.all('SELECT * FROM media_objects')) {
    const sql = !!db.get(`SELECT ${readiness.playableSql('?')} AS p`, [o.id]).p;
    assert.strictEqual(sql, readiness.compute(o).playable, `playableSql agrees for ${o.legacy_ref || o.id}`);
}
console.log('✅ readiness: hash contradictions, corrupt copies, deletion and non-playback kinds; playableSql() agrees');

(async () => {
    // ── The scheduled verification is what makes an offloaded VOD playable ──
    const o2 = vod(2).object_id;
    await verifyJob.runOnce({ batch: 50, head: async (provider) => (provider === 'b2' ? { size: 64 } : null), upload: async () => undefined });
    assert.deepStrictEqual([r(vod(2)).bytes_verified, r(vod(2)).playable, r(vod(2)).verified_copies], [true, true, ['b2']],
        'a HEAD with the right size verifies the B2 copy');
    raw.prepare("UPDATE media_locations SET state = 'pending', verified_at = NULL WHERE object_id = ?").run(o2);
    console.log('✅ readiness: an offloaded VOD becomes playable once its copy is verified');

    // ── HTTP: v1 JSON, v2 JSON, watch pages ──
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v2/:app/objects', require('../server/objects/routes'));
    app.use('/', require('../server/public/routes'));
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const get = (p, headers = {}) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
            let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) }));
        }).on('error', reject);
    });
    const key = { authorization: 'Bearer games-key' };
    const nav = { accept: 'text/html,*/*;q=0.8', 'sec-fetch-dest': 'document' };

    let res = await get('/api/v1/games/vods/1', key);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([res.json().status, res.json().readiness.playable], ['ready', true], 'GET /vods/:id carries readiness');
    res = await get('/api/v1/games/vods/2', key);
    assert.deepStrictEqual([res.json().status, res.json().readiness.playable, res.json().readiness.reason], ['ready', false, 'verification_pending'],
        'status stays as it was; readiness says the bytes are not verified');
    assert.ok(res.json().playback_url, 'existing fields are unchanged');
    res = await get('/api/v1/games/vods?include_recording=1', key);
    assert.ok(res.json().vods.every(v => v.readiness && typeof v.readiness.playable === 'boolean'), 'lists carry it too');
    res = await get('/api/v1/games/clips/12', key);
    assert.deepStrictEqual([res.json().status, res.json().readiness.reason], ['processing', 'processing']);
    res = await get(`/api/v2/games/objects/${vod(1).object_id}`, key);
    assert.deepStrictEqual(res.json().readiness, { metadata: true, bytes_verified: true, playable: true, hash_verified: true, verified_copies: ['local'], reason: null });
    res = await get('/api/v2/games/objects?kind=vod', key);
    assert.ok(res.json().objects.find(o => o.id === vod(2).object_id).readiness.reason === 'verification_pending', 'the v2 list carries it');
    console.log('✅ v1 VOD/clip JSON and v2 object JSON carry readiness (existing fields unchanged)');

    const hasPlayer = (html) => /<video[\s>]/.test(html);
    res = await get('/v/1', nav);
    assert.ok(hasPlayer(res.body) && res.body.includes('<meta property="og:video"'), 'a playable VOD gets its player');
    res = await get('/v/2', nav);
    assert.strictEqual(res.status, 200);
    assert.ok(!hasPlayer(res.body), 'no player for bytes nobody verified');
    assert.ok(res.body.includes('Still processing') && res.body.includes('data-readiness="verification_pending"'));
    assert.ok(res.body.includes('content="noindex, follow"') && !res.body.includes('og:video') && !res.body.includes('application/ld+json') && !res.body.includes(' download>'),
        'no index, no video metadata, no structured data, no download');
    res = await get('/v/3', nav);
    assert.ok(!hasPlayer(res.body) && res.body.includes('Still being recorded'));
    res = await get('/v/3?raw=1', {});
    assert.strictEqual(res.status, 200, 'the bytes of a recording still serve (Live\'s DVR reads them)');
    res = await get('/v/4', nav);
    assert.ok(!hasPlayer(res.body) && res.body.includes('could not be processed'));
    res = await get('/v/5', nav);
    assert.ok(!hasPlayer(res.body) && res.body.includes('No verified copy'));
    res = await get('/c/11', nav);
    assert.ok(hasPlayer(res.body), 'a cut clip plays');
    res = await get('/c/12', nav);
    assert.deepStrictEqual([res.status, hasPlayer(res.body), res.body.includes('still being cut')], [200, false, true], 'a clip being cut says so');
    res = await get('/c/12', { accept: 'video/webm,*/*;q=0.5', 'sec-fetch-dest': 'video' });
    assert.deepStrictEqual([res.status, res.json().error], [404, 'Not found'], 'its bytes are still a plain 404');
    res = await get('/c/13', nav);
    assert.ok(!hasPlayer(res.body) && res.body.includes('could not be cut'));
    console.log('✅ watch pages offer a player only when playable, and say why otherwise; the bytes route is unchanged');

    server.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('readiness: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
