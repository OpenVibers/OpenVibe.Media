'use strict';
/**
 * Bytes people chose never run as a page on openvibe.media (security review 2026-10-10):
 *   - GET /a/:id serves only images (never SVG), audio and video inline; anything else (an "emote" uploaded as HTML)
 *     downloads, always with nosniff and a sandboxing CSP;
 *   - every file response carries X-Content-Type-Options: nosniff;
 *   - a live thumbnail's id names a file, so an id that decodes to a path ("../x") is refused.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-usercontent-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_INVARIANT_SCAN_HOURS: '0',
    });
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-usercontent' });
    const files = dir('assets');
    const asset = async (name, mime, body) => {
        const p = path.join(files, name);
        fs.writeFileSync(p, body);
        return Number((await db.run(`INSERT INTO assets (app_id, kind, name, file_path, mime) VALUES ('live', 'emote', ?, ?, ?) RETURNING id`, [name, p, mime])).lastInsertRowid);
    };
    const html = await asset('evil.html', 'text/html', '<script>alert(document.domain)</script>');
    const svg = await asset('evil.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const png = await asset('ok.png', 'image/png', Buffer.from('89504e470d0a1a0a', 'hex'));

    const app = express();
    app.use(express.json());
    app.use('/', require('../server/public/routes'));
    app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        let r = await fetch(`${base}/a/${html}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('content-disposition'), 'attachment', 'HTML downloads');
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
        assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
        r = await fetch(`${base}/a/${svg}`);
        assert.strictEqual(r.headers.get('content-disposition'), 'attachment', 'SVG is never inline');
        r = await fetch(`${base}/a/${png}`);
        assert.strictEqual(r.headers.get('content-disposition'), 'inline', 'an image is shown inline');
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');

        const post = (id) => new Promise((resolve, reject) => {
            const body = JSON.stringify({ image: 'data:image/jpeg;base64,/9j/4AAQ' });
            const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/v1/live/thumbnails/live/${id}`, method: 'POST',
                headers: { Authorization: 'Bearer live-key-usercontent', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            req.on('error', reject);
            req.end(body);
        });
        assert.strictEqual(await post('..%2f..%2fescape'), 400, 'a path in the id is refused');
        assert.strictEqual(await post('a%2fb'), 400);
        const thumbs = require('../server/thumbnails/thumbnail-service');
        assert.strictEqual(thumbs.saveLiveThumbnail('live', '../../escape', Buffer.from('x')), null, 'the service refuses it too');
        assert.ok(!fs.existsSync(path.join(tmp, 'escape.jpg')) && !fs.readdirSync(tmp).some((f) => f.includes('escape')));
        console.log('user content serving: /a/ downloads anything but images, audio and video; nosniff everywhere; thumbnail ids are plain');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
