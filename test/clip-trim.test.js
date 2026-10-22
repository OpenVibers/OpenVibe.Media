'use strict';
// POST /clips/:id/trim: a ready clip narrows in place. Its window of the source VOD shrinks and it is cut again from
// the source (202 with the clip.cut job); the id and title stay, the superseded file is removed, clip.ready is told
// again. The whole clip is no change; a window under 1 s or outside the clip is refused; a clip still being cut is
// 409 (from the answer on: a file clip is `processing` at once, and a queued or running cut also refuses); a clip with
// no source VOD (a browser upload) or whose source recording cannot be read is 422; acting for a user, only that
// user's own clips. A clip under a retention hold (its own or its VOD's) is 409 media.object.held, and a re-cut of a
// held clip keeps its previous file. A trim whose cut fails for good gives the clip its previous window and file back
// (ready, clip.ready again); an earlier failed attempt leaves that to the retry. object.cmaf of a clip is keyed on its
// file, and commits nothing when the clip was cut again while it ran.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-cliptrim-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.MEDIA_JOBS_POLL_MS = '50';
    process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';
    process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';
    for (const p of ['B2', 'R2']) for (const k of ['ENDPOINT', 'BUCKET', 'KEY_ID', 'APP_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) process.env[`MEDIA_${p}_${k}`] = '';
    const stub = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
            res.statusCode = 404; res.end('{}');
        });
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 240000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };

    if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('clip-trim: skipped (ffmpeg not found)'); process.exit(0); }
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    const conn = db.getDb();
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const events = require('../server/events');
    events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 });
    const queue = require('../server/jobs/queue');
    const worker = require('../server/jobs/worker');
    const model = require('../server/objects/model');
    const clipJobs = require('../server/vod/clip-jobs');
    const cutter = require('../server/vod/clip-cutter');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body, headers = {}) => {
        const res = await fetch(api + p, { method, headers: { authorization: 'Bearer live-key', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const trim = async (id, body) => await call('POST', `/api/v1/live/clips/${id}/trim`, body);
    const readyEvents = async (id) => (await conn.prepare('SELECT envelope FROM event_outbox ORDER BY id').all())
        .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))
        .filter((e) => e.event_type === 'media.clip.ready' && String(e.subject.id) === String(id)).length;
    const settled = async (jobId) => await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(jobId)).status));
    const windowOf = (c) => [Number(c.start_time), Number(c.end_time), Number(c.duration_seconds)];
    await worker.start();

    const src = path.join(process.env.VOD_PATH, 'rec-30.webm');
    const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
        '-c:v', 'libvpx', '-g', '10', '-b:v', '200k', '-c:a', 'libopus', '-shortest', src]);
    assert.strictEqual(mk.status, 0, String(mk.stderr));
    await conn.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, is_public, duration_seconds) OVERRIDING SYSTEM VALUE VALUES (30, 'live', 5, 'Thirty seconds', ?, ?, 1, 30) RETURNING id").run(src, fs.statSync(src).size);
    await model.syncVod(30);

    // A 15 s clip of the VOD (5-20 s), cut.
    let r = await call('POST', '/api/v1/live/clips', { vod_id: 30, start_s: 5, end_s: 20, title: 'Best food', user_id: 5 });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    const clipId = r.body.id;
    assert.ok(await settled(r.body.job_id));
    const first = await db.getClipById(clipId);
    assert.strictEqual(first.status, 'ready');
    const len = Number(first.duration_seconds);
    assert.ok(Math.abs(len - 15) < 1.5, `a 15 s clip (${len})`);

    // ── The whole clip: nothing changes ──
    r = await trim(clipId, { start_s: 0, end_s: len });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.unchanged, true);
    assert.strictEqual((await db.getClipById(clipId)).file_path, first.file_path, 'the file is untouched');

    // ── Refused windows ──
    for (const [body, why] of [[{}, 'no window'], [{ start_s: 4, end_s: 4.5 }, 'under 1 s'], [{ start_s: -1, end_s: 5 }, 'before the clip'], [{ start_s: 2, end_s: len + 5 }, 'past its end']]) {
        assert.strictEqual((await trim(clipId, body)).status, 400, why);
    }

    // ── Acting for another user: not theirs ──
    r = await call('POST', `/api/v1/live/clips/${clipId}/trim`, { start_s: 3, end_s: 9 }, { 'x-ov-user-id': '6' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));

    // ── Under a retention hold, its own or its source VOD's: not trimmed (the whole clip still answers unchanged) ──
    const vodObject = (await db.get('SELECT object_id FROM vods WHERE id = 30')).object_id;
    assert.ok(vodObject, 'the VOD has an object');
    for (const [objectId, whose] of [[first.object_id, 'its own'], [vodObject, "its VOD's"]]) {
        const hold = await model.placeHold({ object_id: objectId, kind: 'evidence', reason: 'clip-trim test' });
        r = await trim(clipId, { start_s: 3, end_s: 9 });
        assert.deepStrictEqual([r.status, r.body && r.body.code], [409, 'media.object.held'], `${whose} hold: ${JSON.stringify(r.body)}`);
        assert.strictEqual((await trim(clipId, { start_s: 0, end_s: len })).body.unchanged, true, `${whose} hold: the whole clip is still no change`);
        const still = await db.getClipById(clipId);
        assert.deepStrictEqual([still.status, windowOf(still), still.file_path], ['ready', windowOf(first), first.file_path], `${whose} hold: the clip is untouched`);
        await model.releaseHold(hold.id);
    }

    // ── A queued or running cut of the clip: a trim would join it (it read the old window), so it is refused ──
    const pending = await queue.enqueue({ appId: 'live', type: 'clip.cut', objectId: first.object_id, params: { clip_id: clipId, reason: 're-cut' }, runAfterS: 3600 });
    r = await trim(clipId, { start_s: 3, end_s: 9 });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.deepStrictEqual(windowOf(await db.getClipById(clipId)), windowOf(first), 'the window is untouched');
    await queue.cancel(pending.job.id, { reason: 'test' });

    // ── The source recording cannot be read: refused before the window changes ──
    fs.renameSync(src, `${src}.away`);
    r = await trim(clipId, { start_s: 3, end_s: 9 });
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));
    const unread = await db.getClipById(clipId);
    assert.deepStrictEqual([unread.status, windowOf(unread)], ['ready', windowOf(first)], 'the clip is untouched');
    fs.renameSync(`${src}.away`, src);

    // ── A cut that fails for good: the clip gets its previous window and file back ──
    const realCut = cutter.cutClipFile;
    cutter.cutClipFile = async () => ({ ok: false, error: 'No decodable footage in that window' });   // hopeless: no retry
    let readyBefore = await readyEvents(clipId);
    r = await trim(clipId, { start_s: 2, end_s: 6 });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.ok(await settled(r.body.job_id));
    assert.strictEqual((await queue.get(r.body.job_id)).status, 'failed');
    const restored = await db.getClipById(clipId);
    assert.deepStrictEqual([restored.status, restored.file_path, restored.cut_error], ['ready', first.file_path, null], 'ready again on its previous cut');
    assert.deepStrictEqual(windowOf(restored), windowOf(first), 'its previous window');
    assert.ok(fs.existsSync(first.file_path), 'the previous file is still there');
    assert.strictEqual(await readyEvents(clipId), readyBefore + 1, 'clip.ready is told again');
    // An attempt with retries left leaves the clip to its retry; the last one restores (the job's own run, directly).
    cutter.cutClipFile = async () => ({ ok: false, error: 'ffmpeg exited 1' });
    const prev = { start_time: first.start_time, end_time: first.end_time, duration_seconds: first.duration_seconds };
    const narrow = async () => await model.withObject('clip', clipId, async () => await db.run("UPDATE clips SET start_time = ?, end_time = ?, duration_seconds = 4, status = 'processing' WHERE id = ?", [Number(first.start_time) + 2, Number(first.start_time) + 6, clipId]));
    const runJob = async (attempt) => await clipJobs.spec.run({ id: `mjob_test${attempt}`, app_id: 'live', params: { clip_id: clipId, reason: 'trim', prev }, attempts: attempt, max_attempts: 4 }, { attempt })
        .then(() => null, (err) => err);
    await narrow();
    let err = await runJob(1);
    assert.strictEqual(err && err.code, 'clip_cut_failed');
    let row = await db.getClipById(clipId);
    assert.deepStrictEqual([row.status, Number(row.duration_seconds)], ['failed', 4], 'attempt 1 of 4: failed, the trimmed window waits for the retry');
    err = await runJob(4);
    assert.strictEqual(err && err.code, 'clip_cut_failed');
    row = await db.getClipById(clipId);
    assert.deepStrictEqual([row.status, windowOf(row), row.file_path], ['ready', windowOf(first), first.file_path], 'attempt 4 of 4: restored');
    cutter.cutClipFile = realCut;

    // ── Seconds 3-9 of the clip: cut again from the source, in place ──
    const before = await readyEvents(clipId);
    r = await trim(clipId, { start_s: 3, end_s: 9 });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.id, clipId);
    assert.ok(/^mjob_/.test(r.body.job_id), 'the answer names the cut job');
    // Processing from the answer on: a second trim (a double submit) is refused, it does not narrow the window again.
    assert.strictEqual((await db.getClipById(clipId)).status, 'processing', 'processing at once');
    const again = await trim(clipId, { start_s: 1, end_s: 3 });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.ok(await settled(r.body.job_id));
    assert.strictEqual((await queue.get(r.body.job_id)).status, 'succeeded');
    const trimmed = await db.getClipById(clipId);
    assert.strictEqual(trimmed.status, 'ready');
    assert.strictEqual(trimmed.title, 'Best food', 'the title stays');
    assert.ok(Math.abs(Number(trimmed.start_time) - 8) < 0.01, `starts 3 s into the old window (${trimmed.start_time})`);
    assert.ok(Math.abs(Number(trimmed.duration_seconds) - 6) < 1.5, `a 6 s clip (${trimmed.duration_seconds})`);
    assert.notStrictEqual(trimmed.file_path, first.file_path, 'a new cut');
    assert.ok(fs.existsSync(trimmed.file_path), 'the new file is there');
    assert.ok(!fs.existsSync(first.file_path), 'the superseded file is removed');
    assert.strictEqual(await readyEvents(clipId), before + 1, 'clip.ready is told again');

    // ── A re-cut of a held clip keeps its previous file (a hold keeps bytes) ──
    const hold = await model.placeHold({ object_id: vodObject, kind: 'evidence', reason: 'clip-trim test' });
    r = await call('POST', `/api/v1/live/clips/${clipId}/recut`, {});
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.ok(await settled(r.body.job_id));
    const recut = await db.getClipById(clipId);
    assert.notStrictEqual(recut.file_path, trimmed.file_path, 'a new cut');
    assert.ok(fs.existsSync(trimmed.file_path), 'the held clip\'s previous file is kept');
    await model.releaseHold(hold.id);

    // ── A clip still being cut ──
    await conn.prepare("UPDATE clips SET status = 'processing' WHERE id = ?").run(clipId);
    assert.strictEqual((await trim(clipId, { start_s: 1, end_s: 3 })).status, 409);
    await conn.prepare("UPDATE clips SET status = 'ready' WHERE id = ?").run(clipId);

    // ── A browser upload has no source to trim from ──
    const up = await db.createClip({ app_id: 'live', vod_id: null, user_id: 5, title: 'Uploaded', file_path: recut.file_path, start_time: 0, end_time: 6, duration_seconds: 6, status: 'ready' });
    r = await trim(up.lastInsertRowid, { start_s: 1, end_s: 4 });
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));

    worker.stop();
    await sleep(100);

    // ── object.cmaf of a clip: keyed on its file; a cut that lands while it runs makes it commit nothing ──
    const config = require('../server/config');
    const timelineQueue = require('../server/objects/timeline-queue');
    const timeline = require('../server/objects/timeline');
    const derive = require('../server/jobs/derive');
    const cmaf = require('../server/jobs/cmaf');
    config.hls.enabled = true;
    const objectId = recut.object_id;
    const keyOf = async (jobId) => (await queue.get(jobId)).idempotency_key;
    const j1 = await timelineQueue.queueCmaf('live', objectId);
    const k1 = await keyOf(j1);
    assert.ok(new RegExp(`^object\\.cmaf:${objectId}:[0-9a-f]{12}$`).test(k1), `the key names the file (${k1})`);
    await queue.cancel(j1, { reason: 'test' });
    assert.strictEqual(await timelineQueue.queueCmaf('live', objectId), j1, 'the same file: the same job (replayed)');
    const copy = path.join(process.env.CLIPS_PATH, 'clip-copy.webm');
    fs.copyFileSync(recut.file_path, copy);
    await conn.prepare('UPDATE clips SET file_path = ? WHERE id = ?').run(copy, clipId);
    const j2 = await timelineQueue.queueCmaf('live', objectId);
    assert.ok(j2 && j2 !== j1 && await keyOf(j2) !== k1, 'a new file: a new job, not the old one replayed');
    await queue.cancel(j2, { reason: 'test' });
    await conn.prepare('UPDATE clips SET file_path = ? WHERE id = ?').run(recut.file_path, clipId);

    const x264 = /libx264/.test(String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout));
    if (x264) {
        config.hls.transcode = true;   // the clip is VP8: fMP4 needs it transcoded
        const ctx = () => ({ signal: new AbortController().signal, checkpoint: null, attempt: 1, saveCheckpoint: async () => {}, cancelled: () => false });
        const job = (n) => ({ id: `mjob_cmaftest${n}`, app_id: 'live', object_id: objectId, type: 'object.cmaf', params: {} });
        // The clip is cut again (its row names a new file) between the cmaf run's read of its source and its commit.
        const realResolve = derive.resolveSource;
        derive.resolveSource = async (obj) => {
            const s = await realResolve(obj);
            await conn.prepare('UPDATE clips SET file_path = ? WHERE id = ?').run(copy, clipId);
            return s;
        };
        err = await cmaf.spec.run(job(1), ctx()).then(() => null, (e) => e);
        derive.resolveSource = realResolve;
        assert.deepStrictEqual([err && err.code, err && err.permanent], ['media.source.changed', true], String(err && err.stack));
        assert.deepStrictEqual(await timeline.list(objectId, timeline.SOURCE), [], 'nothing committed');
        // The file it reads stays the clip's: committed (the check passes a normal run).
        const out = await cmaf.spec.run(job(2), ctx());
        assert.ok(out.segments > 0 && (await timeline.list(objectId, timeline.SOURCE)).length > 0, 'a normal run commits its rows');
        config.hls.transcode = false;
    } else console.log('clip-trim: cmaf commit check skipped (no libx264)');
    config.hls.enabled = false;

    events._reset();
    server.close();
    stub.close();
    console.log('clip-trim: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
