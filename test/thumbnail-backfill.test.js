'use strict';
// The missing-picture backfill (server/jobs/thumbnail.js sweepMissing): a scheduled, due-based sweep of
// stored public VODs whose thumbnail is absent or whose file is gone. It queues the existing
// thumbnail.regenerate job for a small batch, does not retry one that is active or recently failed, and
// logs its count. The job it queues makes a real picture (checked with a 2-second test video), and a row
// that already has a thumbnail file is left alone.
//   node --import ./test/helpers/pg-preload.mjs test/thumbnail-backfill.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-thumb-backfill-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
        MEDIA_INVARIANT_SCAN_HOURS: '0', MEDIA_JOBS_ENABLED: '0',
    });

    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const jobs = require('../server/jobs/thumbnail');
    const THUMB_DIR = require('../server/thumbnails/thumbnail-service').THUMB_DIR;
    const AGE = Date.now() - 3600 * 1000;
    const oldIso = new Date(AGE).toISOString();

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });

    const video = path.join(process.env.VOD_PATH, 'clip.mp4');
    const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
    if (hasFfmpeg) {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { stdio: 'ignore' });
        assert.strictEqual(r.status, 0, 'the test video was made');
    }

    async function insert({ title, thumb = null, file = video, audio = false, recording = false, isPublic = true, created_at = oldIso, health = 'ok', managed_stream_id = null }) {
        const id = Number((await db.run(`INSERT INTO vods (app_id, title, file_path, file_size, duration_seconds, thumbnail_url, health_status,
                is_recording, is_public, visibility, audio_only, created_at, managed_stream_id)
            VALUES ('live', ?, ?, ?, 60, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [title, file, file && fs.existsSync(file) ? fs.statSync(file).size : 0, thumb, health,
            recording ? 1 : 0, isPublic ? 1 : 0, isPublic ? 'public' : 'private', audio ? 1 : 0, created_at, managed_stream_id])).lastInsertRowid);
        await model.sync('vod', id);
        return id;
    }

    // A picture file that is really there.
    fs.writeFileSync(path.join(THUMB_DIR, 'vod-present-1.jpg'), Buffer.from('not-a-real-jpeg-but-a-file'));

    const noPicture = await insert({ title: 'no picture yet' });
    const lostFile = await insert({ title: 'picture file gone', thumb: '/t/vod-lost-file-1.jpg' });
    const present = await insert({ title: 'picture present', thumb: '/t/vod-present-1.jpg' });
    const audioOnly = await insert({ title: 'audio only', audio: true });
    const recording = await insert({ title: 'still recording', recording: true });
    const tooNew = await insert({ title: 'just finalized', created_at: new Date().toISOString() });
    const privateVod = await insert({ title: 'private', isPublic: false });
    const broken = await insert({ title: 'missing file', health: 'missing_file' });

    // The newest recording per slot wins deterministically (same created_at: the newer id), and it says
    // when it has no frame to show, so Live's card can carry the flag instead of a 1×1 fallback.
    const olderSlotVod = await insert({ title: 'slot older', thumb: '/t/vod-present-1.jpg', managed_stream_id: 77 });
    const newestSlotVod = await insert({ title: 'slot newest audio', thumb: '/t/vod-present-1.jpg', audio: true, managed_stream_id: 77 });
    assert.ok(olderSlotVod < newestSlotVod);
    const thumb = (await db.latestVodThumbsByManagedStreams('live', [77]))[77];
    assert.deepStrictEqual(thumb, { vod_id: newestSlotVod, thumbnail_url: '/t/vod-present-1.jpg', audio_only: true },
        'latest-thumbs picks the newest row and carries audio_only for the card');

    assert.strictEqual(jobs.hasPicture({ thumbnail_url: '/t/vod-present-1.jpg' }), true, 'present file is a picture');
    assert.strictEqual(jobs.hasPicture({ thumbnail_url: '/t/vod-lost-file-1.jpg' }), false, 'a URL whose file is gone is not');

    // ── 1. A small, due batch: missing pictures only, not recordings/new/private/broken ones ──
    const now = Date.now();
    const first = await jobs.sweepMissing({ appId: 'live', now, limit: 10 });
    assert.deepStrictEqual(first, { missing: 3, queued: 3 }, 'no picture, lost file, audio-only');
    const queued = (await db.all("SELECT params FROM media_jobs WHERE app_id = 'live' AND job_type = 'thumbnail.regenerate' ORDER BY id"))
        .map((r) => JSON.parse(r.params).id).sort((a, b) => a - b);
    assert.deepStrictEqual(queued, [noPicture, lostFile, audioOnly].sort((a, b) => a - b),
        `only the missing ones were queued (saw ${JSON.stringify(queued)}; ${present}/${recording}/${tooNew}/${privateVod}/${broken} were skipped)`);

    // ── 2. Due based: an active job is not queued twice, and a failed one waits ──
    const again = await jobs.sweepMissing({ appId: 'live', now: now + 60 * 1000, limit: 10 });
    assert.deepStrictEqual(again, { missing: 3, queued: 0 }, 'active jobs are not queued again');
    await db.run(`UPDATE media_jobs SET status = 'failed', error_code = 'generate_failed', created_at = ? WHERE job_type = 'thumbnail.regenerate' AND params = ?`,
        [new Date(now - 60 * 60 * 1000).toISOString(), JSON.stringify({ kind: 'vod', id: noPicture })]);
    const third = await jobs.sweepMissing({ appId: 'live', now: now + 2 * 60 * 1000, limit: 10 });
    assert.strictEqual(third.queued, 0, 'a generate_failed attempt waits six hours');

    // ── 3. The queued job makes the picture: a real frame from the stored video ──
    if (hasFfmpeg) {
        const before = await db.get('SELECT thumbnail_url FROM vods WHERE id = ?', [lostFile]);
        assert.strictEqual(before.thumbnail_url, '/t/vod-lost-file-1.jpg');
        const out = await jobs.spec.run({ app_id: 'live', params: { kind: 'vod', id: lostFile } }, {});
        assert.match(out.url, /^\/t\/vod-\d+-\d+-[0-9a-f]{6}\.jpg$/);
        const after = await db.get('SELECT thumbnail_url FROM vods WHERE id = ?', [lostFile]);
        assert.strictEqual(after.thumbnail_url, out.url, 'the row names the new picture');
        assert.ok(fs.existsSync(path.join(THUMB_DIR, path.basename(out.url))), 'the file is there');
        assert.strictEqual(jobs.hasPicture(after), true, 'and the sweep no longer sees it as missing');
    } else {
        console.log('thumbnail-backfill: generation check skipped (ffmpeg not found)');
    }

    console.log('thumbnail-backfill: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
