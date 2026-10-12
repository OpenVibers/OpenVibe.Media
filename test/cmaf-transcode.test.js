'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cmaf-transcode-'));
    const dir = (name) => { const p = path.join(tmp, name); fs.mkdirSync(p, { recursive: true }); return p; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_HLS_ENABLED: '1', MEDIA_CMAF_TRANSCODE: '0',
        MEDIA_UPLOAD_MIN_FREE_MB: '0', MEDIA_INVARIANT_SCAN_HOURS: '0',
    });
    for (const p of ['B2', 'R2']) for (const k of ['ENDPOINT', 'BUCKET', 'KEY_ID', 'APP_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) process.env[`MEDIA_${p}_${k}`] = '';
    const ffmpeg = (...args) => {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
    };
    const probe = (file) => {
        const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', file], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        return JSON.parse(r.stdout).streams.map((s) => s.codec_name);
    };
    try {
        const config = require('../server/config');
        const db = require('../server/db/database');
        const model = require('../server/objects/model');
        const timeline = require('../server/objects/timeline');
        const cmaf = require('../server/jobs/cmaf');
        const queue = require('../server/jobs/queue');
        const { queueCmaf } = require('../server/objects/timeline-queue');
        await db.upsertApp({ app_id: 'live', api_key: 'cmaf-test' });
        const webm = path.join(tmp, 'browser.webm');
        const mp4 = path.join(tmp, 'compatible.mp4');
        const audioOnly = path.join(tmp, 'audio.m4a');
        ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=7:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=7',
            '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', webm);
        ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=7:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=7',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4);
        ffmpeg('-f', 'lavfi', '-i', 'sine=duration=7', '-c:a', 'aac', audioOnly);
        const object = async (file, mime) => {
            const id = await model.createObject({ app_id: 'live', owner_user_id: 1, visibility: 'public', lifecycle_status: 'ready',
                kind: 'file', mime_type: mime, size_bytes: fs.statSync(file).size });
            await model.upsertLocation(id, { provider: 'local', key: file, state: 'present', size_bytes: fs.statSync(file).size, verified: true });
            return id;
        };
        const browser = await object(webm, 'video/webm');
        const compatible = await object(mp4, 'video/mp4');
        const onlyAudio = await object(audioOnly, 'audio/mp4');
        const run = async (id, suffix) => await cmaf.spec.run({ id: `mjob_${suffix}`, app_id: 'live', object_id: id, params: { segment_seconds: 2 } },
            { signal: new AbortController().signal });
        await assert.rejects(run(browser, 'off'), (e) => e.code === 'codec_unsupported' && e.permanent);
        config.hls.transcode = true;
        config.hls.transcodeMaxSeconds = 1;
        await assert.rejects(run(browser, 'long'), (e) => e.code === 'too_long_to_transcode' && e.permanent);
        config.hls.transcodeMaxSeconds = 14400;
        const made = await run(browser, 'on');
        assert.deepStrictEqual([made.video, made.audio], ['h264', 'aac']);
        const rows = await timeline.list(browser, 'source');
        assert.ok(rows.length >= 3);
        const joined = path.join(tmp, 'segment.mp4');
        fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(rows[0].local_path), fs.readFileSync(rows[1].local_path)]));
        assert.deepStrictEqual(probe(joined).sort(), ['aac', 'h264']);
        const meta = model.parseJson((await model.getObject(browser)).metadata, {}).renditions.source;
        const master = timeline.masterPlaylist([{ name: 'source', rows, meta }]);
        assert.match(master, /CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2"/);
        const copied = await run(compatible, 'copy');
        assert.deepStrictEqual([copied.video, copied.audio], ['copy', 'copy']);
        const audioResult = await run(onlyAudio, 'audio');
        assert.deepStrictEqual([audioResult.video, audioResult.audio], ['copy', 'copy'], 'audio-only input keeps the copy path');

        // An old failed copy gets one distinct lazy retry. A failed retry settles under its own key.
        const old = await object(webm, 'video/webm');
        config.hls.transcode = false;
        const first = await queueCmaf('live', old);
        await db.run("UPDATE media_jobs SET status = 'failed', error_code = 'codec_unsupported' WHERE id = ?", [first]);
        config.hls.transcode = true;
        const retry = await queueCmaf('live', old, { lazy: true });
        assert.notStrictEqual(retry, first);
        const retryRow = await queue.get(retry);
        assert.strictEqual(retryRow.idempotency_key, `object.cmaf:${old}:transcode`);
        await db.run("UPDATE media_jobs SET status = 'failed', error_code = 'codec_unsupported' WHERE id = ?", [retry]);
        assert.strictEqual(await queueCmaf('live', old, { lazy: true }), retry);
        assert.strictEqual((await db.all("SELECT id FROM media_jobs WHERE object_id = ? AND job_type = 'object.cmaf'", [old])).length, 2);
        const fresh = await object(webm, 'video/webm');
        const freshJob = await queueCmaf('live', fresh, { lazy: true });
        await db.run("UPDATE media_jobs SET status = 'failed', error_code = 'codec_unsupported' WHERE id = ?", [freshJob]);
        assert.strictEqual(await queueCmaf('live', fresh, { lazy: true }), freshJob, 'a new transcode-on failure does not retry');
        config.hls.backfillPerHour = 0;
        assert.strictEqual(await queueCmaf('live', old, { lazy: true }), null, 'the retry still respects the lazy cap');
        console.log('✅ CMAF transcode, copy, duration cap, codecs and one lazy retry');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
