'use strict';
// On-demand renditions, F4 slice 1 (docs/media-fabric.md §5): a ready media object's master playlist lists the
// renditions that exist and queues the missing ones lazily — one rendition.create job per object and rendition,
// deduped while it is active and answered by its idempotency key afterwards. The job transcodes one 720p H.264/AAC
// rung (libx264) into media_timeline through the same content-addressed rows and two-phase commit as object.cmaf, with
// the source timeline's segment boundaries forced as keyframes; the master playlist then lists source + 720p with each
// variant's own BANDWIDTH and /o/:id/720p/… serves it. A source already 720p or smaller is skipped; an object under a
// hold is left alone; with MEDIA_RENDITIONS or MEDIA_HLS_ENABLED off nothing is cut or listed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-rendition-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_JOBS_POLL_MS = '50';
    process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';
    process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';
    process.env.MEDIA_HLS_ENABLED = '1';
    process.env.MEDIA_RENDITIONS = '1';
    for (const p of ['B2', 'R2']) for (const k of ['ENDPOINT', 'BUCKET', 'KEY_ID', 'APP_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) process.env[`MEDIA_${p}_${k}`] = '';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
    const hasX264 = hasFfmpeg && /libx264/.test(String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout));

    (async () => {
        const config = require('../server/config');
        assert.strictEqual(config.hls.enabled, true);
        assert.strictEqual(config.hls.renditions, true);
        const types = require('../server/jobs/types');
        assert.ok(types.names().includes('rendition.create'), 'rendition.create is registered');
        assert.strictEqual(require('../server/jobs/queue').typeSpec('rendition.create').lane, 'heavy');
        assert.deepStrictEqual(require('../server/jobs/rendition').renditionNames(), ['720p'], 'this slice ships one rung');
        console.log('✅ rendition.create is registered on the heavy lane; MEDIA_RENDITIONS reads true');

        if (!hasFfmpeg || !hasX264) { console.log('rendition job: skipped (ffmpeg/libx264 not found)'); process.exit(0); }

        const db = require('../server/db/database');
        await db.upsertApp({ app_id: 'live', api_key: 'live-key-rendition' });
        const model = require('../server/objects/model');
        const timeline = require('../server/objects/timeline');
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
            const res = await fetch(api + p, { method, headers: { authorization: 'Bearer live-key-rendition', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        const get = async (url, headers = {}) => {
            const res = await fetch(url.startsWith('http') ? url : api + url, { headers, redirect: 'manual' });
            return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
        };
        // The worker is never started: lazily queued jobs stay queued until this runs one directly.
        const runJob = async (type, objectId, params) => {
            const r = await call('POST', '/api/v2/live/jobs', { body: { type, object_id: objectId, ...(params && { params }) } });
            assert.strictEqual(r.status, 202, JSON.stringify(r.body));
            assert.ok(await worker.runNow(r.body.job.id), `${type} runs`);
            return queue.jobPublic(await queue.get(r.body.job.id));
        };
        const rendJobs = async (objectId) => await db.all('SELECT * FROM media_jobs WHERE job_type = ? AND object_id = ?', ['rendition.create', objectId]);

        // A 6 s, 1280x800, 10 fps source with keyframes every 1.5 s: cuts at 3.0, 4.5, 6.0 for a 2 s target.
        const srcFile = path.join(process.env.VOD_PATH, 'src.mp4');
        const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=1280x800:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-shortest', srcFile]);
        assert.strictEqual(mk.status, 0, String(mk.stderr));
        const media = async (file, visibility = 'public', metadata = {}) => {
            const id = await model.createObject({ app_id: 'live', owner_user_id: 5, visibility, lifecycle_status: 'ready', kind: 'file', mime_type: 'video/mp4', size_bytes: fs.statSync(file).size, metadata: { duration_seconds: 6, ...metadata } });
            await model.upsertLocation(id, { provider: 'local', key: file, state: 'present', size_bytes: fs.statSync(file).size, verified: true });
            return id;
        };
        const pub = await media(srcFile);

        // The source timeline, cut by a real object.cmaf (stream copy): 0-3000, 3000-4500, 4500-6000 ms.
        const cmaf = await runJob('object.cmaf', pub, { segment_seconds: 2 });
        assert.strictEqual(cmaf.status, 'succeeded', JSON.stringify(cmaf.error));
        const srcRows = await timeline.segments(pub, 'source');
        assert.deepStrictEqual(srcRows.map((r) => [Number(r.start_ms), Number(r.end_ms)]), [[0, 3000], [3000, 4500], [4500, 6000]], 'the source cut on its keyframes');
        const sourceMaster = (await get(`/o/${pub}/master.m3u8`)).buf.toString();
        assert.ok(!sourceMaster.includes('720p/index.m3u8'), 'no 720p rows yet: the master playlist lists source only');
        assert.strictEqual((await get(`/o/${pub}/720p/index.m3u8`)).status, 404, 'and the rendition has nothing to serve');
        console.log('✅ a source timeline exists; the master playlist lists source only until a rendition does');

        // ── Lazy: asking for the master playlist queues exactly one rendition.create; a second request joins it ──
        const m1 = await get(`/o/${pub}/master.m3u8`);
        assert.strictEqual(m1.status, 200);
        let jobs = await rendJobs(pub);
        assert.strictEqual(jobs.length, 1, 'the first master playlist request queues one rendition.create');
        assert.deepStrictEqual([jobs[0].status, jobs[0].created_by, jobs[0].idempotency_key, JSON.parse(jobs[0].params).rendition],
            ['queued', 'system:rendition', `rendition.create:${pub}:720p`, '720p']);
        await get(`/o/${pub}/master.m3u8`);
        jobs = await rendJobs(pub);
        assert.strictEqual(jobs.length, 1, 'a second request joins the active job');
        // The route throttles per process; the queue itself joins an active job and replays on its key.
        const { queueRendition } = require('../server/objects/timeline-queue');
        assert.strictEqual(await queueRendition('live', pub), jobs[0].id, 'queueRendition answers the one active job');
        assert.strictEqual((await rendJobs(pub)).length, 1, 'and does not duplicate it');
        assert.ok(!(await get(`/o/${pub}/master.m3u8`)).buf.toString().includes('720p/index.m3u8'), 'still not listed while the job is queued');
        console.log('✅ the master playlist queues one rendition.create lazily; a second request joins it');

        // ── The job: 720p rows land, contiguous, content-addressed, bytes on this node ──
        const done = queue.jobPublic(await worker.runNow(jobs[0].id));
        assert.strictEqual(done.status, 'succeeded', JSON.stringify(done.error));
        assert.deepStrictEqual([done.result.rendition, done.result.target_height, done.result.segments, done.result.skipped], ['720p', 720, 3, false], JSON.stringify(done.result));
        const rows = await timeline.list(pub, '720p');
        assert.deepStrictEqual(rows.map((r) => Number(r.seq)), [0, 1, 2, 3]);
        assert.deepStrictEqual(rows.map((r) => r.name), ['init.mp4', '000001.m4s', '000002.m4s', '000003.m4s']);
        const segs = rows.slice(1);
        assert.deepStrictEqual(segs.map((r) => [Number(r.start_ms), Number(r.end_ms)]), [[0, 3000], [3000, 4500], [4500, 6000]], 'the rung is cut on the source boundaries it forced');
        for (const r of rows) {
            assert.strictEqual(sha(fs.readFileSync(r.local_path)), r.sha256, `${r.name} sha256`);
            assert.strictEqual(r.key, `${pub}/720p/${r.sha256.slice(0, 12)}/${r.name}`, 'the key is that rendition\'s, versioned by the sha');
            assert.strictEqual(r.durability, 'local', 'no durable provider configured here');
            assert.ok(r.local_path.startsWith(path.join(path.resolve(process.env.OBJECTS_PATH), '.timeline', 'live', pub, '720p')), r.local_path);
        }
        assert.ok(segs.every((r) => Number(r.byte_length) > 0));
        assert.strictEqual(JSON.stringify(await timeline.segments(pub, 'source')), JSON.stringify(srcRows), 'the source timeline is untouched');
        assert.strictEqual(fs.readdirSync(path.join(process.env.OBJECTS_PATH, '.jobs')).length, 0, 'the work directory is removed');
        console.log('✅ the job lands 720p rows with the produced bytes, times and sha256; the source is untouched');

        // ── The master playlist now lists source + 720p, each with its own BANDWIDTH, and the variant plays ──
        const master = (await get(`/o/${pub}/master.m3u8`)).buf.toString();
        assert.ok(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+\nsource\/index\.m3u8\n/.test(master), master);
        assert.ok(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+\n720p\/index\.m3u8\n/.test(master), master);
        const bw = [...master.matchAll(/#EXT-X-STREAM-INF:BANDWIDTH=(\d+)/g)].map((m) => Number(m[1]));
        assert.strictEqual(bw.length, 2, 'one variant per rendition whose rows exist');
        const media720 = (await get(`/o/${pub}/720p/index.m3u8`)).buf.toString();
        assert.ok(media720.includes('#EXT-X-PLAYLIST-TYPE:VOD') && media720.trim().endsWith('#EXT-X-ENDLIST') && media720.includes('000001.m4s'), media720);
        const bw720 = Number(/#EXT-X-STREAM-INF:BANDWIDTH=(\d+),AVERAGE-BANDWIDTH=\d+\n720p/.exec(master)[1]);
        assert.strictEqual(bw720, Math.max(...segs.map((r) => Math.ceil(Number(r.byte_length) * 8 * 1000 / Math.max(1, Number(r.end_ms) - Number(r.start_ms))))), 'the 720p BANDWIDTH is its own segments\' peak');
        for (const r of rows) {
            const s = await get(`/o/${pub}/720p/${r.name}`);
            assert.deepStrictEqual([s.status, sha(s.buf)], [200, r.sha256], `${r.name} served`);
        }
        assert.strictEqual((await get(`/o/${pub}/720p/000009.m4s`)).status, 404);
        assert.strictEqual((await get(`/o/${pub}/720p/..%2Findex.m3u8`)).status, 404);
        // A real HLS reader sees 720p, with the source's duration (the playlist is the master, so ffprobe takes a variant).
        const probed = await new Promise((resolve) => {
            const p = spawn('ffprobe', ['-v', 'error', '-rw_timeout', '10000000', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', `${api}/o/${pub}/720p/index.m3u8`]);
            let out = '';
            let err = '';
            p.stdout.on('data', (d) => { out += d; });
            p.stderr.on('data', (d) => { err += d; });
            p.on('close', () => resolve(`${out.trim()}${err ? ` (${err.trim()})` : ''}`));
        });
        const heights = probed.split(/\s+/).filter(Boolean).map(Number);
        assert.ok(heights.length && heights.every((h) => h === 720), `the produced rendition is 720p: ${JSON.stringify(probed)}`);
        assert.ok(bw.every((x) => x > 0), 'both variants carry a bitrate');
        console.log('✅ the master playlist lists source + 720p with per-variant BANDWIDTH; /o/:id/720p/… plays');

        // ── Idempotent: a rerun finds the rows and re-encodes nothing ──
        const mtimes = rows.map((r) => fs.statSync(r.local_path).mtimeMs);
        const again = await runJob('rendition.create', pub, { rendition: '720p' });
        assert.deepStrictEqual([again.status, again.result.already, again.result.segments], ['succeeded', true, 3], JSON.stringify(again.result));
        assert.deepStrictEqual(rows.map((r) => fs.statSync(r.local_path).mtimeMs), mtimes, 'no segment re-encoded');

        // ── A source already 720p or smaller is not upscaled ──
        const smallFile = path.join(process.env.VOD_PATH, 'small.mp4');
        const mkSmall = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10', smallFile]);
        assert.strictEqual(mkSmall.status, 0, String(mkSmall.stderr));
        const small = await media(smallFile, 'public', { duration_seconds: 2 });
        const skip = await runJob('rendition.create', small, {});
        assert.deepStrictEqual([skip.status, skip.result.skipped], ['succeeded', true], JSON.stringify(skip.result));
        assert.strictEqual(await timeline.has(small, '720p'), false, 'nothing is written for a source at or below the rung');
        console.log('✅ a source at or below 720p is skipped, with no rows');

        // ── A held object is left alone (retried, not cut) ──
        const held = await media(srcFile, 'public', { duration_seconds: 6 });
        const hold = await model.placeHold({ object_id: held, kind: 'admin', reason: 'rendition test' });
        const hj = await runJob('rendition.create', held, {});
        assert.deepStrictEqual([hj.status, hj.error_code], ['queued', 'media.object.held'], JSON.stringify(hj));
        assert.strictEqual(await timeline.has(held, '720p'), false, 'no rows on a held object');
        await model.releaseHold(hold.id);

        // ── MEDIA_RENDITIONS off: nothing is queued or cut; the job is refused ──
        const off = await media(srcFile, 'public', { duration_seconds: 6 });
        await runJob('object.cmaf', off, { segment_seconds: 2 });
        config.hls.renditions = false;
        assert.strictEqual((await get(`/o/${off}/master.m3u8`)).status, 200, 'the master playlist still serves the source timeline');
        assert.ok(!(await get(`/o/${off}/master.m3u8`)).buf.toString().includes('720p/index.m3u8'), 'no rendition is listed');
        const offJob = await call('POST', '/api/v2/live/jobs', { body: { type: 'rendition.create', object_id: off, params: { rendition: '720p' } } });
        assert.deepStrictEqual([offJob.status, offJob.body.code], [409, 'media.renditions.disabled'], JSON.stringify(offJob.body));
        assert.strictEqual((await rendJobs(off)).length, 0, 'nothing queued with the flag off');
        assert.strictEqual((await get(`/o/${off}/720p/index.m3u8`)).status, 404, 'and the rendition route has nothing');
        config.hls.renditions = true;
        console.log('✅ MEDIA_RENDITIONS off: no rendition queued, cut or listed; the job is refused 409');

        // ── MEDIA_HLS_ENABLED off: the routes 404 and the job is refused as before ──
        config.hls.enabled = false;
        assert.strictEqual((await get(`/o/${pub}/master.m3u8`)).status, 404);
        assert.strictEqual((await get(`/o/${pub}/720p/index.m3u8`)).status, 404);
        const hlsOff = await call('POST', '/api/v2/live/jobs', { body: { type: 'rendition.create', object_id: pub, params: { rendition: '720p' } } });
        assert.deepStrictEqual([hlsOff.status, hlsOff.body.code], [409, 'media.hls.disabled']);
        config.hls.enabled = true;

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('rendition job: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
