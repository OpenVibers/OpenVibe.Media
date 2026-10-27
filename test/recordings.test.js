'use strict';
// Recordings (docs/recordings.md; owner, 2026-10-27: "instead of 'The stream was recorded in 2 parts: Part 1 · Part 2'
// it should automatically just have them as a single vod … that seeks just fine"):
// - timeline.joinRows puts the parts' rows end to end: names p<k>-…, times shifted, part k's init (and its shape
//   periods') named, bytes untouched; the playlist puts a discontinuity and the next part's init at the join; a clip
//   window may cross the join.
// - PUT /api/v1/:app/recordings/:key makes a recording of an app's VODs (a native object, no VOD row); its playlist and
//   segments play both parts' bytes; lists show only its first part, which names the recording; visibility and the
//   title follow the first part; a clip in recording time across the join is virtual over the recording.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-recordings-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
        MEDIA_HLS_ENABLED: '1', MEDIA_INVARIANT_SCAN_HOURS: '0',
    });
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const timeline = require('../server/objects/timeline');
    const tools = require('../server/vod/media-tools');
    const thumbService = require('../server/thumbnails/thumbnail-service');
    const vodStorage = require('../server/vod/vod-storage');
    await vodStorage.tierConfig.init(vodStorage.DEFAULTS);
    await require('../server/objects/tier-policy').init();
    const { finalizeVod } = require('../server/vod/finalize');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-recordings' });
    thumbService.generateVodThumbnail = async () => null;
    tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 30, error: null });
    tools.probeDuration = async () => ({ ok: true, seconds: 30, format: {}, streams: [], error: null });
    tools.remuxForSeeking = async () => true;
    tools.probeVodInfo = async () => ({ duration: 30 });

    // ── joinRows ──
    const row = (seq, start, end, extra = {}) => ({ seq, name: timeline.segmentName(seq), start_ms: start, end_ms: end, keyframe_ms: seq > 0 ? start : null,
        key: `x/source/${timeline.segmentName(seq)}`, local_path: null, durable_provider: null, packed_object_id: null, byte_offset: null,
        byte_length: 1000, sha256: String(Math.abs(seq) % 10).repeat(64), durability: 'local', init_name: null, ...extra });
    const a = [row(0, 0, 0), row(1, 0, 4000), row(2, 4000, 8000), row(3, 8000, 10500)];
    // Part 2 starts at its own 2000 ms and turns at 6000 ms (a shape period with init-2.mp4).
    const b = [row(0, 0, 0), { ...row(-102, 0, 0), name: 'init-2.mp4' }, row(1, 2000, 6000), row(2, 6000, 9000, { init_name: 'init-2.mp4' })];
    const joined = timeline.joinRows([a, b]);
    assert.deepStrictEqual(joined.map((r) => [r.seq, r.name, r.start_ms, r.end_ms, r.init_name]), [
        [0, 'p1-init.mp4', 0, 0, null],
        [1, 'p1-000001.m4s', 0, 4000, null], [2, 'p1-000002.m4s', 4000, 8000, null], [3, 'p1-000003.m4s', 8000, 10500, null],
        [-20000, 'p2-init.mp4', 0, 0, null], [-20002, 'p2-init-2.mp4', 0, 0, null],
        [4, 'p2-000001.m4s', 10500, 14500, 'p2-init.mp4'], [5, 'p2-000002.m4s', 14500, 17500, 'p2-init-2.mp4'],
    ], 'end to end, renamed, part 2 decoding with its own inits');
    assert.strictEqual(joined[6].key, b[2].key, 'bytes stay where they are');
    const mp = timeline.mediaPlaylist(joined);
    assert.ok(mp.includes('#EXT-X-MAP:URI="p1-init.mp4"\n#EXTINF:4.000,\np1-000001.m4s'), mp);
    assert.ok(mp.includes('p1-000003.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="p2-init.mp4"\n#EXTINF:4.000,\np2-000001.m4s'), 'a clean decoder reset at the join');
    assert.ok(mp.includes('p2-000001.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="p2-init-2.mp4"'), 'and at part 2\'s turn');
    assert.deepStrictEqual(timeline.joinRows([a, [row(0, 0, 0)]]), [], 'a part with nothing to play: no recording yet');
    const across = timeline.clipRows(joined, 9000, 13000);
    assert.deepStrictEqual(across.filter((r) => r.seq > 0).map((r) => [r.name, r.start_ms, r.end_ms, r.init_name]),
        [['p1-000003.m4s', 0, 1500, null], ['p2-000001.m4s', 1500, 4000, 'p2-init.mp4']], 'a clip window across the join');
    assert.ok(across.some((r) => r.name === 'p2-init.mp4'), 'carrying part 2\'s init');
    assert.ok(timeline.mediaPlaylist(across).includes('#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="p2-init.mp4"'));
    console.log('✅ joinRows: end to end, renamed inits, discontinuity at the join, a clip across it');

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v1/:app/recordings', require('../server/vod/recordings').router);
    app.use('/o', require('../server/objects/routes').publicRouter);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    const auth = { authorization: 'Bearer live-key-recordings' };
    const call = async (method, p, body) => {
        const headers = { ...auth };
        if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
        const r = await fetch(api + p, { method, headers, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body, redirect: 'manual' });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const get = async (url) => {
        const u = new URL(url, api);
        const r = await fetch(api + u.pathname + u.search, { redirect: 'manual' });
        return { status: r.status, text: Buffer.from(await r.arrayBuffer()) };
    };

    // Two finished VODs of stream 2795 with timelines on this node's disk.
    const made = [];
    for (const [title, rows] of [['BIRD DRAMA (Part 1)', a], ['BIRD DRAMA (Part 2)', b]]) {
        const r = await call('POST', '/api/v1/live/vods', { title, user_id: 5, stream_id: 2795 });
        assert.strictEqual(r.status, 201);
        const f = new FormData();
        f.append('chunk', new Blob([Buffer.alloc(40000, 1)], { type: 'video/webm' }), 'a.webm');
        await call('POST', `/api/v1/live/vods/${r.body.id}/chunks`, f);
        const objectId = (await finalizeVod(r.body.id)).object_id;
        const obj = await model.getObject(objectId);
        const bytes = {};
        await timeline.replace(objectId, 'source', rows.map((s) => {
            const p = timeline.localPathFor(obj, 'source', s.name, 'v1');
            fs.mkdirSync(path.dirname(p), { recursive: true });
            bytes[s.name] = Buffer.from(`${title}:${s.name}`);
            fs.writeFileSync(p, bytes[s.name]);
            return { ...s, local_path: p, byte_length: bytes[s.name].length };
        }));
        made.push({ id: r.body.id, objectId, bytes });
    }
    const [p1, p2] = made;

    // ── the recording ──
    let r = await call('PUT', '/api/v1/live/recordings/stream:2795', { parts: [p1.id, { vod_id: p2.id, gap_before_ms: 4000, stream_offset_ms: 709000 }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const rec = r.body;
    assert.match(rec.id, /^med_/);
    assert.deepStrictEqual([rec.key, rec.state, rec.duration_ms, rec.vod_id], ['stream:2795', 'open', 17500, p1.id]);
    assert.deepStrictEqual(rec.parts.map((x) => [x.seq, x.vod_id, x.start_ms, x.duration_ms, x.gap_before_ms]), [[1, p1.id, 0, 10500, 0], [2, p2.id, 10500, 7000, 4000]]);
    assert.strictEqual(rec.parts[1].stream_offset_ms, 709000);
    assert.strictEqual(rec.hls_url, `https://media.test/o/${rec.id}/master.m3u8`);
    assert.strictEqual((await call('PUT', '/api/v1/live/recordings/stream:2795', { parts: [p1.id, p2.id] })).body.id, rec.id, 'idempotent: the same recording');
    assert.strictEqual((await call('PUT', '/api/v1/live/recordings/stream:9', { parts: [p2.id, p1.id] })).status, 409, 'a part belongs to one recording');
    assert.strictEqual((await call('GET', '/api/v1/live/recordings/stream:2795')).body.id, rec.id);
    assert.strictEqual((await call('GET', `/api/v1/live/recordings/object/${rec.id}`)).body.key, 'stream:2795');
    assert.ok(!(await db.get('SELECT 1 FROM vods WHERE object_id = ?', [rec.id])), 'no VOD row of its own');

    // Playback: both parts' bytes through the recording's playlists.
    const master = await get(`/o/${rec.id}/master.m3u8`);
    assert.strictEqual(master.status, 200, master.text.toString());
    const media = (await get(`/o/${rec.id}/source/index.m3u8`)).text.toString();
    assert.ok(media.includes('p1-000001.m4s') && media.includes('#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="p2-init.mp4"') && media.includes('p2-000002.m4s'), media);
    assert.deepStrictEqual((await get(`/o/${rec.id}/source/p2-000001.m4s`)).text, p2.bytes['000001.m4s'], 'part 2\'s segment, as stored');
    assert.deepStrictEqual((await get(`/o/${rec.id}/source/p1-init.mp4`)).text, p1.bytes['init.mp4']);
    assert.deepStrictEqual((await get(`/o/${rec.id}/source/p2-init-2.mp4`)).text, p2.bytes['init-2.mp4']);
    assert.strictEqual((await get(`/o/${rec.id}/source/p3-000001.m4s`)).status, 404);
    console.log('✅ PUT /recordings: one object over both parts, its playlist and segments play them');

    // Lists: the first part stands for the video and names the recording; its later part only when asked.
    r = await call('GET', '/api/v1/live/vods?stream_id=2795');
    assert.deepStrictEqual(r.body.vods.map((v) => v.id), [p1.id], 'the later part is not a video of its own');
    assert.deepStrictEqual([r.body.vods[0].recording.recording_id, r.body.vods[0].recording.parts], [rec.id, 2]);
    assert.strictEqual((await call('GET', '/api/v1/live/vods?stream_id=2795&include_parts=1')).body.vods.length, 2);
    r = await call('GET', `/api/v1/live/vods/${p2.id}`);
    assert.deepStrictEqual([r.body.recording.id, r.body.recording.this_part.start_ms, r.body.recording.vod_id], [rec.id, 10500, p1.id], 'a part says where it is in the whole');

    // Visibility and the title follow the first part.
    assert.strictEqual((await call('PUT', `/api/v1/live/vods/${p1.id}`, { visibility: 'private', title: 'BIRD DRAMA (Part 1)' })).status, 200);
    assert.strictEqual((await db.getVodById(p2.id)).visibility, 'private', 'every part');
    assert.strictEqual((await model.getObject(rec.id)).visibility, 'private', 'and the recording');
    assert.strictEqual((await get(`/o/${rec.id}/master.m3u8`)).status, 404, 'a private recording needs its signature');
    assert.strictEqual(model.parseJson((await model.getObject(rec.id)).metadata, {}).title, 'BIRD DRAMA', 'the title without "(Part 1)"');
    await call('PUT', `/api/v1/live/vods/${p1.id}`, { visibility: 'public' });
    assert.strictEqual((await db.getVodById(p2.id)).visibility, 'public');

    // A clip in recording time across the join: virtual over the recording, on the first part.
    r = await call('POST', '/api/v1/live/clips', { vod_id: p2.id, start_s: 9, end_s: 13, recording_time: true, title: '' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.vod_id, r.body.recording_id, r.body.time_base, r.body.start_time, r.body.end_time], [p1.id, rec.id, 'recording', 9, 13]);
    const clipObj = (await db.getClipById(r.body.id)).object_id;
    const clipMedia = (await get(`/o/${clipObj}/source/index.m3u8`)).text.toString();
    assert.ok(clipMedia.includes('p1-000003.m4s') && clipMedia.includes('p2-000001.m4s') && clipMedia.includes('#EXT-X-DISCONTINUITY'), clipMedia);
    assert.deepStrictEqual((await get(`/o/${clipObj}/source/p2-000001.m4s`)).text, p2.bytes['000001.m4s'], 'the clip plays part 2\'s bytes');
    assert.strictEqual((await get(`/o/${clipObj}/source/p2-000002.m4s`)).status, 404, 'and nothing outside its window');
    console.log('✅ lists show the whole video once; visibility and title follow; a clip across the join');

    // Fewer than two parts: no recording.
    assert.deepStrictEqual((await call('PUT', '/api/v1/live/recordings/stream:2795', { parts: [p1.id] })).body, { recording: null });
    assert.strictEqual((await call('GET', '/api/v1/live/recordings/stream:2795')).status, 404);
    assert.strictEqual((await call('GET', '/api/v1/live/vods?stream_id=2795')).body.vods.length, 2, 'both parts list again');

    server.close();
    console.log('recordings: all passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
