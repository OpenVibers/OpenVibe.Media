'use strict';
// Media's Network keys (server/auth.js, openvibe-sdk/auth createNetworkKeys): the API, the internal guard and the
// site sign-in (server/user-auth.js) verify with the same keys, loaded from Network's JWKS at boot and following a
// rotation on an unknown kid. The site sign-in never takes a typed token (a FedCM assertion, a realtime ticket, an
// export token) or a service principal for a session, whoever signed it.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const K1 = pair(), K2 = pair(), ROGUE = pair();
const jwkOf = (k, kid) => ({ ...k.publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid });
let published = [jwkOf(K1, 'k1')];
let fetches = 0;
const network = http.createServer((req, res) => {
    if (req.url !== '/api/.well-known/jwks') { res.statusCode = 404; return res.end(); }
    fetches++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: published }));
});

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    const ISS = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_NETWORK_URL = ISS;
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    const warn = console.warn; const log = console.log;
    console.warn = () => {}; console.log = () => {};
    const express = require('express');
    const auth = require('../server/auth');
    const userAuth = require('../server/user-auth');
    const { guard } = require('../server/service-guard');

    const now = () => Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const sign = (k, kid, claims) => {
        const input = `${enc({ alg: 'RS256', typ: 'JWT', kid })}.${enc(claims)}`;
        return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), k.privateKey).toString('base64url')}`;
    };
    const session = (extra = {}) => ({ sub: 7, subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', username: 'x', role: 'user', iss: ISS, aud: ['openvibe.network', 'openvibe.media'], iat: now(), exp: now() + 600, ...extra });
    const service = (cap) => ({ iss: ISS, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.media'], cap, ns: [], iat: now(), exp: now() + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` });
    const site = userAuth.createAuthClient({ networkUrl: ISS, networkInternalUrl: ISS, oauth: { clientId: 'media', clientSecret: '', redirectUri: 'https://media.test/auth/callback' } });

    const app = express();
    app.post('/internal/probe', guard('media.avatar.ingest'), (req, res) => res.json({ sub: req.principal.sub }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const probe = (token) => fetch(`http://127.0.0.1:${server.address().port}/internal/probe`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

    try {
        assert.strictEqual(auth.jwksLoaded(), false, 'nothing fetched at module load');
        auth.startJwksRefresh();
        for (let i = 0; i < 100 && !auth.jwksLoaded(); i++) await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(auth.jwksLoaded(), true, 'loaded at boot');

        const claims = await site.verify(sign(K1, 'k1', session()));
        assert.ok(claims && claims.subject_id === 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', 'a session signs in on the site');
        for (const [what, extra] of [['a FedCM assertion', { typ: 'fedcm' }], ['a realtime ticket', { typ: 'realtime', purpose: 'realtime' }],
            ['an export token', { purpose: 'export' }], ['a service principal', { sub: 'svc:live', actor_type: 'service' }]]) {
            assert.strictEqual(await site.verify(sign(K1, 'k1', session(extra))), null, `${what} is not a session on the site`);
        }
        assert.strictEqual(await site.verify(sign(ROGUE, 'k1', session())), null, 'a key Network never published');

        const before = fetches;
        published = [jwkOf(K2, 'k2'), jwkOf(K1, 'k1')];
        let r = await probe(sign(K2, 'k2', service(['media.avatar.ingest'])));
        assert.strictEqual(r.status, 200, 'the guard follows a rotation');
        assert.strictEqual(fetches, before + 1, 'after one refetch');
        assert.ok(await site.verify(sign(K2, 'k2', session())), 'and so does the site sign-in');
        r = await probe(sign(K2, 'k2', service([])));
        assert.strictEqual(r.status, 403);
        r = await probe(sign(ROGUE, 'k2', service(['media.avatar.ingest'])));
        assert.strictEqual(r.status, 401, 'a forged service token');
        r = await probe(sign(K2, 'k2', session()));
        assert.strictEqual(r.status, 401, 'a session token is not a service token');
    } finally {
        auth.stopJwksRefresh();
        server.close();
        network.close();
        console.warn = warn; console.log = log;
    }
    console.log('network-keys: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
