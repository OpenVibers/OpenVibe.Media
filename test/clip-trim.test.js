'use strict';
// POST /clips/:id/trim: a ready clip narrows in place. Its window of the source VOD shrinks and it is cut again from
// the source (202 with the clip.cut job); the id and title stay, the superseded file is removed, clip.ready is told
// again. The whole clip is no change; a window under 1 s or outside the clip is refused; a clip still being cut is
// 409; a clip with no source VOD (a browser upload) is 422; acting for a user, only that user's own clips.
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
    const readyEvents = async (id) => (await conn.prepare('SELECT envelope FROM event_outbox ORDER BY id').all())
        .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))
        .filter((e) => e.event_type === 'media.clip.ready' && String(e.subject.id) === String(id)).length;
    const settled = async (jobId) => await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(jobId)).status));
    await worker.start();

    const src = path.join(process.env.VOD_PATH, 'rec-30.webm');
    const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
        '-c:v', 'libvpx', '-g', '10', '-b:v', '200k', '-c:a', 'libopus', '-shortest', src]);
    assert.strictEqual(mk.status, 0, String(mk.stderr));
    await conn.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, is_public, duration_seconds) OVERRIDING SYSTEM VALUE VALUES (30, 'live', 5, 'Thirty seconds', ?, ?, 1, 30) RETURNING id").run(src, fs.statSync(src).size);

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
    r = await call('POST', `/api/v1/live/clips/${clipId}/trim`, { start_s: 0, end_s: len });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.unchanged, true);
    assert.strictEqual((await db.getClipById(clipId)).file_path, first.file_path, 'the file is untouched');

    // ── Refused windows ──
    for (const [body, why] of [[{}, 'no window'], [{ start_s: 4, end_s: 4.5 }, 'under 1 s'], [{ start_s: -1, end_s: 5 }, 'before the clip'], [{ start_s: 2, end_s: len + 5 }, 'past its end']]) {
        assert.strictEqual((await call('POST', `/api/v1/live/clips/${clipId}/trim`, body)).status, 400, why);
    }

    // ── Acting for another user: not theirs ──
    r = await call('POST', `/api/v1/live/clips/${clipId}/trim`, { start_s: 3, end_s: 9 }, { 'x-ov-user-id': '6' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));

    // ── Seconds 3-9 of the clip: cut again from the source, in place ──
    const before = await readyEvents(clipId);
    r = await call('POST', `/api/v1/live/clips/${clipId}/trim`, { start_s: 3, end_s: 9 });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.id, clipId);
    assert.ok(/^mjob_/.test(r.body.job_id), 'the answer names the cut job');
    // Still being cut: a second trim waits.
    if ((await db.getClipById(clipId)).status === 'processing') {
        assert.strictEqual((await call('POST', `/api/v1/live/clips/${clipId}/trim`, { start_s: 1, end_s: 3 })).status, 409);
    }
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

    // ── A clip still being cut ──
    await conn.prepare("UPDATE clips SET status = 'processing' WHERE id = ?").run(clipId);
    assert.strictEqual((await call('POST', `/api/v1/live/clips/${clipId}/trim`, { start_s: 1, end_s: 3 })).status, 409);
    await conn.prepare("UPDATE clips SET status = 'ready' WHERE id = ?").run(clipId);

    // ── A browser upload has no source to trim from ──
    const up = await db.createClip({ app_id: 'live', vod_id: null, user_id: 5, title: 'Uploaded', file_path: trimmed.file_path, start_time: 0, end_time: 6, duration_seconds: 6, status: 'ready' });
    r = await call('POST', `/api/v1/live/clips/${up.lastInsertRowid}/trim`, { start_s: 1, end_s: 4 });
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));

    worker.stop();
    events._reset();
    server.close();
    stub.close();
    console.log('clip-trim: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
