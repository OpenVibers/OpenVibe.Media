'use strict';
// Object API v2 (/api/v2/:app/objects) and /o/:id: init → PUT → complete with an app key, an upload
// token or a Network service token; sha256 + size + quota checks; cursor listing; signed private
// downloads; soft delete/restore; retention holds; the public-size invariant at upload time; and the
// legacy projections (read-only through v2; their v1 deletes honour holds).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-objapi-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.FILES_PATH = dir('files');
process.env.OBJECTS_PATH = dir('objects');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
process.env.MEDIA_OBJECT_MAX_MB = '1';
process.env.MEDIA_PUBLIC_OBJECT_MAX_MB = '0';      // every public playback object violates here

const db = require('../server/db/database');
const auth = require('../server/auth');
const model = require('../server/objects/model');
const objectRoutes = require('../server/objects/routes');
const { serviceAuth } = require('openvibe-contracts');
const express = require('express');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
auth._setNetworkPublicKeyForTests(keys.publicKey);
db.upsertApp({ app_id: 'live', api_key: 'live-key' });
db.upsertApp({ app_id: 'games', api_key: 'games-key' });
db.upsertApp({ app_id: 'tiny', api_key: 'tiny-key', quota_bytes: 20 });
const now = Math.floor(Date.now() / 1000);
const tok = (over = {}) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:example', actor_type: 'service', aud: ['openvibe.media'], cap: ['media.object.upload', 'media.object.read'], ns: ['live'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...over }, keys.privateKey);
const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

// Same mount order as server/index.js.
const app = express();
app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
app.use(express.json());
app.use('/api/v1/:app/files', require('../server/files/routes'));
app.use('/api/v1/:app/vods', require('../server/vod/routes'));
app.use('/api/v2/:app/objects', objectRoutes);
app.use('/o', objectRoutes.publicRouter);
const server = http.createServer(app);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

    // ── Init → PUT (upload token, no other credential) → complete ──
    const hello = Buffer.from('hello world');
    let r = await call('POST', O, { body: { kind: 'file', mime_type: 'text/plain', size_bytes: hello.length, filename: '../hello.txt', visibility: 'private', content_hash: sha(hello) } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    assert.ok(/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(id));
    assert.deepStrictEqual([r.body.object.lifecycle_status, r.body.object.metadata.filename, r.body.upload.method, r.body.upload.max_bytes], ['uploading', 'hello.txt', 'PUT', 11]);
    const putUrl = local(r.body.upload.url);
    r = await call('PUT', putUrl, { bearer: null, raw: Buffer.from('hello') });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.object.size_mismatch']);
    r = await call('PUT', putUrl.replace(/token=[^&]+/, 'token=1.forged'), { bearer: null, raw: hello });
    assert.deepStrictEqual([r.status, r.body.code], [401, 'media.upload_token.invalid']);
    r = await call('PUT', putUrl, { bearer: null, raw: hello, headers: { 'content-type': 'application/json' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.size_bytes, r.body.content_hash], [11, sha(hello)]);
    const stored = model.objectFilePath(model.getObject(id));
    assert.strictEqual(fs.readFileSync(stored, 'utf8'), 'hello world', 'bytes stored under OBJECTS_PATH/<app>/<id>');
    r = await call('POST', `${O}/${id}/complete`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.lifecycle_status, r.body.mime_type, r.body.content_hash, r.body.public_url], ['ready', 'text/plain', sha(hello), null]);
    r = await call('GET', `${O}/${id}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.locations, [{ provider: 'local', storage_class: 'hot', state: 'present', size_bytes: 11, verified_at: r.body.locations[0].verified_at, canonical: true }]);
    assert.ok(!r.text.includes(tmp), 'no server paths in responses');
    console.log('✅ init → PUT (upload token) → complete; size + sha256 checked');

    // ── Private download: signed, short-lived ──
    r = await call('GET', `/o/${id}`, { bearer: null });
    assert.strictEqual(r.status, 404, 'a private object is not reachable without a signature');
    r = await call('GET', `${O}/${id}/download`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.public, false);
    assert.ok(Date.parse(r.body.expires_at) > Date.now());
    const signed = r.body.url;
    r = await call('GET', local(signed), { bearer: null });
    assert.deepStrictEqual([r.status, r.text, r.headers.get('content-type'), r.headers.get('x-content-type-options'), r.headers.get('cache-control')], [200, 'hello world', 'text/plain', 'nosniff', 'private, no-store']);
    assert.strictEqual(r.headers.get('content-disposition'), 'inline; filename="hello.txt"');
    r = await call('GET', local(signed).replace(/sig=[^&]+/, 'sig=AAAA'), { bearer: null });
    assert.strictEqual(r.status, 404, 'tampered signature');
    const past = now - 10;
    const oldSig = crypto.createHmac('sha256', 'test-signing-secret').update(`get\n${id}\n${past}`).digest('base64url');
    r = await call('GET', `/o/${id}?exp=${past}&sig=${oldSig}`, { bearer: null });
    assert.strictEqual(r.status, 404, 'expired signature');
    const putSig = crypto.createHmac('sha256', 'test-signing-secret').update(`put\n${id}\n${now + 100}`).digest('base64url');
    r = await call('GET', `/o/${id}?exp=${now + 100}&sig=${putSig}`, { bearer: null });
    assert.strictEqual(r.status, 404, 'an upload signature is not a download signature');
    r = await call('GET', `${O}/${id}/download?redirect=1`);
    assert.strictEqual(r.status, 302);
    console.log('✅ private objects: signed short-lived URLs only');

    // ── Public object: app-key PUT, 302 to /o, Range ──
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), crypto.randomBytes(100)]);
    r = await call('POST', O, { body: { kind: 'screenshot', visibility: 'public' } });
    const pubId = r.body.id;
    r = await call('PUT', `${O}/${pubId}/content`, { raw: png, headers: { 'content-type': 'image/png' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await call('POST', `${O}/${pubId}/complete`);
    assert.deepStrictEqual([r.body.mime_type, r.body.public_url], ['image/png', `https://media.test/o/${pubId}`]);
    r = await call('GET', `${O}/${pubId}/download`);
    assert.deepStrictEqual([r.status, r.headers.get('location')], [302, `https://media.test/o/${pubId}`]);
    r = await call('GET', `/o/${pubId}`, { bearer: null, headers: { range: 'bytes=0-7' } });
    assert.deepStrictEqual([r.status, r.headers.get('content-range'), r.headers.get('content-type')], [206, `bytes 0-7/${png.length}`, 'image/png']);
    console.log('✅ public objects: 302 to the public location, ranged bytes at /o/:id');

    // ── Service tokens ──
    r = await call('POST', O, { bearer: tok(), headers: { 'x-ov-subject': `user:${SUBJECT}` }, body: { kind: 'asset', size_bytes: 3 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.object.owner.subject, r.body.object.metadata.created_by], [SUBJECT, 'svc:example']);
    const svcId = r.body.id;
    r = await call('PUT', `${O}/${svcId}/content`, { bearer: tok(), raw: Buffer.from('abc') });
    assert.strictEqual(r.status, 200);
    r = await call('POST', `${O}/${svcId}/complete`, { bearer: tok() });
    assert.strictEqual(r.body.lifecycle_status, 'ready');
    r = await call('POST', O, { bearer: tok(), headers: { 'x-ov-subject': 'alice' }, body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.object.invalid'], 'owner must be a usr_ subject');
    r = await call('POST', O, { bearer: tok({ ns: ['community'] }), body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied']);
    r = await call('POST', O, { bearer: tok({ cap: ['media.object.read'] }), body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'read grant cannot upload');
    r = await call('GET', `${O}?owner=${SUBJECT}`, { bearer: tok({ cap: ['media.object.read'] }) });
    assert.deepStrictEqual(r.body.objects.map(o => o.id), [svcId], 'read grant lists; owner filter');
    r = await call('GET', `${O}/${svcId}`, { bearer: tok({ cap: ['media.object.upload'] }) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'upload grant cannot read');
    r = await call('POST', `${O}/${svcId}/holds`, { bearer: tok(), body: { kind: 'admin' } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'holds are app-key only');
    r = await call('GET', `/api/v2/games/objects/${svcId}`, { bearer: 'games-key' });
    assert.strictEqual(r.status, 404, 'objects are namespaced');
    r = await call('GET', `/api/v2/games/objects/${svcId}`, { bearer: 'live-key' });
    assert.strictEqual(r.status, 403, "another app's key is refused");
    console.log('✅ service tokens: capability + namespace enforced, X-OV-Subject owns the object');

    // ── Cursor listing ──
    const page1 = await call('GET', `${O}?limit=2`);
    assert.strictEqual(page1.body.objects.length, 2);
    assert.ok(page1.body.next_cursor);
    const page2 = await call('GET', `${O}?limit=2&cursor=${page1.body.next_cursor}`);
    const seen = [...page1.body.objects, ...page2.body.objects].map(o => o.id);
    assert.deepStrictEqual(seen, [svcId, pubId, id], 'newest first, no duplicates');
    assert.strictEqual(page2.body.next_cursor, null);
    assert.deepStrictEqual((await call('GET', `${O}?kind=screenshot`)).body.objects.map(o => o.id), [pubId]);
    assert.deepStrictEqual((await call('GET', `${O}?visibility=private&kind=file`)).body.objects.map(o => o.id), [id]);
    assert.strictEqual((await call('GET', `${O}?cursor=nope`)).status, 400);
    console.log('✅ cursor listing with filters');

    // ── Acting users see public + their own ──
    r = await call('POST', O, { headers: { 'x-ov-user-id': '7' }, body: { kind: 'file', visibility: 'private' } });
    const sevens = r.body.id;
    assert.strictEqual(r.body.object.owner.user_id, 7);
    assert.strictEqual((await call('GET', `${O}/${sevens}`, { headers: { 'x-ov-user-id': '8' } })).status, 404);
    assert.ok(!(await call('GET', O, { headers: { 'x-ov-user-id': '8' } })).body.objects.some(o => o.id === sevens || o.id === id), 'no enumeration of others\' private objects');
    assert.ok((await call('GET', O, { headers: { 'x-ov-user-id': '7' } })).body.objects.some(o => o.id === sevens));
    assert.strictEqual((await call('DELETE', `${O}/${pubId}`, { headers: { 'x-ov-user-id': '8' } })).status, 403);
    console.log('✅ acting users: public + own objects only');

    // ── Holds, soft delete, restore ──
    r = await call('POST', `${O}/${id}/holds`, { body: { kind: 'dmca', reason: 'notice 42' } });
    assert.strictEqual(r.status, 201);
    const holdId = r.body.id;
    assert.strictEqual(r.body.created_by, 'app:live');
    assert.strictEqual((await call('GET', `${O}/${id}`)).body.held, true);
    r = await call('DELETE', `${O}/${id}`);
    assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.held']);
    assert.strictEqual((await call('POST', `${O}/${id}/holds`, { body: { kind: 'nope' } })).status, 400);
    assert.strictEqual((await call('GET', `${O}/${id}/holds`)).body.holds.length, 1);
    r = await call('DELETE', `${O}/${id}/holds/${holdId}`);
    assert.ok(r.body.released_at);
    assert.strictEqual((await call('GET', `${O}/${id}/holds`)).body.holds.length, 0);
    assert.strictEqual((await call('GET', `${O}/${id}/holds?all=1`)).body.holds.length, 1);
    r = await call('DELETE', `${O}/${id}`);
    assert.deepStrictEqual([r.status, r.body.lifecycle_status], [200, 'deleted']);
    assert.ok(fs.existsSync(stored), 'soft delete keeps the bytes');
    assert.strictEqual((await call('GET', local(signed), { bearer: null })).status, 410, 'a deleted object is gone, even with a valid signature');
    assert.strictEqual((await call('GET', `${O}/${id}/download`)).status, 410);
    assert.ok(!(await call('GET', O)).body.objects.some(o => o.id === id), 'deleted objects leave the default listing');
    assert.ok((await call('GET', `${O}?include_deleted=1`)).body.objects.some(o => o.id === id));
    r = await call('POST', `${O}/${id}/restore`);
    assert.deepStrictEqual([r.status, r.body.lifecycle_status], [200, 'ready']);
    assert.strictEqual((await call('POST', `${O}/${id}/restore`)).status, 409);
    console.log('✅ holds block deletion (409); soft delete keeps bytes; restore');

    // ── Integrity + limits ──
    r = await call('POST', O, { body: { kind: 'file', content_hash: sha(Buffer.from('expected')) } });
    const badId = r.body.id;
    await call('PUT', `${O}/${badId}/content`, { raw: Buffer.from('something else') });
    r = await call('POST', `${O}/${badId}/complete`);
    assert.deepStrictEqual([r.status, r.body.code], [422, 'media.object.hash_mismatch']);
    assert.strictEqual((await call('POST', O, { body: { kind: 'file', content_hash: 'xyz' } })).status, 400);
    assert.strictEqual((await call('POST', O, { body: { kind: 'nope' } })).status, 400);
    r = await call('POST', O, { body: { kind: 'file', size_bytes: 2 * 1024 * 1024 } });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.object.too_large'], 'MEDIA_OBJECT_MAX_MB at init');
    r = await call('POST', O, { body: { kind: 'file' } });
    r = await call('PUT', `${O}/${r.body.id}/content`, { raw: crypto.randomBytes(1024 * 1024 + 10) });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.object.too_large'], 'and while streaming');
    r = await call('POST', O, { body: { kind: 'vod', visibility: 'public', size_bytes: 10 } });
    assert.deepStrictEqual([r.status, r.body.code], [422, 'media.invariant.public_object_too_large'], 'public playback objects over the invariant are refused');
    r = await call('POST', O, { body: { kind: 'vod', visibility: 'private', size_bytes: 10 } });
    assert.strictEqual(r.status, 201, 'private ones are not public playback');
    const T = '/api/v2/tiny/objects';
    assert.deepStrictEqual([(r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 30 } })).status, r.body.code], [413, 'media.quota.exceeded']);
    assert.strictEqual((await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 10 } })).status, 201);
    r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 15 } });
    assert.strictEqual(r.status, 413, 'reservations count against the quota at init');
    r = await call('POST', T, { bearer: 'tiny-key', body: {} });
    r = await call('PUT', `${T}/${r.body.id}/content`, { bearer: 'tiny-key', raw: Buffer.alloc(15) });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.quota.exceeded'], 'and again with the real size');
    assert.deepStrictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.tmp')), [], 'refused uploads leave no temp files');
    console.log('✅ hash mismatch, size limit, invariant and quota enforced');

    // ── Legacy projections through v2 ──
    r = await call('POST', '/api/v1/live/vods', { body: { title: 'Rec', user_id: 3 } });
    const vodId = r.body.id;
    const legacy = `legacy:live:vod:${vodId}`;
    r = await call('GET', `${O}/${legacy}`);
    assert.deepStrictEqual([r.status, r.body.kind, r.body.lifecycle_status, r.body.legacy_ref], [200, 'vod', 'uploading', legacy], 'a v1 vod creates its object; readable by legacy ref');
    const vodObj = r.body.id;
    assert.strictEqual((await call('DELETE', `${O}/${vodObj}`)).body.code, 'media.object.legacy_managed');
    fs.writeFileSync(path.join(process.env.VOD_PATH, 'v.webm'), 'x');
    db.run('UPDATE vods SET file_path = ?, file_size = 1, duration_seconds = 5 WHERE id = ?', [path.join(process.env.VOD_PATH, 'v.webm'), vodId]);
    model.sync('vod', vodId);
    r = await call('GET', `${O}/${vodObj}/download`);
    assert.deepStrictEqual([r.status, r.headers.get('location')], [302, `https://media.test/v/${vodId}`], 'public legacy objects redirect to their inherited URL');
    await call('POST', `${O}/${vodObj}/holds`, { body: { kind: 'evidence' } });
    r = await call('DELETE', `/api/v1/live/vods/${vodId}`);
    assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.held'], 'v1 delete honours the hold');
    assert.ok(fs.existsSync(path.join(process.env.VOD_PATH, 'v.webm')));
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('data')], { type: 'text/plain' }), 'x.txt');
    r = await fetch(`${base}/api/v1/live/files`, { method: 'POST', headers: { authorization: 'Bearer live-key' }, body: fd }).then(async (x) => ({ status: x.status, body: await x.json() }));
    assert.strictEqual(r.status, 201);
    const fileObj = (await call('GET', `${O}/legacy:live:file:${r.body.key}`)).body;
    assert.deepStrictEqual([fileObj.kind, fileObj.content_hash, fileObj.visibility], ['file', r.body.sha256, 'public'], 'v1 file upload creates its object');
    await call('POST', `${O}/${fileObj.id}/holds`, { body: { kind: 'moderation' } });
    assert.strictEqual((await call('DELETE', `/api/v1/live/files/${r.body.key}`)).status, 409);
    const v1List = await call('GET', '/api/v1/live/files');
    assert.ok(!('object_id' in v1List.body.files[0]), 'v1 responses are unchanged');
    console.log('✅ legacy projections: readable via v2, deleted only via v1, holds honoured there');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('object API v2: all checks passed');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
