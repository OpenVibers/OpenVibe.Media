'use strict';
// The DVR playlist of a recording in progress (vod/fmp4-index.js, /v/:id/dvr.m3u8): with real ffmpeg, a fragmented MP4
// written the way the recorder writes it (+frag_keyframe+empty_moov+default_base_moof) is indexed as it grows, a
// fragment cut off at the end of the file waits for its bytes, the playlist names the init segment and whole segments as
// slices of the file, the slices are the file's own bytes, and init + segments decode to the whole recording. Private,
// finished or out-of-range requests are 404s.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

(async () => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) {
        console.log('dvr playlist: skipped (ffmpeg not found)');
        process.exit(0);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-dvr-hls-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';

    const ffmpeg = (...args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); };
    const duration = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());
    // 12 s, a keyframe every second, H.264-less on purpose (mpeg4 + AAC, like dvr-seek.test.js): what matters is the box layout.
    const full = path.join(tmp, 'full.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=12:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=12',
        '-c:v', 'mpeg4', '-g', '10', '-c:a', 'aac', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', full);
    const bytes = fs.readFileSync(full);

    const fmp4 = require('../server/vod/fmp4-index');

    // The whole file.
    const whole = await fmp4.refresh(full);
    assert.ok(whole.initEnd > 0 && whole.initEnd < 4096, `init segment ${whole.initEnd} bytes`);
    assert.ok(whole.fragments.length >= 11 && whole.fragments.length <= 13, `${whole.fragments.length} fragments`);
    const total = whole.fragments.reduce((s, f) => s + f.duration, 0);
    assert.ok(Math.abs(total - 12) < 0.3, `fragments cover ${total} s`);
    assert.strictEqual(whole.fragments[0].offset, whole.initEnd, 'the first fragment follows the init segment');
    for (let i = 1; i < whole.fragments.length; i++) {
        const a = whole.fragments[i - 1], b = whole.fragments[i];
        assert.strictEqual(b.offset, a.offset + a.length, 'fragments are contiguous');
        assert.ok(Math.abs(b.start - (a.start + a.duration)) < 0.05, 'times follow on');
    }
    const segs = fmp4.segments(whole.fragments, 6);
    assert.strictEqual(segs.length, 2, 'two ~6 s segments');
    assert.ok(segs.every((s) => s.duration >= 5.9), 'each segment at least the target');

    // Growing: half the file, a fragment cut off mid-way, then the rest.
    const growing = path.join(process.env.VOD_PATH, 'vod-live-7.mp4');
    const cut = whole.fragments[5].offset + Math.floor(whole.fragments[5].length / 2);
    fs.writeFileSync(growing, bytes.subarray(0, cut));
    const part = await fmp4.refresh(growing);
    assert.strictEqual(part.fragments.length, 5, 'the cut-off fragment is not indexed');
    fs.appendFileSync(growing, bytes.subarray(cut));
    const grown = await fmp4.refresh(growing);
    assert.deepStrictEqual(grown.fragments.map((f) => [f.offset, f.length]), whole.fragments.map((f) => [f.offset, f.length]), 'the next read finishes it');

    // Routes.
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    fmp4.forget(growing);
    fs.writeFileSync(growing, bytes.subarray(0, cut));   // still being written
    await db.run(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, is_recording) OVERRIDING SYSTEM VALUE
                  VALUES (7, 'live', 5, 'Still live', ?, 1, 'public', 1)`, [growing]);
    const priv = path.join(process.env.VOD_PATH, 'vod-live-8.mp4');
    fs.writeFileSync(priv, bytes);
    await db.run(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, is_recording) OVERRIDING SYSTEM VALUE
                  VALUES (8, 'live', 5, 'Private live', ?, 0, 'private', 1)`, [priv]);
    const express = require('express');
    const app = express();
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }; };

    let pl = await get('/v/7/dvr.m3u8');
    assert.strictEqual(pl.status, 200);
    assert.match(pl.headers.get('content-type'), /mpegurl/);
    assert.strictEqual(pl.headers.get('access-control-allow-origin'), '*');
    assert.match(pl.headers.get('cache-control'), /no-store/);
    let text = pl.body.toString();
    assert.match(text, /#EXT-X-PLAYLIST-TYPE:EVENT/);
    assert.match(text, /#EXT-X-MAP:URI="dvr\/init.mp4"/);
    assert.ok(!/#EXT-X-ENDLIST/.test(text), 'still recording: no end');
    const uris = () => text.split('\n').filter((l) => l.startsWith('dvr/') && l.endsWith('.m4s'));
    assert.strictEqual(uris().length, 1, 'five fragments so far: one ~6 s segment is not yet full, so one open segment');

    const init = await get('/v/7/dvr/init.mp4');
    assert.strictEqual(init.status, 200);
    assert.ok(init.body.equals(bytes.subarray(0, whole.initEnd)), 'the init segment is the file\'s head');
    const seg = await get(`/${'v/7/'}${uris()[0]}`);
    assert.strictEqual(seg.status, 200);
    assert.strictEqual(seg.headers.get('content-type'), 'video/iso.segment');
    const [, o, l] = /dvr\/(\d+)-(\d+)\.m4s/.exec(uris()[0]).map(Number);
    assert.ok(seg.body.equals(bytes.subarray(o, o + l)), 'a segment is the file\'s own bytes');
    assert.strictEqual((await get(`/v/7/dvr/${cut}-100.m4s`)).status, 404, 'never bytes still being written');
    assert.strictEqual((await get('/v/7/dvr/0-100.m4s')).status, 404, 'not the init segment as a media segment');
    assert.strictEqual((await get('/v/7/dvr/x.m4s')).status, 404);

    // The rest arrives: the playlist grows; init + every segment decode to the whole recording.
    fs.appendFileSync(growing, bytes.subarray(cut));
    text = (await get('/v/7/dvr.m3u8')).body.toString();
    assert.strictEqual(uris().length, 2);
    const joined = path.join(tmp, 'joined.mp4');
    const parts = [init.body];
    for (const u of uris()) parts.push((await get(`/v/7/${u}`)).body);
    fs.writeFileSync(joined, Buffer.concat(parts));
    assert.ok(Math.abs(duration(joined) - 12) < 0.3, `init + segments play ${duration(joined)} s`);

    // Private, finished, missing: 404 like /v/:id's own answers.
    assert.strictEqual((await get('/v/8/dvr.m3u8')).status, 404, 'a private recording has no open playlist');
    await db.run('UPDATE vods SET is_recording = 0 WHERE id = 7');
    assert.strictEqual((await get('/v/7/dvr.m3u8')).status, 404, 'finished: /v/:id serves it');
    assert.strictEqual((await get('/v/999/dvr.m3u8')).status, 404);

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('dvr playlist: indexing as it grows, the playlist, slices of the file, and a decodable whole all pass');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
