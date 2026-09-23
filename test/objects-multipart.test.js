'use strict';
// Object API v2 uploads for large files: presigned single-PUT URLs scoped to tenant, object and size
// (MEDIA_SIGNING_SECRET, expiring); multipart initiate / part / status / complete / abort, resumable
// after a dropped connection; content-type rules per kind and byte checks for inline-served types;
// tenant quota and size limits; expired sessions purged.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-multipart-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.FILES_PATH = dir('files');
process.env.OBJECTS_PATH = dir('objects');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
process.env.MEDIA_OBJECT_MAX_MB = '1';                 // single-part limit
process.env.MEDIA_MULTIPART_MAX_MB = '4';
process.env.MEDIA_MULTIPART_MIN_PART_MB = '0';         // small parts in tests
process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';

const db = require('../server/db/database');
const model = require('../server/objects/model');
const multipart = require('../server/objects/multipart');
const objectRoutes = require('../server/objects/routes');
const express = require('express');

db.upsertApp({ app_id: 'live', api_key: 'live-key' });
db.upsertApp({ app_id: 'games', api_key: 'games-key' });
db.upsertApp({ app_id: 'tiny', api_key: 'tiny-key', quota_bytes: 1024 * 1024 });

const app = express();
app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
app.put('/api/v2/:app/objects/:id/multipart/:uploadId/parts/:n', ...objectRoutes.partHandlers);
app.use(express.json());
app.use('/api/v2/:app/objects', objectRoutes);
app.use('/o', objectRoutes.publicRouter);
const server = http.createServer(app);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mac = (parts) => crypto.createHmac('sha256', 'test-signing-secret').update(parts.join('\n')).digest('base64url');

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = (u) => base + String(u).replace('https://media.test', '');
    const call = async (method, p, { bearer = 'live-key', body, headers = {}, raw } = {}) => {
        const h = { ...headers };
        if (bearer) h.authorization = `Bearer ${bearer}`;
        let payload;
        if (raw !== undefined) payload = raw;
        else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
        const res = await fetch(p.startsWith('http') ? p : base + p, { method, headers: h, body: payload, redirect: 'manual' });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, body: json, text, headers: res.headers };
    };
    const O = '/api/v2/live/objects';
    const now = Math.floor(Date.now() / 1000);

    // ── 1. Presigned single PUT: scoped to tenant, object and size; expiring ──
    const hello = Buffer.from('hello world');
    let r = await call('POST', O, { body: { kind: 'file', mime_type: 'text/plain', size_bytes: hello.length, upload_ttl: 120 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const a = r.body;
    assert.ok(/^v2\.\d+\.11\.[\w-]+$/.test(a.upload.token), 'the token names its size');
    assert.ok(Math.abs(Date.parse(a.upload.expires_at) - (Date.now() + 120000)) < 5000, 'upload_ttl sets the expiry');
    assert.deepStrictEqual([a.upload.method, a.upload.content_type, a.upload.max_bytes], ['PUT', 'text/plain', 11]);
    r = await call('POST', O, { body: { kind: 'file', mime_type: 'text/plain', size_bytes: hello.length } });
    const b = r.body;
    r = await call('PUT', local(b.upload.url).replace(b.id, a.id), { bearer: null, raw: hello });
    assert.deepStrictEqual([r.status, r.body.code], [401, 'media.upload_token.invalid'], "another object's token");
    const [, exp, , sig] = a.upload.token.split('.');
    r = await call('PUT', `${O}/${a.id}/content?token=v2.${exp}.12.${sig}`, { bearer: null, raw: Buffer.from('hello world!') });
    assert.strictEqual(r.status, 401, 'a token cannot be re-scoped to another size');
    r = await call('PUT', local(a.upload.url).replace('/api/v2/live/', '/api/v2/games/'), { bearer: null, raw: hello });
    assert.strictEqual(r.status, 404, 'nor used on another tenant');
    const past = now - 5;
    r = await call('PUT', `${O}/${a.id}/content?token=v2.${past}.11.${mac(['put2', 'live', a.id, 11, past])}`, { bearer: null, raw: hello });
    assert.strictEqual(r.status, 401, 'expired');
    const otherTenant = now + 100;
    r = await call('PUT', `${O}/${a.id}/content?token=v2.${otherTenant}.11.${mac(['put2', 'games', a.id, 11, otherTenant])}`, { bearer: null, raw: hello });
    assert.strictEqual(r.status, 401, 'a token signed for another tenant');
    r = await call('PUT', local(a.upload.url), { bearer: null, raw: hello });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await call('POST', `${O}/${a.id}/complete?token=${encodeURIComponent(a.upload.token)}`, { bearer: null });
    assert.deepStrictEqual([r.status, r.body.lifecycle_status], [200, 'ready']);
    r = await call('POST', `${O}/${b.id}/upload-url`, { body: { ttl: 300 } });
    assert.ok(r.status === 200 && r.body.url.includes('token=v2.'), 'a fresh presigned URL');
    r = await call('POST', `${O}/${b.id}/upload-url`, { body: { ttl: 5 } });
    assert.strictEqual(r.status, 400);
    const legacyExp = now + 300;
    r = await call('PUT', `${O}/${b.id}/content?token=${legacyExp}.${crypto.createHmac('sha256', 'test-signing-secret').update(`put\n${b.id}\n${legacyExp}`).digest('base64url')}`, { bearer: null, raw: hello });
    assert.strictEqual(r.status, 200, 'tokens of the earlier form work until they expire');
    console.log('✅ presigned single-PUT URLs: scoped to tenant, object and size, expiring');

    // ── 2. Content types ──
    r = await call('POST', O, { body: { kind: 'screenshot', mime_type: 'text/html' } });
    assert.deepStrictEqual([r.status, r.body.code], [415, 'media.object.unsupported_type']);
    r = await call('POST', O, { body: { kind: 'vod', visibility: 'private', mime_type: 'image/png' } });
    assert.strictEqual(r.status, 415, 'a vod is video or audio');
    r = await call('POST', O, { body: { kind: 'avatar', mime_type: 'image/svg+xml' } });
    assert.strictEqual(r.status, 415, 'no SVG where images are served inline');
    r = await call('POST', O, { body: { kind: 'screenshot', mime_type: 'image/png' } });
    const fake = r.body.id;
    r = await call('PUT', `${O}/${fake}/content`, { raw: Buffer.from('<html><script>alert(1)</script></html>') });
    assert.strictEqual(r.status, 200);
    r = await call('POST', `${O}/${fake}/complete`);
    assert.deepStrictEqual([r.status, r.body.code], [415, 'media.object.content_mismatch'], 'bytes that are not the declared image');
    assert.strictEqual(model.getObject(fake).lifecycle_status, 'uploading', 'the object stays uploading');
    r = await call('POST', O, { body: { kind: 'screenshot' } });
    r = await call('PUT', `${O}/${r.body.id}/content`, { raw: Buffer.from('<svg/>'), headers: { 'content-type': 'image/svg+xml' } });
    assert.deepStrictEqual([r.status, r.body.code], [415, 'media.object.unsupported_type'], 'an undeclared type comes from the PUT and is checked too');
    r = await call('POST', O, { body: { kind: 'file', mime_type: 'image/gif' } });
    const gifId = r.body.id;
    await call('PUT', `${O}/${gifId}/content`, { raw: Buffer.from('%PDF-1.4 not a gif') });
    r = await call('POST', `${O}/${gifId}/complete`);
    assert.deepStrictEqual([r.status, r.body.code], [415, 'media.object.content_mismatch'], 'inline-served types are checked for any kind');
    r = await call('POST', O, { body: { kind: 'file', mime_type: 'application/zip' } });
    const zipId = r.body.id;
    await call('PUT', `${O}/${zipId}/content`, { raw: Buffer.from('anything at all') });
    assert.strictEqual((await call('POST', `${O}/${zipId}/complete`)).status, 200, 'attachments are taken as declared');
    console.log('✅ content types: kind rules at init and PUT, byte checks at complete for inline-served types');

    // ── 3. Multipart ──
    const PART = 512 * 1024;
    const big = crypto.randomBytes(PART * 2 + 251424);
    r = await call('POST', O, { body: { kind: 'file', mime_type: 'application/octet-stream', size_bytes: big.length } });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.object.too_large'], 'over the single-part limit without multipart');
    assert.match(r.body.detail, /multipart: true/);
    r = await call('POST', O, { body: { kind: 'file', size_bytes: 5 * 1024 * 1024, multipart: true } });
    assert.strictEqual(r.status, 413, 'MEDIA_MULTIPART_MAX_MB');
    r = await call('POST', '/api/v2/tiny/objects', { bearer: 'tiny-key', body: { kind: 'file', size_bytes: 2 * 1024 * 1024, multipart: true, part_size: PART } });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.quota.exceeded'], 'the tenant quota at init');
    r = await call('POST', O, { body: { kind: 'file', mime_type: 'application/octet-stream', size_bytes: big.length, multipart: true, part_size: PART, filename: 'big.bin', content_hash: sha(big) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const mp = r.body;
    const up = mp.upload.multipart;
    assert.deepStrictEqual([mp.upload.method, mp.upload.url, up.parts_expected, up.part_size, up.total_size, up.status], ['multipart', null, 3, PART, big.length, 'active']);
    assert.ok(/^mup_/.test(up.upload_id) && /^mp1\./.test(up.token));
    const partUrl = (n) => local(up.part_url_template.replace('{part_number}', String(n)));
    const slice = (n) => big.subarray((n - 1) * PART, Math.min(big.length, n * PART));

    r = await call('PUT', partUrl(1), { bearer: null, raw: slice(1) });
    assert.deepStrictEqual([r.status, r.body.part_number, r.body.sha256], [200, 1, sha(slice(1))]);
    r = await call('PUT', `${O}/${mp.id}/content`, { raw: big.subarray(0, 10) });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.object.too_large'], 'no single PUT for a multipart-sized object');
    r = await call('PUT', partUrl(2), { bearer: null, raw: slice(2).subarray(0, 1000) });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.upload.part_size_mismatch'], 'every part has an exact size');
    r = await call('PUT', partUrl(2), { bearer: null, raw: slice(2), headers: { 'x-content-sha256': sha(Buffer.from('other')) } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.upload.part_hash_mismatch']);
    r = await call('PUT', partUrl(4), { bearer: null, raw: slice(3) });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.upload.invalid_part']);
    r = await call('PUT', partUrl(2).replace(/token=[^&]+/, 'token=mp1.99999999999.forged'), { bearer: null, raw: slice(2) });
    assert.strictEqual(r.status, 401);

    // A dropped connection mid-part: nothing of it is kept; the session says what is missing.
    await new Promise((resolve) => {
        const u = new URL(partUrl(2));
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT', headers: { 'content-length': slice(2).length } });
        req.on('error', () => resolve());
        req.write(slice(2).subarray(0, 200000));
        setTimeout(() => { req.destroy(); setTimeout(resolve, 150); }, 100);
    });
    r = await call('GET', local(up.status_url), { bearer: null });
    assert.deepStrictEqual([r.status, r.body.parts.map((p) => p.part_number), r.body.missing, r.body.received_bytes], [200, [1], [2, 3], PART]);
    assert.deepStrictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.parts', up.upload_id)), ['1'], 'no half part on disk');
    // Resume: send what is missing (part 3 with the app key instead of the session token).
    r = await call('PUT', partUrl(2), { bearer: null, raw: slice(2), headers: { 'x-content-sha256': sha(slice(2)) } });
    assert.strictEqual(r.status, 200);
    r = await call('PUT', `${O}/${mp.id}/multipart/${up.upload_id}/parts/3`, { raw: slice(3) });
    assert.strictEqual(r.status, 200, 'the tenant credential works as well as the session token');
    r = await call('GET', `${O}/${mp.id}/multipart/${up.upload_id}`);
    assert.deepStrictEqual([r.body.missing, r.body.received_bytes], [[], big.length]);

    r = await call('POST', local(up.complete_url), { bearer: null, body: { parts: [{ part_number: 1, sha256: sha(slice(2)) }] } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.upload.part_hash_mismatch'], "the client's part list must match");
    assert.strictEqual(multipart.getSession(up.upload_id).status, 'active', 'and the session stays open');
    r = await call('POST', local(up.complete_url), { bearer: null, body: { parts: [1, 2, 3].map((n) => ({ part_number: n, sha256: sha(slice(n)) })) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.lifecycle_status, r.body.size_bytes, r.body.content_hash], ['ready', big.length, sha(big)]);
    assert.ok(!fs.existsSync(path.join(process.env.OBJECTS_PATH, '.parts', up.upload_id)), 'parts removed');
    assert.strictEqual(multipart.getSession(up.upload_id).status, 'completed');
    assert.deepStrictEqual(fs.readFileSync(model.objectFilePath(model.getObject(mp.id))), big, 'the assembled object is the original');
    r = await call('GET', `${O}/${mp.id}/download`);
    r = await call('GET', local(r.body.url), { bearer: null });
    assert.deepStrictEqual([r.status, sha(Buffer.from(await (await fetch(local((await call('GET', `${O}/${mp.id}/download`)).body.url))).arrayBuffer()))], [200, sha(big)]);
    r = await call('POST', local(up.complete_url), { bearer: null });
    assert.strictEqual(r.status, 409, 'completing twice');
    console.log('✅ multipart: exact parts, sha256 per part, resumable after a dropped connection, assembled and verified');

    // Declare the size later; abort; a session for another object does not open this one; expiry.
    r = await call('POST', O, { body: { kind: 'file' } });
    const later = r.body.id;
    r = await call('POST', `${O}/${later}/multipart`, { body: { part_size: PART } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.object.invalid'], 'a size is needed');
    r = await call('POST', `${O}/${later}/multipart`, { body: { size_bytes: PART + 10, part_size: PART } });
    assert.strictEqual(r.status, 201);
    const s2 = r.body;
    r = await call('PUT', `${O}/${later}/content`, { raw: Buffer.alloc(PART + 10) });
    assert.deepStrictEqual([r.status, r.body.code], [409, 'media.upload.multipart_active']);
    r = await call('PUT', local(s2.part_url_template.replace('{part_number}', '1')).replace(later, a.id).replace(s2.upload_id, up.upload_id), { bearer: null, raw: Buffer.alloc(PART) });
    assert.strictEqual(r.status, 401, "a session token opens only its own session's object");
    r = await call('PUT', local(s2.part_url_template.replace('{part_number}', '1')), { bearer: null, raw: Buffer.alloc(PART) });
    assert.strictEqual(r.status, 200);
    r = await call('DELETE', local(s2.abort_url), { bearer: null });
    assert.deepStrictEqual([r.status, r.body.status], [200, 'aborted']);
    assert.ok(!fs.existsSync(path.join(process.env.OBJECTS_PATH, '.parts', s2.upload_id)));
    assert.strictEqual(model.getObject(later).lifecycle_status, 'uploading', 'the object can be sent again');
    r = await call('PUT', local(s2.part_url_template.replace('{part_number}', '2')), { bearer: null, raw: Buffer.alloc(10) });
    assert.deepStrictEqual([r.status, r.body.code], [409, 'media.upload.not_active']);
    r = await call('POST', `${O}/${later}/multipart`, { body: { part_size: PART } });
    const s3 = r.body;
    await call('PUT', local(s3.part_url_template.replace('{part_number}', '1')), { bearer: null, raw: Buffer.alloc(PART) });
    db.run("UPDATE media_uploads SET expires_at = datetime('now', '-1 minute') WHERE id = ?", [s3.upload_id]);
    fs.mkdirSync(path.join(process.env.OBJECTS_PATH, '.parts', 'mup_orphan'), { recursive: true });
    const rec = await require('../server/objects/reconcile').reconcile({ appId: 'live' });
    assert.deepStrictEqual(rec.issues.incomplete_multipart.items.map((i) => [i.upload_id, i.parts_received]), [[s3.upload_id, 1]], 'reconciliation reports an open session past its expiry');
    assert.deepStrictEqual(multipart.purgeExpired(), { expired: 1, orphan_dirs: 1 });
    assert.strictEqual(multipart.getSession(s3.upload_id).status, 'expired');
    assert.deepStrictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.parts')), [], 'expired and orphan parts removed');
    console.log('✅ multipart: size declared later, abort, per-session tokens, single PUT refused while open, expiry purge');

    server.close();
    console.log('\nobjects multipart + presigned: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
