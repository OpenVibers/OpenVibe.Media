'use strict';
// Private and unlisted media stay where they belong (roadmap WS-R task 5). Extends
// test/private-not-found.test.js (which covers /v /c /o /p/:slug/raw, transcript.json, the legacy
// /api/thumbnails redirect and the v1 detail routes for an acting non-owner) to the paths it does not:
//   - public lists: the media index (/ and /browse, every tab, thumbnails included), /sitemap.xml,
//     /llms.txt, the v1 VOD/clip lists and latest-thumbs for a caller acting for another user, the v2
//     object and job lists: never a private or unlisted item (sitemap and Search documents in depth:
//     test/crawl.test.js);
//   - every v2 object read (metadata, download, holds, jobs) for another user, another app (on its own
//     tenant and on this one), another developer project, and no credential: the answer an unknown id gets;
//   - /v and /c with another app's key, /p/:slug (the page), projected VOD and thumbnail objects on /o;
//   - signatures: /o and /f answer an expired, tampered or other object's signature exactly as they
//     answer an unknown id; sandbox objects and files need one even when "public".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-secprivate-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.DB_PATH = path.join(tmp, 'media.db');
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.ASSETS_PATH = dir('assets');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    for (const k of ['PASTES_MOVED_TO', 'EVENTS_URL', 'MEDIA_B2_ENDPOINT', 'MEDIA_R2_ENDPOINT']) process.env[k] = '';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const signing = require('../server/objects/signing');
    const queue = require('../server/jobs/queue');
    const { serviceAuth, ids } = require('openvibe-contracts');
    const express = require('express');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const raw = db.getDb();
    const now = Math.floor(Date.now() / 1000);
    const PA = `prj_${ids.ulid()}`, PB = `prj_${ids.ulid()}`;
    const appTok = (project, env = 'production') => serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub: `app:app_${ids.ulid()}`, actor_type: 'app', aud: ['openvibe.media'], cap: ['media.object.upload', 'media.object.read', 'media.object.list'],
        ns: [project], project_id: project, env, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`,
    }, keys.privateKey);

    // ── VODs, clips and their thumbnails (user 5 owns them all) ──
    const thumb = (name) => { fs.writeFileSync(path.join(process.env.THUMBNAILS_PATH, name), Buffer.from('ffd8ffe000104a464946', 'hex')); return `/t/${name}`; };
    const media = (d, name) => { const p = path.join(d, name); fs.writeFileSync(p, Buffer.alloc(64, 1)); return p; };
    const vod = async (title, visibility, extra = {}) => {
        const id = Number((await db.createVod({ app_id: 'live', user_id: 5, title, file_path: media(process.env.VOD_PATH, `${title.replace(/\W/g, '')}.webm`), duration_seconds: 10, visibility, ...extra })).lastInsertRowid);
        return id;
    };
    const pubVod = await vod('Public VOD', 'public', { managed_stream_id: 7 });
    const privVod = await vod('Secret VOD title', 'private', { managed_stream_id: 7 });
    const unlVod = await vod('Unlisted VOD title', 'unlisted', { managed_stream_id: 8 });
    await raw.prepare("UPDATE vods SET created_at = datetime('now', ?) WHERE id = ?").run('-2 hours', pubVod);   // the private one is the newest of stream 7
    for (const [id, name] of [[pubVod, `vod-${pubVod}-111.jpg`], [privVod, `vod-${privVod}-222.jpg`], [unlVod, `vod-${unlVod}-666.jpg`]]) {
        await db.withObject('vod', id, async () => await db.run('UPDATE vods SET thumbnail_url = ? WHERE id = ?', [thumb(name), id]));
    }
    const clip = async (title, visibility, name) => Number((await db.createClip({
        app_id: 'live', vod_id: pubVod, user_id: 5, title, file_path: media(process.env.CLIPS_PATH, `${title.replace(/\W/g, '')}.webm`),
        thumbnail_url: thumb(name), duration_seconds: 5, is_public: visibility === 'public' ? 1 : 0, visibility, status: 'ready',
    })).lastInsertRowid);
    const pubClip = await clip('Public clip', 'public', 'clip-9001-1.jpg');
    const privClip = await clip('Secret clip title', 'private', 'clip-9002-2.jpg');
    const unlClip = await clip('Unlisted clip title', 'unlisted', 'clip-9003-3.jpg');
    // The thumbnail file names carry the clip ids the rows got.
    for (const [id, old] of [[pubClip, 'clip-9001-1.jpg'], [privClip, 'clip-9002-2.jpg'], [unlClip, 'clip-9003-3.jpg']]) {
        const name = `clip-${id}-${old.split('-')[2]}`;
        fs.renameSync(path.join(process.env.THUMBNAILS_PATH, old), path.join(process.env.THUMBNAILS_PATH, name));
        await db.withObject('clip', id, async () => await db.run('UPDATE clips SET thumbnail_url = ? WHERE id = ?', [`/t/${name}`, id]));
    }
    const HIDDEN_TITLES = ['Secret VOD title', 'Unlisted VOD title', 'Secret clip title', 'Unlisted clip title'];
    const HIDDEN_THUMBS = [`vod-${privVod}-222.jpg`, `vod-${unlVod}-666.jpg`, `clip-${privClip}-2.jpg`, `clip-${unlClip}-3.jpg`];
    await raw.prepare("INSERT INTO pastes (slug, app_id, user_id, title, type, content, language, visibility) VALUES ('priv-page', 'live', 5, 'Secret paste title', 'paste', 'secret text', 'text', 'private') RETURNING id").run();

    const app = express();
    app.put('/api/v2/:app/objects/:id/content', ...require('../server/objects/routes').contentHandlers);
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v1/:app/files', require('../server/files/routes'));
    app.use('/api/v2/:app/objects', require('../server/objects/routes'));
    app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
    app.use('/o', require('../server/objects/routes').publicRouter);
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const local = (u) => String(u).replace('https://media.test', '');
        const get = async (p, headers = {}, method = 'GET', body) => {
            const h = { ...headers };
            let payload = body;
            if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
            const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
            const text = await res.text();
            let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
            return { status: res.status, text, json, location: res.headers.get('location') };
        };
        const same = async (a, b, msg) => {
            const [x, y] = [await get(...a), await get(...b)];
            assert.deepStrictEqual([x.status, x.text, x.location], [y.status, y.text, y.location], msg);
            return x;
        };
        const key = (k) => ({ authorization: `Bearer ${k}` });
        const asUser = (id) => ({ ...key('live-key'), 'x-ov-user-id': String(id) });
        const bearer = (t) => ({ authorization: `Bearer ${t}` });

        // Native objects: init → PUT bytes → complete.
        const mkObject = async (tenant, headers, visibility, body = 'bytes') => {
            let r = await get(`/api/v2/${tenant}/objects`, headers, 'POST', { kind: 'file', mime_type: 'text/plain', size_bytes: Buffer.byteLength(body), visibility, filename: 'x.txt' });
            assert.strictEqual(r.status, 201, r.text);
            const id = r.json.id;
            r = await get(local(r.json.upload.url), { 'content-type': 'text/plain' }, 'PUT', body);
            assert.strictEqual(r.status, 200, r.text);
            r = await get(`/api/v2/${tenant}/objects/${id}/complete`, headers, 'POST', {});
            assert.strictEqual(r.status, 200, r.text);
            return id;
        };
        const privObj = await mkObject('live', asUser(5), 'private');
        const unlObj = await mkObject('live', asUser(5), 'unlisted');
        const pubObj = await mkObject('live', asUser(5), 'public');
        const projObj = await mkObject(PA, bearer(appTok(PA)), 'private');
        const sandboxObj = await mkObject(PA, bearer(appTok(PA, 'sandbox')), 'public');
        const UNKNOWN = 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ';
        const job = (await queue.enqueue({ appId: 'live', type: 'thumbnail.regenerate', objectId: privObj, params: { kind: 'vod', id: privVod }, ownerUserId: 5, createdBy: 'app:live:user:5' })).job;

        // ── 1. Public lists: nothing private or unlisted ──
        for (const p of ['/', '/browse', '/browse?tab=videos', '/browse?tab=clips', '/browse?tab=thumbnails', '/?tab=thumbnails&page=1', '/sitemap.xml', '/llms.txt', '/updates']) {
            const r = await get(p);
            assert.ok(r.status < 500, `${p} answers`);
            for (const t of [...HIDDEN_TITLES, ...HIDDEN_THUMBS, 'Secret paste title']) assert.ok(!r.text.includes(t), `${p} lists ${t}`);
            if (/thumbnails/.test(p)) {
                assert.ok(r.text.includes(`vod-${pubVod}-111.jpg`) && r.text.includes(`clip-${pubClip}-1.jpg`), `${p}: public recordings' thumbnails are listed`);
            }
        }
        assert.ok((await get('/browse?tab=videos')).text.includes('Public VOD'), 'the index lists public VODs');
        console.log('✅ media index (every tab, thumbnails too), sitemap, llms.txt, updates: no private or unlisted item');

        for (const who of [asUser(77), { ...asUser(77), 'x-include': '1' }]) {
            let r = await get('/api/v1/live/vods?include_private=1&include_recording=1', who);
            assert.deepStrictEqual(r.json.vods.map(v => v.id), [pubVod], 'acting for another user: public VODs only, include_private ignored');
            r = await get('/api/v1/live/clips?include_private=1', who);
            assert.deepStrictEqual(r.json.clips.map(c => c.id), [pubClip], 'acting for another user: public clips only');
        }
        let r = await get('/api/v1/live/vods/latest-thumbs?managed_stream_ids=7,8', asUser(77));
        assert.deepStrictEqual(Object.keys(r.json.thumbs), ['7'], 'no thumbnail for a stream whose only VOD is unlisted');
        assert.strictEqual(r.json.thumbs['7'].vod_id, pubVod, 'the newest PUBLIC VOD, not the newer private one');
        r = await get('/api/v1/live/vods?include_private=1', key('live-key'));
        assert.strictEqual(r.json.vods.length, 3, 'the app key itself may list everything (control)');
        r = await get('/api/v2/live/objects', asUser(77));
        assert.deepStrictEqual(r.json.objects.filter(o => [privObj, unlObj, pubObj].includes(o.id)).map(o => o.id).sort(), [pubObj, unlObj].sort(), 'v2 list for another user: public and unlisted (documented), never private');
        r = await get(`/api/v2/live/objects?visibility=private&owner=user:5&user_id=5`, asUser(77));
        assert.ok(!r.json.objects.some(o => o.id === privObj), 'no filter reaches another user\'s private objects');
        r = await get('/api/v2/live/jobs', asUser(77));
        assert.ok(!r.json.jobs.some(j => j.id === job.id), 'another user\'s jobs are not listed');
        r = await get('/api/v2/games/objects', key('games-key'));
        assert.ok(!r.json.objects.some(o => [privObj, unlObj, pubObj].includes(o.id)), 'another app lists none of this app\'s objects');
        r = await get(`/api/v2/${PB}/objects`, bearer(appTok(PB)));
        assert.deepStrictEqual(r.json.objects, [], 'another developer project lists nothing of this one');
        console.log('✅ v1 lists, latest-thumbs, v2 object and job lists: no private item of anyone else');

        // ── 2. Every v2 object read: another user, another app, another project, nobody → the unknown-id answer ──
        const O = (tenant, id, rest = '') => `/api/v2/${tenant}/objects/${id}${rest}`;
        for (const rest of ['', '/download', '/download?format=json', '/download?redirect=1', '/holds', '/holds?all=1']) {
            r = await same([O('live', privObj, rest), asUser(77)], [O('live', UNKNOWN, rest), asUser(77)], `another user: private ${rest || 'metadata'} looks missing`);
            assert.strictEqual(r.status, 404);
            await same([O('games', privObj, rest), key('games-key')], [O('games', UNKNOWN, rest), key('games-key')], `another app on its own tenant: ${rest || 'metadata'}`);
            await same([O('games', pubObj, rest), key('games-key')], [O('games', UNKNOWN, rest), key('games-key')], `another app does not reach even a public object through its tenant: ${rest || 'metadata'}`);
            await same([O('live', privObj, rest), key('games-key')], [O('live', UNKNOWN, rest), key('games-key')], `another app's key on this tenant: ${rest || 'metadata'}`);
            await same([O('live', privObj, rest)], [O('live', UNKNOWN, rest)], `no credential: ${rest || 'metadata'}`);
            await same([O(PB, projObj, rest), bearer(appTok(PB))], [O(PB, UNKNOWN, rest), bearer(appTok(PB))], `another project: ${rest || 'metadata'}`);
            await same([O(PA, projObj, rest), bearer(appTok(PB))], [O(PA, UNKNOWN, rest), bearer(appTok(PB))], `another project's token on this project: ${rest || 'metadata'}`);
        }
        await same([`/api/v2/live/jobs/${job.id}`, asUser(77)], ['/api/v2/live/jobs/mjob_nosuchjob', asUser(77)], 'another user\'s job looks missing');
        assert.strictEqual((await get(O('live', privObj), asUser(5))).status, 200, 'the owner reads it (control)');
        assert.strictEqual((await get(O('live', unlObj), asUser(77))).status, 200, 'unlisted is readable by id (documented)');
        assert.strictEqual((await get(O(PA, projObj), bearer(appTok(PA)))).status, 200, 'its project reads it (control)');
        console.log('✅ v2 object reads (metadata, download, holds, jobs): other users, apps, projects and nobody get the unknown-id answer');

        // ── 3. Public serving with another app's identity; projected objects; the paste page ──
        const video = { accept: 'video/webm,*/*;q=0.5', 'sec-fetch-dest': 'video' };
        const nav = { accept: 'text/html,*/*;q=0.8', 'sec-fetch-dest': 'document' };
        for (const h of [video, nav]) {
            await same([`/v/${privVod}`, { ...h, ...key('games-key') }], ['/v/999999', { ...h, ...key('games-key') }], 'another app\'s key is nobody special on /v');
            await same([`/c/${privClip}`, { ...h, ...key('games-key') }], ['/c/999999', { ...h, ...key('games-key') }], 'another app\'s key is nobody special on /c');
            await same([`/c/${privClip}`, { ...h, ...asUser(77) }], ['/c/999999', { ...h, ...asUser(77) }], 'another user on /c');
        }
        await same(['/p/priv-page', nav], ['/p/no-such-paste', nav], 'a private paste page looks missing');
        await same(['/p/priv-page', { ...nav, ...asUser(77) }], ['/p/no-such-paste', { ...nav, ...asUser(77) }], 'a private paste page, for another user');
        await same([`/api/v1/games/vods/${pubVod}`, key('games-key')], ['/api/v1/games/vods/999999', key('games-key')], 'another app cannot read this app\'s VOD by id');
        await same([`/api/v1/games/clips/${privClip}`, key('games-key')], ['/api/v1/games/clips/999999', key('games-key')], 'nor its clip');
        const projected = await raw.prepare('SELECT id, visibility FROM media_objects WHERE legacy_ref IS NOT NULL AND id IN (SELECT object_id FROM vods WHERE id IN (?, ?) UNION SELECT id FROM media_objects WHERE legacy_ref ILIKE ? OR legacy_ref ILIKE ?)')
            .all(privVod, unlVod, `%vod-${privVod}-222.jpg%`, `%clip-${privClip}-2.jpg%`);
        assert.ok(projected.length >= 2, `the private rows have projected objects (${JSON.stringify(projected)})`);
        for (const o of projected.filter(x => x.visibility === 'private')) {
            await same([`/o/${o.id}`], [`/o/${UNKNOWN}`], `projected private object ${o.id} looks missing on /o`);
        }
        assert.ok(projected.some(o => o.visibility === 'private'), 'a private row\'s objects are private');
        console.log('✅ /v /c /p with another app or user, v1 reads across apps, projected VOD/thumbnail objects on /o');

        // ── 4. Signatures ──
        const miss = [`/o/${UNKNOWN}`];
        const good = signing.signedDownloadUrl(privObj, 60);
        const q = new URL(good.url).searchParams;
        assert.strictEqual((await get(local(good.url))).status, 200, 'a valid signature serves (control)');
        await same([`/o/${privObj}?exp=${now - 10}&sig=${signing.signedDownloadUrl(privObj, 60).url.split('sig=')[1]}`], miss, 'an old signature with a moved expiry');
        const expired = (() => { const real = Date.now; Date.now = () => real() - 3600 * 1000; try { return signing.signedDownloadUrl(privObj, 60); } finally { Date.now = real; } })();
        await same([local(expired.url)], miss, 'an expired signature looks like an unknown id');
        await same([`/o/${privObj}?exp=${Number(q.get('exp')) + 1000}&sig=${q.get('sig')}`], miss, 'a signature with its expiry pushed out');
        await same([`/o/${privObj}?exp=${q.get('exp')}&sig=${q.get('sig').slice(0, -2)}AA`], miss, 'a tampered signature');
        const other = new URL(signing.signedDownloadUrl(projObj, 60).url).searchParams;
        await same([`/o/${privObj}?exp=${other.get('exp')}&sig=${other.get('sig')}`], miss, 'another object\'s signature');
        await same([`/o/${sandboxObj}`], miss, 'a sandbox object is never public, whatever its visibility');
        await same([`/o/${projObj}`], miss, 'a project\'s private object without a signature');
        assert.strictEqual((await get(`/o/${unlObj}`)).status, 200, 'unlisted serves by direct link (control)');

        // Sandbox files (/f/:key): only a valid signed URL, and a bad one looks like an unknown key.
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from('sandbox bytes')], { type: 'text/plain' }), 's.txt');
        const up = await fetch(`${base}/api/v1/${PA}/files`, { method: 'POST', headers: bearer(appTok(PA, 'sandbox')), body: fd });
        const file = await up.json();
        assert.strictEqual(up.status, 201, JSON.stringify(file));
        const fq = new URL(file.url).searchParams;
        const k = encodeURIComponent(file.key);
        assert.strictEqual((await get(local(file.url))).status, 200, 'the signed sandbox file URL serves (control)');
        const fmiss = ['/f/no-such-file-key.txt'];
        await same([`/f/${k}`], fmiss, 'a sandbox file without a signature looks missing');
        await same([`/f/${k}?exp=${Number(fq.get('exp')) + 1000}&sig=${fq.get('sig')}`], fmiss, 'a sandbox file signature with its expiry pushed out');
        await same([`/f/${k}?exp=${now - 10}&sig=${signing.signedFileUrl(file.key, 60).url.split('sig=')[1]}`], fmiss, 'an expired sandbox file signature');
        const otherFile = new URL(signing.signedFileUrl('another-key.txt', 60).url).searchParams;
        await same([`/f/${k}?exp=${otherFile.get('exp')}&sig=${otherFile.get('sig')}`], fmiss, 'another file\'s signature');
        console.log('✅ signatures: expired, extended, tampered and other objects\' or files\' signatures answer as an unknown id');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('security-private: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); server.close(); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
