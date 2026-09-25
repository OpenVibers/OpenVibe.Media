'use strict';
// object.waveform and object.sprite (WS-G task 13): preview variants made as jobs through the jobs API.
// Each makes a private `asset` object (PNG / JPEG) derived from the source and recorded as its variant;
// the sprite's layout (frames, interval, grid, tile size) is in its metadata and matches the image; a
// source with no audio has no waveform and one with no video no sprite (permanent failures); the source
// is untouched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-previews-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.FILES_PATH = dir('files');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');
process.env.MEDIA_JOBS_POLL_MS = '50';
process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';
process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';
const stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        res.statusCode = 404; res.end('{}');
    });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const size = (file) => { const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }); return r.stdout.trim(); };

(async () => {
    // The layout alone: at most one frame per 2 s, a full grid, 16:9 tiles.
    const { spriteLayout } = require('../server/jobs/previews');
    assert.deepStrictEqual(spriteLayout(6, { frames: 100, columns: 10, tile_width: 160 }), { count: 3, interval_seconds: 2, columns: 3, rows: 1, tile_width: 160, tile_height: 90 });
    assert.deepStrictEqual(spriteLayout(43083, { frames: 100, columns: 10, tile_width: 160 }), { count: 100, interval_seconds: 430.83, columns: 10, rows: 10, tile_width: 160, tile_height: 90 });
    assert.strictEqual(spriteLayout(1, { frames: 100, columns: 10, tile_width: 160 }).count, 1);
    if (!hasFfmpeg) { console.log('⚠️  ffmpeg not found: preview jobs skipped'); process.exit(0); }

    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    const conn = db.getDb();
    db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const events = require('../server/events');
    events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 });
    const model = require('../server/objects/model');
    const queue = require('../server/jobs/queue');
    const worker = require('../server/jobs/worker');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, { body } = {}) => {
        const res = await fetch(api + p, { method, headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    worker.start();

    // Sources: a 20 s VOD with sound, a silent clip file, and an audio-only file.
    const mk = (name, args) => { const f = path.join(process.env.VOD_PATH, name); const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, f]); assert.strictEqual(r.status, 0, String(r.stderr)); return f; };
    const av = mk('rec-20.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=20:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:v', 'mpeg4', '-g', '10', '-c:a', 'aac', '-shortest']);
    conn.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, is_public, duration_seconds) VALUES (20, 'live', 5, 'Twenty seconds', ?, ?, 1, 20)").run(av, fs.statSync(av).size);
    const vodObj = model.sync('vod', 20).id;
    const before = JSON.stringify([model.getObject(vodObj), model.listLocations(vodObj)]);
    const native = (file, mime) => {
        const id = model.createObject({ app_id: 'live', owner_user_id: 5, lifecycle_status: 'ready', kind: 'file', mime_type: mime, size_bytes: fs.statSync(file).size, metadata: { duration_seconds: 6 } });
        model.upsertLocation(id, { provider: 'local', key: file, state: 'present', size_bytes: fs.statSync(file).size, verified: true });
        return id;
    };
    const silent = native(mk('silent.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=10', '-c:v', 'mpeg4']), 'video/mp4');
    const audio = native(mk('tone.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'aac']), 'audio/mp4');

    const runJob = async (type, objectId, params) => {
        const r = await call('POST', '/api/v2/live/jobs', { body: { type, object_id: objectId, ...(params && { params }) } });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        const fin = await waitFor(() => ["succeeded", "failed"].includes(queue.get(r.body.job.id).status));
        assert.ok(fin, `${type} finishes: ${JSON.stringify(queue.jobPublic(queue.get(r.body.job.id)))}`);
        return queue.jobPublic(queue.get(r.body.job.id));
    };

    // ── Waveform ──
    const w = await runJob('object.waveform', 'legacy:live:vod:20');
    assert.strictEqual(w.status, 'succeeded', JSON.stringify(w.error));
    const wo = model.getObject(w.result.object_id);
    assert.deepStrictEqual([wo.kind, wo.mime_type, wo.visibility, wo.lifecycle_status, wo.owner_user_id], ['asset', 'image/png', 'private', 'ready', 5]);
    const wloc = model.listLocations(wo.id)[0];
    assert.strictEqual(size(wloc.key), '1800,140', 'the default waveform size');
    assert.strictEqual(model.getVariant(vodObj, 'waveform').derived_object_id, wo.id);
    assert.ok(/-waveform\.png$/.test(model.parseJson(wo.metadata, {}).filename));

    const w2 = await runJob('object.waveform', vodObj, { width: 400, height: 60 });
    assert.strictEqual(size(model.listLocations(w2.result.object_id)[0].key), '400,60');
    assert.strictEqual(model.getVariant(vodObj, 'waveform').derived_object_id, w2.result.object_id, 'a new waveform replaces the variant');

    const ws = await runJob('object.waveform', silent);
    assert.strictEqual(ws.status, 'failed');
    assert.strictEqual(ws.error_code, 'no_audio', ws.error);
    assert.strictEqual(ws.attempts, 1, 'no retry: it is permanent');

    // ── Sprite ──
    const s = await runJob('object.sprite', vodObj);
    assert.strictEqual(s.status, 'succeeded', JSON.stringify(s.error));
    assert.deepStrictEqual(s.result.sprite, { count: 10, interval_seconds: 2, columns: 10, rows: 1, tile_width: 160, tile_height: 90 });
    const so = model.getObject(s.result.object_id);
    assert.deepStrictEqual([so.kind, so.mime_type, so.visibility], ['asset', 'image/jpeg', 'private']);
    assert.strictEqual(size(model.listLocations(so.id)[0].key), '1600,90', 'the image is the layout: 10 × 160 by 1 × 90');
    assert.deepStrictEqual(model.parseJson(so.metadata, {}).sprite, s.result.sprite, 'the layout is in the metadata');
    assert.strictEqual(model.getVariant(vodObj, 'sprite').derived_object_id, so.id);

    const s2 = await runJob('object.sprite', silent, { frames: 4, columns: 2, tile_width: 96 });
    assert.strictEqual(s2.status, 'succeeded', JSON.stringify(s2.error));
    assert.deepStrictEqual([s2.result.sprite.count, s2.result.sprite.rows], [3, 2], '6 s: 3 frames on a 2-column grid');
    assert.strictEqual(size(model.listLocations(s2.result.object_id)[0].key), '192,108');

    const sa = await runJob('object.sprite', audio);
    assert.strictEqual(sa.status, 'failed');
    assert.strictEqual(sa.error_code, 'no_video', sa.error);

    const bad = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.sprite', object_id: vodObj, params: { frames: 1 } } });
    assert.strictEqual(bad.status, 400, 'params are checked when the job is asked for');

    assert.strictEqual(JSON.stringify([model.getObject(vodObj), model.listLocations(vodObj)]), before, 'the source is untouched');
    assert.strictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.jobs')).length, 0, 'work directories are removed');

    worker.stop();
    events._reset();
    server.close();
    stub.close();
    console.log('jobs-previews: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
