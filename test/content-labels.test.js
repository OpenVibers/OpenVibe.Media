'use strict';
// Content labels on VODs and clips (L1, 2026-10-31; Contracts 0.257.0 common.content-labels@1): the creator sets
// `labels`, the AI's `suggested` stays a suggestion until confirmed, every read carries the shape, and a label never
// hides a row from Media (the viewer's Network prefs decide).
//   node test/content-labels.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-labels-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    delete process.env.EVENTS_URL;
    console.log = () => {};
    console.warn = () => {};

    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const raw = db.getDb();
    const file = path.join(process.env.VOD_PATH, 'vod-1.webm');
    fs.writeFileSync(file, Buffer.alloc(64, 1));
    await raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, duration_seconds)
         OVERRIDING SYSTEM VALUE VALUES (1, 'live', 5, 'A VOD', ?, 1, 'public', 60)`).run(file);
    await raw.prepare(`INSERT INTO clips (id, app_id, vod_id, user_id, title, file_path, is_public, visibility, status)
         OVERRIDING SYSTEM VALUE VALUES (10, 'live', 1, 5, 'A clip', 'x.webm', 1, 'public', 'ready')`).run();

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    const server = http.createServer(app);

    try {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}/api/v1/live`;
        const call = async (method, p, body) => {
            const headers = { authorization: 'Bearer live-key' };
            if (body !== undefined) headers['content-type'] = 'application/json';
            const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: res.status, json: await res.json().catch(() => null) };
        };

        // Every read carries the shape, even for a row that never had a label.
        let r = await call('GET', '/vods/1');
        assert.deepStrictEqual(r.json.content_labels, { labels: [], suggested: [] }, 'a VOD is label-free by default');
        r = await call('GET', '/clips/10');
        assert.deepStrictEqual(r.json.content_labels, { labels: [], suggested: [] }, 'a clip is label-free by default');

        // The creator sets labels; the AI's suggestion is stored but never applied.
        r = await call('PUT', '/vods/1', { labels: ['18+', 'language'] });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json.vod.content_labels, { labels: ['18+', 'language'], suggested: [] }, 'the creator labels a VOD');
        await raw.prepare(`UPDATE vods SET content_labels = '{"labels":["18+"],"suggested":["nudity","language"]}' WHERE id = 1`).run();
        r = await call('GET', '/vods/1');
        assert.deepStrictEqual(r.json.content_labels, { labels: ['18+'], suggested: ['nudity', 'language'] }, 'a suggestion is not a label');
        // Confirming nudity applies it and clears that suggestion; the other stays.
        r = await call('PUT', '/vods/1', { labels: ['18+', 'nudity'] });
        assert.deepStrictEqual(r.json.vod.content_labels, { labels: ['18+', 'nudity'], suggested: ['language'] }, 'confirming clears only the confirmed suggestion');

        // Clips take the same shape; unknown labels are refused and change nothing.
        r = await call('PUT', '/clips/10', { labels: ['spoilers', 'flashing'] });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json.clip.content_labels, { labels: ['spoilers', 'flashing'], suggested: [] });
        assert.strictEqual((await call('PUT', '/clips/10', { labels: ['gore'] })).status, 400, 'an unknown label is refused');
        assert.strictEqual((await call('PUT', '/vods/1', { labels: 'nudity' })).status, 400, 'a string is not a label list');
        assert.deepStrictEqual((await call('GET', '/clips/10')).json.content_labels.labels, ['spoilers', 'flashing'], 'a refused write changed nothing');

        // A label is not a filter: the VOD labelled 18+ is still in the list, with its shape.
        r = await call('GET', '/vods');
        const vod = r.json.vods.find((v) => v.id === 1);
        assert.ok(vod, 'the labelled VOD is still listed');
        assert.deepStrictEqual(vod.content_labels.labels, ['18+', 'nudity'], 'the list carries the labels');
        r = await call('GET', '/clips');
        assert.deepStrictEqual(r.json.clips.find((c) => c.id === 10).content_labels.labels, ['spoilers', 'flashing'], 'the clip list carries the labels');
    } finally {
        await new Promise((r) => server.close(r));
    }
    console.log('content labels: VODs and clips carry the shape; suggestions stay suggestions');
})().catch((err) => { console.error(err); process.exit(1); });
