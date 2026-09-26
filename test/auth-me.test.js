'use strict';
// GET /auth/me, the shared navbar's session probe (server/user-auth.js): a guest (no ov_token cookie and
// no bearer token at all) is signed out, not an error, so it answers 200 { user: null }; the 401 logged a
// console error on every guest page view (browser check, OpenVibe.Host). A credential that is present but
// invalid or expired still answers 401; a good one answers the profile.
const assert = require('assert');
const express = require('express');
const { createAuthRoutes } = require('../server/user-auth');

(async () => {
    const verified = [];
    const auth = {   // stands in for the JWKS-backed offline verifier
        verify: async (token) => { verified.push(token); return token === 'good' ? { sub: '7', username: 'ana', display_name: 'Ana', exp: Math.floor(Date.now() / 1000) + 600 } : null; },
    };
    const config = { baseUrl: 'http://media.test', networkUrl: 'http://network.test', cookies: { secure: false }, oauth: { clientId: 'media', clientSecret: '', redirectUri: 'http://media.test/auth/callback' } };
    const app = express();
    app.use((req, _res, next) => {   // as server/index.js parses cookies (no cookie-parser dependency)
        req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]));
        next();
    });
    app.use('/auth', createAuthRoutes(config, auth));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const me = async (headers = {}) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/auth/me`, { headers });
        return { status: r.status, cache: r.headers.get('cache-control'), json: await r.json() };
    };
    try {
        const guest = await me();
        assert.deepStrictEqual([guest.status, guest.json], [200, { user: null }], 'a guest is signed out');
        assert.strictEqual(guest.cache, 'private, no-store');
        assert.deepStrictEqual(verified, [], 'nothing to verify');

        assert.strictEqual((await me({ cookie: 'ov_token=expired.or.forged' })).status, 401, 'a present but invalid cookie');
        assert.strictEqual((await me({ authorization: 'Bearer nope' })).status, 401, 'a present but invalid bearer token');

        const ok = await me({ cookie: 'ov_token=good' });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.json.user.username, 'ana');
        console.log('auth-me: a guest gets 200 { user: null }, a bad credential 401');
    } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
