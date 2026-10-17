'use strict';
// thumbnail.regenerate on a virtual clip (clip-jobs makeVirtual: a window over its VOD's timeline, no file of
// its own). Five such clips (450, 453-456) failed as generate_failed on every page view on 2026-10-17 and Live
// passed the 500 to each visitor's console. The clip's picture now comes from its VOD, half a second after the
// clip starts; a virtual clip whose VOD is gone is media_unavailable (404), not a generate failure.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const express = require('express');

(async () => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('skipped (ffmpeg not found)'); process.exit(0); }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-thumbvirtual-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_INVARIANT_SCAN_HOURS: '0',
    });

    const db = require('../server/db/database');
    const queue = require('../server/jobs/queue');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-thumbvirtual' });

    const vodFile = path.join(process.env.VOD_PATH, 'vod-live-1.mp4');
    const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vodFile]);
    assert.strictEqual(mk.status, 0, String(mk.stderr));
    const vod = Number((await db.run(`INSERT INTO vods (app_id, title, file_path, file_size, is_public, visibility, health_status)
        VALUES ('live', 'the stream', ?, ?, 1, 'public', 'ok') RETURNING id`, [vodFile, fs.statSync(vodFile).size])).lastInsertRowid);
    const insClip = async (vodId) => Number((await db.run(`INSERT INTO clips (app_id, vod_id, title, file_path, storage_provider, start_time, end_time,
        duration_seconds, is_public, visibility, status) VALUES ('live', ?, 'a moment', NULL, 'timeline', 3, 5, 2, 1, 'public', 'ready') RETURNING id`, [vodId])).lastInsertRowid);
    const virtual = await insClip(vod);
    const orphan = await insClip(vod + 1000);   // its VOD is gone

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
    const server = app.listen(0, '127.0.0.1');
    const post = (p) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST', headers: { Authorization: 'Bearer live-key-thumbvirtual', 'Content-Length': 0 } },
            (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
        req.on('error', reject);
        req.end();
    });

    (async () => {
        await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
        const ok = await post(`/api/v1/live/thumbnails/clip/${virtual}`);
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
        const row = await db.getClipById(virtual);
        assert.ok(row.thumbnail_url && /^\/t\/clip-/.test(row.thumbnail_url), `the clip has its picture: ${row.thumbnail_url}`);
        assert.ok(fs.existsSync(path.join(process.env.THUMBNAILS_PATH, path.basename(row.thumbnail_url))), 'the frame is on disk');
        assert.strictEqual(row.file_path, null, 'the clip stays virtual');

        const gone = await post(`/api/v1/live/thumbnails/clip/${orphan}`);
        assert.strictEqual(gone.status, 404, JSON.stringify(gone.body));
        const job = await queue.get(gone.body.job_id);
        assert.deepStrictEqual([job.status, job.error_code, job.attempts], ['failed', 'media_unavailable', 1]);
        assert.strictEqual((await db.all("SELECT COUNT(*) AS n FROM media_jobs WHERE error_code = 'generate_failed'"))[0].n, 0, 'no generate failure');
        server.close();
        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('✅ thumbnail.regenerate on a virtual clip: a frame from its VOD at the clip start; VOD gone: media_unavailable (404)');
        process.exit(0);
    })().catch((err) => { console.error(err); server.close(); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
