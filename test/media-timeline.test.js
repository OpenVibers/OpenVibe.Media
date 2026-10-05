'use strict';
// Segment-native video, first slice (F3.1; docs/media-fabric.md §3): object.cmaf stream-copies a finished video into
// CMAF segments on its own keyframes and writes one media_timeline row per segment; the HLS playlists come from the
// rows (ENDLIST, the rows' durations); segmentAt answers the segment at an instant, at the boundaries too; a rerun is a
// no-op; a private object's playlist refuses an anonymous reader and its signed one carries the signature on; with
// MEDIA_HLS_ENABLED off nothing answers; a purge removes the segments unless the object is held.
// F3.3: object.pack concatenates the durable segments into a chunk, each row naming its byte range; a packed segment is
// served as a ranged read of the chunk (from this node or the durable copy) with the original bytes; a rerun packs
// nothing; the per-segment copies are gone; the durable provider comes from the placement router; private stays private.
// A finished object.cmaf queues object.pack by itself: a rerun while a pack is active joins it, a later cut queues a
// new one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-timeline-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.MEDIA_JOBS_POLL_MS = '50';
    process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';
    process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';
    process.env.MEDIA_HLS_ENABLED = '1';
    for (const p of ['B2', 'R2']) for (const k of ['ENDPOINT', 'BUCKET', 'KEY_ID', 'APP_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) process.env[`MEDIA_${p}_${k}`] = '';
    // The durable providers' bytes ("<provider>:<key>"), served back with Range at /blob/… by the stub (presigned URLs).
    const blobs = new Map();
    const stub = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            if (req.url.startsWith('/blob/')) {
                const b = blobs.get(decodeURIComponent(req.url.slice(6)));
                if (!b) { res.statusCode = 404; return res.end(); }
                const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
                if (!m) return res.end(b);
                res.statusCode = 206;
                return res.end(b.subarray(Number(m[1]), Number(m[2]) + 1));
            }
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
            res.statusCode = 404; res.end('{}');
        });
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const size = (file) => { const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }); return r.stdout.trim(); };
    const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

    (async () => {
        const config = require('../server/config');
        const timeline = require('../server/objects/timeline');
        const { parsePlaylist } = require('../server/jobs/cmaf');
        assert.strictEqual(config.hls.enabled, true);

        // ── The store alone: segmentAt and the playlists over hand-made rows ──
        assert.deepStrictEqual(parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3.000000,\n000001.m4s\n#EXTINF:1.5,\n000002.m4s\n#EXT-X-ENDLIST\n'),
            [{ name: '000001.m4s', seconds: 3 }, { name: '000002.m4s', seconds: 1.5 }]);
        const row = (seq, start, end, len = 1000) => ({ seq, name: timeline.segmentName(seq), start_ms: start, end_ms: end, keyframe_ms: seq ? start : null,
            key: `med_HAND/source/${timeline.segmentName(seq)}`, local_path: null, durable_provider: null, packed_object_id: null, byte_offset: null,
            byte_length: len, sha256: 'a'.repeat(64), durability: 'local' });
        const hand = [row(0, 0, 0, 500), row(1, 0, 3000, 30000), row(2, 3000, 4500), row(3, 4500, 6432)];
        assert.deepStrictEqual(await timeline.replace('med_HAND', 'source', hand), { inserted: 4, updated: 0, unchanged: 0, removed: 0 });
        const at = async (t) => { const r = await timeline.segmentAt('med_HAND', 'source', t); return r ? Number(r.seq) : null; };
        assert.deepStrictEqual([await at(0), await at(2999), await at(3000), await at(4499), await at(4500), await at(6431), await at(6432), await at(-1), await at(NaN)],
            [1, 1, 2, 2, 3, 3, null, null, null], 'start inclusive, end exclusive; nothing past either end');
        assert.strictEqual(await timeline.segmentAt('med_HAND', '720p', 10), null, 'another rendition has no rows');
        const mp = timeline.mediaPlaylist(await timeline.list('med_HAND'));
        assert.ok(mp.includes('#EXT-X-TARGETDURATION:3\n') && mp.includes('#EXT-X-MAP:URI="init.mp4"') && mp.includes('#EXTINF:1.932,\n000003.m4s') && mp.trim().endsWith('#EXT-X-ENDLIST'), mp);
        assert.ok(timeline.masterPlaylist([{ name: 'source', rows: hand }]).includes('#EXT-X-STREAM-INF:BANDWIDTH=80000,AVERAGE-BANDWIDTH='), 'peak = 30000 B over 3 s');
        assert.deepStrictEqual(await timeline.replace('med_HAND', 'source', hand.slice(0, 2)), { inserted: 0, updated: 0, unchanged: 2, removed: 2 }, 'rows past a shorter end are dropped');
        assert.deepStrictEqual(await timeline.removeObject('med_HAND'), { removed: 2, pending: 0 });
        if (!hasFfmpeg) { console.log('media timeline: skipped (ffmpeg not found)'); process.exit(0); }

        await new Promise((r) => stub.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${stub.address().port}`;
        const db = require('../server/db/database');
        await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
        const events = require('../server/events');
        events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 });
        const model = require('../server/objects/model');
        const queue = require('../server/jobs/queue');
        const worker = require('../server/jobs/worker');
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
        app.use('/api/v2/:app/objects', require('../server/objects/routes'));
        app.use('/o', require('../server/objects/routes').publicRouter);
        const server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const api = `http://127.0.0.1:${server.address().port}`;
        const call = async (method, p, { body } = {}) => {
            const res = await fetch(api + p, { method, headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        const get = async (url, headers = {}) => {
            const res = await fetch(url.startsWith('http') ? url : api + url, { headers, redirect: 'manual' });
            return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
        };
        await worker.start();

        // A 7 s source, 10 fps, a keyframe every 1.5 s: segments cut at 3.0, 4.5, 6.0 for a 2 s target.
        const src = path.join(process.env.VOD_PATH, 'src.mp4');
        const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=7:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7',
            '-c:v', 'mpeg4', '-g', '15', '-c:a', 'aac', '-shortest', src]);
        assert.strictEqual(mk.status, 0, String(mk.stderr));
        const native = async (visibility) => {
            const file = path.join(process.env.VOD_PATH, `${visibility}.mp4`);
            fs.copyFileSync(src, file);
            const id = await model.createObject({ app_id: 'live', owner_user_id: 5, visibility, lifecycle_status: 'ready', kind: 'file', mime_type: 'video/mp4', size_bytes: fs.statSync(file).size });
            await model.upsertLocation(id, { provider: 'local', key: file, state: 'present', size_bytes: fs.statSync(file).size, verified: true });
            return id;
        };
        const pub = await native('public');
        const priv = await native('private');
        const before = JSON.stringify([await model.getObject(pub), await model.listLocations(pub)]);

        const runJob = async (objectId, params, type = 'object.cmaf') => {
            const r = await call('POST', '/api/v2/live/jobs', { body: { type, object_id: objectId, ...(params && { params }) } });
            assert.strictEqual(r.status, 202, JSON.stringify(r.body));
            const fin = await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(r.body.job.id)).status));
            assert.ok(fin, `${type} finishes: ${JSON.stringify(queue.jobPublic(await queue.get(r.body.job.id)))}`);
            return queue.jobPublic(await queue.get(r.body.job.id));
        };

        // ── The job → contiguous rows with the right sha256 ──
        const j = await runJob(pub, { segment_seconds: 2 });
        assert.strictEqual(j.status, 'succeeded', JSON.stringify(j.error));
        assert.strictEqual(j.result.segments, 4, JSON.stringify(j.result));
        assert.deepStrictEqual([j.result.durable, j.result.local_only, j.result.uploaded, j.result.rows.inserted], [0, 5, 0, 5], 'no B2 here: every row is local');
        const rows = await timeline.list(pub);
        assert.deepStrictEqual(rows.map((r) => Number(r.seq)), [0, 1, 2, 3, 4]);
        assert.deepStrictEqual(rows.map((r) => r.name), ['init.mp4', '000001.m4s', '000002.m4s', '000003.m4s', '000004.m4s']);
        const segs = rows.slice(1);
        assert.strictEqual(Number(segs[0].start_ms), 0);
        for (let i = 1; i < segs.length; i++) assert.strictEqual(Number(segs[i].start_ms), Number(segs[i - 1].end_ms), `segment ${i + 1} starts where ${i} ends`);
        assert.deepStrictEqual(segs.map((r) => [Number(r.start_ms), Number(r.end_ms), Number(r.keyframe_ms)]), [[0, 3000, 0], [3000, 4500, 3000], [4500, 6000, 4500], [6000, 7000, 6000]], 'cut on the source keyframes');
        for (const r of rows) {
            const bytes = fs.readFileSync(r.local_path);
            assert.strictEqual(sha(bytes), r.sha256, `${r.name} sha256`);
            assert.strictEqual(bytes.length, Number(r.byte_length));
            assert.strictEqual(r.key, `${pub}/source/${r.sha256.slice(0, 12)}/${r.name}`, 'the key is versioned by the sha');
            assert.strictEqual(r.durability, 'local');
            assert.ok(r.local_path.startsWith(path.join(path.resolve(process.env.OBJECTS_PATH), '.timeline', 'live', pub, 'source')));
        }
        assert.strictEqual(JSON.stringify([await model.getObject(pub), await model.listLocations(pub)]), before, 'the source is untouched');
        assert.strictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.jobs')).length, 0, 'the work directory is removed');

        // ── A truncated timeline (an in-progress cut) must not shrink the sheet: the object's own 7 s duration
        // lays it out, exactly as the seek path would, and the samples past the rows become black tiles ──
        const shorty = await model.createObject({ app_id: 'live', owner_user_id: 5, visibility: 'private', lifecycle_status: 'ready', kind: 'file', mime_type: 'video/mp4', size_bytes: 1, metadata: { duration_seconds: 7 } });
        await timeline.replace(shorty, 'source', rows.slice(0, 2));   // init + one 3 s segment: the timeline ends at 3 s
        const st = await runJob(shorty, {}, 'object.sprite');
        assert.strictEqual(st.status, 'succeeded', JSON.stringify(st.error));
        assert.deepStrictEqual(st.result.sprite, require('../server/jobs/previews').spriteLayout(7, { frames: 100, columns: 10, tile_width: 160 }), 'the object duration, not the 3 s timeline end, lays the sheet out');
        assert.deepStrictEqual([st.result.sprite.count, st.result.sprite.interval_seconds], [3, 2.333], 'same interval/count as the seek path over the 7 s source');
        const sto = await model.getObject(st.result.object_id);
        assert.strictEqual(model.parseJson(sto.metadata, {}).source_duration_seconds, 7, 'the seek metadata carries the real duration');
        assert.strictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.jobs')).length, 0, 'the work directory is removed');
        // shorty's rows name pub's segment files (two objects, one location): dropping them keeps the bytes, which pub still names,
        // and lets the purge below delete them, since after that no row of any object names them
        await timeline.removeObject(shorty);
        assert.ok(rows.every((r) => fs.existsSync(r.local_path)), 'pub still names its files after a sharing object is removed');

        // ── The finished cut queues object.pack by itself, once (the worker runs it; no provider yet, so it packs nothing) ──
        const packJobs = async (objectId) => (await queue.list('live', { type: 'object.pack', objectId })).jobs;
        const autoPack = await packJobs(pub);
        assert.strictEqual(autoPack.length, 1, 'a finished object.cmaf queues exactly one object.pack');
        assert.deepStrictEqual([autoPack[0].created_by, autoPack[0].idempotency_key], ['system:timeline', null], 'no idempotency key: dedupeActive is what joins an active pack');
        assert.ok(await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(autoPack[0].id)).status)), 'the queued pack runs');

        // ── The playlists come from the rows ──
        const master = await get(`/o/${pub}/master.m3u8`);
        assert.strictEqual(master.status, 200);
        assert.ok(/^application\/vnd\.apple\.mpegurl/.test(master.headers.get('content-type')));
        assert.ok(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+\nsource\/index\.m3u8\n/.test(master.buf.toString()), master.buf.toString());
        const media = (await get(`/o/${pub}/source/index.m3u8`)).buf.toString();
        assert.ok(media.trim().endsWith('#EXT-X-ENDLIST') && media.includes('#EXT-X-PLAYLIST-TYPE:VOD') && media.includes('#EXT-X-TARGETDURATION:3\n'), media);
        assert.deepStrictEqual(parsePlaylist(media), [['000001.m4s', 3], ['000002.m4s', 1.5], ['000003.m4s', 1.5], ['000004.m4s', 1]].map(([name, seconds]) => ({ name, seconds })), 'the durations are the rows');
        for (const r of rows) {
            const s = await get(`/o/${pub}/source/${r.name}`);
            assert.strictEqual(s.status, 200, r.name);
            assert.strictEqual(sha(s.buf), r.sha256, `${r.name} served as indexed`);
        }
        assert.strictEqual((await get(`/o/${pub}/source/000002.m4s`, { range: 'bytes=0-99' })).status, 206, 'segments take ranges');
        assert.strictEqual((await get(`/o/${pub}/source/000009.m4s`)).status, 404);
        assert.strictEqual((await get(`/o/${pub}/source/..%2Findex.m3u8`)).status, 404);
        // A real HLS reader agrees: the playlist plays back as the 7 s source.
        // (spawned, not spawnSync: the server answering it runs in this process)
        const ffprobe = () => new Promise((resolve) => {
            const p = spawn('ffprobe', ['-v', 'error', '-rw_timeout', '10000000', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${api}/o/${pub}/master.m3u8`]);
            let out = '';
            p.stdout.on('data', (d) => { out += d; });
            p.stderr.on('data', (d) => { out += d; });
            p.on('close', () => resolve(out.trim()));
        });
        const probe = await ffprobe();
        assert.ok(Math.abs(Number(probe) - 7) < 0.2, `ffprobe reads the playlist: ${probe}`);
        assert.strictEqual(master.headers.get('access-control-allow-origin'), '*', 'a public playlist may be read cross-origin');

        // ── segmentAt on the real timeline, at the boundaries ──
        const seqAt = async (t) => { const r = await timeline.segmentAt(pub, 'source', t); return r ? Number(r.seq) : null; };
        assert.deepStrictEqual([await seqAt(0), await seqAt(2999), await seqAt(3000), await seqAt(4500), await seqAt(5999), await seqAt(6000), await seqAt(6999), await seqAt(7000)],
            [1, 1, 2, 3, 3, 4, 4, null]);

        // ── A rerun is a no-op: same rows, no file rewritten ──
        const mtimes = rows.map((r) => fs.statSync(r.local_path).mtimeMs);
        const j2 = await runJob(pub, { segment_seconds: 2 });
        assert.strictEqual(j2.status, 'succeeded', JSON.stringify(j2.error));
        assert.deepStrictEqual(j2.result.rows, { inserted: 0, updated: 0, unchanged: 5, removed: 0 });
        assert.strictEqual(j2.result.uploaded, 0);
        assert.strictEqual(JSON.stringify(await timeline.list(pub)), JSON.stringify(rows), 'the rows are as they were (job_id, updated_at too)');
        assert.deepStrictEqual(rows.map((r) => fs.statSync(r.local_path).mtimeMs), mtimes, 'no segment rewritten');
        // The first pack finished, so the rerun is not joined: a later cut queues a new object.pack.
        const secondPack = await packJobs(pub);
        assert.strictEqual(secondPack.length, 2, 'a cut after the pack finished queues a new object.pack');
        assert.ok(secondPack.some((p) => p.id === autoPack[0].id), 'the finished pack is kept');
        const rerunPack = secondPack.find((p) => p.id !== autoPack[0].id);
        assert.ok(await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(rerunPack.id)).status)), 'the rerun\'s pack runs too');

        // ── F3.3: durable segments (stubbed B2/R2), the provider chosen by the placement router ──
        const pack = require('../server/jobs/pack');
        const vodStorage = require('../server/vod/vod-storage');
        const router = require('../server/placement/router');
        let configured = ['b2', 'r2'];
        Object.assign(vodStorage, {
            providerConfigured: (p) => configured.includes(p),
            providerAvailable: (p) => configured.includes(p),
            uploadFile: async (p, key, file) => { blobs.set(`${p}:${key}`, fs.readFileSync(file)); },
            sha256Object: async (p, key) => (blobs.has(`${p}:${key}`) ? { sha256: sha(blobs.get(`${p}:${key}`)), size: blobs.get(`${p}:${key}`).length } : null),
            deleteObject: async (p, key) => { blobs.delete(`${p}:${key}`); return true; },
            presignGet: async (p, key) => `${base}/blob/${encodeURIComponent(`${p}:${key}`)}`,
        });
        const realRoute = router.route;
        const purposes = [];
        router.route = async (opts) => { purposes.push(opts.purpose); return realRoute(opts); };
        // Pause the worker: the cut's own object.pack (queued below) must stay queued while the unpacked rows are
        // asserted, and it is run explicitly at the packing step.
        worker.stop();
        const j3r = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.cmaf', object_id: pub, params: { segment_seconds: 2 } } });
        assert.strictEqual(j3r.status, 202, JSON.stringify(j3r.body));
        assert.ok(await worker.runNow(j3r.body.job.id), 'the cut runs directly while the worker is paused');
        const j3 = queue.jobPublic(await queue.get(j3r.body.job.id));
        assert.strictEqual(j3.status, 'succeeded', JSON.stringify(j3.error));
        assert.deepStrictEqual([j3.result.uploaded, j3.result.durable, j3.result.rows.updated], [5, 5, 5], JSON.stringify(j3.result));
        assert.ok(purposes.includes('durable'), 'object.cmaf asks the placement router for its provider');
        const durableRows = await timeline.list(pub);
        assert.ok(durableRows.every((r) => r.durability === 'durable' && r.durable_provider === 'b2' && blobs.has(`b2:${r.key}`)), 'the router ranks the canonical tier first');
        configured = ['r2'];
        assert.strictEqual(await timeline.durableProvider(await model.getObject(pub)), 'r2', 'no B2: the router picks R2, nothing is hard-coded');
        configured = [];
        assert.strictEqual(await timeline.durableProvider(await model.getObject(pub)), null);
        configured = ['b2', 'r2'];

        // ── Planning: contiguous durable unpacked runs, ~target each, a short tail joins the chunk before ──
        const pr = (seq, start, end, extra = {}) => ({ ...row(seq, start, end), durability: 'durable', durable_provider: 'b2', ...extra });
        const planned = pack.plan([pr(0, 0, 0), ...[1, 2, 3, 4, 5, 6, 7].map((n) => pr(n, (n - 1) * 25000, n * 25000)), pr(8, 175000, 180000, { durability: 'local', durable_provider: null }),
            pr(9, 180000, 190000), pr(10, 190000, 200000), pr(11, 200000, 210000, { packed_object_id: 'x' })], 60000);
        assert.deepStrictEqual(planned.chunks.map((c) => c.map((r) => r.seq)), [[1, 2, 3], [4, 5, 6, 7], [9, 10]], 'a 25 s tail joins the chunk before; a local segment ends a run');
        assert.deepStrictEqual([planned.alreadyPacked, planned.waiting], [1, 1]);

        // ── The pack job's abort signal: nothing packed, the work directory removed ──
        const acp = new AbortController();
        acp.abort(new Error('pack cancelled in test'));
        await assert.rejects(pack.spec.run({ id: 'mjob_PACKABORT', app_id: 'live', object_id: pub, params: { target_seconds: 10 } }, { signal: acp.signal }), /pack cancelled in test/);
        assert.strictEqual(JSON.stringify(await timeline.list(pub)), JSON.stringify(durableRows));
        assert.strictEqual(fs.existsSync(path.join(process.env.OBJECTS_PATH, '.jobs', 'mjob_PACKABORT')), false);

        // ── Packing: the pack the cut queued (still queued while the worker was paused) makes one chunk, each row its
        // byte range, the per-segment copies deleted ──
        const cutPack = (await packJobs(pub))[0];
        assert.ok(cutPack && cutPack.status === 'queued' && cutPack.idempotency_key == null, 'the cut queued a pack of its own');
        assert.ok(await worker.runNow(cutPack.id), 'the cut\'s pack runs');
        const jp = queue.jobPublic(await queue.get(cutPack.id));
        assert.strictEqual(jp.status, 'succeeded', JSON.stringify(jp.error));
        assert.deepStrictEqual([jp.result.packs, jp.result.segments, jp.result.removed_segments, jp.result.left_behind, jp.result.provider], [1, 4, 4, 0, 'b2'], JSON.stringify(jp.result));
        // Resume the worker for the rerun cases below.
        await worker.start();
        worker.kick();
        const packed = await timeline.list(pub);
        assert.strictEqual(JSON.stringify(packed[0]), JSON.stringify(durableRows[0]), 'the init segment is not packed');
        const chunkId = packed[1].packed_object_id;
        const chunkKey = `${pub}/source/${chunkId.slice(0, 12)}/p000001.m4s`;
        const chunk = blobs.get(`b2:${chunkKey}`);
        assert.ok(chunk && sha(chunk) === chunkId, 'packed_object_id is the chunk sha256, and the durable chunk reads back as it');
        assert.deepStrictEqual(fs.readFileSync(packed[1].local_path), chunk, 'this node keeps the same chunk');
        let at0 = 0;
        for (const [i, r] of packed.slice(1).entries()) {
            const was = durableRows[i + 1];
            assert.deepStrictEqual([r.name, r.start_ms, r.end_ms, r.sha256, r.byte_length], [was.name, was.start_ms, was.end_ms, was.sha256, was.byte_length], `${r.name} keeps its identity`);
            assert.deepStrictEqual([r.packed_object_id, r.key, r.durable_provider, r.durability, Number(r.byte_offset)], [chunkId, chunkKey, 'b2', 'durable', at0], `${r.name} names its range`);
            assert.strictEqual(sha(chunk.subarray(at0, at0 + Number(r.byte_length))), r.sha256, `${r.name}'s range is its bytes`);
            assert.ok(!blobs.has(`b2:${was.key}`) && !fs.existsSync(was.local_path), `${r.name}'s own key and file are deleted`);
            at0 += Number(r.byte_length);
        }
        assert.strictEqual(at0, chunk.length);
        assert.strictEqual((await get(`/o/${pub}/source/index.m3u8`)).buf.toString(), media, 'the playlist is unchanged by packing');
        for (const r of packed) {
            const s = await get(`/o/${pub}/source/${r.name}`);
            assert.deepStrictEqual([s.status, sha(s.buf), Number(s.headers.get('content-length'))], [200, r.sha256, Number(r.byte_length)], `${r.name} served from the chunk`);
        }
        const part = await get(`/o/${pub}/source/000002.m4s`, { range: 'bytes=10-99' });
        assert.deepStrictEqual([part.status, part.headers.get('content-range')], [206, `bytes 10-99/${packed[2].byte_length}`]);
        assert.deepStrictEqual(part.buf, chunk.subarray(Number(packed[2].byte_offset) + 10, Number(packed[2].byte_offset) + 100), 'a range inside a packed segment');
        assert.strictEqual((await get(`/o/${pub}/source/000002.m4s`, { range: `bytes=${packed[2].byte_length}-` })).status, 416);
        assert.ok(Math.abs(Number(await ffprobe()) - 7) < 0.2, 'the packed timeline still plays as the 7 s source');
        // This node's chunk gone: the router's durable copy, read as a byte range.
        fs.renameSync(packed[1].local_path, `${packed[1].local_path}.away`);
        for (const r of packed.slice(1)) {
            const s = await get(`/o/${pub}/source/${r.name}`);
            assert.deepStrictEqual([s.status, sha(s.buf)], [200, r.sha256], `${r.name} served from the durable chunk`);
        }
        fs.renameSync(`${packed[1].local_path}.away`, packed[1].local_path);

        // ── Sprites come from the timeline (F3.1): each frame from the row covering its instant, decoded from the
        // packed chunk's byte range, never the source. The seek layout and the player contract are unchanged ──
        const { spriteLayout } = require('../server/jobs/previews');
        const brightness = (file) => {
            const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'], { encoding: null, maxBuffer: 1 << 20 });
            return r.stdout && r.stdout.length ? r.stdout[r.stdout.length - 1] : -1;
        };
        const sr = await runJob(pub, {}, 'object.sprite');
        assert.strictEqual(sr.status, 'succeeded', JSON.stringify(sr.error));
        assert.deepStrictEqual(sr.result.sprite, spriteLayout(7, { frames: 100, columns: 10, tile_width: 160 }), 'the timeline sheet keeps the seek layout');
        assert.deepStrictEqual([sr.result.sprite.count, sr.result.sprite.interval_seconds, sr.result.sprite.columns], [3, 2.333, 3]);
        const so = await model.getObject(sr.result.object_id);
        assert.deepStrictEqual([so.kind, so.mime_type, so.visibility], ['asset', 'image/jpeg', 'private']);
        assert.strictEqual(size((await model.listLocations(so.id))[0].key), '480,90', 'the image is the layout: 3 × 160 by 1 × 90');
        assert.deepStrictEqual(model.parseJson(so.metadata, {}).sprite, sr.result.sprite, 'the layout is in the metadata');
        assert.strictEqual((await model.getVariant(pub, 'sprite')).derived_object_id, so.id);
        assert.ok(brightness((await model.listLocations(so.id))[0].key) > 30, 'real frames from the rows, not black tiles');

        // The source file gone: the seek path could not run at all, yet the rows' bytes cut the same sheet.
        const pubFile = path.join(process.env.VOD_PATH, 'public.mp4');
        fs.renameSync(pubFile, `${pubFile}.away`);
        const sr2 = await runJob(pub, { frames: 4, columns: 2, tile_width: 96 }, 'object.sprite');
        assert.strictEqual(sr2.status, 'succeeded', JSON.stringify(sr2.error));
        assert.deepStrictEqual([sr2.result.sprite.count, sr2.result.sprite.rows, sr2.result.sprite.columns], [3, 2, 2], 'the same layout from rows, with no source to seek');
        assert.strictEqual(size((await model.listLocations(sr2.result.object_id))[0].key), '192,108');
        fs.renameSync(`${pubFile}.away`, pubFile);

        // ── The durable fallback and its guards. A packed row is a byte range of the chunk: with this node's
        // chunk gone the frame must come from a 206 ranged GET of the durable copy. A 200 (Range ignored) or a
        // wrong content-length is refused before the body is read; a sha mismatch is a black tile, not a failure ──
        const previews = require('../server/jobs/previews');
        assert.strictEqual(typeof previews.rowBuffer, 'function');
        const durableRow = { durability: 'durable', durable_provider: 'b2', key: 'k', packed_object_id: 'chunk', byte_offset: 10, byte_length: 4, sha256: sha(Buffer.from('abcd')) };
        const realFetch = global.fetch;
        let cancelled = 0;
        let read = 0;
        global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, body: { cancel: async () => { cancelled++; } }, arrayBuffer: async () => { read++; return Buffer.from('abcd'); } });
        assert.strictEqual(await previews.rowBuffer(durableRow, {}), null, 'a 200 answer to a packed ranged GET is refused');
        assert.deepStrictEqual([cancelled, read], [1, 0], 'refused without buffering the whole chunk');
        cancelled = 0;
        global.fetch = async () => ({ ok: true, status: 206, headers: { get: () => '999' }, body: { cancel: async () => { cancelled++; } }, arrayBuffer: async () => { read++; return Buffer.alloc(999); } });
        assert.strictEqual(await previews.rowBuffer(durableRow, {}), null, 'a 206 of the wrong length is refused');
        assert.deepStrictEqual([cancelled, read], [1, 0], 'refused before this one was read either');
        global.fetch = async () => ({ ok: true, status: 206, headers: { get: () => '4' }, body: null, arrayBuffer: async () => Buffer.from('0000') });
        assert.strictEqual(await previews.rowBuffer(durableRow, {}), null, 'a sha mismatch is a black tile, not a failure');
        global.fetch = async () => ({ ok: true, status: 206, headers: { get: () => '4' }, body: null, arrayBuffer: async () => Buffer.from('abcd') });
        assert.deepStrictEqual(await previews.rowBuffer(durableRow, {}), Buffer.from('abcd'), 'the verified range');
        global.fetch = realFetch;

        const tileBrightness = (file, i, layout) => {
            const x = (i % layout.columns) * layout.tile_width;
            const y = Math.floor(i / layout.columns) * layout.tile_height;
            const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=${layout.tile_width}:${layout.tile_height}:${x}:${y},scale=1:1,format=gray`, '-f', 'rawvideo', '-'], { encoding: null, maxBuffer: 1 << 20 });
            return r.stdout && r.stdout.length ? r.stdout[r.stdout.length - 1] : -1;
        };
        fs.renameSync(packed[1].local_path, `${packed[1].local_path}.sprite-away`);
        const sd = await runJob(pub, { frames: 4, columns: 2, tile_width: 96 }, 'object.sprite');
        assert.strictEqual(sd.status, 'succeeded', JSON.stringify(sd.error));
        assert.deepStrictEqual([sd.result.sprite.count, sd.result.sprite.columns, sd.result.sprite.rows], [3, 2, 2], 'the durable ranges cut the same sheet');
        const sdFile = (await model.listLocations(sd.result.object_id))[0].key;
        assert.ok([0, 1, 2].every((i) => tileBrightness(sdFile, i, sd.result.sprite) > 30), 'real frames from the durable chunk');
        // One durable range corrupted: its tile is black, the others still decode.
        const cleanChunk = blobs.get(`b2:${chunkKey}`);
        const corruptChunk = Buffer.from(cleanChunk);
        corruptChunk.fill(0, Number(packed[1].byte_offset), Number(packed[1].byte_offset) + Number(packed[1].byte_length));
        blobs.set(`b2:${chunkKey}`, corruptChunk);
        const sc = await runJob(pub, { frames: 4, columns: 2, tile_width: 96 }, 'object.sprite');
        assert.strictEqual(sc.status, 'succeeded', JSON.stringify(sc.error));
        const scFile = (await model.listLocations(sc.result.object_id))[0].key;
        assert.ok(tileBrightness(scFile, 0, sc.result.sprite) < 20, 'the sha-mismatched range is a black tile');
        assert.ok(tileBrightness(scFile, 1, sc.result.sprite) > 30, 'the intact ranges still cut real frames');
        blobs.set(`b2:${chunkKey}`, cleanChunk);
        fs.renameSync(`${packed[1].local_path}.sprite-away`, packed[1].local_path);

        // ── A failed run leaves no seg-*.mp4 behind, only the resumable frame checkpoints ──
        {
            const derive = require('../server/jobs/derive');
            const acs = new AbortController();
            acs.abort(new Error('sprite cancelled in test'));
            const wdir = derive.workDir('mjob_SPRITEABORT');
            fs.writeFileSync(path.join(wdir, 'f0000.jpg'), 'checkpoint');
            await assert.rejects(previews.sprite.run({ id: 'mjob_SPRITEABORT', app_id: 'live', object_id: pub, params: {} }, { signal: acs.signal }), /sprite cancelled in test/);
            assert.deepStrictEqual(fs.readdirSync(wdir).filter((n) => /^seg-.*\.mp4$/.test(n)), [], 'no sampled segment is left behind');
            assert.ok(fs.existsSync(path.join(wdir, 'f0000.jpg')), 'the frame checkpoint survives for a retry');
            derive.cleanupWork('mjob_SPRITEABORT');
        }

        // A source with no timeline uses the old seek path (and writes no rows).
        const plainFile = path.join(process.env.VOD_PATH, 'plain.mp4');
        fs.copyFileSync(src, plainFile);
        const plain = await model.createObject({ app_id: 'live', owner_user_id: 5, visibility: 'private', lifecycle_status: 'ready', kind: 'file', mime_type: 'video/mp4', size_bytes: fs.statSync(plainFile).size });
        await model.upsertLocation(plain, { provider: 'local', key: plainFile, state: 'present', size_bytes: fs.statSync(plainFile).size, verified: true });
        assert.strictEqual(await timeline.has(plain), false);
        const sp = await runJob(plain, { frames: 4, columns: 2, tile_width: 96 }, 'object.sprite');
        assert.strictEqual(sp.status, 'succeeded', JSON.stringify(sp.error));
        assert.deepStrictEqual([sp.result.sprite.count, sp.result.sprite.columns, sp.result.sprite.rows], [3, 2, 2], 'the seek path lays out the sheet the same way');
        assert.strictEqual(await timeline.has(plain), false, 'and writes no timeline rows');

        // ── A rerun packs nothing; a cmaf rerun keeps the packed rows ──
        const jp2 = await runJob(pub, { target_seconds: 10 }, 'object.pack');
        assert.deepStrictEqual([jp2.status, jp2.result.packs, jp2.result.already_packed], ['succeeded', 0, 4], JSON.stringify(jp2.result));
        assert.strictEqual(JSON.stringify(await timeline.list(pub)), JSON.stringify(packed), 'a rerun changes no row');
        const j4 = await runJob(pub, { segment_seconds: 2 });
        assert.deepStrictEqual([j4.status, j4.result.uploaded, j4.result.rows], ['succeeded', 0, { inserted: 0, updated: 0, unchanged: 5, removed: 0 }], JSON.stringify(j4.result));
        assert.ok(blobs.has(`b2:${chunkKey}`) && fs.existsSync(packed[1].local_path), 'and its chunk');
        router.route = realRoute;

        // ── The job's abort signal: nothing written, the work directory removed ──
        const cmaf = require('../server/jobs/cmaf');
        const ac = new AbortController();
        ac.abort(new Error('cancelled in test'));
        await assert.rejects(cmaf.spec.run({ id: 'mjob_ABORTED', app_id: 'live', object_id: priv, params: {} }, { signal: ac.signal }), /cancelled in test/);
        assert.strictEqual(await timeline.has(priv), false);
        assert.strictEqual(fs.existsSync(path.join(process.env.OBJECTS_PATH, '.jobs', 'mjob_ABORTED')), false);

        // ── A private object: anonymous readers get nothing; the signed playlist carries its signature on ──
        assert.strictEqual((await runJob(priv)).status, 'succeeded');
        // The finished cut queued object.pack by itself; a durable provider is up now, so it packs.
        const autoPriv = await packJobs(priv);
        assert.strictEqual(autoPriv.length, 1, 'the private cut queues one object.pack');
        assert.ok(await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(autoPriv[0].id)).status)), 'the queued pack runs');
        const autoPrivDone = queue.jobPublic(await queue.get(autoPriv[0].id));
        assert.deepStrictEqual([autoPrivDone.status, autoPrivDone.result.packs], ['succeeded', 1], JSON.stringify(autoPrivDone));
        for (const p of ['master.m3u8', 'source/index.m3u8', 'source/init.mp4', 'source/000001.m4s']) assert.strictEqual((await get(`/o/${priv}/${p}`)).status, 404, `anonymous ${p}`);
        const dl = await call('GET', `/api/v2/live/objects/${priv}/download?format=json`);
        assert.strictEqual(dl.status, 200);
        const signed = new URL(dl.body.hls_url);
        assert.strictEqual(signed.pathname, `/o/${priv}/master.m3u8`);
        const sm = await get(signed.pathname + signed.search);
        assert.strictEqual(sm.status, 200);
        assert.strictEqual(sm.headers.get('cache-control'), 'private, no-store');
        assert.ok(sm.buf.toString().includes(`source/index.m3u8${signed.search}`), 'the variant URI is signed');
        const smedia = (await get(`/o/${priv}/source/index.m3u8${signed.search}`)).buf.toString();
        assert.ok(smedia.includes(`#EXT-X-MAP:URI="init.mp4${signed.search}"`) && smedia.includes(`000001.m4s${signed.search}`), smedia);
        assert.strictEqual((await get(`/o/${priv}/source/000001.m4s${signed.search}`)).status, 200);
        assert.strictEqual(sm.headers.get('access-control-allow-origin'), null, 'no CORS on a private playlist, as on GET /o/:id');
        const jpp = await runJob(priv, { target_seconds: 10 }, 'object.pack');
        assert.deepStrictEqual([jpp.status, jpp.result.packs], ['succeeded', 0], 'already packed by the cut: the rerun packs nothing');
        const privRows = await timeline.list(priv);
        assert.ok(privRows[1].packed_object_id);
        assert.strictEqual((await get(`/o/${priv}/source/000002.m4s`)).status, 404, 'a packed private segment needs the signature');
        assert.strictEqual((await get(`/o/${priv}/source/000002.m4s?exp=${signed.searchParams.get('exp')}&sig=${'0'.repeat(64)}`)).status, 404);
        const sseg = await get(`/o/${priv}/source/000002.m4s${signed.search}`);
        assert.deepStrictEqual([sseg.status, sha(sseg.buf), sseg.headers.get('access-control-allow-origin')], [200, privRows[2].sha256, null], 'signed: the packed bytes, no CORS');
        assert.strictEqual((await get(`/o/${priv}/master.m3u8?exp=${signed.searchParams.get('exp')}&sig=${'0'.repeat(64)}`)).status, 404, 'a forged signature');
        assert.strictEqual((await get(`/o/${pub}/master.m3u8${signed.search}`)).status, 200, 'a public object needs no signature');
        assert.strictEqual((await call('GET', `/api/v2/live/objects/${pub}/download?format=json`)).body.hls_url, `${config.publicUrl}/o/${pub}/master.m3u8`);

        // ── The shared discovery (objects/hls.js) the v1 VOD/clip shapes read answers exactly as /download does ──
        const hls = require('../server/objects/hls');
        assert.deepStrictEqual(await hls.discovery(pub), { hls_url: `${config.publicUrl}/o/${pub}/master.m3u8` }, 'an open object with a timeline: the plain master URL');
        const privHls = new URL((await hls.discovery(priv)).hls_url);
        assert.strictEqual(privHls.pathname, `/o/${priv}/master.m3u8`, 'a private object: the signed master URL');
        assert.ok(privHls.searchParams.get('exp') && privHls.searchParams.get('sig'), 'with a playlist token');
        assert.strictEqual(await hls.discovery('med_NOPE'), null, 'a missing object answers nothing');

        // ── A sandbox tenant's object: signed, never the plain URL — per-row and batched alike ──
        {
            await db.ensureProjectTenant('prj_hls_sandbox', 'sandbox', 1024 * 1024);
            const sb = await model.createObject({ app_id: 'prj_hls_sandbox-sandbox', visibility: 'public', lifecycle_status: 'ready', kind: 'file', mime_type: 'video/mp4', size_bytes: 1 });
            await timeline.replace(sb, 'source', [row(0, 0, 0, 500), row(1, 0, 3000, 30000)]);
            const plain = `${config.publicUrl}/o/${sb}/master.m3u8`;
            const signing = require('../server/objects/signing');
            const one = await hls.discovery(sb);
            const u = new URL(one.hls_url);
            assert.strictEqual(u.pathname, `/o/${sb}/master.m3u8`, 'the sandbox object\'s playlist URL names its master');
            assert.ok(u.searchParams.get('exp') && u.searchParams.get('sig'), 'a sandbox object is signed');
            assert.ok(signing.verifyPlaylist(sb, u.searchParams.get('exp'), u.searchParams.get('sig')), 'the signature verifies');
            assert.notStrictEqual(one.hls_url, plain, 'a sandbox object never gets the plain URL');
            assert.ok(one.hls_expires_at, 'and carries its expiry');
            const many = await hls.discoveryMany([{ object_id: sb }, { object_id: pub }]);
            assert.strictEqual(many.get(String(pub)).hls_url, `${config.publicUrl}/o/${pub}/master.m3u8`, 'the batch leaves a production object plain');
            const bu = new URL(many.get(String(sb)).hls_url);
            assert.ok(bu.searchParams.get('sig') && many.get(String(sb)).hls_url !== plain, 'and signs the sandbox object in the batch too');
            assert.ok(many.get(String(sb)).hls_expires_at, 'the batched sandbox answer carries its expiry');
        }

        // ── MEDIA_HLS_ENABLED off: the routes 404, the job is refused, the download answer is as before ──
        config.hls.enabled = false;
        assert.strictEqual((await get(`/o/${pub}/master.m3u8`)).status, 404);
        assert.strictEqual((await get(`/o/${pub}/source/000001.m4s`)).status, 404);
        const off = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.cmaf', object_id: pub } });
        assert.deepStrictEqual([off.status, off.body.code], [409, 'media.hls.disabled']);
        const offPack = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.pack', object_id: pub } });
        assert.deepStrictEqual([offPack.status, offPack.body.code], [409, 'media.hls.disabled']);
        assert.deepStrictEqual(Object.keys((await call('GET', `/api/v2/live/objects/${pub}/download?format=json`)).body).sort(), ['expires_at', 'public', 'url']);
        config.hls.enabled = true;

        // ── Deleted: 410; a held object keeps its segments through a purge, an unheld one loses them ──
        const pubPaths = rows.map((r) => r.local_path);
        await model.softDelete(await model.getObject(pub));
        assert.strictEqual((await get(`/o/${pub}/master.m3u8`)).status, 410);
        await model.softDelete(await model.getObject(priv));
        const hold = await model.placeHold({ object_id: priv, kind: 'admin', reason: 'test' });
        await model.purgeExpired({ retentionDays: 0 });
        assert.strictEqual(await timeline.has(pub), false, 'a purge removes the timeline');
        assert.ok(pubPaths.every((p) => !fs.existsSync(p)), 'and its segment files');
        assert.ok(!fs.existsSync(packed[1].local_path) && !blobs.has(`b2:${chunkKey}`) && !blobs.has(`b2:${packed[0].key}`), 'and its chunk, here and durable');
        assert.ok(blobs.has(`b2:${privRows[1].key}`), 'a held object keeps its durable chunk');
        assert.strictEqual(await timeline.has(priv), true, 'a held object keeps its timeline');
        assert.ok((await timeline.list(priv)).every((r) => fs.existsSync(r.local_path)));
        await model.releaseHold(hold.id);
        await model.purgeExpired({ retentionDays: 0 });
        assert.strictEqual(await timeline.has(priv), false);

        worker.stop();
        events._reset();
        server.close();
        stub.close();
        console.log('media-timeline: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
