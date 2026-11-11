'use strict';
// Hover previews (plan 355): preview.make writes a 6 s, 320 px, muted MP4 H.264 and WebM beside the thumbnail,
// under 400 KB, starting at a moment with motion; the backfill queues public items only, newest first; the seek
// ladder moves past a black frame instead of leaving the item without a picture.
//   node --import ./test/helpers/pg-preload.mjs test/preview-hover.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-preview-hover-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
        MEDIA_INVARIANT_SCAN_HOURS: '0', MEDIA_JOBS_ENABLED: '0', MEDIA_UPLOAD_MIN_FREE_MB: '0',
    });

    const db = require('../server/db/database');
    const previewJob = require('../server/jobs/preview');
    const thumbService = require('../server/thumbnails/thumbnail-service');
    const previewService = require('../server/thumbnails/preview-service');
    const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

    // ── The seek ladder and the range parser, no ffmpeg needed ──
    assert.deepStrictEqual(thumbService.frameSeekCandidates(0.8), [0.4, 0.1, 0]);
    assert.strictEqual(thumbService.frameSeekCandidates(60)[0], 6, 'a minute-long item is grabbed at 10%, not second 0');
    assert.ok(thumbService.frameSeekCandidates(2)[0] >= 0.5, 'a two-second item is not grabbed at 0');
    assert.deepStrictEqual(thumbService.frameSeekCandidates(0, { liveEdge: true, lastPts: 42 }), [39, 41, 0.5]);
    assert.strictEqual(thumbService.frameSeekCandidates(60).length, new Set(thumbService.frameSeekCandidates(60)).size, 'no duplicate seeks');
    assert.deepStrictEqual(previewService.parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepStrictEqual(previewService.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.strictEqual(previewService.parseRange('bytes=1000-', 1000), null);
    assert.deepStrictEqual(previewJob.pickWindow(60), { len: 6, anchor: 6 });
    assert.deepStrictEqual(previewJob.pickWindow(3), { len: 3, anchor: 0 });

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const VIDEO = path.join(process.env.VOD_PATH, 'bright.mp4');
    const LEADER = path.join(process.env.VOD_PATH, 'black-leader.mp4');
    if (hasFfmpeg) {
        assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x180:rate=15',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VIDEO], { stdio: 'ignore' }).status, 0);
        // Two seconds of black, then six seconds of moving test pattern: the first seek candidate is black.
        assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2:r=15',
            '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=15',
            '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', LEADER], { stdio: 'ignore' }).status, 0);
    }

    async function insertVod({ title, file = VIDEO, thumb = '/t/vod-present-1.jpg', audio = false, isPublic = true, created_at = new Date(Date.now() - 3600 * 1000).toISOString(), duration = 8 }) {
        const id = Number((await db.run(`INSERT INTO vods (app_id, title, file_path, file_size, duration_seconds, thumbnail_url, health_status,
                is_recording, is_public, visibility, audio_only, created_at)
            VALUES ('live', ?, ?, ?, ?, ?, 'ok', 0, ?, ?, ?, ?) RETURNING id`,
        [title, file, file && fs.existsSync(file) ? fs.statSync(file).size : 0, duration, thumb,
            isPublic ? 1 : 0, isPublic ? 'public' : 'private', !!audio, created_at])).lastInsertRowid);
        return id;
    }
    async function insertClip({ title, isPublic = true, created_at = new Date(Date.now() - 3600 * 1000).toISOString(), vodId = null }) {
        return Number((await db.run(`INSERT INTO clips (app_id, title, vod_id, file_path, duration_seconds, thumbnail_url, status, is_public, visibility, created_at)
            VALUES ('live', ?, ?, NULL, 8, '/t/clip-present-1.jpg', 'ready', ?, ?, ?) RETURNING id`,
        [title, vodId, isPublic ? 1 : 0, isPublic ? 'public' : 'private', created_at])).lastInsertRowid);
    }
    fs.writeFileSync(path.join(thumbService.THUMB_DIR, 'vod-present-1.jpg'), Buffer.from('a file, not a real jpeg'));
    fs.writeFileSync(path.join(thumbService.THUMB_DIR, 'clip-present-1.jpg'), Buffer.from('a file, not a real jpeg'));

    const old = await insertVod({ title: 'old', created_at: new Date(Date.now() - 30 * 86400000).toISOString() });
    const recent = await insertVod({ title: 'recent' });
    const audioOnly = await insertVod({ title: 'audio', audio: true });
    const privateVod = await insertVod({ title: 'private', isPublic: false });
    const clip = await insertClip({ title: 'recent clip', vodId: recent });
    await insertClip({ title: 'private clip', isPublic: false });

    // ── The backfill: public, non-audio, picture first, preview missing, newest first ──
    const swept = await previewJob.sweepMissing({ appId: 'live', now: Date.now(), limit: 10 });
    const queued = (await db.all("SELECT params FROM media_jobs WHERE app_id = 'live' AND job_type = 'preview.make' ORDER BY id"))
        .map((r) => JSON.parse(r.params).id).sort((a, b) => a - b);
    assert.deepStrictEqual(swept, { missing: 3, queued: 3 }, `recent vod, old vod and the clip (saw ${JSON.stringify(swept)})`);
    assert.deepStrictEqual(queued, [old, recent, clip].sort((a, b) => a - b), 'audio-only and private items were skipped');

    if (!hasFfmpeg) { console.log('preview-hover: encode checks skipped (ffmpeg not found)'); return; }

    // ── The job makes both formats, 320 px wide, muted, under 400 KB, and points the row at them ──
    const out = await previewJob.spec.run({ app_id: 'live', params: { kind: 'vod', id: recent } }, {});
    assert.match(out.preview_url, /^\/p\/vod-\d+-\d+\.mp4$/);
    assert.match(out.preview_webm_url, /^\/p\/vod-\d+-\d+\.webm$/);
    assert.ok(out.bytes > 0 && out.bytes <= previewService.MAX_BYTES, `mp4 ${out.bytes} bytes`);
    assert.ok(out.webm_bytes > 0 && out.webm_bytes <= previewService.MAX_BYTES, `webm ${out.webm_bytes} bytes`);
    assert.ok(out.start_seconds >= 0 && out.start_seconds + out.seconds <= 8.1, 'the window is inside the source');
    for (const url of [out.preview_url, out.preview_webm_url]) {
        const file = path.join(previewService.PREVIEW_DIR, path.basename(url));
        assert.ok(fs.existsSync(file), `${url} is on disk`);
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type', '-of', 'json', file], { encoding: 'utf8' });
        const streams = JSON.parse(probe.stdout).streams;
        assert.ok(streams.every((s) => s.codec_type === 'video'), 'no audio track (muted)');
        assert.strictEqual(streams[0].width, 320, '320 px wide');
        const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
        assert.ok(Number(dur.stdout) <= 6.2, `about 6 s (${dur.stdout.trim()})`);
    }
    const row = await db.get('SELECT preview_url, preview_webm_url FROM vods WHERE id = ?', [recent]);
    assert.strictEqual(row.preview_url, out.preview_url, 'the row names the MP4');
    assert.strictEqual(row.preview_webm_url, out.preview_webm_url, 'and the WebM');

    // A second run replaces the pair and removes the old files.
    const again = await previewJob.spec.run({ app_id: 'live', params: { kind: 'vod', id: recent } }, {});
    assert.notStrictEqual(again.preview_url, out.preview_url, 'a new picture gets new names');
    assert.ok(!fs.existsSync(path.join(previewService.PREVIEW_DIR, path.basename(out.preview_url))), 'the old pair is removed');

    // ── A black first frame is skipped: the picture comes from later in the file ──
    const leader = await insertVod({ title: 'black leader', file: LEADER, duration: 8 });
    const made = await thumbService.generateVodThumbnail(leader, LEADER);
    assert.match(made, /^\/t\/vod-\d+-\d+-[0-9a-f]{6}\.jpg$/);
    assert.strictEqual(await thumbService.frameIsBlack(path.join(thumbService.THUMB_DIR, path.basename(made))), false,
        'the thumbnail is not the black leader');

    console.log('preview-hover: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
