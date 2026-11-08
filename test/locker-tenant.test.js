'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-locker-'));
    process.env.OBJECTS_PATH = path.join(dir, 'objects');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'locker-test-signing';
    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const routes = require('../server/objects/routes');
    const model = require('../server/objects/model');
    const { serviceAuth } = require('openvibe-contracts');
    const express = require('express');
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey); await auth.ensureTokenOnlyApps();
    const tenant = await db.getApp('locker'); assert.strictEqual(tenant.api_key_hash, ''); assert.strictEqual(tenant.quota_bytes, 0);
    const now = Math.floor(Date.now() / 1000);
    const token = (sub = 'svc:locker', ns = ['locker']) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub, actor_type: 'service', aud: ['openvibe.media'],
        cap: ['media.object.upload', 'media.object.read', 'media.object.delete'], ns, iat: now, exp: now + 300, jti: crypto.randomUUID() }, keys.privateKey);
    const app = express(); app.put('/api/v2/:app/objects/:id/content', ...routes.contentHandlers); app.use(express.json()); app.use('/api/v2/:app/objects', routes); app.use('/o', routes.publicRouter);
    const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, body, bearer = token(), raw = false) => fetch(base + p, { method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    try {
        const obj = '/api/v2/locker/objects'; const init = { kind: 'file', visibility: 'private', mime_type: 'application/octet-stream', size_bytes: 5 };
        assert.strictEqual((await call('POST', obj, { ...init, visibility: 'public' })).status, 422);
        assert.strictEqual((await call('POST', obj, { ...init, mime_type: 'image/png' })).status, 422);
        assert.strictEqual((await call('POST', obj, init, token('svc:community', ['community']))).status, 403);
        let r = await call('POST', obj, init); assert.strictEqual(r.status, 201, await r.clone().text()); const { id } = await r.json();
        assert.strictEqual((await call('PUT', `${obj}/${id}/content`, Buffer.from('OVLK!'), token(), true)).status, 200);
        assert.strictEqual((await call('POST', `${obj}/${id}/complete`, {})).status, 200);
        const row = await model.getObject(id); const file = model.objectFilePath(row); assert.ok(fs.existsSync(file));
        assert.strictEqual((await fetch(`${base}/o/${id}`)).status, 404);
        const unlink = fs.unlinkSync;
        fs.unlinkSync = (name) => { if (name === file) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return unlink(name); };
        try {
            assert.strictEqual((await call('DELETE', `${obj}/${id}?purge=1`)).status, 409, 'failed erasure remains pending');
            assert.ok((await model.listLocations(id)).length, 'the durable location is retained for retry');
            assert.ok(fs.existsSync(file));
        } finally { fs.unlinkSync = unlink; }
        assert.strictEqual((await call('DELETE', `${obj}/${id}?purge=1`)).status, 200);
        assert.ok(!fs.existsSync(file), 'expired Send ciphertext is erased, not held through a restore window');
        assert.strictEqual((await call('DELETE', `${obj}/${id}?purge=1`)).status, 200, 'erasure retries are idempotent');
        assert.strictEqual((await call('POST', `${obj}/${id}/restore`, {})).status, 410);
        console.log('locker-tenant: private opaque files, namespace isolation, immediate retryable erasure');
    } finally { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
