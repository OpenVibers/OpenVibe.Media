'use strict';
// Service-principal tokens on Media's tenant API (roadmap Wave 1/5): accepted only on routes that name
// their capability and only for granted :app namespaces; and the token-only 'community' tenant.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-svc-'));
    process.env.DB_PATH = path.join(tmp, 'media.db');
    process.env.FILES_PATH = path.join(tmp, 'files');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const { serviceAuth } = require('openvibe-contracts');
    const express = require('express');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await auth.ensureTokenOnlyApps();
    await auth.ensureTokenOnlyApps();   // idempotent
    const community = await db.getApp('community');
    assert.ok(community && community.api_key_hash === '' && community.quota_bytes > 0, 'token-only community tenant with a quota');

    const now = Math.floor(Date.now() / 1000);
    const tok = (over = {}) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap: ['media.object.upload'], ns: ['community'], iat: now, exp: now + 300, jti: 'tok_test12345', ...over }, keys.privateKey);

    const app = express();
    app.use('/api/v1/:app/files', require('../server/files/routes'));
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const upload = (appId, bearer) => {
            const fd = new FormData();
            fd.append('file', new Blob([Buffer.from('\x89PNG\r\n\x1a\nfake')], { type: 'image/png' }), 'shot.png');
            return fetch(`${base}/api/v1/${appId}/files`, { method: 'POST', headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, body: fd })
                .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
        };

        let r = await upload('community', tok());
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        assert.ok(r.body.key && r.body.url, 'upload answers key + url');
        r = await upload('live', tok());
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.namespace_denied', 'a community token cannot write the live namespace');
        r = await upload('community', tok({ cap: ['media.object.read'] }));
        assert.strictEqual(r.body.code, 'capability.denied');
        r = await upload('community', tok({ aud: ['openvibe.network'] }));
        assert.strictEqual(r.status, 401, 'wrong audience is not a service credential here');
        r = await upload('community', serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap: ['media.object.upload'], ns: ['community'], iat: now, exp: now + 300, jti: 'tok_forged123' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey));
        assert.strictEqual(r.status, 401, 'forged token refused');
        r = await upload('community', '');
        assert.strictEqual(r.status, 401);
        r = await upload('community', 'live-key');
        assert.strictEqual(r.status, 403, "live's key is not valid for the community tenant");
        let list = await fetch(`${base}/api/v1/community/files`, { headers: { authorization: `Bearer ${tok()}` } });
        assert.strictEqual(list.status, 403, 'listing needs media.object.read');
        list = await fetch(`${base}/api/v1/community/files`, { headers: { authorization: `Bearer ${tok({ cap: ['media.object.upload', 'media.object.read'] })}` } });
        assert.strictEqual(list.status, 200, 'listing with media.object.read');
        assert.strictEqual((await list.json()).files.length, 1);
        server.close();

        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('service tokens: all checks passed');
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
