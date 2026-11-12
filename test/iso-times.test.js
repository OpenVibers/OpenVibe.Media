'use strict';
/**
 * Times leave with their zone (openvibe.design rule 148): Media's SQLite-era text timestamps are UTC
 * but a browser reads `YYYY-MM-DD HH:MM:SS` as local time. The JSON edge renders time fields as ISO
 * 8601 with Z; stored text, cursors and every query that compares it stay unchanged.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { isoTime, normalizeTimes, isoJsonTimes } = require('../server/iso-times');

assert.strictEqual(isoTime('2026-11-12 05:01:02'), '2026-11-12T05:01:02Z');
assert.strictEqual(isoTime('2026-11-12T05:01:02.123Z'), '2026-11-12T05:01:02.123Z', 'ISO with Z is left alone');
assert.strictEqual(isoTime('2026-11-12T05:01:02+02:00'), '2026-11-12T05:01:02+02:00', 'ISO with an offset is left alone');
assert.strictEqual(isoTime('2026-11-12'), '2026-11-12', 'a date is not a time');
assert.strictEqual(isoTime(null), null);
assert.deepStrictEqual(
    normalizeTimes({ id: 1, created_at: '2026-11-12 05:01:02', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12 05:01:02' }, tags: [{ expires_at: '2026-11-12 05:01:02' }] }),
    { id: 1, created_at: '2026-11-12T05:01:02Z', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12T05:01:02Z' }, tags: [{ expires_at: '2026-11-12T05:01:02Z' }] },
    'time-named fields are rendered; body text that looks like a time is not',
);

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-iso-times-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        OBJECTS_PATH: dir('objects'), THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'),
        MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'https://openvibe.network',
    });
    const db = require('../server/db/database');
    const express = require('express');
    await db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const raw = db.getDb();
    await raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, file_size, is_public, visibility, duration_seconds, is_recording, storage_provider, health_status, created_at) OVERRIDING SYSTEM VALUE
                       VALUES (91, 'games', 'Zoned', ?, 64, 1, 'public', 60, 0, 'local', 'ok', '2026-10-01 10:00:00')`).run(path.join(process.env.VOD_PATH, 'zoned.webm'));

    const app = express();
    app.use(express.json());
    app.use(isoJsonTimes);
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers: { authorization: 'Bearer games-key' } }, (res) => {
            let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body, json: () => JSON.parse(body) }));
        }).on('error', reject);
    });

    const r = await get('/api/v1/games/vods/91');
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.json().created_at, '2026-10-01T10:00:00Z', 'the VOD created_at is ISO with Z');
    assert.match(r.json().created_at, /Z$/);
    const stored = await raw.prepare('SELECT created_at FROM vods WHERE id = 91').get();
    assert.strictEqual(stored.created_at, '2026-10-01 10:00:00', 'the stored text is untouched');

    await new Promise((resolve) => server.close(resolve));
    console.log('iso times: helper and GET /api/v1/games/vods/:id checked');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
