'use strict';
// Composer attachments (composer.attachment@1, server/attachments/routes.js): the person's upload through a Network
// user JWT, a site's service token naming the person in X-OV-Subject, sniffed kinds, the per-kind limits, executable
// refusal, keep, delete, the 24-hour expiry and the CORS allow-list (a first-party origin yes, a foreign one no).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-attachments-'));
    process.env.ATTACHMENTS_PATH = path.join(tmp, 'attachments');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    const db = require('../server/db/database');
    const config = require('../server/config');
    const auth = require('../server/auth');
    const routes = require('../server/attachments/routes');
    const MB = 1024 * 1024;

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    auth._setNetworkPublicKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }));
    const now = Math.floor(Date.now() / 1000);
    const SUBJECT = ids.newId('user');
    const OTHER = ids.newId('user');
    // Network's session token: the numeric account id in `sub`, the person's subject in `subject_id`.
    const personToken = (subject = SUBJECT) => jwt.sign({ iss: 'https://openvibe.network', sub: 42, subject_id: subject, aud: ['openvibe.media', 'openvibe.network'], iat: now, exp: now + 600 }, privateKey.export({ type: 'pkcs8', format: 'pem' }), { algorithm: 'RS256' });
    const serviceToken = (cap = ['media.object.upload']) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const app = express();
    app.use(express.json());
    app.use('/api/v1/attachments', routes);
    app.use('/a', routes.publicRouter);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const form = (bytes, type, name, extra = {}) => {
        const f = new FormData();
        for (const [k, v] of Object.entries(extra)) f.append(k, String(v));
        f.append('file', new Blob([bytes], { type }), name);
        return f;
    };
    const upload = async (bytes, type, name, { token = personToken(), headers = {}, extra } = {}) => {
        const r = await fetch(`${base}/api/v1/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body: form(bytes, type, name, extra) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    // ── CORS: a first-party origin is allowed, a foreign one is not ──
    const preflight = (origin) => fetch(`${base}/api/v1/attachments`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
    let r = await preflight('https://openvibe.community');
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://openvibe.community', 'an OpenVibe origin is allowed');
    assert.match(r.headers.get('access-control-allow-headers') || '', /Authorization/);
    r = await preflight('https://evil.example');
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null, 'a foreign origin gets no allow header');

    // ── A person's image: sniffed kind, thumb and size, 24-hour expiry ──
    const png = await sharp({ create: { width: 48, height: 24, channels: 3, background: '#3366ff' } }).png().toBuffer();
    let out = await upload(png, 'image/png', 'shot.png');
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    assert.match(out.body.id, /^att_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(out.body.kind, 'image');
    assert.strictEqual(out.body.size, png.length);
    assert.strictEqual(out.body.mime, 'image/png');
    assert.match(out.body.url, /^https:\/\/media\.test\/a\/att_[^/]+\/shot\.png$/);
    assert.match(out.body.thumb, /^https:\/\/media\.test\/a\/att_[^/]+\/thumb\.jpg$/);
    assert.deepStrictEqual([out.body.w, out.body.h], [48, 24]);
    const ttl = Date.parse(out.body.expires_at) - Date.now();
    assert.ok(ttl > 23 * 3600_000 && ttl <= 24 * 3600_000, 'expires in 24 hours');
    const imageId = out.body.id;

    let bytes = await fetch(`${base}/a/${imageId}/shot.png`);
    assert.strictEqual(bytes.status, 200);
    assert.strictEqual(bytes.headers.get('content-type'), 'image/png');
    assert.strictEqual(bytes.headers.get('x-content-type-options'), 'nosniff');
    bytes = await fetch(`${base}/a/${imageId}/thumb.jpg`);
    assert.strictEqual(bytes.status, 200);
    assert.strictEqual(bytes.headers.get('content-type'), 'image/jpeg');

    // ── Kinds come from the bytes, not the browser's claim ──
    const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]);
    out = await upload(fakeMp4, 'application/octet-stream', 'clip.mp4');
    assert.strictEqual(out.status, 201);
    assert.strictEqual(out.body.kind, 'video', 'an ftyp header is a video, whatever the browser said');
    out = await upload(Buffer.from('a plain note\n'), 'text/plain', 'note.txt');
    assert.strictEqual(out.body.kind, 'file');
    out = await upload(Buffer.from('export const x = 1;\n'), 'text/plain', 'x.js');
    assert.strictEqual(out.body.kind, 'code');
    out = await upload(Buffer.from('OggS' + 'x'.repeat(28)), 'audio/ogg', 'take.ogg');
    assert.strictEqual(out.body.kind, 'audio');

    // ── An executable is refused ──
    out = await upload(Buffer.from('MZ\x90\x00'), 'application/octet-stream', 'setup.exe');
    assert.strictEqual(out.status, 415);
    assert.strictEqual(out.body.code, 'media.attachment.executable');
    out = await upload(Buffer.from('\x7fELFrest'), 'application/octet-stream', 'tool');
    assert.strictEqual(out.status, 415);

    // ── The per-kind limits (the picture is over 20 MB) ──
    assert.deepStrictEqual(routes.MAX_BYTES, { image: 20 * MB, video: 300 * MB, audio: 50 * MB, file: 25 * MB, code: 25 * MB });
    out = await upload(Buffer.concat([png, Buffer.alloc(20 * MB)]), 'image/png', 'huge.png');
    assert.strictEqual(out.status, 413);
    assert.strictEqual(out.body.code, 'media.attachment.too_large');

    // ── A site's service token names the person it acts for ──
    out = await upload(png, 'image/png', 'via-site.png', { token: serviceToken(), headers: { 'X-OV-Subject': SUBJECT } });
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    const siteId = out.body.id;
    out = await upload(png, 'image/png', 'no-person.png', { token: serviceToken() });
    assert.strictEqual(out.status, 403);
    assert.strictEqual(out.body.code, 'attachments.subject_required');
    out = await upload(png, 'image/png', 'no-cap.png', { token: serviceToken(['media.object.read']), headers: { 'X-OV-Subject': SUBJECT } });
    assert.strictEqual(out.status, 403);

    // ── Keep with a message: only the owner, and it moves the expiry out ──
    let res = await fetch(`${base}/api/v1/attachments/${siteId}/keep`, { method: 'POST', headers: { Authorization: `Bearer ${personToken(OTHER)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: 'msg_1' }) });
    assert.strictEqual(res.status, 404, 'another person cannot keep it');
    res = await fetch(`${base}/api/v1/attachments/${siteId}/keep`, { method: 'POST', headers: { Authorization: `Bearer ${personToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: 'msg_1' }) });
    assert.strictEqual(res.status, 200);
    const kept = await res.json();
    assert.ok(Date.parse(kept.expires_at) - Date.now() > 24 * 3600_000, 'a kept attachment lives past the unkept 24 hours');
    const row = await db.get('SELECT message_id, kept_at, expires_at FROM media_attachments WHERE id = ?', [siteId]);
    assert.strictEqual(row.message_id, 'msg_1');

    // ── Delete: the owner only ──
    res = await fetch(`${base}/api/v1/attachments/${siteId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${personToken(OTHER)}` } });
    assert.strictEqual(res.status, 404);
    res = await fetch(`${base}/api/v1/attachments/${siteId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${serviceToken()}`, 'X-OV-Subject': SUBJECT } });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(await db.get('SELECT id FROM media_attachments WHERE id = ?', [siteId]), undefined);
    assert.strictEqual(fs.existsSync(path.join(config.attachments.path, siteId)), false);

    // ── No credential, no answer ──
    res = await fetch(`${base}/api/v1/attachments`, { method: 'POST', body: form(png, 'image/png', 'x.png') });
    assert.strictEqual(res.status, 401);

    // ── Expiry: a row past its time goes, bytes and all ──
    const expiredId = `att_${ids.ulid()}`;
    const expiredDir = path.join(config.attachments.path, expiredId);
    fs.mkdirSync(expiredDir, { recursive: true });
    fs.writeFileSync(path.join(expiredDir, 'old.txt'), 'old');
    await db.run(`INSERT INTO media_attachments (id, subject, principal, name, stored_name, kind, mime, size_bytes, expires_at)
                  VALUES (?, ?, ?, 'old.txt', 'old.txt', 'file', 'text/plain', 3, ?)`, [expiredId, SUBJECT, SUBJECT, new Date(Date.now() - 1000).toISOString()]);
    assert.strictEqual(await routes.cleanupExpired(), 1);
    assert.strictEqual(fs.existsSync(expiredDir), false);
    assert.strictEqual(await db.get('SELECT id FROM media_attachments WHERE id = ?', [expiredId]), undefined);

    // The image from the first upload is still there and still served.
    assert.strictEqual((await fetch(`${base}/a/${imageId}/shot.png`)).status, 200);

    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('attachments: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
