'use strict';
// GET /api/v1/:app/vods/:id/ingest says whether this process is recording a VOD right now (the owner, 2026-11-18: "the
// replay feature … unreliable, it doesn't have the full VOD"). A Media restart ends every ingest while the row keeps
// is_recording = 1 until the orphan sweep finalizes it minutes later; OpenVibe.Live asks here every 15 s and resumes a
// broken recording in a new part at once. What this proves:
//   - a recording this process holds answers recording: true, its kind, since when, and its file's size and age;
//   - after a restart (the row still says recording, nothing holds it) it answers recording: false, row_recording: true;
//   - another app's VOD, or an unknown id, is 404; no key is 401; the answer is never cached.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-ingest-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
    });
    const db = require('../server/db/database');
    const recorder = require('../server/vod/recorder');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-ingest-test' });
    await db.upsertApp({ app_id: 'other', api_key: 'other-key-ingest-test' });
    const held = Number((await db.createVod({ app_id: 'live', title: 'held' })).lastInsertRowid);
    const orphan = Number((await db.createVod({ app_id: 'live', title: 'orphan' })).lastInsertRowid);
    const theirs = Number((await db.createVod({ app_id: 'other', title: 'theirs' })).lastInsertRowid);
    const file = path.join(process.env.VOD_PATH, 'held.mp4');
    fs.writeFileSync(file, Buffer.alloc(4096));
    await db.run('UPDATE vods SET is_recording = 1, file_path = ? WHERE id IN (?, ?)', [file, held, orphan]);
    // The recording this process holds (what _registerCommon puts in the map), and one left by a process that is gone.
    recorder.activeRecordings.set(held, { vodId: held, appId: 'live', filePath: file, startTime: Date.now() - 5000, protocol: 'rtmp' });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const get = (p, key = 'live-key-ingest-test') => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers: key ? { Authorization: `Bearer ${key}` } : {} }, (res) => {
            let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: body ? JSON.parse(body) : null }));
        }).on('error', reject);
    });
    try {
        const a = await get(`/api/v1/live/vods/${held}/ingest`);
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.headers['cache-control'], 'no-store');
        assert.deepStrictEqual([a.json.recording, a.json.row_recording, a.json.kind, a.json.bytes], [true, true, 'rtmp', 4096]);
        assert.ok(Date.parse(a.json.since) <= Date.now() - 4000, 'since when it records');
        assert.ok(a.json.file_age_ms >= 0 && a.json.file_age_ms < 60000);

        const b = await get(`/api/v1/live/vods/${orphan}/ingest`);
        assert.deepStrictEqual([b.status, b.json.recording, b.json.row_recording, b.json.kind, b.json.since], [200, false, true, null, null],
            'after a restart: the row still says recording, nothing holds it');

        assert.strictEqual((await get(`/api/v1/live/vods/${theirs}/ingest`)).status, 404, 'another app\'s VOD');
        assert.strictEqual((await get('/api/v1/live/vods/99999999/ingest')).status, 404);
        assert.strictEqual((await get(`/api/v1/live/vods/${held}/ingest`, null)).status, 401);
        console.log('ingest-status: a held recording answers true with its file; an orphan answers false with its row still recording; scoped and uncached');
    } finally {
        recorder.activeRecordings.delete(held);
        server.close();
        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
