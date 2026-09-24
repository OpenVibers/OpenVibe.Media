'use strict';
// thumbnail.regenerate on a recording with nothing to take a frame from: the five jobs that failed on
// production (2026-09-23 21:36:41, generate_failed) were Live asking for thumbnails of zero-byte VODs
// (health zero_byte, quarantined). Media ran ffmpeg on the empty files and answered 500. Now such a
// request fails at once as media_unavailable (permanent) and the v1 route answers 404, whether the
// health scan already marked the VOD or the file is simply empty or gone.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-thumbfail-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_INVARIANT_SCAN_HOURS: '0',
});

const db = require('../server/db/database');
const queue = require('../server/jobs/queue');
db.upsertApp({ app_id: 'live', api_key: 'live-key-thumbfail' });

const V = process.env.VOD_PATH;
const insVod = (file, health) => Number(db.run(`INSERT INTO vods (app_id, title, file_path, file_size, is_public, visibility, health_status)
    VALUES ('live', 't', ?, 0, 1, 'public', ?)`, [file, health]).lastInsertRowid);
fs.writeFileSync(path.join(V, 'zero-marked.mp4'), '');
fs.writeFileSync(path.join(V, 'zero-unscanned.mp4'), '');
const marked = insVod(path.join(V, 'zero-marked.mp4'), 'zero_byte');          // as on production
const unscanned = insVod(path.join(V, 'zero-unscanned.mp4'), 'unknown');      // empty, not scanned yet
const missing = insVod(path.join(V, 'gone.mp4'), 'ok');                        // no file, not offloaded

const app = express();
app.use(express.json());
app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
const server = app.listen(0, '127.0.0.1');
const post = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST', headers: { Authorization: 'Bearer live-key-thumbfail', 'Content-Length': 0 } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
    req.on('error', reject);
    req.end();
});

(async () => {
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    for (const id of [marked, unscanned, missing]) {
        const t0 = Date.now();
        const r = await post(`/api/v1/live/thumbnails/vod/${id}`);
        assert.strictEqual(r.status, 404, `vod ${id}: ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.error, 'Media file unavailable');
        const job = queue.get(r.body.job_id);
        assert.deepStrictEqual([job.status, job.error_code, job.attempts], ['failed', 'media_unavailable', 1], `vod ${id}`);
        assert.ok(Date.now() - t0 < 5000, 'refused before any ffmpeg run');
    }
    assert.ok(/empty \(0 bytes\)/.test(queue.list('live', { type: 'thumbnail.regenerate' }).jobs.find(j => JSON.parse(j.params).id === marked).error));
    assert.strictEqual(db.all("SELECT COUNT(*) AS n FROM media_jobs WHERE error_code = 'generate_failed'")[0].n, 0, 'none of them is a generate failure any more');
    server.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('✅ thumbnail.regenerate on an empty or missing recording: media_unavailable at once, 404 from the v1 route');
    process.exit(0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
