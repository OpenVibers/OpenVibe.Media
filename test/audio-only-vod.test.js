'use strict';
// R4: an audio-only recording has no frame to take, so its picture is the streamer's avatar card (or a microphone
// when there is none) over the site's dark gradient, with an "Audio" mark. The row says audio_only once, from the one
// ffprobe in the thumbnail job, and the card is served from /t/ like any other thumbnail. A clip of such a recording
// carries the same flag and gets the same card.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-audio-only-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_INVARIANT_SCAN_HOURS: '0',
    });

    const ffmpeg = spawnSync('ffmpeg', ['-version']);
    if (ffmpeg.status !== 0) {
        console.log('audio-only card: skipped (ffmpeg not found)');
        process.exit(0);
    }

    const db = require('../server/db/database');
    const thumbs = require('../server/thumbnails/thumbnail-service');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-audio-card' });

    const audio = path.join(process.env.VOD_PATH, 'audio.webm');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus', audio]);
    assert.strictEqual(made.status, 0, String(made.stderr));
    assert.strictEqual(await thumbs.hasVideoStream(audio), false, 'the probe says the source has no video');

    const vodId = Number((await db.run(`INSERT INTO vods (app_id, user_id, title, file_path, file_size, duration_seconds, is_public, visibility, health_status)
        VALUES ('live', 7, 'A microphone on a dark night', ?, ?, 3, 1, 'public', 'ok') RETURNING id`, [audio, fs.statSync(audio).size])).lastInsertRowid);
    const url = await thumbs.generateVodThumbnail(vodId, audio, { audioOnly: true });
    assert.match(url, new RegExp(`^/t/vod-${vodId}-\\d+\\.jpg$`));
    const row = await db.get('SELECT audio_only, thumbnail_url FROM vods WHERE id = ?', [vodId]);
    assert.deepStrictEqual([row.audio_only, row.thumbnail_url], [true, url], 'the row says audio_only and names the card');
    const file = path.join(process.env.THUMBNAILS_PATH, path.basename(url));
    const bytes = fs.readFileSync(file);
    assert.deepStrictEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], 'a real JPEG, not a 1×1 fallback');
    const meta = await require('sharp')(file).metadata();
    assert.deepStrictEqual([meta.width, meta.height], [1280, 720], 'a card-shaped 16:9 thumbnail');

    // The public /t/ route serves it, so Live's and Video's cards never show a hole.
    const server = http.createServer((req, res) => {
        req.params = { id: decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/t\//, '')) };
        req.query = {};
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (b) => res.end(JSON.stringify(b));
        thumbs.serveThumbnail(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const got = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    assert.strictEqual(got.status, 200, 'served, not 404');
    assert.strictEqual(got.headers.get('content-type'), 'image/jpeg');
    assert.deepStrictEqual([...Buffer.from(await got.arrayBuffer()).subarray(0, 2)], [0xff, 0xd8]);

    // A clip of it is audio-only too: the same card, under /t/clip-.
    const clipId = Number((await db.run(`INSERT INTO clips (app_id, vod_id, user_id, channel_user_id, title, file_path, start_time, end_time, duration_seconds, is_public, visibility, status, audio_only)
        VALUES ('live', ?, 7, 7, 'A clip of the microphone', ?, 0, 3, 3, 1, 'public', 'ready', true) RETURNING id`, [vodId, audio])).lastInsertRowid);
    const clipUrl = await thumbs.generateClipThumbnail(clipId, audio);
    assert.match(clipUrl, new RegExp(`^/t/clip-${clipId}-\\d+\\.jpg$`));
    assert.strictEqual((await db.get('SELECT audio_only FROM clips WHERE id = ?', [clipId])).audio_only, true);
    assert.ok(fs.existsSync(path.join(process.env.THUMBNAILS_PATH, path.basename(clipUrl))));

    server.close();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('✅ audio-only VOD/clip: probe without video → stored audio_only, avatar card served from /t/ (not 404)');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
