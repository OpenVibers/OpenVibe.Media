'use strict';
// VIS-6 in Media: an unsafe-image review's three categories are enforcement, not advice.
//   fine          the object serves as before
//   sex_acts      hidden from every public surface; a signed read still keeps it for its owner
//   minor_sexual  quarantined even from a signed read, with the operator's report id on the row
// A visible upload is pending until Vision answers, so an outage cannot publish an unreviewed image.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ids, serviceAuth } = require('openvibe-contracts');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-review-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    process.env.MEDIA_OBJECT_MAX_MB = '2';
    process.env.MEDIA_PUBLIC_OBJECT_MAX_MB = '10';
    process.env.OV_NETWORK_INTERNAL_URL = 'http://127.0.0.1:1';   // replaced below with the mock's address
    process.env.OV_OAUTH_CLIENT_ID = 'media';
    process.env.OV_OAUTH_CLIENT_SECRET = 'media-secret';

    // ── Vision, as Media sees it: a token, then one review per image ──
    const state = { category: 'fine', fail: false, requests: [] };
    const vision = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return send(200, { access_token: 'svc-vision-review', token_type: 'Bearer', expires_in: 300 });
            if (req.url === '/api/v1/review') {
                state.requests.push(JSON.parse(body.toString('utf8')));
                if (state.fail) return send(503, { code: 'vision.review_unavailable', detail: 'the reviewer is down' });
                const out = { category: state.category, action: state.category === 'fine' ? 'allow' : state.category === 'sex_acts' ? 'hide' : 'quarantine_and_report', public: state.category === 'fine', report: state.category === 'minor_sexual' ? { id: 'vor_01JAB2C3D4E5F6G7H8J9K0MNPQ', status: 'open' } : null };
                return send(201, out);
            }
            send(404, {});
        });
    });
    await new Promise((r) => vision.listen(0, '127.0.0.1', r));
    const visionBase = `http://127.0.0.1:${vision.address().port}`;
    process.env.VISION_URL = visionBase;
    process.env.OV_NETWORK_INTERNAL_URL = visionBase;

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const objectRoutes = require('../server/objects/routes');
    const express = require('express');
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    const nowS = Math.floor(Date.now() / 1000);
    const svc = (cap) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:vision', actor_type: 'service', aud: ['openvibe.media'], cap, ns: ['live'], iat: nowS, exp: nowS + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey);

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const app = express();
    app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
    app.use(express.json());
    app.use('/api/v2/:app/objects', objectRoutes);
    app.use('/o', objectRoutes.publicRouter);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = (u) => base + String(u).replace('https://media.test', '');
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const png = await require('sharp')({ create: { width: 80, height: 60, channels: 3, background: '#3355aa' } }).png().toBuffer();
    const O = '/api/v2/live/objects';
    const call = async (method, p, { body, raw, headers = {}, bearer = 'live-key' } = {}) => {
        const h = { authorization: `Bearer ${bearer}`, ...headers };
        let payload;
        if (raw !== undefined) payload = raw;
        else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
        const res = await fetch(p.startsWith('http') ? p : base + p, { method, headers: h, body: payload, redirect: 'manual' });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* bytes */ }
        return { status: res.status, body: json, text, headers: res.headers };
    };
    async function upload({ kind = 'screenshot', visibility = 'public', mime = 'image/png', bytes = png } = {}) {
        let r = await call('POST', O, { body: { kind, visibility, mime_type: mime, size_bytes: bytes.length, content_hash: sha(bytes) } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.body.id;
        r = await call('PUT', `${O}/${id}/content`, { raw: bytes, headers: { 'content-type': mime } });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('POST', `${O}/${id}/complete`);
        assert.strictEqual(r.status, 200, r.text);
        return { id, complete: r.body };
    }

    let passed = 0;
    const check = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

    await check('fine: the image serves publicly, and the row says clear', async () => {
        state.category = 'fine';
        const { id, complete } = await upload();
        globalThis.__fineId = id;
        assert.strictEqual(complete.review.category, 'fine');
        assert.strictEqual(complete.review.status, 'clear');
        assert.strictEqual(complete.public_url, `https://media.test/o/${id}`);
        const got = await fetch(`${base}/o/${id}`);
        assert.strictEqual(got.status, 200);
        assert.strictEqual((await call('GET', `${O}/${id}`)).body.visibility, 'public');
    });

    await check('sex_acts: hidden from /o, private in the row, and a signed read still reaches it for its owner', async () => {
        state.category = 'sex_acts';
        const { id, complete } = await upload();
        assert.deepStrictEqual([complete.review.category, complete.review.status, complete.visibility, complete.public_url], ['sex_acts', 'hidden', 'private', null]);
        assert.strictEqual((await fetch(`${base}/o/${id}`)).status, 404);
        const signed = await call('GET', `${O}/${id}/download`);
        assert.strictEqual(signed.status, 200, JSON.stringify(signed.body));
        assert.strictEqual(signed.body.public, false);
        const bytes = await fetch(local(signed.body.url));
        assert.strictEqual(bytes.status, 200, 'the owner keeps the bytes through a signed link');
        assert.strictEqual(Buffer.from(await bytes.arrayBuffer()).length, png.length);
    });

    await check('minor_sexual: quarantined even with a signature, report id kept on the row', async () => {
        state.category = 'minor_sexual';
        const { id, complete } = await upload();
        assert.deepStrictEqual([complete.review.category, complete.review.status, complete.visibility, complete.public_url], ['minor_sexual', 'quarantined', 'private', null]);
        assert.match(complete.review.report_id, /^vor_/);
        assert.strictEqual((await fetch(`${base}/o/${id}`)).status, 404);
        assert.strictEqual((await call('GET', `${O}/${id}/download`)).status, 404, 'a signed download is closed too');
        const row = await db.get('SELECT review_category, review_status, review_report_id FROM media_objects WHERE id = ?', [id]);
        assert.deepStrictEqual([row.review_category, row.review_status], ['minor_sexual', 'quarantined']);
        assert.match(row.review_report_id, /^vor_/);
    });

    await check('a Vision outage leaves the object pending and unserved; a later re-review clears it', async () => {
        state.category = 'fine';
        state.fail = true;
        const { id, complete } = await upload();
        assert.deepStrictEqual([complete.review.status, complete.public_url], ['pending', null]);
        assert.strictEqual((await fetch(`${base}/o/${id}`)).status, 404, 'pending is not public');
        state.fail = false;
        const again = await call('POST', `${O}/${id}/review`);
        assert.strictEqual(again.status, 200, again.text);
        assert.deepStrictEqual([again.body.review.category, again.body.review.status], ['fine', 'clear']);
        assert.strictEqual((await fetch(`${base}/o/${id}`)).status, 200);
    });

    await check('a non-image is never sent to Vision', async () => {
        const before = state.requests.length;
        const text = Buffer.from('hello world');
        const { complete } = await upload({ kind: 'file', mime: 'text/plain', bytes: text });
        assert.strictEqual(state.requests.length, before, 'text files are not reviewed');
        assert.deepStrictEqual([complete.review.status, complete.public_url !== null], ['clear', true]);
    });

    await check('an operator decision needs the service capability; the same enforcement follows', async () => {
        state.category = 'fine';
        const { id } = await upload();
        const no = await call('POST', `${O}/${id}/review-decision`, { body: { category: 'sex_acts' } });
        assert.deepStrictEqual([no.status, no.body.code], [403, 'capability.denied']);
        const r = await call('POST', `${O}/${id}/review-decision`, { body: { category: 'sex_acts' }, bearer: svc(['media.object.review.decide']) });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.body.review.category, r.body.review.status, r.body.visibility], ['sex_acts', 'hidden', 'private']);
        assert.strictEqual((await fetch(`${base}/o/${id}`)).status, 404);
        const bad = await call('POST', `${O}/${id}/review-decision`, { body: { category: 'nudity' }, bearer: svc(['media.object.review.decide']) });
        assert.deepStrictEqual([bad.status, bad.body.code], [400, 'media.object.invalid']);
    });

    await check('minor_sexual places an evidence hold; the owner delete is the usual neutral 409', async () => {
        state.category = 'minor_sexual';
        const { id } = await upload();
        const hold = await db.get("SELECT id, kind, released_at, released_by FROM media_holds WHERE object_id = ? AND kind = 'evidence' AND released_at IS NULL", [id]);
        assert.ok(hold && hold.id, 'an open evidence hold exists');
        const del = await call('DELETE', `${O}/${id}`);
        assert.deepStrictEqual([del.status, del.body.code], [409, 'media.object.held']);
        // A second category-3 decision does not duplicate the hold.
        await call('POST', `${O}/${id}/review-decision`, { body: { category: 'minor_sexual', report_id: 'vor_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, bearer: svc(['media.object.review.decide']) });
        const count = await db.get("SELECT COUNT(*)::int AS n FROM media_holds WHERE object_id = ? AND kind = 'evidence'", [id]);
        assert.strictEqual(Number(count.n), 1);
    });

    await check('operator view: only the review.view capability, only hidden/quarantined, and it opens a 60-second URL', async () => {
        state.category = 'minor_sexual';
        const { id } = await upload();
        const no = await call('POST', `${O}/${id}/operator-view`, { body: {} });
        assert.deepStrictEqual([no.status, no.body.code], [403, 'capability.denied'], 'an app key is not an operator');
        const wrong = await call('POST', `${O}/${id}/operator-view`, { body: {}, bearer: svc(['media.object.review.decide']) });
        assert.strictEqual(wrong.status, 403, 'another capability is not view');
        const r = await call('POST', `${O}/${id}/operator-view`, { body: {}, bearer: svc(['media.object.review.view']) });
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.body.url, /\?exp=\d+&sig=/);
        const ttl = Math.round((Date.parse(r.body.expires_at) - Date.now()) / 1000);
        assert.ok(ttl >= 30 && ttl <= 60, `a 60-second view, got ${ttl}s`);
        const bytes = await fetch(local(r.body.url));
        assert.strictEqual(bytes.status, 200, 'the operator URL opens a quarantined object');
        const fine = await call('POST', `${O}/${globalThis.__fineId}/operator-view`, { body: {}, bearer: svc(['media.object.review.view']) });
        assert.deepStrictEqual([fine.status, fine.body.code], [409, 'media.object.not_reviewed']);
        // A past operator signature does not open it.
        const past = nowS - 10;
        const sig = crypto.createHmac('sha256', 'test-signing-secret').update(`operator\n${id}\n${past}`).digest('base64url');
        assert.strictEqual((await fetch(`${base}/o/${id}?exp=${past}&sig=${sig}`)).status, 404);
        const viewed = await db.get('SELECT viewer_sub, expires_at FROM media_review_views WHERE object_id = ? ORDER BY id DESC LIMIT 1', [id]);
        assert.strictEqual(viewed.viewer_sub, 'svc:vision');
    });

    await check('an operator overruling to fine releases the evidence hold with who and when', async () => {
        state.category = 'minor_sexual';
        const { id } = await upload();
        const open = await db.get("SELECT id FROM media_holds WHERE object_id = ? AND kind = 'evidence' AND released_at IS NULL", [id]);
        assert.ok(open);
        const r = await call('POST', `${O}/${id}/review-decision`, { body: { category: 'fine', report_id: 'vor_01JAB2C3D4E5F6G7H8J9K0MNPQ', decided_by: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, bearer: svc(['media.object.review.decide']) });
        assert.strictEqual(r.status, 200, r.text);
        const released = await db.get('SELECT released_at, released_by FROM media_holds WHERE id = ?', [open.id]);
        assert.ok(released.released_at);
        assert.strictEqual(released.released_by, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        const del = await call('DELETE', `${O}/${id}`);
        assert.strictEqual(del.status, 200, del.text);
    });

    console.log(`object review: ${passed} checks passed`);
    await new Promise((r) => server.close(r));
    await new Promise((r) => vision.close(r));
})().catch((e) => { console.error(e); process.exit(1); });
