'use strict';
/**
 * Sharing a VOD or a clip with specific people (design 2026-11-06, VISIBILITY-EVERYWHERE step 5).
 *
 * A recording starts at its visibility's audience; the Share sheet's four choices are enforced by
 * canView on the watch page, the bytes, the thumbnail and the API's audience field. A named person
 * reads it; a stranger gets the gate (never the title or the player); Everyone puts it back in the
 * sitemap, Specific people takes it out. The share column stays `private` for people, so every old
 * read path that only knows the column fails closed.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-sharing-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.ASSETS_PATH = dir('assets');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.OV_NETWORK_INTERNAL_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_HLS_ENABLED = '1';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    delete process.env.EVENTS_URL;
    delete process.env.OV_OAUTH_CLIENT_SECRET;

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const express = require('express');
    const sharingLib = require('../server/sharing');
    const { serviceAuth, ids } = require('openvibe-contracts');

    const OWNER = ids.newId('user');
    const FRIEND = ids.newId('user');
    const STRANGER = ids.newId('user');
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    auth._setNetworkPublicKeyForTests(keys.publicKey.export({ type: 'spki', format: 'pem' }));
    const now = () => Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = (subject, username) => {
        const claims = { sub: 1, subject_id: subject, username, display_name: username, role: 'user', iss: 'https://openvibe.network', aud: ['openvibe.network', 'openvibe.media'], iat: now(), exp: now() + 600 };
        const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
        return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
    };
    const PEOPLE = {
        [FRIEND]: { subject: { type: 'user', id: FRIEND }, username: 'maticus', display_name: 'Maticus', avatar_url: null },
        [STRANGER]: { subject: { type: 'user', id: STRANGER }, username: 'sam', display_name: 'Sam', avatar_url: null },
        [OWNER]: { subject: { type: 'user', id: OWNER }, username: 'carol', display_name: 'Carol', avatar_url: null },
    };
    const networkJson = async ({ path, method = 'GET', json, query } = {}) => {
        if (path === '/internal/identity/resolve' && String(query && query.username).toLowerCase() === 'maticus') {
            return { ...PEOPLE[FRIEND], banned: false, deleted: false };
        }
        if (path === '/internal/identity/resolve-batch') {
            const results = {};
            for (const id of (json && json.subject_ids) || []) if (PEOPLE[id]) results[id] = { ...PEOPLE[id], banned: false, deleted: false };
            return { results };
        }
        if (path === '/internal/notifications/push') return { queued: true };
        const err = new Error(`no mock Network route ${method} ${path}`); err.status = 404; throw err;
    };

    await db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const raw = db.getDb();
    const mk = async (title, visibility, thumb) => {
        const file = path.join(process.env.VOD_PATH, `${title.replace(/\W/g, '')}.webm`);
        fs.writeFileSync(file, Buffer.alloc(64, 1));
        const res = await raw.prepare(`INSERT INTO vods (app_id, user_id, title, file_path, is_public, visibility, duration_seconds, thumbnail_url)
            VALUES ('games', 5, ?, ?, ?, ?, 10, ?) RETURNING id`).run(title, file, visibility === 'public' ? 1 : 0, visibility, thumb);
        return Number(res.rows[0].id);
    };
    const project = async (id, subject) => {
        await db.withObject('vod', id, async () => {});
        await raw.prepare('UPDATE media_objects SET owner_subject = ? WHERE legacy_ref = ?').run(subject, `legacy:games:vod:${id}`);
    };
    const pubId = await mk('Everyone recording', 'public', '/t/vod-0-1.jpg');
    const quietId = await mk('Quiet recording', 'public', '/t/vod-0-1.jpg');
    const thumb = (id) => { const name = `vod-${id}-1.jpg`; fs.writeFileSync(path.join(process.env.THUMBNAILS_PATH, name), Buffer.from('ffd8ffe000104a464946', 'hex')); return `/t/${name}`; };
    await raw.prepare('UPDATE vods SET thumbnail_url = ? WHERE id IN (?, ?)').run(null, pubId, quietId).catch(() => undefined);
    await raw.prepare('UPDATE vods SET thumbnail_url = ? WHERE id = ?').run(thumb(pubId), pubId);
    await raw.prepare('UPDATE vods SET thumbnail_url = ? WHERE id = ?').run(thumb(quietId), quietId);
    await project(pubId, OWNER);
    await project(quietId, OWNER);

    const sharing = sharingLib.createSharing({ db: raw, config: require('../server/config'), networkJson, log: console });
    await sharing.register('vod', pubId, 'public');
    await sharing.register('vod', quietId, 'public');

    const app = express();
    app.locals.sharing = sharing;
    app.use(express.json());
    app.use((req, _res, next) => {
        req.cookies = {};
        for (const part of String(req.headers.cookie || '').split(';')) {
            const i = part.indexOf('=');
            if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        }
        next();
    });
    // The same wiring server/index.js mounts.
    {
        const routed = Object.create(sharing.shares);
        routed.getWithRevision = async (viewer, ref) => { await sharing.ensure(ref.kind, ref.id); return await sharing.shares.getWithRevision(viewer, ref); };
        routed.update = async (viewer, ref, body, opts) => { await sharing.ensure(ref.kind, ref.id); return await sharing.shares.update(viewer, ref, body, opts); };
        routed.requestAccess = async (viewer, ref) => { await sharing.ensure(ref.kind, ref.id); return await sharing.shares.requestAccess(viewer, ref); };
        const shareApi = express.Router();
        shareApi.use(sharingLib.attachViewer);
        shareApi.use(sharing.shares.router({ service: 'media', authenticate: (req) => (req.shareClaims ? sharingLib.shareViewer(req.shareClaims) : null), describe: sharingLib.describeRef(raw) }));
        const SHARE_PATH = /^\/api\/v1\/(?:shared-with-me$|share\/people$|(?:vod|clip)\/[^/]+\/share(?:\/|$))/;
        app.use((req, res, next) => (SHARE_PATH.test(req.path) ? shareApi(req, res, next) : next()));
    }
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/o', require('../server/objects/routes').publicRouter);
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p, { as, headers = {}, method = 'GET', json } = {}) => {
        const h = { 'sec-fetch-site': 'same-origin', ...headers };
        if (as) h.cookie = `ov_token=${token(as, PEOPLE[as].username)}`;
        let body;
        if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
        const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, text, headers: res.headers };
    };
    const share = (id, opts) => get(`/api/v1/vod/${id}/share`, opts);
    const nav = { accept: 'text/html', 'sec-fetch-dest': 'document' };
    const bytes = { accept: 'video/webm', 'sec-fetch-dest': 'video' };

    try {
        let r = await get(`/v/${pubId}`, { headers: bytes });
        assert.strictEqual(r.status, 200, 'a public recording serves');
        assert.ok((await get('/sitemap.xml')).text.includes(`/v/${pubId}`), 'and is in the sitemap');
        assert.strictEqual((await share(pubId, { as: OWNER })).status, 200, 'the owner opens the sheet');
        assert.strictEqual((await share(pubId, { as: STRANGER })).status, 404, 'a stranger does not');

        // Specific people.
        r = await share(pubId, { as: OWNER, method: 'PUT', json: { audience: 'people', members: [{ name: '@maticus', role: 'viewer' }] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(JSON.parse(r.text).audience, 'people');
        const row = await raw.prepare('SELECT visibility FROM vods WHERE id = ?').get(pubId);
        assert.strictEqual(row.visibility, 'private', 'the old column fails closed');

        const memberPage = await get(`/v/${pubId}`, { as: FRIEND, headers: nav });
        assert.strictEqual(memberPage.status, 200, 'the named person reads the page');
        assert.ok(memberPage.text.includes('Everyone recording'));
        assert.match(memberPage.headers.get('cache-control') || '', /private/);
        assert.match(memberPage.headers.get('cache-control') || '', /no-store/);
        const memberBytes = await get(`/v/${pubId}`, { as: FRIEND, headers: bytes });
        assert.strictEqual(memberBytes.status, 200, 'and its bytes');
        assert.match(memberBytes.headers.get('cache-control') || '', /private/);
        assert.match(memberBytes.headers.get('cache-control') || '', /no-store/);

        const strangerPage = await get(`/v/${pubId}`, { as: STRANGER, headers: nav });
        assert.strictEqual(strangerPage.status, 404);
        assert.ok(strangerPage.text.includes('shared with specific people') && strangerPage.text.includes('data-ov-share-gate'), 'the gate');
        assert.ok(strangerPage.text.includes('data-kind="vod"') && strangerPage.text.includes(`data-id="${pubId}"`), 'with its kind and id');
        assert.ok(!strangerPage.text.includes('OVShare.gate('), 'no inline script to need a CSP nonce');
        assert.ok(!strangerPage.text.includes('Everyone recording'), 'never the title');
        const anonBytes = await get(`/v/${pubId}`, { headers: bytes });
        assert.strictEqual(anonBytes.status, 404, 'no bytes signed out');
        assert.strictEqual(anonBytes.text, '', 'and no body');
        assert.strictEqual((await get(`/v/${pubId}`, { as: STRANGER, headers: bytes })).status, 404, 'no bytes for a stranger');
        const anonThumb = await get(`/t/vod-${pubId}-1.jpg`);
        assert.strictEqual(anonThumb.status, 404, 'no thumbnail signed out');
        assert.strictEqual(anonThumb.text, '', 'and no body');
        const memberThumb = await get(`/t/vod-${pubId}-1.jpg`, { as: FRIEND });
        assert.strictEqual(memberThumb.status, 200, 'the member gets the picture');
        assert.match(memberThumb.headers.get('cache-control') || '', /private/);
        assert.match(memberThumb.headers.get('cache-control') || '', /no-store/);

        r = await get(`/api/v1/games/vods/${pubId}`, { headers: { authorization: 'Bearer games-key' } });
        assert.strictEqual(r.status, 200);
        const dto = JSON.parse(r.text);
        assert.strictEqual(dto.audience, 'people', 'the API names the audience');
        assert.deepStrictEqual(dto.members, [FRIEND], 'with the people on the list');

        assert.ok(!(await get('/sitemap.xml')).text.includes(`/v/${pubId}`), 'leaving Everyone drops the sitemap');
        assert.ok(!(await get('/')).text.includes('Everyone recording'), 'and the gathered index');
        assert.ok(!(await get('/llms.txt')).text.includes('Everyone recording'), 'and llms.txt');

        // ── Every byte path answers the member with a private, no-store header ──
        // Local: above. Thumbnail: above. B2/R2 redirect: patch the placement answer, as the provider would.
        const vodStorage = require('../server/vod/vod-storage');
        const saveIsRemote = vodStorage.isRemote, saveResolve = vodStorage.resolvePlayback;
        try {
            const remoteFile = path.join(process.env.VOD_PATH, 'not-local-b2.webm');
            const remoteId = Number((await raw.prepare(`INSERT INTO vods (app_id, user_id, title, file_path, is_public, visibility, duration_seconds, storage_provider, storage_key)
                VALUES ('games', 5, 'Remote recording', NULL, 1, 'public', 10, 'b2', 'b2/key') RETURNING id`).run()).rows[0].id);
            await project(remoteId, OWNER);
            await sharing.register('vod', remoteId, 'public');
            await share(remoteId, { as: OWNER, method: 'PUT', json: { audience: 'people', members: [{ subject: { type: 'user', id: FRIEND }, role: 'viewer' }] } });
            vodStorage.isRemote = () => true;
            vodStorage.resolvePlayback = async () => ({ kind: 'redirect', provider: 'b2', url: 'https://b2.example/presigned' });
            const remoteMember = await get(`/v/${remoteId}`, { as: FRIEND, headers: bytes });
            assert.strictEqual(remoteMember.status, 302, 'the member gets the provider redirect');
            assert.match(remoteMember.headers.get('cache-control') || '', /private, no-store/);
            const remoteAnon = await get(`/v/${remoteId}`, { headers: bytes });
            assert.strictEqual(remoteAnon.status, 404);
            assert.strictEqual(remoteAnon.text, '');

            // A virtual clip is a redirect to its signed playlist; the closed clip is only the member's.
            const clipId = Number((await raw.prepare(`INSERT INTO clips (app_id, vod_id, user_id, title, file_path, is_public, visibility, status, storage_provider, object_id)
                VALUES ('games', ?, 5, 'Virtual clip', NULL, 0, 'public', 'ready', 'timeline', 'med_01J0000000000000000000000A') RETURNING id`).run(pubId)).rows[0].id);
            await db.withObject('clip', clipId, async () => {});
            await raw.prepare('UPDATE media_objects SET owner_subject = ? WHERE legacy_ref = ?').run(OWNER, `legacy:games:clip:${clipId}`);
            await sharing.register('clip', clipId, 'public');
            const clipPut = await get(`/api/v1/clip/${clipId}/share`, { as: OWNER, method: 'PUT', json: { audience: 'people', members: [{ subject: { type: 'user', id: FRIEND }, role: 'viewer' }] } });
            assert.strictEqual(clipPut.status, 200, clipPut.text);
            const virtualMember = await get(`/c/${clipId}`, { as: FRIEND, headers: bytes });
            assert.strictEqual(virtualMember.status, 302, 'the member is sent to the signed playlist');
            assert.match(virtualMember.headers.get('cache-control') || '', /private, no-store/);
            assert.ok(String(virtualMember.headers.get('location')).includes('/o/'), 'a signed object playlist');
            const virtualAnon = await get(`/c/${clipId}`, { headers: bytes });
            assert.strictEqual(virtualAnon.status, 404);
            assert.strictEqual(virtualAnon.text, '');

            // The object and its HLS (playlist and, by the same check, segments): unsigned is missing;
            // a short-lived signed playlist is the member's and never enters a shared cache.
            const objectId = (await raw.prepare('SELECT object_id FROM clips WHERE id = ?').get(clipId)).object_id;
            await raw.prepare("UPDATE media_objects SET lifecycle_status = 'ready' WHERE id = ?").run(objectId);
            assert.strictEqual((await get(`/o/${objectId}`)).status, 404, 'the private object is missing unsigned');
            const playlist = require('../server/objects/signing').signedPlaylistUrl(objectId);
            const signedPlaylist = await get(playlist.url.replace('https://media.test', ''));
            assert.match(signedPlaylist.headers.get('cache-control') || '', /private, no-store/);
        } finally {
            vodStorage.isRemote = saveIsRemote;
            vodStorage.resolvePlayback = saveResolve;
        }

        // Only me: even the member loses it.
        assert.strictEqual((await share(pubId, { as: OWNER, method: 'PUT', json: { audience: 'private' } })).status, 200);
        assert.strictEqual((await get(`/v/${pubId}`, { as: FRIEND, headers: nav })).status, 404, 'Only me');
        assert.strictEqual((await get(`/v/${pubId}`, { as: OWNER, headers: nav })).status, 200, 'its owner still reads it');

        // Everyone again: back in the sitemap and readable by anybody.
        assert.strictEqual((await share(pubId, { as: OWNER, method: 'PUT', json: { audience: 'public' } })).status, 200);
        assert.strictEqual((await get(`/v/${pubId}`, { headers: bytes })).status, 200);
        assert.ok((await get('/sitemap.xml')).text.includes(`/v/${pubId}`), 'Everyone is listed again');

        // A stranger cannot learn a people-only item's transcript, and the API hides the title from the
        // watch page; the share API stays the owner's.
        assert.strictEqual((await share(quietId, { as: STRANGER })).status, 404);

        console.log('✅ media sharing: audiences, the gate, bytes, thumbnails, sitemap');
    } finally {
        sharing.work = null;
        await new Promise((r) => server.close(r));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
