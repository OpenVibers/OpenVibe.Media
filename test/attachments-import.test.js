'use strict';
// One remote picture, brought in (server/attachments/routes.js, POST /api/v1/attachments/import): a first-party
// service token names an https address, Media fetches it through its own egress rules (server/avatars/ingest.js:
// https only, public addresses only, at most 2 MB, images only) and keeps it as an unlisted attachment with a
// short life. A picture that is not an image, one that is too large, one on a private address and a caller
// without the capability are refused, and nothing is kept.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const { serviceAuth } = require('openvibe-contracts');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-import-'));
    process.env.ATTACHMENTS_PATH = path.join(tmp, 'attachments');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const routes = require('../server/attachments/routes');
    const ingest = require('../server/avatars/ingest');

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    auth._setNetworkPublicKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }));
    const now = Math.floor(Date.now() / 1000);
    const serviceToken = (cap = ['media.object.upload']) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:chat', actor_type: 'service', aud: ['openvibe.media'], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const app = express();
    app.use(express.json());
    app.use('/api/v1/attachments', routes);
    app.use('/a', routes.publicRouter);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#3366ff' } }).png().toBuffer();
    // The guarded read: the address check and the fetch are stubbed here (the real ones need the internet).
    ingest._setResolver(async () => ({ address: '93.184.216.34', family: 4 }));
    ingest._setFetcher(async () => ({ body: png }));

    const bring = async (url, { token = serviceToken(), headers = {} } = {}) => {
        const r = await fetch(`${base}/api/v1/attachments/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ url }) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    // ── A service brings one picture in: it is served from here, with a short life ──
    let out = await bring('https://pictures.example/og.png');
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    assert.match(out.body.id, /^att_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(out.body.kind, 'image');
    assert.strictEqual(out.body.mime, 'image/png');
    assert.match(out.body.url, /^https:\/\/media\.test\/a\/att_[^/]+\/og\.png$/);
    assert.deepStrictEqual([out.body.w, out.body.h], [40, 20]);
    const ttl = Date.parse(out.body.expires_at) - Date.now();
    assert.ok(ttl > 23 * 3600_000 && ttl <= 24 * 3600_000, 'it has a short life');
    const row = await db.get('SELECT subject, principal, kind FROM media_attachments WHERE id = ?', [out.body.id]);
    assert.strictEqual(row.subject, 'svc:chat', 'the row belongs to the service that brought it in');
    assert.strictEqual(row.kind, 'image');
    const bytes = await fetch(`${base}/a/${out.body.id}/og.png`);
    assert.strictEqual(bytes.status, 200);
    assert.strictEqual(bytes.headers.get('content-type'), 'image/png');
    assert.strictEqual(bytes.headers.get('x-content-type-options'), 'nosniff');

    // ── The credential: a service token with the capability, and nothing else ──
    out = await bring('https://pictures.example/og.png', { token: null });
    assert.strictEqual(out.status, 401, 'no token, no answer');
    out = await bring('https://pictures.example/og.png', { token: serviceToken(['media.object.read']) });
    assert.strictEqual(out.status, 403, 'the capability is not granted');
    assert.strictEqual(out.body.code, 'capability.denied');
    out = await bring('');
    assert.strictEqual(out.status, 400, 'no address, no fetch');
    assert.strictEqual(out.body.code, 'attachments.url_required');

    // ── A picture that is not a picture ──
    ingest._setFetcher(async () => ({ body: Buffer.from('<html>not a picture</html>') }));
    out = await bring('https://pictures.example/page.html');
    assert.strictEqual(out.status, 415, JSON.stringify(out.body));
    assert.strictEqual(out.body.code, 'media.attachment.not_an_image');

    // ── A picture that is too large ──
    ingest._setFetcher(async () => ({ body: Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]) }));
    out = await bring('https://pictures.example/big.png');
    assert.strictEqual(out.status, 422, JSON.stringify(out.body));
    assert.match(String(out.body.detail || ''), /too large/);

    // ── An address that is not on the public internet ──
    ingest._setFetcher(async () => ({ body: png }));
    ingest._setResolver(async () => { throw new Error('That address is not on the public internet'); });
    out = await bring('https://private.example/secret.png');
    assert.strictEqual(out.status, 422, JSON.stringify(out.body));
    assert.match(String(out.body.detail || ''), /public internet/);

    // ── Nothing refused was kept ──
    const kept = await db.all('SELECT id FROM media_attachments');
    assert.strictEqual(kept.length, 1, 'only the picture that was brought in is stored');

    ingest._setResolver(null);
    ingest._setFetcher(null);
    server.close();
    console.log('attachments-import: 1 file, 12 checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
