'use strict';
// Plan §9 gate: seek works during an active DVR. A recording still being written is a fragmented MP4
// (frag_keyframe+empty_moov, as the recorder writes it); Live's DVR player reads it through /v/:id, which
// serves the live seek snapshot (remuxForLiveSeeking: one copy-remux, the whole index after the media). Here
// with real ffmpeg: the snapshot of a recording mid-stream answers ranged reads from any offset with no-cache,
// carries one whole index (a player reads a tail moov with one range request), and a player can seek to a late
// moment in it; after the recording grows, the next snapshot reaches the new live edge and keeps the earlier
// samples at the same offsets; once finalized, /v/:id serves the recording itself again.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

(async () => {
    // Like cmaf-transcode.test.js: real encodes need ffmpeg/ffprobe, which CI may not have.
    if (spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) {
        console.log('dvr seek: skipped (ffmpeg not found)');
        process.exit(0);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-dvr-seek-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';

    const ffmpeg = (...args) => {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
    };
    const duration = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());
    // A recording `seconds` long, written the way the recorder writes a growing MP4 (a keyframe every second).
    const record = (file, seconds) => ffmpeg('-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=160x90:rate=10`,
        '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:v', 'mpeg4', '-g', '10', '-c:a', 'aac',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', file);

    const db = require('../server/db/database');
    const tools = require('../server/vod/media-tools');
    const express = require('express');

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const rec = path.join(process.env.VOD_PATH, 'vod-live-7.mp4');
    record(rec, 4);
    await db.run(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, is_recording) OVERRIDING SYSTEM VALUE
                  VALUES (7, 'live', 5, 'Still live', ?, 1, 'public', 1)`, [rec]);

    const app = express();
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (range) => {
        const res = await fetch(`${base}/v/7`, { headers: range ? { range } : {}, redirect: 'manual' });
        return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
    };
    // A pass is paced (the next may start only after 9× the last one's run time): retry until one runs.
    const snapshot = async () => {
        for (let i = 0; i < 200; i++) {
            if (await tools.remuxForLiveSeeking(rec)) return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return false;
    };
    const ok = [];
    const check = async (name, fn) => { await fn(); ok.push(name); };

    try {
        const sidecar = tools.seekableSidecarPath(rec);
        await check('mid-recording, /v/:id serves the seek snapshot: ranged, uncached, one whole index after its media', async () => {
            assert.ok(await snapshot(), 'the first snapshot ran');
            const size = fs.statSync(sidecar).size;
            const whole = await get('bytes=0-');
            assert.strictEqual(whole.status, 206);
            assert.match(whole.headers.get('cache-control'), /no-cache/);
            assert.strictEqual(whole.headers.get('content-range'), `bytes 0-${size - 1}/${size}`);
            assert.ok(whole.body.equals(fs.readFileSync(sidecar)), 'the snapshot, not the growing file');
            const moov = whole.body.indexOf('moov'), mdat = whole.body.indexOf('mdat');
            assert.ok(mdat > 0 && moov > mdat, `the index follows the media, written in one pass (moov ${moov}, mdat ${mdat})`);
            assert.strictEqual(whole.body.indexOf('moof'), -1, 'one whole index, not fragments a player must walk');
            // A seek lands mid-file: the player asks for a range starting there.
            const mid = Math.floor(size / 2);
            const part = await get(`bytes=${mid}-${mid + 999}`);
            assert.strictEqual(part.status, 206);
            assert.strictEqual(part.headers.get('content-range'), `bytes ${mid}-${mid + 999}/${size}`);
            assert.ok(part.body.equals(whole.body.subarray(mid, mid + 1000)));
        });

        await check('a player seeks to a late moment of the snapshot it was served', async () => {
            const served = path.join(tmp, 'served.mp4');
            fs.writeFileSync(served, (await get()).body);
            assert.ok(Math.abs(duration(served) - 4) < 0.5, `the snapshot covers what was recorded: ${duration(served)} s`);
            const r = spawnSync('ffprobe', ['-v', 'error', '-read_intervals', '3.5%+0.5', '-select_streams', 'v', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', served], { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            const times = r.stdout.trim().split('\n').map(Number).filter(Number.isFinite);
            assert.ok(times.length > 0 && times[0] >= 2.9 && times[0] < 3.6, `seeking to 3.5 s decodes from its keyframe (3 s), not the start: ${times.slice(0, 3)}`);
        });

        await check('as the recording grows, the next snapshot reaches the new live edge, earlier samples where they were', async () => {
            const earlier = fs.readFileSync(path.join(tmp, 'served.mp4'));
            record(rec, 8);
            assert.ok(await snapshot(), 'the next snapshot ran');
            const served = path.join(tmp, 'served-later.mp4');
            fs.writeFileSync(served, (await get()).body);
            assert.ok(Math.abs(duration(served) - 8) < 0.5, `the later snapshot covers 8 s: ${duration(served)} s`);
            // A player that started on the earlier snapshot keeps reading ranges after the swap: the media before the
            // earlier snapshot's tail (its last fragment can be cut differently) is byte-identical in the later one.
            const later = fs.readFileSync(served);
            const from = earlier.indexOf('mdat') + 4, to = Math.floor(earlier.indexOf('moov') * 0.8);
            assert.ok(to > from && earlier.subarray(from, to).equals(later.subarray(from, to)), `the earlier media sits at the same offsets (${from}-${to})`);
        });

        await check('once finalized, /v/:id serves the recording itself, cacheable again', async () => {
            await db.run('UPDATE vods SET is_recording = 0 WHERE id = 7');
            const res = await get('bytes=0-');
            assert.strictEqual(res.status, 206);
            assert.ok(res.body.equals(fs.readFileSync(rec)), 'the recording, not the snapshot');
            assert.doesNotMatch(res.headers.get('cache-control') || '', /no-cache/);
        });
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`dvr seek: ${ok.length} checks passed`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
