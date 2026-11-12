'use strict';
// POST /api/v2/:app/objects/:id/rotate: the owner of a stored picture turns it a quarter at a time; the stored
// bytes are turned, the uploader's file is kept beside them, and the turn is recorded in the object's metadata.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-rotate-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods'); process.env.FILES_PATH = dir('files'); process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails'); process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test'; process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    process.env.MEDIA_OBJECT_MAX_MB = '1'; process.env.MEDIA_PUBLIC_OBJECT_MAX_MB = '2';
    process.env.MEDIA_ORIENTATION = 'off';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const model = require('../server/objects/model');
    const objectRoutes = require('../server/objects/routes');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    await db.upsertApp({ app_id: 'media-hub', api_key: 'mh-key' });
    const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const OTHER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPX';

    const app = express();
    app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
    app.use(express.json());
    app.use('/api/v2/:app/objects', objectRoutes);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, { bearer = 'mh-key', body, headers = {}, raw } = {}) => {
        const h = { ...headers };
        if (bearer) h.authorization = `Bearer ${bearer}`;
        let payload;
        if (raw !== undefined) payload = raw;
        else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
        const res = await fetch(p.startsWith('http') ? p : base + p, { method, headers: h, body: payload, redirect: 'manual' });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, body: json, text };
    };
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const file = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#c33' } }).jpeg().toBuffer();

    try {
        let r = await call('POST', '/api/v2/media-hub/objects', { headers: { 'X-OV-Subject': SUBJECT }, body: { kind: 'file', mime_type: 'image/jpeg', size_bytes: file.length, filename: 'p.jpg', visibility: 'private', content_hash: sha(file) } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.body.id;
        r = await call('PUT', `${base}/api/v2/media-hub/objects/${id}/content`, { bearer: 'mh-key', headers: { 'Content-Type': 'application/octet-stream' }, raw: file });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('POST', `/api/v2/media-hub/objects/${id}/complete`, { headers: { 'X-OV-Subject': SUBJECT }, body: {} });
        assert.strictEqual(r.status, 200, r.text);

        // Only the person the picture belongs to may turn it.
        r = await call('POST', `/api/v2/media-hub/objects/${id}/rotate`, { headers: { 'X-OV-Subject': OTHER }, body: { degrees: 90 } });
        assert.deepStrictEqual([r.status, r.body.code], [403, 'media.rotate.forbidden']);
        r = await call('POST', `/api/v2/media-hub/objects/${id}/rotate`, { headers: { 'X-OV-Subject': SUBJECT }, body: { degrees: 45 } });
        assert.deepStrictEqual([r.status, r.body.code], [422, 'media.rotate.invalid']);

        r = await call('POST', `/api/v2/media-hub/objects/${id}/rotate`, { headers: { 'X-OV-Subject': SUBJECT }, body: { quarter_turns: 1 } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.rotation, 90);
        assert.strictEqual(r.body.metadata.orientation_status, 'rotated by hand');
        assert.strictEqual(r.body.metadata.rotation_audit.length, 1);
        assert.strictEqual(r.body.metadata.rotation_audit[0].by, `user:${SUBJECT}`);
        assert.strictEqual(r.body.metadata.rotation_original_kept, true);

        const loc = (await model.listLocations(id)).find((l) => l.provider === 'local');
        const turned = await sharp(loc.key).metadata();
        assert.deepStrictEqual([turned.width, turned.height], [20, 30], 'the stored pixels are turned');
        assert.ok(fs.existsSync(`${loc.key}.original`), "the uploader's file is kept beside the stored copy");
        const original = await sharp(`${loc.key}.original`).metadata();
        assert.deepStrictEqual([original.width, original.height], [30, 20]);

        // A second quarter turn accumulates, and the kept original is still the first one.
        r = await call('POST', `/api/v2/media-hub/objects/${id}/rotate`, { headers: { 'X-OV-Subject': SUBJECT }, body: { degrees: 90 } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.rotation, 180);
        assert.strictEqual(r.body.metadata.rotation_audit.length, 2);
        const twice = await sharp(loc.key).metadata();
        assert.deepStrictEqual([twice.width, twice.height], [30, 20]);
        assert.strictEqual((await sharp(`${loc.key}.original`).metadata()).width, 30);
        console.log('image rotate: owner term only, pixels turned, original kept, audit recorded');
    } finally {
        await new Promise((r) => server.close(r));
        await db.close().catch(() => {});
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
