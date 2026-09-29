'use strict';
// Service tokens on Media's v1 tenant API (plan T4 / decision D8): Live and OpenRe stop presenting
// Media's `live` app key (MEDIA_API_KEY) and present a Network service token for audience
// openvibe.media instead. Media must serve them identically.
//
//   * every v1 route they call names the verb it performs, so the token is checked against the right
//     capability (auth.js VERBS): read → media.object.read, list → media.object.list,
//     write → media.object.upload, delete → media.object.delete. A collection GET is `list`, so a
//     token holding media.object.read can still list it (the VERBS map keeps that older grant).
//   * a service token for the SAME tenant honours X-OV-User-Id exactly as the app key does, and a
//     token for another tenant is refused before the header is ever read.
//   * the app key keeps answering every one of these routes unchanged.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-svctenant-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.ASSETS_PATH = dir('assets');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const { serviceAuth } = require('openvibe-contracts');
    const express = require('express');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.upsertApp({ app_id: 'community', api_key: 'community-key' });

    const now = Math.floor(Date.now() / 1000);
    let jti = 0;
    // A Network service token for the `live` tenant, as Network will issue it (audience openvibe.media).
    const tok = (over = {}) => serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: ['openvibe.media'],
        cap: ['media.object.read', 'media.object.list', 'media.object.upload', 'media.object.delete'],
        ns: ['live'], iat: now, exp: now + 300, jti: `tok_tenant_${++jti}`,
        ...over,
    }, keys.privateKey);
    const uploadTok = () => tok({ cap: ['media.object.upload'] });
    const KEY = 'live-key';

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
    app.use('/api/v1/:app/assets', require('../server/assets/routes'));
    app.use('/api/v1/:app/views', require('../server/views/routes'));
    const server = http.createServer(app);

    const collect = (r) => ({ status: r.status, code: r.body && r.body.code });

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = async (method, p, { bearer = null, body, headers = {}, form } = {}) => {
            const h = { ...headers };
            if (bearer) h.authorization = `Bearer ${bearer}`;
            let payload;
            if (form) payload = form;
            else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
            const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
            const text = await res.text();
            let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
            return { status: res.status, body: json, text };
        };
        const denied = (r, code = 'capability.denied') => assert.deepStrictEqual([r.status, r.body && r.body.code], [403, code], r.text);
        const allowed = (r, what) => assert.ok(r.status !== 401 && r.status !== 403, `${what} refused a credited token: ${r.status} ${r.text}`);
        const file = (buf, name, type) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); return fd; };

        // ── VOD: create / finalize / update / delete under a write+delete token ──
        // Finalize gets its own VOD: one with no recording file is legitimately discarded there (409,
        // or the empty row deleted) — the point is that it is not an auth refusal.
        let r = await call('POST', '/api/v1/live/vods', { bearer: uploadTok(), body: { title: 'Rec', user_id: 7 } });
        assert.strictEqual(r.status, 201, r.text);
        const emptyVod = r.body.id;
        r = await call('POST', `/api/v1/live/vods/${emptyVod}/finalize`, { bearer: uploadTok() });
        allowed(r, 'finalize');

        r = await call('POST', '/api/v1/live/vods', { bearer: uploadTok(), body: { title: 'Rec', user_id: 7 } });
        assert.strictEqual(r.status, 201, r.text);
        const vodId = r.body.id;
        r = await call('PUT', `/api/v1/live/vods/${vodId}`, { bearer: uploadTok(), body: { title: 'Renamed' } });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('GET', `/api/v1/live/vods/${vodId}`, { bearer: tok({ cap: ['media.object.read'] }) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.title, 'Renamed');   // bare object per CONTRACTS.md
        console.log('✅ a service token holding media.object.upload creates/finalizes/updates a VOD');

        // ── list vs read: collection GET is `list`, single GET is `read` ──
        r = await call('GET', '/api/v1/live/vods', { bearer: tok({ cap: ['media.object.list'] }) });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('GET', '/api/v1/live/vods', { bearer: tok({ cap: ['media.object.read'] }) });
        assert.strictEqual(r.status, 200, 'read lists (the VERBS map keeps the older grant)');
        r = await call('GET', '/api/v1/live/vods', { bearer: uploadTok() });
        denied(r, 'capability.denied');
        r = await call('GET', `/api/v1/live/vods/${vodId}`, { bearer: tok({ cap: ['media.object.list'] }) });
        denied(r, 'capability.denied');
        console.log('✅ list needs media.object.list (read may list); read needs media.object.read');

        // ── A token without the write capability is refused the write ──
        r = await call('POST', '/api/v1/live/vods', { bearer: tok({ cap: ['media.object.read'] }), body: { title: 'nope' } });
        denied(r);
        r = await call('DELETE', `/api/v1/live/vods/${vodId}`, { bearer: tok({ cap: ['media.object.read'] }) });
        denied(r);
        console.log('✅ a token without media.object.upload gets 403 capability.denied');

        // ── Clip: create (cut) / update / delete, on a VOD with a local source ──
        const mediaName = `vod-${vodId}.webm`;
        fs.writeFileSync(path.join(process.env.VOD_PATH, mediaName), Buffer.alloc(64 * 1024, 7));
        await db.run('UPDATE vods SET file_path = ?, duration_seconds = ? WHERE id = ?', [mediaName, 30, vodId]);
        r = await call('POST', '/api/v1/live/clips', { bearer: uploadTok(), body: { vod_id: vodId, start_s: 0, end_s: 2, user_id: 7 } });
        assert.strictEqual(r.status, 202, r.text);
        const clipId = r.body.id;
        r = await call('PUT', `/api/v1/live/clips/${clipId}`, { bearer: uploadTok(), body: { title: 'Cut' } });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('GET', `/api/v1/live/clips/${clipId}`, { bearer: tok({ cap: ['media.object.read'] }) });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('GET', '/api/v1/live/clips', { bearer: tok({ cap: ['media.object.list'] }) });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('POST', '/api/v1/live/clips', { bearer: tok({ cap: ['media.object.read'] }), body: { vod_id: vodId, start_s: 0, end_s: 2 } });
        denied(r);
        console.log('✅ a service token creates/updates/lists a clip; read alone cannot cut');

        // ── Thumbnail (live stream) + asset upload under the same token ──
        const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.alloc(8, 3)]);
        const thumbForm = new FormData(); thumbForm.append('thumbnail', new Blob([jpeg], { type: 'image/jpeg' }), 'live.jpg');
        r = await call('POST', '/api/v1/live/thumbnails/live/stream-1', { bearer: uploadTok(), form: thumbForm });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(String(r.body.url).startsWith('/t/'), r.text);
        const thumbForm2 = new FormData(); thumbForm2.append('thumbnail', new Blob([jpeg], { type: 'image/jpeg' }), 'live.jpg');
        r = await call('POST', '/api/v1/live/thumbnails/live/stream-2', { bearer: tok({ cap: ['media.object.read'] }), form: thumbForm2 });
        denied(r);

        let assetForm = file(Buffer.from('wav'), 'boop.wav', 'audio/wav');
        assetForm.append('kind', 'sound');
        assetForm.append('name', 'boop');
        r = await call('POST', '/api/v1/live/assets', { bearer: uploadTok(), form: assetForm });
        assert.strictEqual(r.status, 201, r.text);
        const assetId = r.body.asset.id;
        r = await call('GET', '/api/v1/live/assets', { bearer: tok({ cap: ['media.object.list'] }) });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('GET', '/api/v1/live/assets', { bearer: uploadTok() });
        denied(r);
        r = await call('DELETE', `/api/v1/live/assets/${assetId}`, { bearer: tok({ cap: ['media.object.delete'] }) });
        assert.strictEqual(r.status, 200, r.text);
        console.log('✅ thumbnail and asset upload need media.object.upload; assets list needs list');

        // ── X-OV-User-Id under a service token, exactly as under the app key ──
        r = await call('POST', '/api/v1/live/vods', { bearer: uploadTok(), body: { title: 'Mine', user_id: 7 } });
        assert.strictEqual(r.status, 201, r.text);
        const mine = r.body.id;
        const scoped = async (bearer, uid) => collect(await call('PUT', `/api/v1/live/vods/${mine}`, { bearer, headers: uid == null ? {} : { 'x-ov-user-id': String(uid) }, body: { title: 'x' } }));
        // The app key is the control: the token must answer each of these exactly as the key does.
        for (const uid of [7, 8, null]) {
            const byKey = await scoped(KEY, uid);
            const byTok = await scoped(uploadTok(), uid);
            assert.deepStrictEqual(byTok, byKey, `X-OV-User-Id ${uid}: token answered differently from the key`);
            if (uid === 7 || uid == null) assert.deepStrictEqual(byKey, { status: 200, code: undefined }, JSON.stringify(byKey));
            else assert.deepStrictEqual(byKey, { status: 403, code: undefined }, 'another user\'s VOD is refused');
        }
        // …and the scoping is the same on delete.
        r = await call('DELETE', `/api/v1/live/vods/${mine}`, { bearer: uploadTok(), headers: { 'x-ov-user-id': '8' } });
        assert.strictEqual(r.status, 403, 'a token naming another of the tenant\'s users cannot delete their VOD');
        r = await call('DELETE', `/api/v1/live/vods/${mine}`, { bearer: uploadTok(), headers: { 'x-ov-user-id': '7' } });
        assert.strictEqual(r.status, 200, r.text);
        console.log('✅ X-OV-User-Id under a service token scopes writes exactly as under the key');

        // ── A token for another tenant borrows nothing (and its header is never read) ──
        r = await call('POST', '/api/v1/live/vods', { bearer: tok({ ns: ['community'] }), body: { title: 'x' } });
        denied(r, 'capability.namespace_denied');
        r = await call('POST', '/api/v1/live/vods', { bearer: tok({ ns: ['community'] }), headers: { 'x-ov-user-id': '7' }, body: { title: 'x' } });
        denied(r, 'capability.namespace_denied');
        r = await call('POST', '/api/v1/live/vods', { bearer: tok({ aud: ['openvibe.network'] }), body: { title: 'x' } });
        assert.strictEqual(r.status, 401, 'wrong audience is not a credential here');
        r = await call('POST', '/api/v1/live/views', { bearer: tok(), body: { kind: 'vod' } });
        denied(r, 'capability.denied');
        console.log('✅ another tenant\'s token, a wrong audience and an un-verb\'d route are all refused');

        // ── The app key still answers every route unchanged ──
        r = await call('POST', '/api/v1/live/vods', { bearer: KEY, body: { title: 'Key Rec', user_id: 9 } });
        assert.strictEqual(r.status, 201, r.text);
        const keyVod = r.body.id;
        r = await call('GET', '/api/v1/live/vods', { bearer: KEY });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('PUT', `/api/v1/live/vods/${keyVod}`, { bearer: KEY, body: { title: 'Key Renamed' } });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('POST', '/api/v1/live/clips', { bearer: KEY, body: { vod_id: vodId, start_s: 4, end_s: 6 } });
        assert.ok([200, 202].includes(r.status), r.text);   // 200 when an identical window was just cut
        r = await call('DELETE', `/api/v1/live/clips/${clipId}`, { bearer: KEY });   // the token's clip
        assert.strictEqual(r.status, 200, r.text);
        r = await call('GET', '/api/v1/live/assets', { bearer: KEY });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('DELETE', `/api/v1/live/vods/${keyVod}`, { bearer: KEY });
        assert.strictEqual(r.status, 200, r.text);
        r = await call('POST', '/api/v1/live/vods', { bearer: 'community-key', body: { title: 'x' } });
        assert.strictEqual(r.status, 403, 'another app\'s key is still not valid for this tenant');
        console.log('✅ the `live` app key answers every one of these routes unchanged');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('service tokens on the v1 tenant API: all checks passed');
    })().catch((err) => { console.error(err); server.close(); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
