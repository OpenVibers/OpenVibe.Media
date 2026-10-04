'use strict';
// Segment-native video, first slice (F3.1; docs/media-fabric.md §3): object.cmaf stream-copies a finished video into
// CMAF segments on its own keyframes and writes one media_timeline row per segment; the HLS playlists come from the
// rows (ENDLIST, the rows' durations); segmentAt answers the segment at an instant, at the boundaries too; a rerun is a
// no-op; a private object's playlist refuses an anonymous reader and its signed one carries the signature on; with
// MEDIA_HLS_ENABLED off nothing answers; a purge removes the segments unless the object is held.
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
    const stub = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
            res.statusCode = 404; res.end('{}');
        });
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
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
        assert.strictEqual(await timeline.removeObject('med_HAND'), 2);
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

        const runJob = async (objectId, params) => {
            const r = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.cmaf', object_id: objectId, ...(params && { params }) } });
            assert.strictEqual(r.status, 202, JSON.stringify(r.body));
            const fin = await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(r.body.job.id)).status));
            assert.ok(fin, `object.cmaf finishes: ${JSON.stringify(queue.jobPublic(await queue.get(r.body.job.id)))}`);
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
            assert.strictEqual(r.key, `${pub}/source/${r.name}`);
            assert.strictEqual(r.durability, 'local');
            assert.ok(r.local_path.startsWith(path.join(path.resolve(process.env.OBJECTS_PATH), '.timeline', 'live', pub, 'source')));
        }
        assert.strictEqual(JSON.stringify([await model.getObject(pub), await model.listLocations(pub)]), before, 'the source is untouched');
        assert.strictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.jobs')).length, 0, 'the work directory is removed');

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
        const probe = await new Promise((resolve) => {
            const p = spawn('ffprobe', ['-v', 'error', '-rw_timeout', '10000000', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${api}/o/${pub}/master.m3u8`]);
            let out = '';
            p.stdout.on('data', (d) => { out += d; });
            p.stderr.on('data', (d) => { out += d; });
            p.on('close', () => resolve(out.trim()));
        });
        assert.ok(Math.abs(Number(probe) - 7) < 0.2, `ffprobe reads the playlist: ${probe}`);

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

        // ── The job's abort signal: nothing written, the work directory removed ──
        const cmaf = require('../server/jobs/cmaf');
        const ac = new AbortController();
        ac.abort(new Error('cancelled in test'));
        await assert.rejects(cmaf.spec.run({ id: 'mjob_ABORTED', app_id: 'live', object_id: priv, params: {} }, { signal: ac.signal }), /cancelled in test/);
        assert.strictEqual(await timeline.has(priv), false);
        assert.strictEqual(fs.existsSync(path.join(process.env.OBJECTS_PATH, '.jobs', 'mjob_ABORTED')), false);

        // ── A private object: anonymous readers get nothing; the signed playlist carries its signature on ──
        assert.strictEqual((await runJob(priv)).status, 'succeeded');
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
        assert.strictEqual((await get(`/o/${priv}/master.m3u8?exp=${signed.searchParams.get('exp')}&sig=${'0'.repeat(64)}`)).status, 404, 'a forged signature');
        assert.strictEqual((await get(`/o/${pub}/master.m3u8${signed.search}`)).status, 200, 'a public object needs no signature');
        assert.strictEqual((await call('GET', `/api/v2/live/objects/${pub}/download?format=json`)).body.hls_url, `${config.publicUrl}/o/${pub}/master.m3u8`);

        // ── MEDIA_HLS_ENABLED off: the routes 404, the job is refused, the download answer is as before ──
        config.hls.enabled = false;
        assert.strictEqual((await get(`/o/${pub}/master.m3u8`)).status, 404);
        assert.strictEqual((await get(`/o/${pub}/source/000001.m4s`)).status, 404);
        const off = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.cmaf', object_id: pub } });
        assert.deepStrictEqual([off.status, off.body.code], [409, 'media.hls.disabled']);
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
