'use strict';
// clip.cut as a media job (WS-G task 3): POST /clips answers 202 with the clip and its job id; the job
// cuts the clip (clip.ready as before) with media.job.* events, and GET /api/v2/:app/jobs/:id is what a
// UI polls and reattaches to. A window with no footage fails permanently at once; the old sweeper leaves
// clips that have a job alone; a re-cut is a new job, and asking again while it runs gets the same one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-clipjob-'));
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

(async () => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('⚠️  ffmpeg not found: clip.cut skipped'); process.exit(0); }
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    const conn = db.getDb();
    db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const events = require('../server/events');
    events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 });
    const queue = require('../server/jobs/queue');
    const worker = require('../server/jobs/worker');
    const clipJobs = require('../server/vod/clip-jobs');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body) => {
        const res = await fetch(api + p, { method, headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const outbox = () => conn.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
    const jobEvents = (id) => outbox().filter((e) => e.subject.type === 'job' && e.subject.id === id).map((e) => e.event_type);
    worker.start();

    const src = path.join(process.env.VOD_PATH, 'rec-30.webm');
    const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
        '-c:v', 'libvpx', '-g', '10', '-b:v', '200k', '-c:a', 'libopus', '-shortest', src]);
    assert.strictEqual(mk.status, 0, String(mk.stderr));
    conn.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, is_public, duration_seconds) VALUES (30, 'live', 5, 'Thirty seconds', ?, ?, 1, 30)").run(src, fs.statSync(src).size);

    // ── A clip: 202 with its job; the job cuts it ──
    let r = await call('POST', '/api/v1/live/clips', { vod_id: 30, start_s: 5, end_s: 12, title: 'Five to twelve', user_id: 5 });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.ok(/^mjob_/.test(r.body.job_id), 'the answer names the job');
    const clipId = r.body.id, jobId = r.body.job_id;
    assert.ok(await waitFor(() => ['succeeded', 'failed'].includes(queue.get(jobId).status)), 'the cut finishes');
    const j = await call('GET', `/api/v2/live/jobs/${jobId}`);
    assert.strictEqual(j.status, 200);
    assert.deepStrictEqual([j.body.job.type, j.body.job.status, j.body.job.result.clip_id], ['clip.cut', 'succeeded', clipId], JSON.stringify(j.body.job));
    const clip = db.getClipById(clipId);
    assert.strictEqual(clip.status, 'ready');
    assert.ok(fs.existsSync(clip.file_path) && Math.abs(clip.duration_seconds - 7) < 1.5, `a 7 s clip (${clip.duration_seconds})`);
    assert.deepStrictEqual(jobEvents(jobId), ['media.job.queued', 'media.job.started', 'media.job.succeeded']);
    assert.ok(outbox().some((e) => e.event_type === 'media.clip.ready' && e.subject.type === 'clip' && String(e.subject.id) === String(clipId)), 'media.clip.ready as before');

    // ── A window with no footage: permanent at once, and the sweeper leaves it alone ──
    r = await call('POST', '/api/v1/live/clips', { vod_id: 30, start_s: 28, end_s: 35, title: 'Past the end', user_id: 5 });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    const badJob = r.body.job_id, badClip = r.body.id;
    assert.ok(await waitFor(() => ['succeeded', 'failed'].includes(queue.get(badJob).status)));
    const bad = queue.jobPublic(queue.get(badJob));
    if (bad.status === 'failed') {
        assert.strictEqual(db.getClipById(badClip).status, 'failed');
        assert.strictEqual(db.getClipById(badClip).cut_next_at, null, 'no sweeper retry is scheduled under a job');
        const before = db.getClipById(badClip).cut_attempts;
        await clipJobs.sweep();
        assert.strictEqual(db.getClipById(badClip).cut_attempts, before, 'the sweeper leaves a clip that has a job');
    } else {
        assert.strictEqual(db.getClipById(badClip).status, 'ready', 'ffmpeg cut what there was');
    }

    // ── A re-cut is a new job; asking again while it is active gets the same one ──
    const r1 = await call('POST', `/api/v1/live/clips/${clipId}/recut`);
    assert.strictEqual(r1.status, 202, JSON.stringify(r1.body));
    assert.ok(r1.body.job_id && r1.body.job_id !== jobId, 'a new job');
    const same = clipJobs.enqueueCut('live', clipId, { reason: 're-cut' });
    assert.ok(same.job.id === r1.body.job_id || queue.get(r1.body.job_id).status === 'succeeded', 'an active re-cut is reused');
    assert.ok(await waitFor(() => queue.get(r1.body.job_id).status === 'succeeded'));
    assert.strictEqual(db.getClipById(clipId).status, 'ready');

    // ── Another tenant cannot see the job ──
    db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const other = await fetch(`${api}/api/v2/games/jobs/${jobId}`, { headers: { authorization: 'Bearer games-key' } });
    assert.strictEqual(other.status, 404);

    worker.stop();
    events._reset();
    server.close();
    stub.close();
    console.log('clip-cut-job: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
