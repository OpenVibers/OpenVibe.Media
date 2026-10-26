'use strict';
// ?download on /v/:id and /c/:id (server/public/routes.js): the bytes as an attachment, so a browser saves them instead
// of playing them (OpenVibe.Video's Download menu, through Live's download-url).
// - A file on disk: Content-Disposition attachment, named after ?name with the file's extension (path, quote and
//   control characters dropped; the UTF-8 name too); without ?download nothing changes; a Range still works.
// - A copy in B2/R2: the store's own presigned URL, asked with that disposition (never the shield).
// - A virtual clip (no file of its own): its playlist remuxed into one MP4 as it is sent, with real ffmpeg over loopback;
//   a playlist that cannot be read is a 502 with nothing sent; more than two at once wait (503).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('media downloads: skipped (ffmpeg not found)'); process.exit(0); }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-downloads-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_HLS_ENABLED = '1';
    const port = await freePort();
    process.env.PORT = String(port);   // the remux reads the clip's playlist from this service over loopback

    const ffmpeg = (...args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); };
    const vodFile = path.join(process.env.VOD_PATH, 'vod-live-7-1.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=4:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'mpeg4', '-c:a', 'aac', vodFile);
    // A clip's HLS (fMP4 segments, as Media's timeline serves them) for the virtual clip's playlist.
    const hls = dir('hls');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=6:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=6', '-c:v', 'mpeg4', '-g', '10', '-c:a', 'aac',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', path.join(hls, '%06d.m4s'), path.join(hls, 'index.m3u8'));

    const config = require('../server/config');
    assert.strictEqual(config.port, port);
    config.hls.enabled = true;
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.run(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, is_recording) OVERRIDING SYSTEM VALUE
                  VALUES (7, 'live', 5, 'Seven', ?, 1, 'public', 0)`, [vodFile]);
    await db.run(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, is_recording, storage_provider, storage_key) OVERRIDING SYSTEM VALUE
                  VALUES (8, 'live', 5, 'In the cloud', 'vod-live-8-1.mp4', 1, 'public', 0, 'b2', 'vods/vod-live-8-1.mp4')`);
    for (const [id, obj] of [[60, 'med_virtual_ok'], [61, 'med_virtual_bad']]) {
        await db.run(`INSERT INTO clips (id, app_id, user_id, vod_id, title, status, visibility, is_public, storage_provider, object_id) OVERRIDING SYSTEM VALUE
                      VALUES (?, 'live', 5, 7, 'Virtual', 'ready', 'public', 1, 'timeline', ?)`, [id, obj]);
    }

    const vodStorage = require('../server/vod/vod-storage');
    const presigned = [];
    vodStorage.resolvePlayback = async () => ({ kind: 'redirect', url: 'https://b2.test/plain', provider: 'b2', fallbacks: [] });
    vodStorage.presignGet = async (provider, key, ttl, overrides = {}) => { presigned.push({ provider, key, ttl, ...overrides }); return 'https://b2.test/signed'; };

    const express = require('express');
    const app = express();
    // The clip's playlist and segments, as Media's /o/:id/source/ routes would answer them (only the good object).
    let held = null;
    app.get('/o/med_virtual_ok/source/:name', (req, res, next) => (held ? held.push(next) : next()), (req, res) => {
        const f = path.join(hls, path.basename(req.params.name));
        if (!fs.existsSync(f)) return res.status(404).end();
        res.sendFile(f);
    });
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    const base = `http://127.0.0.1:${port}`;
    const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers, redirect: 'manual' }); return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }; };
    const raw = { accept: 'video/*' };   // a player's request: the bytes, not the watch page

    // A file on disk.
    const plain = await get('/v/7', raw);
    assert.strictEqual(plain.status, 200);
    assert.strictEqual(plain.headers.get('content-disposition'), null, 'playback is unchanged');
    const dl = await get(`/v/7?download=1&name=${encodeURIComponent('Seven — "best"/bits')}`, raw);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.headers.get('content-disposition'), 'attachment; filename="Seven _ best bits.mp4"; filename*=UTF-8\'\'Seven%20%E2%80%94%20best%20bits.mp4');
    assert.ok(dl.body.equals(fs.readFileSync(vodFile)), 'the whole file');
    const ranged = await get('/v/7?download=1', { ...raw, range: 'bytes=0-99' });
    assert.strictEqual(ranged.status, 206);
    assert.strictEqual(ranged.body.length, 100);
    assert.strictEqual(ranged.headers.get('content-disposition'), 'attachment; filename="vod-7.mp4"; filename*=UTF-8\'\'vod-7.mp4', 'no ?name: vod-<id>');
    const navigated = await get('/v/7?download=1', { accept: 'text/html', 'sec-fetch-dest': 'document' });
    assert.strictEqual(navigated.headers.get('content-disposition') !== null, true, 'a browser navigation with ?download gets the file, not the watch page');

    // A copy in the cloud: presigned with the disposition, not the plain playback URL.
    const cloud = await get('/v/8?download=1&name=Cloud', raw);
    assert.strictEqual(cloud.status, 302);
    assert.strictEqual(cloud.headers.get('location'), 'https://b2.test/signed');
    assert.deepStrictEqual(presigned.pop(), { provider: 'b2', key: 'vods/vod-live-8-1.mp4', ttl: 900, contentDisposition: 'attachment; filename="Cloud.mp4"; filename*=UTF-8\'\'Cloud.mp4' });
    const play = await get('/v/8', raw);
    assert.strictEqual(play.headers.get('location'), 'https://b2.test/plain', 'playback keeps its own URL');

    // A virtual clip: one MP4 remuxed from its playlist.
    const clip = await get('/c/60?download=1&name=Virtual', raw);
    assert.strictEqual(clip.status, 200, clip.body.toString().slice(0, 200));
    assert.strictEqual(clip.headers.get('content-type'), 'video/mp4');
    assert.strictEqual(clip.headers.get('content-disposition'), 'attachment; filename="Virtual.mp4"; filename*=UTF-8\'\'Virtual.mp4');
    const out = path.join(tmp, 'virtual.mp4');
    fs.writeFileSync(out, clip.body);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'compact', out], { encoding: 'utf8' }).stdout;
    assert.ok(/codec_type=video/.test(probe) && /codec_type=audio/.test(probe), probe);
    const dur = Number((/duration=([\d.]+)/.exec(probe) || [])[1]);
    assert.ok(Math.abs(dur - 6) < 0.5, `the whole clip (${dur} s)`);
    const bad = await get('/c/61?download=1', raw);
    assert.strictEqual(bad.status, 502, 'a playlist that cannot be read');
    assert.deepStrictEqual(JSON.parse(bad.body.toString()), { error: 'The clip could not be prepared for download' });

    // Two at once at most: a third waits.
    held = [];
    const first = [get('/c/60?download=1', raw), get('/c/60?download=1', raw)];
    while (held.length < 2) await new Promise((r) => setTimeout(r, 20));
    const third = await get('/c/60?download=1', raw);
    assert.strictEqual(third.status, 503);
    assert.strictEqual(third.headers.get('retry-after'), '5');
    const waiting = held; held = null; waiting.forEach((next) => next());
    for (const r of await Promise.all(first)) assert.strictEqual(r.status, 200);

    server.close();
    console.log('media downloads: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
