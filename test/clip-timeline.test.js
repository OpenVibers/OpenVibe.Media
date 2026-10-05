'use strict';
// Clips over the timeline (F3.5; docs/media-fabric.md §4): timeline.clipRows cuts a source's rows to a window (edges,
// empty window, init segment); a clip over a VOD with a timeline is virtual — ready at once, no clip.cut — and plays as
// HLS over the source's segments through the hlsObject() rules; its playlist token reaches only the segments inside its
// window (never the rest of the source, never GET /o/:id); /c/:id sends a reader to that playlist. materialize still
// queues clip.cut, a file clip keeps serving its file, and with MEDIA_HLS_ENABLED off a clip is cut as before.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-clip-timeline-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
        MEDIA_HLS_ENABLED: '1', MEDIA_INVARIANT_SCAN_HOURS: '0',
    });

    const config = require('../server/config');
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const timeline = require('../server/objects/timeline');
    const signing = require('../server/objects/signing');
    const tools = require('../server/vod/media-tools');
    const thumbService = require('../server/thumbnails/thumbnail-service');
    const vodStorage = require('../server/vod/vod-storage');
    await vodStorage.tierConfig.init(vodStorage.DEFAULTS);
    await require('../server/objects/tier-policy').init();
    const { finalizeVod } = require('../server/vod/finalize');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-clip-timeline' });

    // No ffmpeg in these paths; the job worker is never started, so queued jobs stay queued.
    thumbService.generateVodThumbnail = async () => null;
    tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 30, error: null });
    tools.probeDuration = async () => ({ ok: true, seconds: 30, format: {}, streams: [], error: null });
    tools.remuxForSeeking = async () => true;
    tools.probeVodInfo = async () => ({ duration: 30 });

    // ── clipRows: the window's edges ──
    const row = (seq, start, end, extra = {}) => ({ seq, name: timeline.segmentName(seq), start_ms: start, end_ms: end, keyframe_ms: seq ? start : null,
        key: `src/source/${timeline.segmentName(seq)}`, local_path: null, durable_provider: null, packed_object_id: null, byte_offset: null,
        byte_length: 1000, sha256: String(seq).repeat(64).slice(0, 64), durability: 'local', ...extra });
    const src = [row(0, 0, 0), row(1, 0, 4000), row(2, 4000, 8000), row(3, 8000, 12000, { packed_object_id: 'p'.repeat(64), byte_offset: 5, byte_length: 10 }),
        row(4, 12000, 16000), row(5, 16000, 18500)];
    let c = timeline.clipRows(src, 5000, 11000);
    assert.deepStrictEqual(c.map((r) => [r.seq, r.name, r.start_ms, r.end_ms]), [[0, 'init.mp4', 0, 0], [1, '000002.m4s', 0, 3000], [2, '000003.m4s', 3000, 6000]],
        'segments straddling start and end are in, renumbered, times clipped and relative to the window');
    assert.deepStrictEqual([c[2].key, c[2].packed_object_id, c[2].byte_offset, c[2].byte_length, c[2].sha256], [src[3].key, src[3].packed_object_id, 5, 10, src[3].sha256],
        'location and bytes stay the source\'s');
    assert.deepStrictEqual(timeline.clipRows(src, 4000, 8000).map((r) => r.name), ['init.mp4', '000002.m4s'], 'a window on segment boundaries takes exactly those');
    assert.deepStrictEqual(timeline.clipRows(src, 17000, 60000).map((r) => [r.name, r.end_ms]), [['init.mp4', 0], ['000005.m4s', 1500]], 'the tail stops at the source\'s end');
    assert.deepStrictEqual(timeline.clipRows(src, 30000, 40000), [], 'an empty window has no rows, not even the init segment');
    assert.deepStrictEqual(timeline.clipRows(src, 4000, 4000), [], 'a zero-length window too');
    assert.strictEqual(src[2].seq, 2, 'the source rows are not changed');
    const mp = timeline.mediaPlaylist(c, { query: 'exp=1&sig=x' });
    assert.ok(mp.includes('#EXT-X-MEDIA-SEQUENCE:1') && mp.includes('#EXTINF:3.000,\n000002.m4s?exp=1&sig=x') && !mp.includes('000001.m4s'), mp);
    console.log('✅ clipRows: straddling edges, boundaries, tail, empty window, init segment');

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v2/:app/objects', require('../server/objects/routes'));
    app.use('/o', require('../server/objects/routes').publicRouter);
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const api = `http://127.0.0.1:${server.address().port}`;
        const auth = { authorization: 'Bearer live-key-clip-timeline' };
        const call = async (method, p, body) => {
            const headers = { ...auth };
            if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
            const r = await fetch(api + p, { method, headers, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body, redirect: 'manual' });
            return { status: r.status, body: await r.json().catch(() => null) };
        };
        const get = async (url, headers = {}) => {
            const u = new URL(url, api);
            const r = await fetch(api + u.pathname + u.search, { headers, redirect: 'manual' });
            return { status: r.status, location: r.headers.get('location'), buf: Buffer.from(await r.arrayBuffer()) };
        };
        const jobs = async (type, where = '') => await db.all(`SELECT * FROM media_jobs WHERE job_type = ? ${where}`, [type]);
        const clipCuts = async (clipId) => (await jobs('clip.cut')).filter((j) => Number(model.parseJson(j.params, {}).clip_id) === Number(clipId));

        // A private, finished VOD with a source timeline on this node's disk (segment 3 packed in a chunk).
        let r = await call('POST', '/api/v1/live/vods', { title: 'Source', user_id: 5, visibility: 'private' });
        assert.strictEqual(r.status, 201);
        const vodId = r.body.id;
        const f = new FormData();
        f.append('chunk', new Blob([Buffer.alloc(40000, 1)], { type: 'video/webm' }), 'a.webm');
        assert.strictEqual((await call('POST', `/api/v1/live/vods/${vodId}/chunks`, f)).body.status, 'created');
        const vodObj = (await finalizeVod(vodId)).object_id;
        const vodRow = await model.getObject(vodObj);
        const bytes = {};
        const rows = src.map((s) => {
            const p = timeline.localPathFor(vodRow, 'source', s.name, 'v1');
            fs.mkdirSync(path.dirname(p), { recursive: true });
            bytes[s.name] = Buffer.from(`${s.name}:`.padEnd(64, String(s.seq)));
            if (s.packed_object_id) {
                fs.writeFileSync(p, Buffer.concat([Buffer.from('HEAD!'), bytes[s.name].subarray(0, 10), Buffer.from('TAIL')]));
                bytes[s.name] = bytes[s.name].subarray(0, 10);
            } else fs.writeFileSync(p, bytes[s.name]);
            return { ...s, local_path: p, byte_length: s.packed_object_id ? 10 : bytes[s.name].length };
        });
        await timeline.replace(vodObj, 'source', rows);

        // ── A clip over it is virtual: ready at once, no clip.cut ──
        r = await call('POST', '/api/v1/live/clips', { vod_id: vodId, start_s: 5, end_s: 11, visibility: 'private', title: 'Virtual' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.status, r.body.storage_provider, r.body.file_path, r.body.start_time, r.body.end_time, r.body.duration_seconds],
            ['ready', 'timeline', null, 5, 11, 6]);
        assert.strictEqual(r.body.playback_url, `${config.publicUrl}/c/${r.body.id}`, 'playback_url unchanged');
        const clipId = r.body.id;
        const clipObj = (await db.getClipById(clipId)).object_id;
        const co = await model.getObject(clipObj);
        assert.deepStrictEqual([co.kind, co.lifecycle_status, co.visibility], ['clip', 'ready', 'private']);
        assert.strictEqual((await clipCuts(clipId)).length, 0, 'no clip.cut for a virtual clip');
        assert.deepStrictEqual([r.body.readiness.playable, r.body.readiness.bytes_verified, r.body.readiness.reason], [true, true, null], 'a virtual clip is playable');
        assert.strictEqual(model.parseJson(co.metadata, {}).virtual, true);
        const readiness = require('../server/objects/readiness');
        assert.ok(await db.get(`SELECT 1 FROM clips WHERE id = ? AND ${readiness.playableSql('clips.object_id')}`, [clipId]), 'playableSql agrees');
        const verified = await require('../server/objects/verify-job').runOnce({ batch: 50, head: async () => undefined, upload: async () => { throw new Error('no upload in this test'); }, maxReuploads: 0 });
        assert.ok(!verified.objects.some((o) => o.object_id === clipObj), 'the verify job leaves a virtual clip alone');
        assert.ok(!(await db.get('SELECT 1 FROM media_verifications WHERE object_id = ?', [clipObj])), 'and reports no no_good_copy for it');
        console.log('✅ POST /clips over a timeline: ready at once (201), storage_provider timeline, playable, no clip.cut, not verified');

        // ── Its playlists: hlsObject() rules, the source's segments inside the window ──
        for (const p of ['master.m3u8', 'source/index.m3u8', 'source/init.mp4', 'source/000002.m4s']) assert.strictEqual((await get(`/o/${clipObj}/${p}`)).status, 404, `unsigned ${p}`);
        const tok = new URL(signing.signedPlaylistUrl(clipObj).url).search;
        const master = await get(`/o/${clipObj}/master.m3u8${tok}`);
        assert.strictEqual(master.status, 200);
        assert.ok(master.buf.toString().includes(`source/index.m3u8${tok}`));
        const index = (await get(`/o/${clipObj}/source/index.m3u8${tok}`)).buf.toString();
        assert.ok(index.includes(`#EXT-X-MAP:URI="init.mp4${tok}"`) && index.includes(`#EXTINF:3.000,\n000002.m4s${tok}`) && index.includes(`#EXTINF:3.000,\n000003.m4s${tok}`), index);
        assert.ok(!/00000[145]\.m4s/.test(index), 'nothing outside the window is listed');
        const demand = require('../server/placement/demand');
        demand._reset();                                  // only the segment reads below count
        for (const n of ['init.mp4', '000002.m4s', '000003.m4s']) {
            const s = await get(`/o/${clipObj}/source/${n}${tok}`);
            assert.strictEqual(s.status, 200, n);
            assert.deepStrictEqual(s.buf, bytes[n], `${n}: the source's bytes${n === '000003.m4s' ? ' (a slice of its packed chunk)' : ''}`);
        }
        // The segment route threads the segment into the demand rollup (F2.4): the object total is what it served,
        // and each segment reads apart from the others.
        assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ objectIds: [clipObj] })), { [clipObj]: 3 });
        assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ objectIds: [clipObj], segment: '000002.m4s' })), { [clipObj]: 1 });
        assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ objectIds: [clipObj], segment: '000003.m4s' })), { [clipObj]: 1 });
        assert.deepStrictEqual(Object.fromEntries(await demand.hotness({ objectIds: [clipObj], segment: '000001.m4s' })), { [clipObj]: 0 }, 'a segment outside the window was never served');
        console.log('✅ a private virtual clip: 404 unsigned, signed playlists over the source window, source bytes and packed slices');

        // ── Token scope: the clip's window only ──
        for (const n of ['000001.m4s', '000004.m4s', '000005.m4s']) assert.strictEqual((await get(`/o/${clipObj}/source/${n}${tok}`)).status, 404, `clip token refused for ${n}`);
        for (const p of ['master.m3u8', 'source/index.m3u8', 'source/000001.m4s', 'source/000002.m4s']) assert.strictEqual((await get(`/o/${vodObj}/${p}${tok}`)).status, 404, `clip token never opens the source's ${p}`);
        assert.strictEqual((await get(`/o/${clipObj}${tok}`)).status, 404, 'GET /o/:id refuses a playlist token');
        const vodTok = new URL(signing.signedPlaylistUrl(vodObj).url).search;
        assert.strictEqual((await get(`/o/${clipObj}/source/000002.m4s${vodTok}`)).status, 404, 'a source token does not open the clip');
        assert.strictEqual((await get(`/o/${vodObj}/source/000001.m4s${vodTok}`)).status, 200, 'the source token still plays the source');
        console.log('✅ a clip token reaches only its window: not the source, not GET /o/:id; a source token is not needed nor accepted');

        // ── Discovery: /download names the playlist (no object.cmaf for the clip); /c/:id redirects to it ──
        r = await call('GET', `/api/v2/live/objects/${clipObj}/download?format=json`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const hu = new URL(r.body.hls_url);
        assert.ok(hu.pathname === `/o/${clipObj}/master.m3u8` && signing.verifyPlaylist(clipObj, hu.searchParams.get('exp'), hu.searchParams.get('sig')));
        assert.strictEqual((await jobs('object.cmaf', 'AND object_id = ?'.replace('?', `'${clipObj}'`))).length, 0, 'no object.cmaf for a virtual clip');
        assert.strictEqual((await get(`/c/${clipId}`)).status, 404, '/c/:id of a private clip, unsigned: 404');
        const cr = await get(new URL(signing.signedMediaUrl('clip', clipId, 600).url).pathname + new URL(signing.signedMediaUrl('clip', clipId, 600).url).search);
        assert.strictEqual(cr.status, 302);
        const cu = new URL(cr.location);
        assert.ok(cu.pathname === `/o/${clipObj}/master.m3u8` && signing.verifyPlaylist(clipObj, cu.searchParams.get('exp'), cu.searchParams.get('sig')), cr.location);
        const signedC = new URL(signing.signedMediaUrl('clip', clipId, 600).url);
        for (const h of [{ 'sec-fetch-dest': 'document' }, { accept: 'text/html,application/xhtml+xml' }]) {
            const nav = await get(signedC.pathname + signedC.search, h);
            assert.strictEqual(nav.status, 302, `a browser navigation (${JSON.stringify(h)}) is redirected, not shown "not available"`);
            assert.strictEqual(new URL(nav.location).pathname, `/o/${clipObj}/master.m3u8`);
        }
        assert.strictEqual((await get(`/c/${clipId}`, { 'sec-fetch-dest': 'document' })).status, 404, 'unsigned navigation of a private clip: 404');
        console.log('✅ /download gives hls_url without queueing object.cmaf; /c/:id (signed, any reader) redirects to the clip\'s signed playlist');

        // ── Materialize: still clip.cut, the virtual clip keeps playing meanwhile ──
        r = await call('POST', `/api/v1/live/clips/${clipId}/recut`, { materialize: true });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.ok(r.body.job_id && r.body.status === 'ready');
        assert.strictEqual((await clipCuts(clipId)).length, 1, 'recut?materialize queues clip.cut');
        assert.strictEqual((await get(`/o/${clipObj}/master.m3u8${tok}`)).status, 200, 'still playing');
        r = await call('POST', '/api/v1/live/clips', { vod_id: vodId, start_s: 20, end_s: 23, materialize: true });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.ok(r.body.job_id && r.body.status === 'processing');
        assert.strictEqual((await clipCuts(r.body.id)).length, 1, 'POST materialize queues clip.cut');
        console.log('✅ materialize (POST and recut) queues clip.cut; a virtual clip plays on while it is cut');

        // ── A re-encoded clip keeps serving its file; its recut stays a cut ──
        const file = path.join(process.env.CLIPS_PATH, 'old.webm');
        fs.writeFileSync(file, Buffer.alloc(3000, 7));
        const old = (await db.createClip({ app_id: 'live', vod_id: vodId, user_id: 5, title: 'Old', file_path: file, start_time: 2, end_time: 6,
            duration_seconds: 4, is_public: 1, visibility: 'public', status: 'ready' })).lastInsertRowid;
        const oldObj = await model.getObject((await db.getClipById(old)).object_id);
        assert.strictEqual(oldObj.lifecycle_status, 'ready');
        const ob = await get(`/c/${old}?raw=1`);
        assert.deepStrictEqual([ob.status, ob.buf.length], [200, 3000], 'the file is served as before');
        r = await call('POST', `/api/v1/live/clips/${old}/recut`, {});
        assert.strictEqual(r.status, 202);
        assert.strictEqual((await clipCuts(old)).length, 1, 'a clip with a file is re-cut, not turned virtual');
        assert.strictEqual((await db.getClipById(old)).file_path, file);
        console.log('✅ a re-encoded clip keeps serving its file, and its recut is a cut');

        // ── The retry sweeper recovers a failed, file-less clip the way a recut does: virtual over the timeline ──
        const failed = (await db.createClip({ app_id: 'live', vod_id: vodId, user_id: 5, title: 'Failed', file_path: null, start_time: 8, end_time: 12,
            duration_seconds: 4, is_public: 1, visibility: 'public', status: 'failed' })).lastInsertRowid;
        await require('../server/vod/clip-jobs').sweep();
        const fr = await db.getClipById(failed);
        assert.deepStrictEqual([fr.status, fr.storage_provider, fr.file_path], ['ready', 'timeline', null]);
        assert.strictEqual((await clipCuts(failed)).length, 0, 'no cut for it');
        console.log('✅ the retry sweeper turns a failed clip over a timeline virtual, as a recut does');

        // ── Flag off: cut as before ──
        config.hls.enabled = false;
        await db.run("UPDATE clips SET created_at = '2000-01-01 00:00:00'");   // past the duplicate-clip window
        r = await call('POST', '/api/v1/live/clips', { vod_id: vodId, start_s: 26, end_s: 29 });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.strictEqual((await clipCuts(r.body.id)).length, 1, 'MEDIA_HLS_ENABLED off: clip.cut');
        assert.strictEqual((await get(`/o/${clipObj}/master.m3u8${tok}`)).status, 404, 'and the HLS routes are off');
        config.hls.enabled = true;
        console.log('✅ MEDIA_HLS_ENABLED off: clips are cut as before');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('✅ All clip timeline tests passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
