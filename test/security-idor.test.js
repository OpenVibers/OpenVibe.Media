'use strict';
// IDOR (roadmap WS-R task 5): swapping ids between owners never reaches someone else's media. Two users
// of one app (the app key acting for user 77 on user 5's things), two apps (games' key on live's ids,
// through its own tenant and through live's), two developer projects (PB's token on PA's objects) and two
// namespaces of one tenant (a token for live.b on live.a) try every write and every read that names an id:
//   v2 objects: read, download, delete, restore, holds (place, release), upload URL, content with another
//   object's upload token, multipart (start, status, part, complete, abort, another session's token),
//   complete, list; jobs: read, create, approve, cancel; namespaces;
//   v1: VODs (update/visibility, delete, finalize, complete, chunks, ingest), clips (update, delete,
//   re-cut), thumbnails (replace), files (delete), assets (delete), admin storage (holds, release, tier
//   move, bulk delete; acting for a user at all).
// Someone else's private item answers exactly as an unknown id; a visible one 403; a namespace outside
// the token's grant 403 capability.namespace_denied (the documented contract, test/namespaces.test.js).
// After every attempt nothing changed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-idor-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), OBJECTS_PATH: dir('objects'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), ASSETS_PATH: dir('assets'),
        OV_NETWORK_URL: 'https://openvibe.network', MEDIA_PUBLIC_URL: 'https://media.test', MEDIA_SIGNING_SECRET: 'test-signing-secret',
        MEDIA_UPLOAD_MIN_FREE_MB: '0', MEDIA_MULTIPART_MIN_PART_MB: '1', MEDIA_JOBS_ENABLED: '0',
    });
    for (const k of ['EVENTS_URL', 'MEDIA_B2_ENDPOINT', 'MEDIA_R2_ENDPOINT', 'PASTES_MOVED_TO']) process.env[k] = '';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const queue = require('../server/jobs/queue');
    const objectRoutes = require('../server/objects/routes');
    const { serviceAuth, ids } = require('openvibe-contracts');
    const express = require('express');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const raw = db.getDb();
    const now = Math.floor(Date.now() / 1000);
    const jti = () => `tok_${crypto.randomBytes(6).toString('hex')}`;
    const ALL_CAPS = ['media.object.upload', 'media.object.read', 'media.object.list', 'media.object.delete', 'media.derivative.create'];
    const svc = (ns) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:example', actor_type: 'service', aud: ['openvibe.media'], cap: ALL_CAPS, ns, iat: now, exp: now + 300, jti: jti() }, keys.privateKey);
    const PA = `prj_${ids.ulid()}`, PB = `prj_${ids.ulid()}`;
    const appTok = (project) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: `app:app_${ids.ulid()}`, actor_type: 'app', aud: ['openvibe.media'], cap: ALL_CAPS, ns: [project], project_id: project, env: 'production', iat: now, exp: now + 300, jti: jti() }, keys.privateKey);

    // ── v1 rows, all user 5's ──
    const file = (d, n, bytes = 64) => { const p = path.join(d, n); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); return p; };
    const mkVod = async (title, visibility) => Number((await db.createVod({ app_id: 'live', user_id: 5, title, file_path: file(process.env.VOD_PATH, `${title}.webm`), duration_seconds: 10, visibility, thumbnail_url: `/t/${title}.jpg` })).lastInsertRowid);
    const privVod = await mkVod('privvod', 'private');
    const pubVod = await mkVod('pubvod', 'public');
    const mkClip = async (title, visibility) => Number((await db.createClip({ app_id: 'live', vod_id: pubVod, user_id: 5, title, file_path: file(process.env.CLIPS_PATH, `${title}.webm`), duration_seconds: 5, is_public: visibility === 'public' ? 1 : 0, visibility, status: 'ready' })).lastInsertRowid);
    const privClip = await mkClip('privclip', 'private');
    const pubClip = await mkClip('pubclip', 'public');
    const assetId = Number((await raw.prepare("INSERT INTO assets (app_id, kind, name, file_path, user_id) VALUES ('live', 'emote', 'hi', ?, 5) RETURNING id").run(file(process.env.ASSETS_PATH, 'hi.png'))).lastInsertRowid);
    const v1State = async () => ({
        vods: await raw.prepare('SELECT id, title, visibility, is_public, thumbnail_url, is_recording FROM vods ORDER BY id').all(),
        clips: await raw.prepare('SELECT id, title, visibility, is_public, status, thumbnail_url, cut_attempts FROM clips ORDER BY id').all(),
        files: await raw.prepare('SELECT key FROM files ORDER BY key').all(),
        assets: await raw.prepare('SELECT id FROM assets ORDER BY id').all(),
    });

    const app = express();
    app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
    app.put('/api/v2/:app/objects/:id/multipart/:uploadId/parts/:n', ...objectRoutes.partHandlers);
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v1/:app/files', require('../server/files/routes'));
    app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
    app.use('/api/v1/:app/assets', require('../server/assets/routes'));
    app.use('/api/v1/:app/admin/storage', require('../server/admin/routes'));
    app.use('/api/v2/:app/objects', objectRoutes);
    app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
    app.use('/api/v2/:app/namespaces', require('../server/objects/namespace-routes'));
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const local = (u) => String(u).replace('https://media.test', '');
        const call = async (method, p, headers = {}, body) => {
            const h = { ...headers };
            let payload = body;
            if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string' && !(body instanceof FormData)) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
            const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
            const text = await res.text();
            let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
            return { status: res.status, text, json };
        };
        const key = (k) => ({ authorization: `Bearer ${k}` });
        const asUser = (id) => ({ ...key('live-key'), 'x-ov-user-id': String(id) });
        const same = async (a, b, msg) => {
            const [x, y] = [await call(...a), await call(...b)];
            assert.deepStrictEqual([x.status, x.text], [y.status, y.text], msg);
            assert.ok(x.status >= 400, `${msg}: refused (${x.status})`);
            return x;
        };

        // ── v2 objects ──
        const init = async (tenant, headers, body) => {
            const r = await call('POST', `/api/v2/${tenant}/objects`, headers, { kind: 'file', mime_type: 'text/plain', filename: 'x.txt', ...body });
            assert.strictEqual(r.status, 201, r.text);
            return r.json;
        };
        const mkReady = async (tenant, headers, body) => {
            const o = await init(tenant, headers, { size_bytes: 5, ...body });
            assert.strictEqual((await call('PUT', local(o.upload.url), { 'content-type': 'text/plain' }, 'hello')).status, 200);
            assert.strictEqual((await call('POST', `/api/v2/${tenant}/objects/${o.id}/complete`, headers, {})).status, 200);
            return o.id;
        };
        const priv5 = await mkReady('live', asUser(5), { visibility: 'private' });
        const pub5 = await mkReady('live', asUser(5), { visibility: 'public' });
        const up5 = await init('live', asUser(5), { visibility: 'private', size_bytes: 5 });        // still uploading
        const upPub5 = await init('live', asUser(5), { visibility: 'public', size_bytes: 5 });
        const mpObj = await init('live', asUser(5), { visibility: 'private', size_bytes: 10 });
        let r = await call('POST', `/api/v2/live/objects/${mpObj.id}/multipart`, asUser(5), {});
        assert.strictEqual(r.status, 201, r.text);
        const mp5 = r.json;
        const other = await init('live', asUser(5), { visibility: 'private', size_bytes: 10 });        // a second session, for its token
        const otherMp = (await call('POST', `/api/v2/live/objects/${other.id}/multipart`, asUser(5), {})).json;
        const nsA = await mkReady('live', key(svc(['live.a'])), { namespace: 'a', visibility: 'private' });
        const nsB = await mkReady('live', key(svc(['live.b'])), { namespace: 'b', visibility: 'private' });
        const projA = await mkReady(PA, key(appTok(PA)), { visibility: 'private' });
        r = await call('POST', `/api/v2/live/objects/${pub5}/holds`, key('live-key'), { kind: 'dmca', reason: 'notice 1' });
        assert.strictEqual(r.status, 201, r.text);
        const hold5 = r.json.id;
        const job5 = (await queue.enqueue({ appId: 'live', type: 'thumbnail.regenerate', objectId: priv5, params: { kind: 'vod', id: privVod }, status: 'proposed', ownerUserId: 5, createdBy: 'app:live:user:5' })).job;
        const UNKNOWN = 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ';
        const v2State = async () => ({
            objects: await raw.prepare('SELECT id, lifecycle_status, visibility, size_bytes, content_hash, owner_user_id, namespace FROM media_objects ORDER BY id').all(),
            holds: await raw.prepare('SELECT id, object_id, released_at FROM media_holds ORDER BY id').all(),
            sessions: await raw.prepare('SELECT id, status FROM media_uploads ORDER BY id').all(),
            parts: await raw.prepare('SELECT upload_id, part_number FROM media_upload_parts ORDER BY upload_id, part_number').all(),
            jobs: await raw.prepare('SELECT id, status FROM media_jobs ORDER BY id').all(),
        });
        const before = await v2State();

        const OPS = (uploadId) => [
            ['GET', ''], ['GET', '/download'], ['GET', '/download?format=json'], ['GET', '/holds'],
            ['DELETE', ''], ['POST', '/restore', {}],
            ['POST', '/holds', { kind: 'dmca', reason: 'x' }], ['DELETE', `/holds/${hold5}`],
            ['POST', '/upload-url', {}], ['POST', '/multipart', { size_bytes: 10 }], ['POST', '/complete', {}],
            ['PUT', '/content', 'hello'],
            ['GET', `/multipart/${uploadId}`], ['POST', `/multipart/${uploadId}/complete`, {}], ['DELETE', `/multipart/${uploadId}`],
            ['PUT', `/multipart/${uploadId}/parts/1`, Buffer.alloc(10, 7)],
        ];
        const attempt = (tenant, id, [method, rest, body], headers) => [method, `/api/v2/${tenant}/objects/${id}${rest}`, headers, body];

        // Another user of the app, on user 5's private objects: the unknown-id answer, every time.
        for (const target of [priv5, up5.id, mpObj.id]) {
            for (const op of OPS(mp5.upload_id)) await same(attempt('live', target, op, asUser(77)), attempt('live', UNKNOWN, op, asUser(77)), `user 77 ${op[0]} ${op[1]} on user 5's private ${target}`);
        }
        // ... and on user 5's public object: reads are fine, every write 403.
        for (const op of OPS(mp5.upload_id).filter(([m]) => m !== 'GET')) {
            for (const target of [pub5, upPub5.id]) {
                r = await call(...attempt('live', target, op, asUser(77)));
                assert.ok([403, 404].includes(r.status), `user 77 ${op[0]} ${op[1]} on user 5's public ${target}: ${r.status} ${r.text}`);
                if (!/multipart\/|holds\//.test(op[1])) assert.strictEqual(r.status, 403, `${op[0]} ${op[1]}: 403 for a visible object (${r.text})`);
            }
        }
        // Another app, through its own tenant (not found) and through this one (its key is not valid here).
        for (const op of OPS(mp5.upload_id)) {
            for (const target of [priv5, pub5, mpObj.id]) {
                await same(attempt('games', target, op, key('games-key')), attempt('games', UNKNOWN, op, key('games-key')), `games ${op[0]} ${op[1]} via its tenant`);
                await same(attempt('live', target, op, key('games-key')), attempt('live', UNKNOWN, op, key('games-key')), `games ${op[0]} ${op[1]} via live's tenant`);
                await same(attempt('live', target, op, {}), attempt('live', UNKNOWN, op, {}), `no credential ${op[0]} ${op[1]}`);
            }
            // Another developer project: its own tenant does not hold PA's objects, and PA's tenant is not its own.
            await same(attempt(PB, projA, op, key(appTok(PB))), attempt(PB, UNKNOWN, op, key(appTok(PB))), `project B ${op[0]} ${op[1]} via its tenant`);
            await same(attempt(PA, projA, op, key(appTok(PB))), attempt(PA, UNKNOWN, op, key(appTok(PB))), `project B ${op[0]} ${op[1]} via project A's`);
            // Another namespace of the same tenant: 403 capability.namespace_denied (documented), never the object.
            if (!/multipart\/|holds/.test(op[1])) {
                r = await call(...attempt('live', nsA, op, key(svc(['live.b']))));
                assert.ok([403, 409].includes(r.status) && !r.text.includes('"size_bytes"'), `live.b token ${op[0]} ${op[1]} on live.a: ${r.status} ${r.text}`);
                if (r.status === 403) assert.ok(['capability.namespace_denied', 'capability.denied'].includes(r.json.code), r.text);
            }
        }
        // Tokens scoped to one object never open another.
        const upTok = new URL(up5.upload.url).searchParams.get('token');
        r = await call('PUT', `/api/v2/live/objects/${upPub5.id}/content?token=${encodeURIComponent(upTok)}`, { 'content-type': 'text/plain' }, 'hello');
        assert.deepStrictEqual([r.status, r.json && r.json.code], [401, 'media.upload_token.invalid'], 'an upload token for one object does not write another');
        r = await call('PUT', `/api/v2/games/objects/${up5.id}/content?token=${encodeURIComponent(upTok)}`, { 'content-type': 'text/plain' }, 'hello');
        assert.ok(r.status >= 400, 'nor its object through another tenant');
        for (const [m, p, b] of [['PUT', `/api/v2/live/objects/${other.id}/multipart/${otherMp.upload_id}/parts/1`, Buffer.alloc(10)], ['GET', `/api/v2/live/objects/${other.id}/multipart/${otherMp.upload_id}`],
            ['POST', `/api/v2/live/objects/${other.id}/multipart/${otherMp.upload_id}/complete`, {}], ['DELETE', `/api/v2/live/objects/${other.id}/multipart/${otherMp.upload_id}`],
            ['PUT', `/api/v2/live/objects/${mpObj.id}/multipart/${otherMp.upload_id}/parts/1`, Buffer.alloc(10)]]) {
            r = await call(m, `${p}?token=${encodeURIComponent(mp5.token)}`, {}, b);
            assert.deepStrictEqual([r.status, r.json && r.json.code], [401, 'media.upload_token.invalid'], `a multipart token for one session: ${m} ${p}`);
        }
        r = await call('GET', `/api/v2/live/objects/${mpObj.id}/multipart/${otherMp.upload_id}`, key('live-key'));
        assert.strictEqual(r.status, 404, 'another object\'s session id through this object is not found');
        // Lists: nothing of another owner, app, project or namespace.
        const listed = async (p, h) => ((await call('GET', p, h)).json || { objects: [] }).objects.map(o => o.id);
        assert.ok(!(await listed('/api/v2/live/objects?user_id=5&visibility=private', asUser(77))).some(id => [priv5, up5.id, mpObj.id].includes(id)), 'another user lists none of user 5\'s private objects');
        assert.deepStrictEqual(await listed('/api/v2/games/objects', key('games-key')), [], 'another app lists none');
        assert.deepStrictEqual(await listed(`/api/v2/${PB}/objects`, key(appTok(PB))), [], 'another project lists none');
        assert.deepStrictEqual(await listed('/api/v2/live/objects', key(svc(['live.b']))), [nsB], 'a live.b token lists live.b only');
        r = await call('GET', '/api/v2/live/objects?namespace=a', key(svc(['live.b'])));
        assert.deepStrictEqual([r.status, r.json.code], [403, 'capability.namespace_denied'], 'nor asks for live.a');
        r = await call('GET', '/api/v2/live/namespaces/live.a', key(svc(['live.b'])));
        assert.strictEqual(r.status, 403, 'nor reads live.a\'s namespace');
        r = await call('GET', '/api/v2/games/namespaces/live.a', key('games-key'));
        assert.ok(r.status >= 400 && !r.text.includes('"live.a"'), 'another app does not read live\'s namespaces');
        // Jobs.
        for (const [m, rest, b] of [['GET', ''], ['POST', '/approve', {}], ['POST', '/cancel', {}], ['DELETE', '']]) {
            await same([m, `/api/v2/live/jobs/${job5.id}${rest}`, asUser(77), b], [m, `/api/v2/live/jobs/mjob_nosuchjob${rest}`, asUser(77), b], `user 77 ${m} ${rest} on user 5's job`);
            await same([m, `/api/v2/games/jobs/${job5.id}${rest}`, key('games-key'), b], [m, `/api/v2/games/jobs/mjob_nosuchjob${rest}`, key('games-key'), b], `games ${m} ${rest} on live's job`);
        }
        const jobBody = (object_id) => ({ type: 'thumbnail.regenerate', object_id, params: { kind: 'vod', id: privVod } });
        await same(['POST', '/api/v2/live/jobs', asUser(77), jobBody(priv5)], ['POST', '/api/v2/live/jobs', asUser(77), jobBody(UNKNOWN)], 'user 77 cannot start a job on user 5\'s private object');
        r = await call('POST', '/api/v2/live/jobs', asUser(77), jobBody(pub5));
        assert.strictEqual(r.status, 403, `nor on user 5's public object (${r.text})`);
        await same(['POST', '/api/v2/games/jobs', key('games-key'), jobBody(priv5)], ['POST', '/api/v2/games/jobs', key('games-key'), jobBody(UNKNOWN)], 'games cannot start a job on live\'s object');
        assert.deepStrictEqual(await v2State(), before, 'no object, hold, upload session or job changed');
        console.log('✅ v2 objects, uploads, multipart, holds, jobs, lists and namespaces: other users, apps, projects and namespaces reach nothing');

        // ── v1 ──
        fs.writeFileSync(path.join(process.env.FILES_PATH, '.keep'), '');
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from('user five')], { type: 'text/plain' }), 'five.txt');
        r = await call('POST', '/api/v1/live/files', asUser(5), fd);
        assert.strictEqual(r.status, 201, r.text);
        const fileKey = r.json.key;
        const v1Before = await v1State();
        const v2Before = await v2State();   // the file above is an object too
        const chunk = () => { const f = new FormData(); f.append('chunk', new Blob([Buffer.alloc(32)], { type: 'video/webm' }), 'c.webm'); return f; };
        const VOD_OPS = [['PUT', '', { visibility: 'public', title: 'pwned' }], ['DELETE', ''], ['POST', '/finalize', {}], ['POST', '/complete', {}],
            ['POST', '/ingest/rtp/stop', {}], ['POST', '/ingest/rtmp', { rtmp_url: 'rtmp://10.0.0.5:1935/live/k' }], ['POST', '/chunks', chunk]];
        const CLIP_OPS = [['PUT', '', { visibility: 'public', title: 'pwned' }], ['DELETE', ''], ['POST', '/recut', {}]];
        const thumbBody = { image: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==' };
        const v1 = (kind, tenant, id, [m, rest, b], h) => [m, `/api/v1/${tenant}/${kind}/${id}${rest}`, h, typeof b === 'function' ? b() : b];
        for (const [kind, ops, priv, pub] of [['vods', VOD_OPS, privVod, pubVod], ['clips', CLIP_OPS, privClip, pubClip]]) {
            for (const op of ops) {
                await same(v1(kind, 'live', priv, op, asUser(77)), v1(kind, 'live', 999999, op, asUser(77)), `user 77 ${op[0]} ${kind}${op[1]} on user 5's private one`);
                r = await call(...v1(kind, 'live', pub, op, asUser(77)));
                assert.strictEqual(r.status, 403, `user 77 ${op[0]} ${kind}${op[1]} on user 5's public one: ${r.status} ${r.text}`);
                await same(v1(kind, 'games', priv, op, key('games-key')), v1(kind, 'games', 999999, op, key('games-key')), `games ${op[0]} ${kind}${op[1]} via its tenant`);
                await same(v1(kind, 'games', pub, op, key('games-key')), v1(kind, 'games', 999999, op, key('games-key')), `games ${op[0]} ${kind}${op[1]} on a public one`);
                await same(v1(kind, 'live', pub, op, key('games-key')), v1(kind, 'live', 999999, op, key('games-key')), `games ${op[0]} ${kind}${op[1]} via live's tenant`);
            }
        }
        for (const [kind, priv, pub] of [['vod', privVod, pubVod], ['clip', privClip, pubClip]]) {
            await same(['POST', `/api/v1/live/thumbnails/${kind}/${priv}`, asUser(77), thumbBody], ['POST', `/api/v1/live/thumbnails/${kind}/999999`, asUser(77), thumbBody], `user 77 replaces the thumbnail of user 5's private ${kind}`);
            r = await call('POST', `/api/v1/live/thumbnails/${kind}/${pub}`, asUser(77), thumbBody);
            assert.strictEqual(r.status, 403, `user 77 replaces the thumbnail of user 5's public ${kind}: ${r.status} ${r.text}`);
            await same(['POST', `/api/v1/games/thumbnails/${kind}/${pub}`, key('games-key'), thumbBody], ['POST', `/api/v1/games/thumbnails/${kind}/999999`, key('games-key'), thumbBody], `games replaces live's ${kind} thumbnail`);
        }
        r = await call('DELETE', `/api/v1/live/files/${encodeURIComponent(fileKey)}`, asUser(77));
        assert.strictEqual(r.status, 403, 'user 77 cannot delete user 5\'s file');
        await same(['DELETE', `/api/v1/games/files/${encodeURIComponent(fileKey)}`, key('games-key')], ['DELETE', '/api/v1/games/files/no-such-key.txt', key('games-key')], 'games cannot delete live\'s file');
        await same(['DELETE', `/api/v1/games/assets/${assetId}`, key('games-key')], ['DELETE', '/api/v1/games/assets/999999', key('games-key')], 'games cannot delete live\'s asset');
        // Admin storage: another app's ids are unknown ids there; acting for a user is refused outright.
        const A = '/api/v1/games/admin/storage';
        await same(['POST', `${A}/holds`, key('games-key'), { vod_id: privVod, reason: 'x' }], ['POST', `${A}/holds`, key('games-key'), { vod_id: 999999, reason: 'x' }], 'games holds live\'s VOD');
        await same(['POST', `${A}/holds`, key('games-key'), { clip_id: pubClip, reason: 'x' }], ['POST', `${A}/holds`, key('games-key'), { clip_id: 999999, reason: 'x' }], 'games holds live\'s clip');
        await same(['POST', `${A}/holds`, key('games-key'), { object_id: priv5, reason: 'x' }], ['POST', `${A}/holds`, key('games-key'), { object_id: UNKNOWN, reason: 'x' }], 'games holds live\'s object');
        await same(['POST', `${A}/holds/${hold5}/release`, key('games-key'), {}], ['POST', `${A}/holds/999999/release`, key('games-key'), {}], 'games releases live\'s hold');
        await same(['DELETE', `${A}/holds/${hold5}`, key('games-key')], ['DELETE', `${A}/holds/999999`, key('games-key')], 'games releases live\'s hold (DELETE)');
        await same(['POST', `${A}/tiers/move`, key('games-key'), { vod_id: pubVod, target: 'local' }], ['POST', `${A}/tiers/move`, key('games-key'), { vod_id: 999999, target: 'local' }], 'games moves live\'s VOD');
        r = await call('DELETE', `${A}/vods/bulk`, key('games-key'), { ids: [privVod, pubVod] });
        assert.ok(r.status >= 400 || (r.json && r.json.deleted === 0), `games bulk-deletes live's VODs: ${r.text}`);
        for (const [m, p, b, code] of [['DELETE', '/vods/bulk', { ids: [privVod] }, 'media.admin.forbidden'], ['POST', '/tiers/move', { vod_id: privVod, target: 'local' }, 'media.admin.forbidden'],
            ['GET', '/vods?limit=5', undefined, 'media.admin.forbidden'], ['PUT', '/tiers/settings', {}, 'media.admin.forbidden'], ['GET', '/holds?all=1', undefined, 'media.hold.forbidden'],
            ['POST', '/holds', { vod_id: privVod, reason: 'x' }, 'media.hold.forbidden'], ['POST', `/holds/${hold5}/release`, {}, 'media.hold.forbidden'], ['GET', '/ops', undefined, 'media.ops.forbidden']]) {
            r = await call(m, `/api/v1/live/admin/storage${p}`, asUser(77), b);
            assert.deepStrictEqual([r.status, r.json && r.json.code], [403, code], `acting for a user: ${m} admin/storage${p}`);
        }
        assert.deepStrictEqual(await v1State(), v1Before, 'no VOD, clip, thumbnail, file or asset changed');
        assert.deepStrictEqual(await v2State(), v2Before, 'no hold or object changed');
        // Controls: the owner and the app itself still can.
        assert.strictEqual((await call('PUT', `/api/v1/live/vods/${privVod}`, asUser(5), { title: 'mine' })).status, 200, 'the owner updates their private VOD');
        assert.strictEqual((await call('PUT', `/api/v1/live/clips/${pubClip}`, key('live-key'), { title: 'app edit' })).status, 200, 'the app key updates any clip');
        assert.strictEqual((await call('POST', `/api/v1/live/thumbnails/vod/${privVod}`, asUser(5), thumbBody)).status, 200, 'the owner replaces their thumbnail');
        assert.strictEqual((await call('GET', '/api/v1/live/admin/storage/holds', key('live-key'))).status, 200, 'the app reads its holds');
        console.log('✅ v1 VODs, clips, thumbnails, files, assets and admin storage: other users and apps change nothing; acting for a user is refused on admin storage');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('security-idor: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); server.close(); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
