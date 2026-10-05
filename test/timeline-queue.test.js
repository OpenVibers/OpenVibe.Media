'use strict';
// The timeline queued by itself and signed playlists (F3.c; docs/media-fabric.md §3): a finalized VOD queues exactly one
// object.cmaf (a second finalize joins it); nothing is queued with MEDIA_HLS_ENABLED off, for a non-media object or once
// a timeline exists; GET …/download?format=json queues it lazily for an older VOD. queuePack queues one object.pack for
// a cut (a later call while it is active joins it; a later cut after it finished queues a new one); nothing is queued
// with MEDIA_HLS_ENABLED off or for a non-media object. A playlist token (purpose 'hls', MEDIA_HLS_PLAYLIST_TTL_S,
// clamped to 12 h) outlives the 1 h download token, is accepted only by
// the HLS routes and is carried onto the segment URIs; a download signature still opens the HLS routes. format=mp4
// queues object.remux once while the remux variant is missing and answers the variant's signed URL once it exists.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-timeline-queue-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
        MEDIA_HLS_ENABLED: '1', MEDIA_HLS_PLAYLIST_TTL_S: '999999', MEDIA_INVARIANT_SCAN_HOURS: '0',
    });

    const config = require('../server/config');
    assert.strictEqual(config.hls.playlistTtlS, 43200, 'MEDIA_HLS_PLAYLIST_TTL_S is clamped to 12 h');
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const timeline = require('../server/objects/timeline');
    const signing = require('../server/objects/signing');
    const { queueCmaf, queuePack } = require('../server/objects/timeline-queue');
    const tools = require('../server/vod/media-tools');
    const thumbService = require('../server/thumbnails/thumbnail-service');
    const vodStorage = require('../server/vod/vod-storage');
    await vodStorage.tierConfig.init(vodStorage.DEFAULTS);
    await require('../server/objects/tier-policy').init();
    const { finalizeVod } = require('../server/vod/finalize');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-timeline-queue' });

    // No ffmpeg in these paths; the job worker is never started, so queued jobs stay queued.
    thumbService.generateVodThumbnail = async () => null;
    tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 30, error: null });
    tools.probeDuration = async () => ({ ok: true, seconds: 30, format: {}, streams: [], error: null });
    tools.remuxForSeeking = async () => true;
    tools.probeVodInfo = async () => ({ duration: 12 });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v2/:app/objects', require('../server/objects/routes'));
    app.use('/o', require('../server/objects/routes').publicRouter);
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const api = `http://127.0.0.1:${server.address().port}`;
        const auth = { authorization: 'Bearer live-key-timeline-queue' };
        const call = async (method, p, body) => {
            const headers = { ...auth };
            if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
            const r = await fetch(api + p, { method, headers, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body, redirect: 'manual' });
            return { status: r.status, body: await r.json().catch(() => null) };
        };
        const get = async (url) => {
            const u = new URL(url, api);
            const r = await fetch(api + u.pathname + u.search, { redirect: 'manual' });
            return { status: r.status, text: await r.text() };
        };
        const jobs = async (type, objectId) => await db.all('SELECT * FROM media_jobs WHERE job_type = ? AND object_id = ?', [type, objectId]);
        const realNow = Date.now;
        const at = (s) => { const t0 = realNow(); Date.now = () => t0 + s * 1000; };
        const media = async (visibility = 'private', extra = {}) => await model.createObject({
            app_id: 'live', owner_user_id: 5, visibility, lifecycle_status: 'ready', kind: 'file', mime_type: 'video/mp4', size_bytes: 1000, ...extra });
        const row = (seq, start, end) => ({ seq, name: timeline.segmentName(seq), start_ms: start, end_ms: end, keyframe_ms: seq ? start : null,
            key: `x/source/${timeline.segmentName(seq)}`, local_path: null, durable_provider: null, packed_object_id: null, byte_offset: null,
            byte_length: 1000, sha256: 'a'.repeat(64), durability: 'local' });

        // ── Finalize queues the timeline, once ──
        let r = await call('POST', '/api/v1/live/vods', { title: 'Queued', user_id: 5, visibility: 'private' });
        assert.strictEqual(r.status, 201);
        const vodId = r.body.id;
        const f = new FormData();
        f.append('chunk', new Blob([Buffer.alloc(40000, 1)], { type: 'video/webm' }), 'a.webm');
        assert.strictEqual((await call('POST', `/api/v1/live/vods/${vodId}/chunks`, f)).body.status, 'created');
        const done = await finalizeVod(vodId);
        assert.ok(done && done.health_status === 'ok' && done.object_id, 'finalize returns the ready row');
        const vodObj = done.object_id;
        let cmaf = await jobs('object.cmaf', vodObj);
        assert.strictEqual(cmaf.length, 1, 'a ready VOD queues one object.cmaf');
        assert.deepStrictEqual([cmaf[0].status, cmaf[0].created_by, cmaf[0].idempotency_key, cmaf[0].app_id],
            ['queued', 'system:timeline', `object.cmaf:${vodObj}`, 'live']);
        await finalizeVod(vodId);
        assert.strictEqual(await queueCmaf('live', vodObj), cmaf[0].id, 'a later call answers the same job');
        assert.strictEqual((await jobs('object.cmaf', vodObj)).length, 1, 'a second finalize dedupes');
        console.log('✅ finalize: one object.cmaf per ready VOD, a second finalize joins it');

        // ── Nothing queued: flag off, non-media, missing, timeline already there ──
        const plain = await media();
        config.hls.enabled = false;
        assert.strictEqual(await queueCmaf('live', plain), null);
        config.hls.enabled = true;
        assert.strictEqual((await jobs('object.cmaf', plain)).length, 0, 'flag off: nothing queued');
        const pdf = await media('private', { mime_type: 'application/pdf' });
        assert.strictEqual(await queueCmaf('live', pdf), null);
        assert.strictEqual((await jobs('object.cmaf', pdf)).length, 0, 'a non-media object: nothing queued');
        assert.strictEqual(await queueCmaf('live', 'med_NOPE'), null, 'a missing object: nothing queued');
        const cut = await media();
        await timeline.replace(cut, 'source', [row(0, 0, 0), row(1, 0, 4000), row(2, 4000, 8000)]);
        assert.strictEqual(await queueCmaf('live', cut), null);
        assert.strictEqual((await jobs('object.cmaf', cut)).length, 0, 'a timeline already there: nothing queued');
        console.log('✅ nothing queued with the flag off, for a non-media or missing object, or once the timeline exists');

        // ── queuePack: a cut queues one object.pack, a re-run joins it; flag off or non-media queue nothing ──
        const packOff = await media();
        config.hls.enabled = false;
        assert.strictEqual(await queuePack('live', packOff), null);
        config.hls.enabled = true;
        assert.strictEqual((await jobs('object.pack', packOff)).length, 0, 'flag off: nothing queued');
        const packId = await queuePack('live', cut);
        assert.ok(packId && /^mjob_/.test(packId), 'a cut queues one object.pack');
        const packJobs = await jobs('object.pack', cut);
        assert.strictEqual(packJobs.length, 1);
        assert.deepStrictEqual([packJobs[0].status, packJobs[0].created_by, packJobs[0].idempotency_key, packJobs[0].app_id],
            ['queued', 'system:timeline', null, 'live'], 'no idempotency key: dedupeActive is what joins an active pack');
        assert.strictEqual(await queuePack('live', cut), packId, 'a later call while it is active answers the same job');
        assert.strictEqual((await jobs('object.pack', cut)).length, 1, 'an active pack is joined, not duplicated');
        assert.strictEqual(await queuePack('live', pdf), null);
        assert.strictEqual(await queuePack('live', 'med_NOPE'), null);
        assert.strictEqual((await jobs('object.pack', pdf)).length, 0, 'a non-media or missing object: nothing queued');
        console.log('✅ queuePack: a cut queues one object.pack, a re-run joins it; flag off or non-media queues nothing');

        // ── Playlist tokens: own purpose, outlive the download token, up to the configured TTL ──
        const pl = new URL(signing.signedPlaylistUrl(cut).url);
        assert.strictEqual(pl.pathname, `/o/${cut}/master.m3u8`);
        const [pexp, psig] = [pl.searchParams.get('exp'), pl.searchParams.get('sig')];
        const dl = new URL(signing.signedDownloadUrl(cut, 3600).url);
        const [dexp, dsig] = [dl.searchParams.get('exp'), dl.searchParams.get('sig')];
        assert.ok(signing.verifyPlaylist(cut, pexp, psig) && signing.verifyDownload(cut, dexp, dsig));
        assert.ok(!signing.verifyDownload(cut, pexp, psig), 'a playlist token is no download signature');
        assert.ok(!signing.verifyPlaylist(cut, dexp, dsig), 'a download signature is no playlist token');
        assert.ok(!signing.verifyPlaylist(plain, pexp, psig), 'bound to its object');
        at(2 * 3600);
        assert.ok(signing.verifyPlaylist(cut, pexp, psig), 'valid 2 h on');
        assert.ok(!signing.verifyDownload(cut, dexp, dsig), 'the 1 h download token is not');
        at(12 * 3600 - 10);
        assert.ok(signing.verifyPlaylist(cut, pexp, psig), 'valid up to the configured TTL');
        at(12 * 3600 + 10);
        assert.ok(!signing.verifyPlaylist(cut, pexp, psig), 'expired past it');
        Date.now = realNow;
        assert.ok(Number(new URL(signing.signedPlaylistUrl(cut, 10 ** 9).url).searchParams.get('exp')) <= Math.floor(realNow() / 1000) + 43200, 'TTL capped at 12 h');
        console.log('✅ playlist tokens: purpose hls, valid past the download TTL and up to MEDIA_HLS_PLAYLIST_TTL_S');

        // ── The routes: hls_url signed as a playlist, accepted by HLS only, carried onto the segments ──
        r = await call('GET', `/api/v2/live/objects/${cut}/download?format=json`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const hls = new URL(r.body.hls_url);
        assert.strictEqual(hls.pathname, `/o/${cut}/master.m3u8`);
        assert.ok(signing.verifyPlaylist(cut, hls.searchParams.get('exp'), hls.searchParams.get('sig')), 'hls_url carries a playlist token');
        assert.ok(!signing.verifyDownload(cut, hls.searchParams.get('exp'), hls.searchParams.get('sig')));
        assert.ok(Date.parse(r.body.hls_expires_at) - Date.parse(r.body.expires_at) > 3600 * 1000 * 10, 'the playlist outlives the download URL');
        const durl = new URL(r.body.url);
        at(2 * 3600);
        const master = await get(r.body.hls_url);
        assert.strictEqual(master.status, 200, 'the playlist plays 2 h on');
        assert.ok(master.text.includes(`source/index.m3u8${hls.search}`), master.text);
        const index = await get(`/o/${cut}/source/index.m3u8${hls.search}`);
        assert.strictEqual(index.status, 200);
        assert.ok(index.text.includes(`000001.m4s${hls.search}`) && index.text.includes(`init.mp4${hls.search}`), 'the token is carried onto the segment URIs');
        assert.strictEqual((await get(`/o/${cut}/master.m3u8${durl.search}`)).status, 404, 'the download signature has expired by then');
        Date.now = realNow;
        assert.strictEqual((await get(`/o/${cut}${hls.search}`)).status, 404, 'GET /o/:id refuses a playlist token');
        assert.strictEqual((await get(`/o/${cut}/master.m3u8${durl.search}`)).status, 200, 'a download signature still opens the HLS routes');
        assert.strictEqual((await get(`/o/${cut}/master.m3u8`)).status, 404, 'unsigned: refused');
        const pubCut = await media('public');
        await timeline.replace(pubCut, 'source', [row(0, 0, 0), row(1, 0, 4000)]);
        assert.strictEqual((await call('GET', `/api/v2/live/objects/${pubCut}/download?format=json`)).body.hls_url, `${config.publicUrl}/o/${pubCut}/master.m3u8`, 'public stays unsigned');
        console.log('✅ hls_url: a playlist token, refused by GET /o/:id, carried onto segments; download signatures still play');

        // ── Lazy: an older VOD gets its timeline queued on the first JSON download ──
        const old = await media();
        r = await call('GET', `/api/v2/live/objects/${old}/download?format=json`);
        assert.strictEqual(r.status, 200);
        assert.ok(!('hls_url' in r.body), 'no hls_url until the timeline exists');
        await call('GET', `/api/v2/live/objects/${old}/download?format=json`);
        cmaf = await jobs('object.cmaf', old);
        assert.strictEqual(cmaf.length, 1, 'queued once on demand');
        assert.strictEqual(cmaf[0].created_by, 'system:timeline');
        assert.strictEqual((await jobs('object.cmaf', pdf)).length, 0);
        await call('GET', `/api/v2/live/objects/${pdf}/download?format=json`);
        assert.strictEqual((await jobs('object.cmaf', pdf)).length, 0, 'a non-media download queues nothing');
        console.log('✅ download?format=json queues object.cmaf lazily, once');

        // ── format=mp4: object.remux once while missing, the variant's URL once present ──
        r = await call('GET', `/api/v2/live/objects/${plain}/download?format=mp4`);
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        const job = r.body.job_id;
        assert.ok(/^mjob_/.test(job));
        r = await call('GET', `/api/v2/live/objects/${plain}/download?format=mp4`);
        assert.deepStrictEqual([r.status, r.body.job_id], [202, job], 'joins the queued remux');
        assert.strictEqual((await jobs('object.remux', plain)).length, 1, 'object.remux queued once');
        const mp4 = await media('private');
        await model.setVariant(plain, 'remux', mp4, 'object.remux@1');
        r = await call('GET', `/api/v2/live/objects/${plain}/download?format=mp4`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const mu = new URL(r.body.url);
        assert.deepStrictEqual([mu.pathname, r.body.object_id], [`/o/${mp4}`, mp4]);
        assert.ok(signing.verifyDownload(mp4, mu.searchParams.get('exp'), mu.searchParams.get('sig')), 'the variant\'s signed URL');
        assert.strictEqual((await jobs('object.remux', plain)).length, 1, 'nothing more queued');
        assert.strictEqual((await call('GET', `/api/v2/live/objects/${pdf}/download?format=mp4`)).status, 400, 'no MP4 of a non-media object');
        console.log('✅ format=mp4: object.remux queued once while missing, the remux variant\'s URL once present');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('✅ All timeline queue tests passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
