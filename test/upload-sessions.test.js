'use strict';
// An object upload whose bytes are moving is a protected session: a restart of Media would cut it
// (the bytes are in a temporary file), so ovhost's Media probe must hold the restart while it runs
// (server/objects/upload-sessions.js, server/protected-sessions.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-uploadsess-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';

    const db = require('../server/db/database');
    const uploadSessions = require('../server/objects/upload-sessions');
    const objectRoutes = require('../server/objects/routes');
    const express = require('express');

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });

    const app = express();
    app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
    app.use(express.json());
    app.use('/api/v2/:app/objects', objectRoutes);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

    const body = Buffer.from('hello world, this upload is watched');
    const init = await fetch(`${base}/api/v2/live/objects`, {
        method: 'POST',
        headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'file', mime_type: 'text/plain', size_bytes: body.length, filename: 'watched.txt', visibility: 'private', content_hash: sha(body) }),
    });
    const initText = await init.text();
    assert.strictEqual(init.status, 201, initText);
    const id = JSON.parse(initText).id;

    // The upload streams in two parts: the first half is on the wire while the second has not moved.
    const put = http.request(`${base}/api/v2/live/objects/${id}/content`, {
        method: 'PUT',
        headers: { authorization: 'Bearer live-key', 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
    });
    const done = new Promise((resolve) => { put.on('response', (res) => { res.resume(); resolve(res.statusCode); }); });
    put.write(body.subarray(0, 10));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(uploadSessions.countActive(), 1, 'the upload counts while its bytes are moving');
    put.end(body.subarray(10));
    const status = await done;
    assert.strictEqual(status, 200, 'the upload finished');
    assert.strictEqual(uploadSessions.countActive(), 0, 'the upload ended: nothing counts any more');
    console.log('✅ an object upload counts as a protected session while its bytes move');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ upload-session tests passed');
})().catch((err) => { console.error('❌', err); process.exit(1); });
