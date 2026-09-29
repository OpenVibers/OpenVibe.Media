'use strict';
// Per-actor rate limits at the capability boundaries (server/actor-limits.js, roadmap WS-R task 4): past
// its limit one caller gets 429 problem+json `rate_limited` with Retry-After, before the route does any
// work, while another caller still passes; the window reopens on the clock; an app's own API key is not
// counted, an app acting for one of its users is counted per user; refusals are logged and counted.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-limits-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    process.env.MEDIA_LIMITS_MINUTE = '3';
    process.env.MEDIA_LIMITS_HOUR = '100';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const actorLimits = require('../server/actor-limits');
    const objectRoutes = require('../server/objects/routes');
    const { serviceAuth } = require('openvibe-contracts');
    const express = require('express');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const iat = Math.floor(Date.now() / 1000);
    const tok = (sub) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub, actor_type: 'service', aud: ['openvibe.media'], cap: ['media.object.upload', 'media.object.read'], ns: ['live'], iat, exp: iat + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey);
    const ONE = tok('svc:one'), TWO = tok('svc:two');

    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left.
    let t = Date.UTC(2026, 8, 27, 12, 0, 15);
    actorLimits._setClockForTests(() => t);
    const refusals = [];
    actorLimits.bindMetrics({ counter: () => ({ inc: (labels) => refusals.push(labels) }) });
    const logged = [];
    const warn = console.warn;
    console.warn = (...a) => { logged.push(a.join(' ')); };

    const app = express();
    app.use(express.json());
    app.use('/api/v2/:app/objects', objectRoutes);
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = async (method, p, { bearer, body, headers = {} } = {}) => {
            const h = { ...headers };
            if (bearer) h.authorization = `Bearer ${bearer}`;
            let payload;
            if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
            const res = await fetch(base + p, { method, headers: h, body: payload });
            const text = await res.text();
            let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
            return { status: res.status, body: json, headers: res.headers };
        };
        const O = '/api/v2/live/objects';

        // ── A read route: MEDIA_LIMITS_MINUTE (3 here) per caller ──
        for (let i = 0; i < 3; i++) assert.strictEqual((await call('GET', O, { bearer: ONE })).status, 200);
        let r = await call('GET', O, { bearer: ONE });
        assert.strictEqual(r.status, 429, 'the fourth read in the minute is refused');
        assert.strictEqual(r.headers.get('retry-after'), '45', 'Retry-After: the rest of the minute');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')));
        assert.deepStrictEqual([r.body.code, r.body.status, r.body.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(r.body.detail.includes('media.object.list'), r.body.detail);
        assert.strictEqual((await call('GET', O, { bearer: TWO })).status, 200, 'another principal still passes');
        assert.strictEqual((await call('GET', O, { bearer: 'not-a-token' })).status, 401, 'no credential: 401 from auth first, never a 429');
        assert.strictEqual((await call('GET', `${O}/med_missing`, { bearer: ONE })).status, 404, 'each route has its own count');
        t += 45 * 1000;
        assert.strictEqual((await call('GET', O, { bearer: ONE })).status, 200, 'the next minute opens the window again');
        console.log('✅ reads: 3 per minute per principal, 429 rate_limited + Retry-After, another principal passes');

        // ── An app's own key is not counted; an app acting for a user is counted per user ──
        for (let i = 0; i < 8; i++) assert.strictEqual((await call('GET', O, { bearer: 'live-key' })).status, 200);
        const asUser = (id) => ({ bearer: 'live-key', headers: { 'x-ov-user-id': String(id) } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await call('GET', O, asUser(7))).status, 200);
        r = await call('GET', O, asUser(7));
        assert.deepStrictEqual([r.status, r.body.code], [429, 'rate_limited'], 'user 7 of live is over');
        assert.strictEqual((await call('GET', O, asUser(8))).status, 200, 'user 8 of live still passes');
        assert.strictEqual((await call('GET', O, { bearer: 'live-key' })).status, 200, 'the app itself still passes');
        console.log('✅ app key not counted; X-OV-User-Id counted per user');

        // ── A write route has its own, tighter numbers: init 30 per minute ──
        t = Date.UTC(2026, 8, 27, 12, 5, 0);
        const init = async (bearer) => await call('POST', O, { bearer, body: { kind: 'file', mime_type: 'text/plain', size_bytes: 5, visibility: 'private' } });
        for (let i = 0; i < 30; i++) assert.strictEqual((await init(ONE)).status, 201);
        r = await init(ONE);
        assert.deepStrictEqual([r.status, r.body.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
        const before = (await db.get('SELECT COUNT(*) AS n FROM media_objects')).n;
        await init(ONE);
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_objects')).n, before, 'a refused init makes nothing');
        assert.strictEqual((await init(TWO)).status, 201, 'another principal still uploads');
        console.log('✅ uploads: 30 inits per minute per principal, refused before any row is made');

        // ── Refusals are logged (no credential) and counted ──
        assert.ok(refusals.some((l) => l.limit === 'media.object.list' && l.window === 'minute'));
        assert.ok(refusals.some((l) => l.limit === 'media.object.upload' && l.window === 'minute'));
        assert.ok(logged.some((l) => l.includes('[Limits] media.object.upload: svc:one refused, over 30 per minute')), logged.join('\n'));
        assert.ok(!logged.some((l) => l.includes('live-key') || l.includes(ONE)), 'no credential in the log');
        assert.strictEqual(actorLimits.actor({ authType: 'app', appId: 'live', ip: '127.0.0.1' }), null);
        assert.strictEqual(actorLimits.actor({ ip: '203.0.113.9' }), 'ip:203.0.113.9', 'an upload token alone: by address');
        assert.strictEqual(actorLimits.actor({ person: { subject: 'usr_x' } }), 'user:usr_x');
        console.log('✅ refusals logged and counted (media_rate_limited_total)');

        console.warn = warn;
        server.close();
        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('\nactor-limits: all passed');
    })().catch((err) => { console.warn = warn; console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
