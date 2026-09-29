'use strict';
// POST /internal/avatar-ingest authorization (plan T2, X-Internal-Key retirement): a Network service
// token holding media.avatar.ingest reaches the handler; a token without it is 403; another audience
// or a sandbox token is 401; a Bearer is judged on the token alone and never downgraded to
// INTERNAL_API_KEY; the key alone still works; and anything that came through the proxy is refused
// whatever it carries (server/service-guard.js).
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.INTERNAL_API_KEY = 'k'.repeat(40);   // a fake key, built at runtime so no literal looks like a secret

(async () => {
    const express = require('express');
    const auth = require('../server/auth');
    const { guardOrKey } = require('../server/service-guard');
    const { serviceAuth } = require('openvibe-contracts');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);

    const now = Math.floor(Date.now() / 1000);
    const tok = (over = {}) => serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub: 'svc:network', actor_type: 'service',
        aud: ['openvibe.media'], cap: ['media.avatar.ingest'], iat: now, exp: now + 300, jti: 'tok_avatar_0001', ...over,
    }, keys.privateKey);
    const forged = serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub: 'svc:network', actor_type: 'service',
        aud: ['openvibe.media'], cap: ['media.avatar.ingest'], iat: now, exp: now + 300, jti: 'tok_avatar_0002',
    }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);

    let reached = 0;
    const app = express();
    app.use(express.json());
    app.post('/internal/avatar-ingest', guardOrKey('media.avatar.ingest'), (req, res) => { reached++; res.json({ ok: true, principal: req.principal || null }); });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (headers = {}) => fetch(`${base}/internal/avatar-ingest`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    const KEY = process.env.INTERNAL_API_KEY;
    try {
        let r = await post({ authorization: `Bearer ${tok()}` });
        assert.deepStrictEqual([r.status, r.body.ok], [200, true], 'a token with media.avatar.ingest reaches the handler');
        assert.strictEqual(r.body.principal.cap[0], 'media.avatar.ingest');

        r = await post({ authorization: `Bearer ${tok({ cap: ['media.object.read'] })}` });
        assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'a token without the capability is 403');

        r = await post({ authorization: `Bearer ${tok({ aud: ['openvibe.network'] })}` });
        assert.deepStrictEqual([r.status, r.body.code], [401, 'token.wrong_audience'], 'another audience is 401');

        r = await post({ authorization: `Bearer ${tok({ env: 'sandbox' })}` });
        assert.deepStrictEqual([r.status, r.body.code], [401, 'token.sandbox_refused'], 'a sandbox token is 401');

        r = await post({ authorization: `Bearer ${forged}` });
        assert.strictEqual(r.status, 401, 'a forged token is 401');

        r = await post({ authorization: `Bearer ${forged}`, 'x-internal-key': KEY });
        assert.strictEqual(r.status, 401, 'a Bearer is never downgraded to the key');

        r = await post({});
        assert.strictEqual(r.status, 404, 'no credential looks like a route that is not there');

        r = await post({ 'x-internal-key': 'wrong-key-0000000000000000' });
        assert.strictEqual(r.status, 404, 'a wrong key is refused');

        r = await post({ 'x-internal-key': KEY });
        assert.deepStrictEqual([r.status, r.body.ok], [200, true], 'the key alone still reaches the handler');

        r = await post({ 'x-forwarded-for': '203.0.113.7', authorization: `Bearer ${tok()}`, 'x-internal-key': KEY });
        assert.strictEqual(r.status, 404, 'a request that came through the proxy is refused whatever it carries');

        r = await post({ 'x-real-ip': '203.0.113.7', 'x-internal-key': KEY });
        assert.strictEqual(r.status, 404, 'a proxy header with the key only is refused');

        assert.strictEqual(reached, 2, 'only the two authorized requests reached the handler');
        console.log('avatar-ingest auth: all checks passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
