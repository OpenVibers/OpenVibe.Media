'use strict';
// Materialized clips over the source's bytes (F3.6; docs/materialized-clips.md). A clip over a source that has a
// source-rendition timeline, with MEDIA_HLS_ENABLED + MEDIA_MATERIALIZED_CLIPS, gets its own persisted media_timeline
// rows: the interior segments copy the source's rows — packed chunk ranges included, no bytes written — and only the
// two window edges are re-encoded from the source segment's bytes into fMP4 with their own inits (init-head.mp4 /
// init-tail.mp4 on negative seq). The playlist switches init with #EXT-X-DISCONTINUITY + #EXT-X-MAP; the segment route
// serves every init row as video/mp4; sprites decode each piece with its own init; readiness and the verify job treat
// the clip as virtual; download?format=mp4 answers the playlist; deleting the clip removes its own rows/edge bytes and
// keeps every location the source still names; a source removal racing the insert aborts the insert (or, committed
// first, keeps the bytes the clip names); a source without a timeline, or the flag off, still gets the full re-encode.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-matclip-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
        MEDIA_JOBS_POLL_MS: '50', MEDIA_INVARIANT_SCAN_HOURS: '0', MEDIA_UPLOAD_MIN_FREE_MB: '0',
        MEDIA_HLS_ENABLED: '1', MEDIA_MATERIALIZED_CLIPS: '1',
    });
    for (const p of ['B2', 'R2']) for (const k of ['ENDPOINT', 'BUCKET', 'KEY_ID', 'APP_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) process.env[`MEDIA_${p}_${k}`] = '';

    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
    const hasX264 = hasFfmpeg && /libx264/.test(String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout));

    (async () => {
        const config = require('../server/config');
        assert.strictEqual(config.hls.enabled, true);
        assert.strictEqual(config.hls.materialized, true, 'MEDIA_MATERIALIZED_CLIPS reads true');
        const db = require('../server/db/database');
        const timeline = require('../server/objects/timeline');
        const model = require('../server/objects/model');
        const mat = require('../server/vod/clip-materialize');
        const previews = require('../server/jobs/previews');

        // ── planWindow: edges over the source's media segments, the 100 ms boundary rule, the empty window ──
        const hrow = (seq, start, end, extra = {}) => ({ seq, name: timeline.segmentName(seq), start_ms: start, end_ms: end, keyframe_ms: seq ? start : null,
            key: `s/source/${timeline.segmentName(seq)}`, local_path: null, durable_provider: null, packed_object_id: null, byte_offset: null,
            byte_length: 1000, sha256: 'a'.repeat(64), durability: 'local', init_name: null, ...extra });
        const hand = [hrow(0, 0, 0), hrow(1, 0, 3000), hrow(2, 3000, 4500), hrow(3, 4500, 6000), hrow(4, 6000, 9000)];
        const kinds = (p) => p.pieces.map((x) => x.kind);
        {
            const p = mat.planWindow(hand, 3101, 7899);
            assert.deepStrictEqual(kinds(p), ['head', 'copy', 'tail'], 'a window cutting both ends re-encodes exactly the two edges');
            assert.deepStrictEqual([p.pieces[0].start_ms, p.pieces[0].end_ms, p.pieces[0].init], [3101, 4500, timeline.HEAD_INIT]);
            assert.strictEqual(Number(p.pieces[1].source.seq), 3, 'the interior piece is the source segment wholly inside the window, copied');
            assert.deepStrictEqual([p.pieces[2].start_ms, p.pieces[2].end_ms, p.pieces[2].init], [6000, 7899, timeline.TAIL_INIT]);
            assert.strictEqual(p.originMs, 3101);
            assert.strictEqual(p.durationMs, 7899 - 3101, 'the source segment holding the end is cut at the request');
            assert.deepStrictEqual(p.sourceRows.map((r) => Number(r.seq)), [0, 3], 'the pin names the seq 0 init and every copied segment (not the re-encoded edges)');
        }
        {
            const p = mat.planWindow(hand, 3000, 5900);
            assert.deepStrictEqual(kinds(p), ['copy', 'copy'], 'both edges within 100 ms of a boundary: nothing is re-encoded');
            assert.strictEqual(p.originMs, 3000, 'the clip starts on the boundary');
            assert.strictEqual(p.durationMs, 3000, 'and ends on the boundary (the snap is < 100 ms each side)');
        }
        assert.deepStrictEqual(kinds(mat.planWindow(hand, 3000, 5899)), ['copy', 'tail'], 'only the end cuts');
        assert.deepStrictEqual(kinds(mat.planWindow(hand, 3101, 6000)), ['head', 'copy'], 'only the start cuts');
        {
            const p = mat.planWindow(hand, 3200, 4300);
            assert.deepStrictEqual(kinds(p), ['head'], 'a window inside one segment is re-encoded once, as the head edge');
            assert.deepStrictEqual([p.pieces[0].start_ms, p.pieces[0].end_ms], [3200, 4300]);
            assert.deepStrictEqual(p.sourceRows, [], 'no copied row, so nothing to pin');
            assert.strictEqual(mat.planWindow([], 0, 1000), null);
            assert.strictEqual(mat.planWindow(hand, 3000, 3000), null, 'a zero-length window plans nothing');
            assert.strictEqual(mat.planWindow(hand, 9000, 12000), null, 'a window past the timeline plans nothing');
        }
        {
            // The exact rule is "more than 100 ms": 101 cuts, 100 snaps, and a window inside one segment is one piece.
            const p = mat.planWindow(hand, 3101, 4399);
            assert.deepStrictEqual([kinds(p), p.pieces[0].start_ms, p.pieces[0].end_ms, p.pieces[0].init],
                [['head'], 3101, 4399, timeline.HEAD_INIT], 'both edges inside one segment: re-encoded once, as the head edge');
            assert.deepStrictEqual(kinds(mat.planWindow(hand, 3100, 4400)), ['copy'], 'exactly 100 ms inside a boundary snaps to it');
            assert.deepStrictEqual(kinds(mat.planWindow(hand, 3100, 6000)), ['copy', 'copy'], 'and the boundary itself never cuts');
        }
        console.log('✅ planWindow: head/interior/tail, the 100 ms rule, same-segment windows, empty windows');

        // ── mediaPlaylist: byte-for-byte unchanged without edge inits; discontinuity + fresh map with them ──
        {
            const frozen = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:1',
                '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"',
                '#EXTINF:3.000,', '000001.m4s', '#EXTINF:1.500,', '000002.m4s', '#EXT-X-ENDLIST', ''].join('\n');
            assert.strictEqual(timeline.mediaPlaylist([hrow(0, 0, 0), hrow(1, 0, 3000), hrow(2, 3000, 4500)]), frozen,
                'a playlist with no edge inits is byte for byte what it always was');
            const edge = [
                { ...hrow(-2, 0, 0), name: 'init-tail.mp4' }, { ...hrow(-1, 0, 0), name: 'init-head.mp4' }, hrow(0, 0, 0),
                hrow(1, 0, 1000, { init_name: 'init-head.mp4' }), hrow(2, 1000, 3000), hrow(3, 3000, 4000, { init_name: 'init-tail.mp4' }),
            ];
            const pl = timeline.mediaPlaylist(edge);
            const events = [];
            for (const line of pl.split('\n')) {
                if (line === '#EXT-X-DISCONTINUITY') events.push('disc');
                const m = /^#EXT-X-MAP:URI="([^"]+)"/.exec(line);
                if (m) events.push(`map ${m[1]}`);
            }
            assert.deepStrictEqual(events, ['map init-head.mp4', 'disc', 'map init.mp4', 'disc', 'map init-tail.mp4'], pl);
            assert.strictEqual((pl.match(/#EXT-X-DISCONTINUITY/g) || []).length, 2, 'exactly two discontinuities');
            assert.strictEqual((pl.match(/#EXTINF:/g) || []).length, 3, 'every segment is listed once');
        }
        console.log('✅ mediaPlaylist: byte-for-byte without edge inits; two discontinuities with the right maps with them');

        // ── clipRows refuses a virtual clip over a materialized one (the simplest correct choice) ──
        {
            assert.deepStrictEqual(timeline.clipRows([
                { ...hrow(-1, 0, 0), name: 'init-head.mp4' }, hrow(0, 0, 0), hrow(1, 0, 3000, { init_name: 'init-head.mp4' }),
            ], 0, 3000), [], 'a source with edge inits is refused');
            assert.deepStrictEqual(timeline.clipRows([hrow(0, 0, 0), hrow(1, 0, 3000)], 0, 3000).map((r) => Number(r.seq)), [0, 1],
                'a copy-only clip (edges on boundaries) still builds a virtual one');
        }

        // ── replace() drops negative-seq rows a new plan does not carry; the CHECK admits only the two edge init names ──
        {
            const edgeInit = { ...hrow(-1, 0, 0), name: 'init-head.mp4', key: 'c/source/init-head.mp4' };
            assert.deepStrictEqual((await timeline.replace('mat-replace', 'source', [hrow(0, 0, 0), hrow(1, 0, 3000), edgeInit])).inserted, 3);
            assert.deepStrictEqual((await timeline.list('mat-replace')).map((r) => Number(r.seq)), [-1, 0, 1]);
            assert.strictEqual((await timeline.replace('mat-replace', 'source', [hrow(0, 0, 0), hrow(1, 0, 3000)])).removed, 1,
                'a replace that carries no edge init drops it');
            assert.deepStrictEqual((await timeline.list('mat-replace')).map((r) => Number(r.seq)), [0, 1]);
            assert.ok((await timeline.list('mat-replace')).every((r) => r.init_name == null), 'init_name defaults NULL');
            await timeline.removeObject('mat-replace');
            await assert.rejects(db.run(`INSERT INTO media_timeline (object_id, rendition, seq, name, start_ms, end_ms, key, byte_length, sha256)
                    VALUES ('mat-bad', 'source', -3, '000003.m4s', 0, 0, 'k', 1, 'x')`), /check|constraint/i, 'a negative seq outside the edge inits is rejected');
            await assert.rejects(db.run(`INSERT INTO media_timeline (object_id, rendition, seq, name, start_ms, end_ms, key, byte_length, sha256)
                    VALUES ('mat-bad', 'source', -1, 'evil.mp4', 0, 0, 'k', 1, 'x')`), /check|constraint/i, 'a negative seq not named an edge init is rejected');
            // Re-applying the migration is a no-op (as migration 0003's test does; only on PGlite, where the runner is the owner).
            if (process.env.MEDIA_TEST_STORE !== 'pg') await db.getDb().query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0005_materialized_clips.sql'), 'utf8'));
        }
        console.log('✅ migration 0005 / replace: edge init rows admitted, dropped when unnamed, never beyond the two names');

        // ── The sprite job picks each segment's init by init_name, falling back to seq 0 ──
        {
            const rows = [
                { seq: -1, name: 'init-head.mp4' }, { seq: -2, name: 'init-tail.mp4' }, { seq: 0, name: 'init.mp4' },
                { seq: 1, name: '000001.m4s', init_name: 'init-head.mp4' }, { seq: 2, name: '000002.m4s', init_name: null }, { seq: 3, name: '000003.m4s', init_name: 'init-tail.mp4' },
            ];
            assert.strictEqual(previews.initRowFor(rows, rows[3]).name, 'init-head.mp4', 'a head edge decodes with init-head');
            assert.strictEqual(previews.initRowFor(rows, rows[4]).name, 'init.mp4', 'a NULL init_name falls back to seq 0');
            assert.strictEqual(previews.initRowFor(rows, rows[5]).name, 'init-tail.mp4', 'a tail edge decodes with init-tail');
            assert.strictEqual(previews.initRowFor([{ seq: 1, name: '000001.m4s', init_name: null }], { seq: 1, name: '000001.m4s', init_name: null }), null, 'no init row at all → null');
        }

        // ── The pin: a source removal or a moved location between plan and pin aborts; committed first, it keeps bytes ──
        const seedSource = async (id) => {
            const obj = { app_id: 'live', id };
            const payloads = [Buffer.from('init-bytes'), Buffer.from('segment-one-bytes-'), Buffer.from('segment-two-bytes--'), Buffer.from('segment-three-bytes')];
            const rows = [];
            for (let seq = 0; seq < payloads.length; seq++) {
                const bytes = payloads[seq];
                const s = sha(bytes);
                const name = timeline.segmentName(seq);
                const key = timeline.keyFor(id, 'source', name, s.slice(0, 12));
                const local = timeline.localPathFor(obj, 'source', name, s.slice(0, 12));
                fs.mkdirSync(path.dirname(local), { recursive: true });
                fs.writeFileSync(local, bytes);
                const r = { seq, name, start_ms: seq ? (seq - 1) * 3000 : 0, end_ms: seq * 3000, keyframe_ms: seq ? (seq - 1) * 3000 : null,
                    key, local_path: local, durable_provider: null, packed_object_id: null, byte_offset: null, byte_length: bytes.length, sha256: s, durability: 'local', init_name: null };
                await db.run(`INSERT INTO media_timeline (object_id, rendition, seq, ${timeline.FIELDS.join(', ')})
                        VALUES (?, ?, ?, ${timeline.FIELDS.map(() => '?').join(', ')})`, [id, 'source', seq, ...timeline.FIELDS.map((f) => r[f] ?? null)]);
                rows.push(r);
            }
            return rows;
        };
        const copyRow = (source, seq, originMs) => {
            const row = { seq };
            for (const f of timeline.FIELDS) row[f] = source[f] == null ? null : source[f];
            row.name = timeline.segmentName(seq);
            row.start_ms = Number(source.start_ms) - originMs;
            row.end_ms = Number(source.end_ms) - originMs;
            row.keyframe_ms = source.keyframe_ms == null ? null : Number(source.keyframe_ms) - originMs;
            row.init_name = null;
            return row;
        };
        const planRows = (plan) => {
            const out = [];
            for (const [i, p] of plan.pieces.entries()) if (p.kind === 'copy') out.push(copyRow(p.source, i + 1, plan.originMs));
            if (plan.pieces.some((p) => p.kind === 'copy') && plan.sourceInit) {
                const r = copyRow(plan.sourceInit, 0, 0);
                r.name = timeline.INIT_NAME; r.start_ms = 0; r.end_ms = 0; r.keyframe_ms = null;
                out.push(r);
            }
            return out;
        };
        {
            const srcA = await seedSource('mat-race-A');
            const planA = mat.planWindow(srcA, 3000, 6000);
            assert.deepStrictEqual(planA.pieces.map((p) => p.kind), ['copy'], 'the race window is interior-only');
            const rowsA = planRows(planA);
            await timeline.removeObject('mat-race-A');
            await assert.rejects(mat.pinRows({ clipObjectId: 'mat-clip-A', sourceObjectId: 'mat-race-A', rows: rowsA, sourceRows: planA.sourceRows, jobId: 'mjob_RACEA' }),
                (err) => err.code === 'media.timeline.changed' && err.retryAfterS > 0, 'a source removed between plan and pin aborts the insert, retryably');
            assert.strictEqual((await timeline.list('mat-clip-A')).length, 0, 'nothing was inserted');

            const srcB = await seedSource('mat-race-B');
            const planB = mat.planWindow(srcB, 3000, 6000);
            const rowsB = planRows(planB);
            // A pack commits first: the planned row now names a chunk range (a moved location, same sha).
            await db.run(`UPDATE media_timeline SET key = 'mat-race-B/source/chunk', packed_object_id = ?, byte_offset = 0 WHERE object_id = 'mat-race-B' AND seq = 2`, ['c'.repeat(64)]);
            await assert.rejects(mat.pinRows({ clipObjectId: 'mat-clip-B', sourceObjectId: 'mat-race-B', rows: rowsB, sourceRows: planB.sourceRows, jobId: 'mjob_RACEB' }),
                (err) => err.code === 'media.timeline.changed', 'a pack between plan and pin aborts the insert');
            assert.strictEqual((await timeline.list('mat-clip-B')).length, 0, 'nothing was inserted');
            await timeline.removeObject('mat-race-B');

            // Committed first, then the source removed: the clip keeps its rows and the bytes it names.
            const srcC = await seedSource('mat-race-C');
            const planC = mat.planWindow(srcC, 0, 6000);
            const rowsC = planRows(planC);
            await mat.pinRows({ clipObjectId: 'mat-clip-C', sourceObjectId: 'mat-race-C', rows: rowsC, sourceRows: planC.sourceRows, jobId: 'mjob_RACEC' });
            assert.deepStrictEqual((await timeline.list('mat-clip-C')).map((r) => Number(r.seq)), [0, 1, 2], 'the clip committed its rows');
            const inWindow = srcC.filter((r) => Number(r.seq) <= 2).map((r) => r.local_path);   // the init and the copied segments
            const outside = srcC.filter((r) => Number(r.seq) === 3).map((r) => r.local_path);   // not named by the clip
            assert.ok(inWindow.concat(outside).every((f) => fs.existsSync(f)));
            await timeline.removeObject('mat-race-C');
            assert.strictEqual((await timeline.list('mat-race-C')).length, 0, 'the source rows are gone');
            assert.ok(inWindow.every((f) => fs.existsSync(f)), 'the locations the clip still names are kept');
            assert.ok(outside.every((f) => !fs.existsSync(f)), 'the locations no row names go with the source');
            assert.ok(timeline.mediaPlaylist(await timeline.list('mat-clip-C')).includes('000002.m4s'), 'and the clip still writes its playlist from them');
            await timeline.removeObject('mat-clip-C');
            assert.ok(inWindow.every((f) => !fs.existsSync(f)), 'the last naming object deletes them');
        }
        console.log('✅ pin: a source removal or a pack between plan and pin aborts retryably; committed first, the bytes stay');

        if (!hasFfmpeg || !hasX264) { console.log('materialized clips: pure checks passed; ffmpeg/libx264 sections skipped (not found)'); process.exit(0); }

        // ── The ffmpeg path: a window over a packed source — two edges re-encoded, interior referenced ──
        const blobStore = new Map();
        const vodStorage = require('../server/vod/vod-storage');
        Object.assign(vodStorage, {
            providerConfigured: (p) => ['b2', 'r2'].includes(p),
            providerAvailable: (p) => ['b2', 'r2'].includes(p),
            uploadFile: async (p, key, file) => { blobStore.set(`${p}:${key}`, fs.readFileSync(file)); },
            sha256Object: async (p, key) => (blobStore.has(`${p}:${key}`) ? { sha256: sha(blobStore.get(`${p}:${key}`)), size: blobStore.get(`${p}:${key}`).length } : null),
            deleteObject: async (p, key) => { blobStore.delete(`${p}:${key}`); return true; },
            presignGet: async () => null,
        });
        timeline.durableProvider = async () => 'b2';   // the placement router's choice, stubbed as the provider is

        const stub = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                res.setHeader('Content-Type', 'application/json');
                if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
                res.statusCode = 404; res.end('{}');
            });
        });
        await new Promise((r) => stub.listen(0, '127.0.0.1', r));
        const events = require('../server/events');
        events.init({ eventsUrl: `http://127.0.0.1:${stub.address().port}`, clientSecret: 's', networkUrl: `http://127.0.0.1:${stub.address().port}`, intervalMs: 60000 });
        await db.upsertApp({ app_id: 'live', api_key: 'live-key-mat' });
        require('../server/thumbnails/thumbnail-service').generateClipThumbnail = async () => null;
        const queue = require('../server/jobs/queue');
        const worker = require('../server/jobs/worker');
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/api/v1/:app/vods', require('../server/vod/routes'));
        app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
        app.use('/api/v2/:app/objects', require('../server/objects/routes'));
        app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
        app.use('/o', require('../server/objects/routes').publicRouter);
        app.use('/', require('../server/public/routes'));
        const server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const api = `http://127.0.0.1:${server.address().port}`;
        const auth = { authorization: 'Bearer live-key-mat' };
        const call = async (method, p, body) => {
            const headers = { ...auth };
            if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
            const res = await fetch(api + p, { method, headers, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body, redirect: 'manual' });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        const get = async (url, headers = {}) => {
            const u = new URL(url, api);
            const res = await fetch(api + u.pathname + u.search, { headers, redirect: 'manual' });
            return { status: res.status, location: res.headers.get('location'), headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
        };
        const signal = () => new AbortController().signal;
        // Duplicate-window detection matches a recent clip within 8 s (start) / 10 s (end): age the rows first,
        // as the other clip tests do, so each create below really creates.
        const freshClip = async (body) => { await db.run("UPDATE clips SET created_at = '2000-01-01 00:00:00'"); return await call('POST', '/api/v1/live/clips', body); };
        const runClip = async (jobId) => { assert.ok(await worker.runNow(jobId), 'the clip.cut job runs'); return queue.jobPublic(await queue.get(jobId)); };

        // A 34 s, 160x90, 10 fps source with keyframes every 2 s: object.cmaf cuts ~2 s segments, object.pack one chunk.
        const srcFile = path.join(process.env.VOD_PATH, 'mat-source.mp4');
        const mk = spawnSync('nice', ['-n', '15', 'ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=34:size=160x90:rate=10',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=34', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '20', '-c:a', 'aac', '-shortest', srcFile]);
        assert.strictEqual(mk.status, 0, String(mk.stderr));
        const vodId = (await db.createVod({ app_id: 'live', user_id: 5, title: 'Mat source', file_path: srcFile,
            file_size: fs.statSync(srcFile).size, duration_seconds: 34, visibility: 'public' })).lastInsertRowid;
        const vod = await db.getVodById(vodId, 'live');
        await db.run("UPDATE media_objects SET lifecycle_status = 'ready' WHERE id = ?", [vod.object_id]);
        await model.upsertLocation(vod.object_id, { provider: 'local', key: srcFile, state: 'present', size_bytes: fs.statSync(srcFile).size, verified: true });
        const cmafOut = await require('../server/jobs/cmaf').spec.run({ id: 'mjob_MATCMAF', app_id: 'live', object_id: vod.object_id, params: { segment_seconds: 2 } }, { signal: signal() });
        assert.strictEqual(cmafOut.segments, 17, JSON.stringify(cmafOut));
        const packOut = await require('../server/jobs/pack').spec.run({ id: 'mjob_MATPACK', app_id: 'live', object_id: vod.object_id, params: { target_seconds: 60 } }, { signal: signal() });
        assert.strictEqual(packOut.packs, 1, JSON.stringify(packOut));
        const srcRows = await timeline.list(vod.object_id, 'source');
        const srcSegs = srcRows.filter((x) => Number(x.seq) > 0);
        assert.ok(srcSegs.every((x) => x.packed_object_id && x.durability === 'durable'), 'every source segment is packed');
        const chunkKey = srcSegs[0].key;
        const chunkLocal = srcSegs[0].local_path;
        assert.ok(blobStore.has(`b2:${chunkKey}`) && fs.existsSync(chunkLocal), 'the chunk is here and durable');
        const segAt = (t) => srcSegs.find((x) => Number(x.start_ms) <= t && t < Number(x.end_ms));
        const mid = (x) => Math.floor((Number(x.start_ms) + Number(x.end_ms)) / 2);
        console.log(`✅ a 34 s source is cut into ${srcSegs.length} segments and packed into one chunk`);

        // ── Materialize a ~31 s window: exactly two edges re-encoded, the interior rows name the chunk's bytes ──
        const headSeg = srcSegs[0];
        const tailSeg = segAt(Number(headSeg.start_ms) + 30000);
        const startMs = mid(headSeg);
        const endMs = mid(tailSeg);
        const tailSeq = Number(tailSeg.seq);
        assert.ok(tailSeq > 3 && endMs - startMs > 25000, 'the window spans most of the source');
        const derive = require('../server/jobs/derive');
        const realFfmpeg = derive.ffmpeg;
        let encodes = 0;
        derive.ffmpeg = async (...a) => { encodes++; return await realFfmpeg(...a); };
        let r = await freshClip({ vod_id: vodId, start_s: startMs / 1000, end_s: endMs / 1000, materialize: true, title: 'Materialized window' });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        const clipId = r.body.id;
        const job = await runClip(r.body.job_id);
        assert.strictEqual(job.status, 'succeeded', JSON.stringify(job.error));
        assert.strictEqual(encodes, 2, 'exactly two segments re-encoded (the two edges)');
        const clip = await db.getClipById(clipId);
        const clipObj = clip.object_id;
        assert.deepStrictEqual([clip.status, clip.file_path, clip.storage_provider], ['ready', null, 'timeline']);
        assert.strictEqual(Number(clip.duration_seconds), (endMs - startMs) / 1000, 'the clip duration is the planned window');
        const md = model.parseJson((await model.getObject(clipObj)).metadata, {});
        assert.deepStrictEqual([md.virtual, md.materialized], [true, true], 'virtual stays, materialized is added');

        const expectedSeqs = [-2, -1, 0, ...Array.from({ length: tailSeq }, (_, i) => i + 1)];
        const rows = await timeline.list(clipObj, 'source');
        assert.deepStrictEqual(rows.map((x) => Number(x.seq)), expectedSeqs, 'the edge inits, the source init and the pieces, all numbered');
        const bySeq = new Map(rows.map((x) => [Number(x.seq), x]));
        const srcBySeq = new Map(srcRows.map((x) => [Number(x.seq), x]));
        for (let s = 2; s < tailSeq; s++) {
            const c = bySeq.get(s);
            const o = srcBySeq.get(s);
            assert.deepStrictEqual([c.key, c.local_path, c.durable_provider, c.packed_object_id, Number(c.byte_offset), Number(c.byte_length), c.sha256, c.init_name],
                [o.key, o.local_path, o.durable_provider, o.packed_object_id, Number(o.byte_offset), Number(o.byte_length), o.sha256, null],
                `interior seq ${s} names the source's chunk bytes`);
            assert.deepStrictEqual([Number(c.start_ms), Number(c.end_ms)], [Number(o.start_ms) - startMs, Number(o.end_ms) - startMs], 'times are relative to the window');
        }
        assert.deepStrictEqual([bySeq.get(1).init_name, bySeq.get(tailSeq).init_name], [timeline.HEAD_INIT, timeline.TAIL_INIT], 'the two edges name their own init');
        assert.deepStrictEqual([Number(bySeq.get(1).start_ms), Number(bySeq.get(1).end_ms)], [0, Number(headSeg.end_ms) - startMs], 'the head edge ends at its source segment\'s end');
        assert.deepStrictEqual([Number(bySeq.get(tailSeq).start_ms), Number(bySeq.get(tailSeq).end_ms)], [Number(tailSeg.start_ms) - startMs, endMs - startMs], 'the tail edge starts at its source segment\'s start');
        for (const s of [1, tailSeq]) {
            const e = bySeq.get(s);
            assert.ok(e.key.startsWith(`${clipObj}/source/`) && e.local_path.startsWith(path.join(path.resolve(process.env.OBJECTS_PATH), '.timeline', 'live', clipObj, 'source')), `edge ${s} is the clip's own`);
            assert.strictEqual(sha(fs.readFileSync(e.local_path)), e.sha256, `edge ${s} sha256`);
            assert.ok(blobStore.has(`b2:${e.key}`), `edge ${s} is durable too`);
        }
        for (const initSeq of [-1, -2]) {
            const init = bySeq.get(initSeq);
            assert.strictEqual(sha(fs.readFileSync(init.local_path)), init.sha256);
            assert.ok(blobStore.has(`b2:${init.key}`), `${init.name} is durable`);
        }
        console.log('✅ materialize: the interior rows copy the packed source; exactly two edge segments and two edge inits are its own');

        // ── The playlist: two discontinuities with the right maps; every row serves through /o/<clip>/source/<name> ──
        const pl = (await get(`/o/${clipObj}/source/index.m3u8`)).buf.toString();
        {
            const events = [];
            for (const line of pl.split('\n')) {
                if (line === '#EXT-X-DISCONTINUITY') events.push('disc');
                const m = /^#EXT-X-MAP:URI="([^"]+)"/.exec(line);
                if (m) events.push(`map ${m[1]}`);
            }
            assert.deepStrictEqual(events, ['map init-head.mp4', 'disc', 'map init.mp4', 'disc', 'map init-tail.mp4'], pl);
            assert.strictEqual((pl.match(/#EXTINF:/g) || []).length, tailSeq, 'every piece is listed once');
            assert.ok(pl.includes('#EXT-X-MEDIA-SEQUENCE:1') && pl.trim().endsWith('#EXT-X-ENDLIST'));
        }
        for (const row of rows) {
            const s = await get(`/o/${clipObj}/source/${row.name}`);
            assert.strictEqual(s.status, 200, row.name);
            assert.strictEqual(sha(s.buf), row.sha256, `${row.name} serves its indexed bytes`);
            assert.strictEqual(s.headers.get('content-type'), Number(row.seq) <= 0 ? 'video/mp4' : 'video/iso.segment', `${row.name} MIME`);
        }
        const probed = await new Promise((resolve) => {
            const p = spawn('nice', ['-n', '15', 'ffprobe', '-v', 'quiet', '-rw_timeout', '10000000', '-show_entries', 'format=duration', '-of', 'csv=p=0', `${api}/o/${clipObj}/source/index.m3u8`]);
            let out = '';
            p.stdout.on('data', (d) => { out += d; });
            p.on('close', () => resolve(out.trim()));
        });
        assert.ok(Math.abs(Number(probed) - (endMs - startMs) / 1000) < 0.2, `ffprobe plays across both discontinuities: ${JSON.stringify(probed)}`);
        console.log('✅ the playlist carries two discontinuities with the right maps; every segment and edge init serves with the right MIME');

        // ── Readiness counts it playable; the verify job skips it ──
        const readiness = require('../server/objects/readiness');
        const rdy = await readiness.compute(await model.getObject(clipObj));
        assert.deepStrictEqual([rdy.playable, rdy.bytes_verified, rdy.reason], [true, true, null], 'a materialized clip is playable with no location of its own');
        assert.ok(await db.get(`SELECT 1 FROM clips WHERE id = ? AND ${readiness.playableSql('clips.object_id')}`, [clipId]), 'playableSql agrees');
        const verified = await require('../server/objects/verify-job').runOnce({ batch: 100, head: async () => undefined, upload: async () => { throw new Error('no upload in this test'); }, maxReuploads: 0 });
        assert.ok(!verified.objects.some((o) => o.object_id === clipObj), 'the verify job skips a materialized clip as it skips a virtual one');
        r = await call('PUT', `/api/v1/live/clips/${clipId}`, { title: 'Materialized, renamed' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const remd = model.parseJson((await model.getObject(clipObj)).metadata, {});
        assert.deepStrictEqual([remd.virtual, remd.materialized], [true, true], 'a re-projection keeps virtual and materialized');

        // ── An edge-only clip (a window inside one source segment) decodes through the sprite with its own init ──
        {
            const soloSeg = srcSegs[4];
            const sStart = Number(soloSeg.start_ms) + 300;
            const sEnd = Number(soloSeg.end_ms) - 1;
            r = await freshClip({ vod_id: vodId, start_s: sStart / 1000, end_s: sEnd / 1000, materialize: true, title: 'Edge only' });
            assert.strictEqual(r.status, 202, JSON.stringify(r.body));
            assert.strictEqual((await runClip(r.body.job_id)).status, 'succeeded');
            const soloObj = (await db.getClipById(r.body.id)).object_id;
            const soloRows = await timeline.list(soloObj, 'source');
            assert.deepStrictEqual(soloRows.map((x) => Number(x.seq)), [-1, 1], 'one head edge, its own init, no seq 0 (nothing copied)');
            assert.strictEqual(soloRows.find((x) => Number(x.seq) === 1).init_name, timeline.HEAD_INIT);
            const soloPl = (await get(`/o/${soloObj}/source/index.m3u8`)).buf.toString();
            assert.ok(soloPl.includes('#EXT-X-MAP:URI="init-head.mp4"') && !soloPl.includes('#EXT-X-DISCONTINUITY'), soloPl);
            // Run the job directly: the worker's ctx.saveCheckpoint runs the callback (no job checkpoint needed here).
            const spriteCtx = { signal: signal(), saveCheckpoint: async (_cp, alsoInTx) => { if (alsoInTx) await alsoInTx(); } };
            const sprite = await previews.sprite.run({ id: 'mjob_MATSPRITE', app_id: 'live', object_id: soloObj, params: { frames: 4, columns: 2, tile_width: 96 } }, spriteCtx);
            assert.deepStrictEqual([sprite.sprite.count, sprite.sprite.columns, sprite.sprite.rows], [1, 1, 1]);
            const spriteFile = (await model.listLocations(sprite.object_id))[0].key;
            const rr = spawnSync('ffmpeg', ['-v', 'error', '-i', spriteFile, '-frames:v', '1', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'], { encoding: null, maxBuffer: 1 << 20 });
            const grey = rr.stdout && rr.stdout.length ? rr.stdout[rr.stdout.length - 1] : -1;
            assert.ok(grey > 30, `the edge decodes with init-head through the sprite (grey ${grey})`);
        }
        console.log('✅ an edge-only clip plays and its sprite decodes the edge with init-head');

        // ── Downloads: format=mp4 answers the playlist (no remux it cannot read); /c/:id still 302s to it ──
        r = await call('GET', `/api/v2/live/objects/${clipObj}/download?format=mp4`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.url, `${config.publicUrl}/o/${clipObj}/master.m3u8`);
        assert.strictEqual(r.body.public, true);
        assert.strictEqual((await db.all("SELECT id FROM media_jobs WHERE job_type = 'object.remux'")).length, 0, 'no remux is queued for a timeline-only clip');
        const redir = await fetch(`${api}/api/v2/live/objects/${clipObj}/download?format=mp4&redirect=1`, { headers: auth, redirect: 'manual' });
        assert.strictEqual(redir.status, 302);
        assert.ok(String(redir.headers.get('location')).endsWith(`/o/${clipObj}/master.m3u8`), redir.headers.get('location'));
        const c = await get(`/c/${clipId}`);
        assert.deepStrictEqual([c.status, new URL(c.location).pathname], [302, `/o/${clipObj}/master.m3u8`], '/c/:id redirects a file-less materialized clip to its playlist');
        console.log('✅ download?format=mp4 and /c/:id answer the playlist for a materialized clip');

        // ── A virtual clip is still the default; recutting it with materialize:true materializes it ──
        r = await freshClip({ vod_id: vodId, start_s: 3000 / 1000, end_s: 6000 / 1000, title: 'Virtual then materialized' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.status, r.body.storage_provider, r.body.file_path], ['ready', 'timeline', null]);
        const virtId = r.body.id;
        const virtObj = (await db.getClipById(virtId)).object_id;
        assert.strictEqual((await timeline.list(virtObj, 'source')).length, 0, 'a virtual clip has no rows of its own');
        r = await call('POST', `/api/v1/live/clips/${virtId}/recut`, { materialize: true });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.strictEqual((await runClip(r.body.job_id)).status, 'succeeded');
        assert.ok((await timeline.list(virtObj, 'source')).some((x) => Number(x.seq) < 0), 'materializing a virtual clip writes its own edge init rows');
        assert.strictEqual(model.parseJson((await model.getObject(virtObj)).metadata, {}).materialized, true);
        assert.strictEqual((await call('DELETE', `/api/v1/live/clips/${virtId}`)).status, 200, 'and it deletes like any materialized clip');
        assert.strictEqual((await timeline.list(virtObj, 'source')).length, 0);
        console.log('✅ a virtual clip is the default; recut?materialize=1 materializes it over the source');

        // ── The flag off, and a source without a timeline: the full re-encode, exactly as before ──
        const cutter = require('../server/vod/clip-cutter');
        const realCut = cutter.cutClipFile;
        const cuts = [];
        cutter.cutClipFile = async (o) => {
            cuts.push(o);
            const f = path.join(process.env.CLIPS_PATH, `fallback-${cuts.length}.webm`);
            fs.writeFileSync(f, Buffer.alloc(2048, 7));
            return { ok: true, filePath: f, duration: 4 };
        };
        config.hls.materialized = false;
        r = await freshClip({ vod_id: vodId, start_s: 20, end_s: 24, materialize: true, title: 'Flag off' });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.strictEqual((await runClip(r.body.job_id)).status, 'succeeded');
        assert.strictEqual(cuts.length, 1, 'MEDIA_MATERIALIZED_CLIPS off: clip.cut re-encodes as before');
        const offClip = await db.getClipById(r.body.id);
        assert.ok(offClip.file_path && fs.existsSync(offClip.file_path), 'and the clip has its own file');
        assert.strictEqual((await timeline.list(offClip.object_id, 'source')).length, 0, 'no timeline rows');

        // With the flag back on, a clip that has a file of its own keeps being cut: never turned into a timeline clip.
        config.hls.materialized = true;
        r = await call('POST', `/api/v1/live/clips/${offClip.id}/recut`);
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.strictEqual((await runClip(r.body.job_id)).status, 'succeeded');
        assert.strictEqual(cuts.length, 2, 'a clip with a file is re-cut, not materialized');
        const recut = await db.getClipById(offClip.id);
        assert.ok(recut.file_path && fs.existsSync(recut.file_path), 'it still has a file of its own');
        assert.strictEqual((await timeline.list(recut.object_id, 'source')).length, 0, 'and no timeline rows');

        const plainFile = path.join(process.env.VOD_PATH, 'plain.mp4');
        fs.copyFileSync(srcFile, plainFile);
        const plainVodId = (await db.createVod({ app_id: 'live', user_id: 5, title: 'No timeline', file_path: plainFile,
            file_size: fs.statSync(plainFile).size, duration_seconds: 34, visibility: 'public' })).lastInsertRowid;
        const plainVod = await db.getVodById(plainVodId, 'live');
        await db.run("UPDATE media_objects SET lifecycle_status = 'ready' WHERE id = ?", [plainVod.object_id]);
        await model.upsertLocation(plainVod.object_id, { provider: 'local', key: plainFile, state: 'present', size_bytes: fs.statSync(plainFile).size, verified: true });
        r = await freshClip({ vod_id: plainVodId, start_s: 1, end_s: 5, materialize: true, title: 'No timeline' });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.strictEqual((await runClip(r.body.job_id)).status, 'succeeded');
        assert.strictEqual(cuts.length, 3, 'a source without a timeline re-encodes in full');
        cutter.cutClipFile = realCut;
        console.log('✅ flag off, or a source without a timeline: the full re-encode stays exactly as it was');

        // ── Deletion: the clip's rows and edge bytes go; the source's bytes stay; and vice versa ──
        const edgeAssets = [bySeq.get(-1), bySeq.get(-2), bySeq.get(1), bySeq.get(tailSeq)];
        const edgeGone = () => edgeAssets.every((x) => !fs.existsSync(x.local_path) && !blobStore.has(`b2:${x.key}`));
        assert.ok(edgeAssets.every((x) => fs.existsSync(x.local_path) && blobStore.has(`b2:${x.key}`)), 'the clip\'s edge bytes exist before the delete');
        const srcRowCount = (await timeline.list(vod.object_id, 'source')).length;
        r = await call('DELETE', `/api/v1/live/clips/${clipId}`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual((await timeline.list(clipObj, 'source')).length, 0, 'the clip\'s rows are gone');
        assert.strictEqual((await timeline.list(vod.object_id, 'source')).length, srcRowCount, 'the source\'s rows stay');
        assert.ok(fs.existsSync(chunkLocal) && blobStore.has(`b2:${chunkKey}`), 'the source\'s chunk stays');
        assert.ok(edgeGone(), 'the clip\'s own edge bytes go');

        const s2 = mid(srcSegs[1]);
        const e2 = mid(srcSegs[3]);
        r = await freshClip({ vod_id: vodId, start_s: s2 / 1000, end_s: e2 / 1000, materialize: true, title: 'Source removed' });
        assert.strictEqual(r.status, 202, JSON.stringify(r.body));
        assert.strictEqual((await runClip(r.body.job_id)).status, 'succeeded');
        const clipBId = r.body.id;
        const clipBObj = (await db.getClipById(clipBId)).object_id;
        const hold = await model.placeHold({ object_id: vod.object_id, kind: 'admin', reason: 'materialized clip test' });
        r = await call('DELETE', `/api/v1/live/clips/${clipBId}`);
        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.ok((await timeline.list(clipBObj, 'source')).length > 0, 'a held source still freezes its clip');
        await model.releaseHold(hold.id);
        assert.ok((await timeline.removeObject(vod.object_id)).removed > 0, 'the source rows go');
        const bRows = await timeline.list(clipBObj, 'source');
        assert.ok(bRows.some((x) => Number(x.seq) < 0), 'the clip keeps its own rows');
        assert.ok(fs.existsSync(chunkLocal) && blobStore.has(`b2:${chunkKey}`), 'and the chunk it names is kept');
        assert.strictEqual((await get(`/o/${clipBObj}/source/index.m3u8`)).status, 200, 'the clip stays playable after the source is gone');
        const bSeg = bRows.find((x) => Number(x.seq) === 2);
        const served = await get(`/o/${clipBObj}/source/${bSeg.name}`);
        assert.deepStrictEqual([served.status, sha(served.buf)], [200, bSeg.sha256], 'an interior segment still serves from the kept chunk');
        r = await call('DELETE', `/api/v1/live/clips/${clipBId}`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(!fs.existsSync(chunkLocal) && !blobStore.has(`b2:${chunkKey}`), 'the last naming object deletes the chunk, here and durable');
        console.log('✅ deletion: a materialized clip releases only its own bytes; a removed source keeps the clip playable');

        events._reset();
        server.close();
        stub.close();
        console.log('materialized clips: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
