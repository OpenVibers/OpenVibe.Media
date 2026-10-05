'use strict';
// Privacy: anyone who may not see a private item gets exactly the answer a missing id gets.
// A 403 ("This media is private"), a 410, or a redirect that happens only for real items all
// confirm that the item exists. Covers the public serving routes (/v /c /o /p/:slug/raw,
// /v/:id/transcript.json, legacy /api/thumbnails) and the v1 detail routes when an app acts
// for one of its users (X-OV-User-Id).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-private404-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    delete process.env.PASTES_MOVED_TO;

    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const signing = require('../server/objects/signing');
    const express = require('express');

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const raw = db.getDb();
    const vodFile = (n) => { const p = path.join(process.env.VOD_PATH, n); fs.writeFileSync(p, Buffer.alloc(64, 1)); return p; };
    const clipFile = (n) => { const p = path.join(process.env.CLIPS_PATH, n); fs.writeFileSync(p, Buffer.alloc(32, 2)); return p; };

    const insVod = raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, duration_seconds, clips_only, thumbnail_url) OVERRIDING SYSTEM VALUE
                                VALUES (?, 'live', ?, ?, ?, ?, ?, 10, ?, ?) RETURNING id`);
    await insVod.run(1, 5, 'Public', vodFile('vod-1.webm'), 1, 'public', 0, '/t/vod-1-111.jpg');
    await insVod.run(2, 5, 'Secret title', vodFile('vod-2-secret.webm'), 0, 'private', 0, '/t/vod-2-222.jpg');
    await insVod.run(3, 5, 'Legacy hidden', vodFile('vod-3.webm'), 0, null, 0, null);
    await insVod.run(4, 5, 'Clips only', vodFile('vod-4.webm'), 0, 'unlisted', 1, null);
    await insVod.run(6, 5, 'Unlisted', vodFile('vod-6.webm'), 0, 'unlisted', 0, null);
    const insClip = raw.prepare(`INSERT INTO clips (id, app_id, vod_id, user_id, title, file_path, is_public, visibility, status) OVERRIDING SYSTEM VALUE
                                 VALUES (?, 'live', 1, ?, ?, ?, ?, ?, 'ready') RETURNING id`);
    await insClip.run(10, 5, 'Public clip', clipFile('clip-10.webm'), 1, 'public');
    await insClip.run(11, 5, 'Private clip', clipFile('clip-11-secret.webm'), 0, 'private');
    const insPaste = raw.prepare(`INSERT INTO pastes (slug, app_id, user_id, title, type, content, language, visibility, screenshot_path)
                                  VALUES (?, 'live', 5, 'P', ?, ?, 'text', ?, ?) RETURNING id`);
    await insPaste.run('pub-text', 'paste', 'hello', 'public', null);
    await insPaste.run('priv-text', 'paste', 'secret', 'private', null);
    await insPaste.run('priv-shot', 'screenshot', 'caption', 'private', '/nonexistent.png');

    const mkObj = async (visibility, lifecycle_status) => await model.createObject({
        app_id: 'live', namespace: 'live', kind: 'file', owner_subject: null, owner_app: 'live', owner_user_id: 5,
        visibility, lifecycle_status, mime_type: 'text/plain', size_bytes: 5, metadata: {},
    });
    const privDeleted = await mkObj('private', 'deleted');
    const privUploading = await mkObj('private', 'uploading');
    const pubDeleted = await mkObj('public', 'deleted');

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/o', require('../server/objects/routes').publicRouter);
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const get = async (p, headers = {}, method = 'GET', body) => {
            const h = { ...headers };
            let payload;
            if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
            const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
            const text = await res.text();
            return { status: res.status, text, location: res.headers.get('location') };
        };
        const same = async (a, b, msg) => {
            const [x, y] = [await get(...a), await get(...b)];
            assert.deepStrictEqual([x.status, x.text, x.location], [y.status, y.text, y.location], msg);
            return x;
        };
        const nav = { accept: 'text/html,*/*;q=0.8', 'sec-fetch-dest': 'document' };
        const video = { accept: 'video/webm,*/*;q=0.5', 'sec-fetch-dest': 'video' };
        const asUser = (id) => ({ authorization: 'Bearer live-key', 'x-ov-user-id': String(id) });

        // ── /v and /c: private = missing, for bytes and for the watch page ──
        let r = await same(['/v/2', video], ['/v/999', video], 'private VOD bytes look missing');
        assert.strictEqual(r.status, 404);
        assert.ok(!r.text.includes('private'), 'the answer never says "private"');
        await same(['/v/2', nav], ['/v/999', nav], 'private VOD watch page looks missing');
        await same(['/v/3', video], ['/v/999', video], 'legacy row (no visibility, is_public 0) is private');
        await same(['/v/4', video], ['/v/999', video], 'clips-only source recordings are not served');
        await same(['/v/vod-2-secret.webm', video], ['/v/no-such-file.webm', video], 'basename form: private file names are not confirmed');
        await same(['/v/clip-11-secret.webm', video], ['/v/no-such-file.webm', video], 'basename form reaching a private clip');
        await same(['/c/11', video], ['/c/999', video], 'private clip looks missing');
        await same(['/c/11', nav], ['/c/999', nav], 'private clip watch page looks missing');
        await same(['/v/2', { ...video, ...asUser(77) }], ['/v/999', { ...video, ...asUser(77) }], 'another user of the app is nobody special');

        assert.strictEqual((await get('/v/1', video)).status, 200, 'public VOD serves');
        assert.strictEqual((await get('/v/6', video)).status, 200, 'unlisted VOD serves by direct link');
        assert.strictEqual((await get('/c/10', video)).status, 200, 'public clip serves');
        assert.strictEqual((await get('/v/2', { ...video, ...asUser(5) })).status, 200, 'the owner gets their private VOD');
        assert.strictEqual((await get('/v/2', { ...video, authorization: 'Bearer live-key' })).status, 200, 'the owning app gets it');
        assert.strictEqual((await get('/c/11', { ...video, ...asUser(5) })).status, 200, 'the owner gets their private clip');
        console.log('✅ /v /c: private looks missing');

        // ── Signed playback URLs (a reader with no key, e.g. OpenVibe.AI transcribing): only the owning app signs ──
        const signedVia = async (p, headers) => { const x = await get(p, headers); return x.status === 200 ? JSON.parse(x.text) : { status: x.status }; };
        const sv = await signedVia('/api/v1/live/vods/2/signed-url?ttl=600', { authorization: 'Bearer live-key' });
        assert.ok(/^https:\/\/media\.test\/v\/2\?exp=\d+&sig=/.test(sv.url), sv.url);
        assert.strictEqual((await get(sv.url.replace('https://media.test', ''), video)).status, 200, 'a signed URL reads the private VOD');
        const sc = await signedVia('/api/v1/live/clips/11/signed-url', { authorization: 'Bearer live-key' });
        assert.strictEqual((await get(sc.url.replace('https://media.test', ''), video)).status, 200, 'a signed URL reads the private clip');
        await same([sv.url.replace('https://media.test', '').replace('/v/2?', '/v/3?'), video], ['/v/999', video], 'a VOD signature is not valid for another VOD');
        await same([sc.url.replace('https://media.test', '').replace('/c/11?', '/v/11?'), video], ['/v/999', video], 'a clip signature is not a VOD signature');
        await same([sv.url.replace('https://media.test', '').replace(/sig=[^&]+/, 'sig=AAAA'), video], ['/v/999', video], 'a forged signature is nobody');
        assert.strictEqual((await signedVia('/api/v1/live/vods/2/signed-url', asUser(5))).status, 403, 'a call acting for a user does not sign');
        assert.strictEqual((await signedVia('/api/v1/live/vods/2/signed-url', {})).status, 401, 'no key, no URL');
        const late = signing.signedMediaUrl('vod', 2, 10 * 24 * 3600);
        assert.ok(Date.parse(late.expires_at) - Date.now() <= 6 * 3600 * 1000 + 5000, 'at most 6 hours');
        console.log('✅ /v /c: signed URLs for the owning app only');

        // ── Transcript companion ──
        r = await same(['/v/2/transcript.json'], ['/v/999/transcript.json'], 'private VOD transcript looks missing');
        assert.strictEqual(r.status, 404);
        assert.ok(!r.text.includes('Secret title'));
        await same(['/v/3/transcript.json'], ['/v/999/transcript.json'], 'legacy private transcript looks missing');
        await same(['/v/4/transcript.json'], ['/v/999/transcript.json'], 'clips-only transcript looks missing');
        console.log('✅ /v/:id/transcript.json: private looks missing');

        // ── Legacy thumbnail names never hand out a private row's current thumbnail URL ──
        r = await get('/api/thumbnails/vod-1-0.jpg');
        assert.deepStrictEqual([r.status, r.location], [302, '/t/vod-1-111.jpg'], 'public rows still redirect to the current thumbnail');
        await same(['/api/thumbnails/vod-2-0.jpg'], ['/api/thumbnails/vod-999-0.jpg'], 'private row: same answer as a missing one');
        r = await get('/api/thumbnails/vod-2-0.jpg');
        assert.strictEqual(r.location, null, 'no redirect for a private row');
        console.log('✅ /api/thumbnails: no redirect for private rows');

        // ── /o: a private object is missing without a signature, whatever its lifecycle ──
        await same([`/o/${privDeleted}`], ['/o/med_01JAB2C3D4E5F6G7H8J9K0MNPQ'], 'deleted private object: 404, not 410');
        await same([`/o/${privUploading}`], ['/o/med_01JAB2C3D4E5F6G7H8J9K0MNPQ'], 'unfinished private object: 404');
        assert.strictEqual((await get(`/o/${pubDeleted}`)).status, 410, 'a deleted public object may say Gone');
        const s = signing.signedDownloadUrl(privDeleted, 60);
        assert.strictEqual((await get(s.url.replace('https://media.test', ''))).status, 410, 'with a valid signature the lifecycle answer is fine');
        console.log('✅ /o: private objects look missing before any lifecycle answer');

        // ── Paste raw: no redirect or answer that singles out a private paste ──
        await same(['/p/priv-text/raw'], ['/p/no-such/raw'], 'private text paste looks missing');
        await same(['/p/priv-shot/raw'], ['/p/no-such/raw'], 'private screenshot paste: no redirect to its screenshot');
        assert.strictEqual((await get('/p/pub-text/raw')).text, 'hello', 'public paste raw still serves');
        process.env.PASTES_MOVED_TO = 'https://community.test';
        r = await get('/p/no-such/raw');
        assert.deepStrictEqual([r.status, r.location], [301, 'https://community.test/p/no-such/raw'], 'moved: every slug goes to Community');
        r = await get('/p/priv-shot/raw');
        assert.deepStrictEqual([r.status, r.location], [301, 'https://community.test/p/priv-shot/raw'], 'moved: a private screenshot is not bounced to /screenshot');
        // /p/:slug/screenshot: a slug Media doesn't hold (pastes made in Community since the move, whose
        // screenshots hero moments linked here) goes to Community; a private one answers the same way.
        r = await get('/p/no-such/screenshot');
        assert.deepStrictEqual([r.status, r.location], [301, 'https://community.test/p/no-such/screenshot'], 'moved: an unknown screenshot slug goes to Community');
        r = await get('/p/priv-shot/screenshot');
        assert.deepStrictEqual([r.status, r.location], [301, 'https://community.test/p/priv-shot/screenshot'], 'moved: a private screenshot looks like an unknown one');
        delete process.env.PASTES_MOVED_TO;
        console.log('✅ /p/:slug/raw: private looks missing');

        // ── v1 detail routes when the app acts for a user ──
        await same(['/api/v1/live/vods/2', asUser(77)], ['/api/v1/live/vods/999', asUser(77)], 'acting non-owner: private VOD looks missing');
        await same(['/api/v1/live/vods/3', asUser(77)], ['/api/v1/live/vods/999', asUser(77)], 'acting non-owner: legacy private VOD looks missing');
        await same(['/api/v1/live/clips/11', asUser(77)], ['/api/v1/live/clips/999', asUser(77)], 'acting non-owner: private clip looks missing');
        await same(['/api/v1/live/clips', asUser(77), 'POST', { vod_id: 2, start_s: 0, end_s: 5 }],
            ['/api/v1/live/clips', asUser(77), 'POST', { vod_id: 999, start_s: 0, end_s: 5 }], 'acting non-owner cannot probe a private VOD by clipping it');
        r = await get('/api/v1/live/vods/2', asUser(5));
        assert.strictEqual(r.status, 200, 'the owner, acting, sees their VOD');
        assert.strictEqual(JSON.parse(r.text).title, 'Secret title');
        assert.strictEqual((await get('/api/v1/live/vods/2', { authorization: 'Bearer live-key' })).status, 200, 'the app key alone sees the namespace');
        assert.strictEqual((await get('/api/v1/live/clips/11', asUser(5))).status, 200);
        assert.strictEqual((await get('/api/v1/live/vods/6', asUser(77))).status, 200, 'unlisted stays reachable by id');

        const views = async () => (await raw.prepare("SELECT views FROM pastes WHERE slug = 'priv-text'").get()).views;
        const before = await views();
        // The read-only paste API is retired (T10 step 2): the v1 path is unmounted for everyone,
        // so it cannot confirm a private paste exists either.
        assert.strictEqual((await get('/api/v1/live/pastes/priv-text', asUser(5))).status, 404, 'the paste API is gone');
        assert.strictEqual((await get('/api/v1/live/pastes/priv-text', asUser(77))).status, 404);
        assert.strictEqual(await views(), before, 'a refused read counts no view');
        console.log('✅ v1 detail: acting non-owners get the missing answer');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('private-not-found: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); server.close(); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
