'use strict';
// Sign-out everywhere reaches openvibe.media (WS-B task 4): POST /internal/events (signature v2,
// never through the proxy) moves the person's cutoff, and the site's token check then refuses their
// older tokens; a forged, foreign or proxied delivery changes nothing; the boot subscription is made once.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-revoke-'));
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.MEDIA_INBOUND_EVENTS_SECRET = 'm'.repeat(40);
const express = require('express');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const revocations = require('../server/revocations');

const SUBJECT = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const at = Date.parse('2026-09-25T12:00:00Z');
const ev = (over = {}) => ({ event_id: 'evt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', event_type: revocations.TOPIC, version: 1, source: 'network',
    payload: { subject: { type: 'user', id: SUBJECT }, valid_after: new Date(at).toISOString(), reason: 'signed_out_everywhere' }, ...over });

(async () => {
    const app = express();
    // As in server/index.js: mounted before the JSON parser (the signature is over the raw body).
    const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    assert.ok(src.indexOf("app.post('/internal/events'") < src.indexOf("app.use(express.json("), 'the events route comes before express.json()');
    app.post('/internal/events', ...revocations.handler());
    app.use(express.json());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/internal/events`;
    const post = (event, { secret = process.env.MEDIA_INBOUND_EVENTS_SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    };
    try {
        const old = { subject_id: SUBJECT, iat: at / 1000 - 30 };
        assert.strictEqual(revocations.isRevoked(old), false);
        assert.strictEqual((await post(ev(), { secret: 'x'.repeat(40) })).status, 401, 'forged');
        assert.strictEqual((await post(ev(), { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 404, 'never through the proxy');
        assert.strictEqual((await post(ev({ source: 'live' }))).body.outcome, 'ignored:source');
        assert.strictEqual(revocations.isRevoked(old), false);
        assert.strictEqual((await post(ev())).body.outcome, 'revoked');
        assert.strictEqual(revocations.isRevoked(old), true, 'older tokens are refused');
        assert.strictEqual(revocations.isRevoked({ subject_id: SUBJECT, iat: at / 1000 + 5 }), false, 'newer ones are fine');
        assert.strictEqual((await post(ev())).body.outcome, 'unchanged', 'a redelivery');
        const src = fs.readFileSync(path.join(__dirname, '../server/user-auth.js'), 'utf8');
        assert.ok(/require\('\.\/revocations'\)\.isRevoked\(claims\)/.test(src), 'the site token check consults it');

        // The boot subscription: created once, then found.
        process.env.EVENTS_URL = 'http://events.test'; process.env.OV_OAUTH_CLIENT_SECRET = 's'.repeat(40);
        const subs = [];
        const fake = async (u, init = {}) => {
            if (/\/oauth\/token$/.test(u)) return new Response(JSON.stringify({ access_token: 't', token_type: 'Bearer', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
            if (init.method === 'POST') { subs.push(JSON.parse(init.body)); return Response.json({ id: 'sub_1' }, { status: 201 }); }
            return Response.json({ subscriptions: subs.map((s, i) => ({ id: `sub_${i}`, ...s })) });
        };
        assert.strictEqual(await revocations.ensureSubscription({ fetchImpl: fake, log: { log() {} } }), 'created');
        assert.strictEqual(await revocations.ensureSubscription({ fetchImpl: fake, log: { log() {} } }), 'exists');
        assert.strictEqual(subs.length, 1);
        assert.strictEqual(subs[0].topic_pattern, revocations.TOPIC);
    } finally {
        srv.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('media revocations: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
