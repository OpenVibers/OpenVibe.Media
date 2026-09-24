'use strict';
// vod.duration.reconcile (server/vod/duration-reconcile.js, the job, scripts/vod-duration-reconcile.js)
// and the vods-orphans/ report (server/vod/orphans-report.js, scripts/vods-orphans-report.js), against
// a fake S3 spoken to by the real AWS SDK: stored durations are compared with a measurement of the
// real file, local or offloaded (ffprobe over a presigned URL, ranged reads); only confirmed, clearly
// wrong values are repaired; the dry run changes nothing; --apply needs a backup and the report
// rolls back; the job walks the library in bounded batches. The orphan report only reads.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, execFile } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-reconcile-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const runCli = (script, args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '../scripts', script), ...args], { env: process.env, encoding: 'utf8' },
        (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
});

// ── Fake S3: path-style /<bucket>/<key>; HEAD, GET (Range), ListObjectsV2; PUT/DELETE recorded ──
const buckets = { 'b2-bucket': new Map() };
const s3log = [];
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const s3 = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/');
        const key = rest.join('/');
        const store = buckets[bucket];
        s3log.push([req.method, bucket, key]);
        if (!store) { res.writeHead(404); return res.end(); }
        if (req.method === 'HEAD' && !key) { res.writeHead(200); return res.end(); }        // HeadBucket
        if (req.method === 'GET' && !key && u.searchParams.get('list-type') === '2') {
            const prefix = u.searchParams.get('prefix') || '';
            const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${
                keys.map(k => `<Contents><Key>${xml(k)}</Key><LastModified>2026-09-21T00:00:00.000Z</LastModified><ETag>"e"</ETag><Size>${store.get(k).length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')}</ListBucketResult>`);
        }
        const obj = store.get(key);
        if (req.method === 'HEAD' || req.method === 'GET') {
            if (!obj) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end(req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : undefined); }
            const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
            if (m && req.method === 'GET') {
                const start = Number(m[1]), end = Math.min(obj.length - 1, m[2] != null ? Number(m[2]) : obj.length - 1);
                if (start >= obj.length) { res.writeHead(416, { 'Content-Range': `bytes */${obj.length}` }); return res.end(); }
                res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${obj.length}`, 'Accept-Ranges': 'bytes', ETag: '"e"', 'Content-Type': 'video/mp4' });
                return res.end(obj.subarray(start, end + 1));
            }
            res.writeHead(200, { 'Content-Length': obj.length, 'Accept-Ranges': 'bytes', ETag: '"e"', 'Content-Type': 'video/mp4' });
            return res.end(req.method === 'GET' ? obj : undefined);
        }
        res.writeHead(405); res.end();
    });
});

(async () => {
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${s3.address().port}`;
    Object.assign(process.env, {
        DB_PATH: path.join(tmp, 'data', 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
        MEDIA_B2_ENDPOINT: endpoint, MEDIA_B2_BUCKET: 'b2-bucket', MEDIA_B2_KEY_ID: 'k', MEDIA_B2_APP_KEY: 's', MEDIA_B2_REGION: 'us-west-004',
        MEDIA_INVARIANT_SCAN_HOURS: '0', MEDIA_JOBS_ENABLED: '0',
    });
    const db = require('../server/db/database');
    const reconcile = require('../server/vod/duration-reconcile');
    const orphans = require('../server/vod/orphans-report');
    db.upsertApp({ app_id: 'live', api_key: 'live-key' });

    // ── 1. classify ──
    assert.strictEqual(reconcile.classify(600, 601.5), 'ok');
    assert.strictEqual(reconcile.classify(600, 640), 'mismatch', '40 s off is reported, not repaired');
    assert.strictEqual(reconcile.classify(3600, 600), 'wrong');
    assert.strictEqual(reconcile.classify(20000, 19800), 'mismatch', '200 s off a 5.5 h VOD (1%) is a mismatch, not wrong');
    assert.strictEqual(reconcile.classify(0, 12), 'missing');
    assert.strictEqual(reconcile.classify(100, 0), 'unmeasurable');
    console.log('✅ classify: ok within 2 s; wrong only past 60 s and 2%; missing when nothing is stored');

    const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
    const mk = (file, secs) => {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=160x120:rate=10`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file]);
        assert.strictEqual(r.status, 0, String(r.stderr));
        return fs.readFileSync(file);
    };
    const insVod = (o) => Number(db.run(`INSERT INTO vods (app_id, title, file_path, file_size, duration_seconds, duration_source, storage_provider, storage_key, health_status, is_recording, is_public, visibility)
        VALUES ('live', ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'public')`, [o.title || 't', o.file, o.size || 1000, o.stored, o.source ?? null, o.provider || 'local', o.key || null, o.health || 'ok']).lastInsertRowid);
    const vod = (id) => db.get('SELECT * FROM vods WHERE id = ?', [id]);

    let ids = {};
    if (!hasFfmpeg) {
        console.log('⚠️  ffmpeg not found: the measurement checks are skipped (orphan report still runs)');
    } else {
        const V = process.env.VOD_PATH;
        mk(path.join(V, 'a.mp4'), 6);
        mk(path.join(V, 'b.mp4'), 6);
        const cBytes = mk(path.join(tmp, 'c.mp4'), 8);
        buckets['b2-bucket'].set('vods/c.mp4', cBytes);                     // offloaded: no local file
        mk(path.join(V, 'd.mp4'), 6);
        mk(path.join(V, 'e.mp4'), 6);
        fs.writeFileSync(path.join(V, 'g.mp4'), Buffer.alloc(30000, 3));   // unreadable
        ids = {
            ok: insVod({ file: path.join(V, 'a.mp4'), stored: 6, source: 'probe' }),
            wallClock: insVod({ file: path.join(V, 'b.mp4'), stored: 3600 }),
            remote: insVod({ file: '/old/host/path/c.mp4', stored: 99999, provider: 'b2', key: 'vods/c.mp4' }),
            missing: insVod({ file: path.join(V, 'd.mp4'), stored: 0 }),
            small: insVod({ file: path.join(V, 'e.mp4'), stored: 9, source: 'probe' }),
            skipped: insVod({ file: path.join(V, 'f.mp4'), stored: 50, health: 'missing_file' }),
            unreadable: insVod({ file: path.join(V, 'g.mp4'), stored: 120 }),
        };

        // ── 2. Dry run: measures local and remote, changes nothing ──
        const before = db.all('SELECT id, duration_seconds, duration_source FROM vods ORDER BY id');
        const dry = await reconcile.reconcileBatch({ appId: 'live', afterId: 0, limit: 50 });
        assert.deepStrictEqual(db.all('SELECT id, duration_seconds, duration_source FROM vods ORDER BY id'), before, 'a dry run writes nothing');
        const by = Object.fromEntries(dry.rows.map(r => [r.vod_id, r]));
        assert.strictEqual(by[ids.ok].verdict, 'ok');
        assert.deepStrictEqual([by[ids.wallClock].verdict, by[ids.wallClock].action, by[ids.wallClock].confirmed], ['wrong', 'would_repair', true]);
        assert.strictEqual(by[ids.remote].where, 'b2', 'the offloaded copy is measured in B2');
        assert.deepStrictEqual([by[ids.remote].verdict, by[ids.remote].action], ['wrong', 'would_repair']);
        assert.ok(Math.abs(by[ids.remote].measured - 8) < 0.6, `remote measured ${by[ids.remote].measured}`);
        assert.ok(s3log.some(([m, , k]) => m === 'GET' && k === 'vods/c.mp4'), 'read through a presigned GET');
        assert.ok(!s3log.some(([m]) => m === 'PUT' || m === 'DELETE'));
        assert.deepStrictEqual([by[ids.missing].verdict, by[ids.missing].action], ['missing', 'would_repair']);
        assert.deepStrictEqual([by[ids.small].verdict, by[ids.small].action], ['mismatch', 'none'], 'a 3 s difference is reported only');
        assert.strictEqual(by[ids.skipped].verdict, 'skipped');
        assert.strictEqual(by[ids.unreadable].verdict, 'unmeasurable');
        assert.strictEqual(dry.counts.would_repair, 3);
        assert.strictEqual(dry.counts.remote, 1);
        console.log('✅ dry run: local files and the B2 copy (presigned ranged read) measured, 3 repairs proposed, nothing written');

        // ── 3. Bounded batches and --apply through the job, then rollback ──
        const small = await reconcile.reconcileBatch({ appId: 'live', afterId: 0, limit: 2 });
        assert.deepStrictEqual([small.rows.length, small.range.last_id, small.range.done], [2, ids.wallClock, false]);
        const queue = require('../server/jobs/queue');
        const worker = require('../server/jobs/worker');
        const spec = queue.typeSpec('vod.duration.reconcile');
        assert.throws(() => spec.validate({ obj: null, params: { limit: 500 } }), /limit/);
        const params = spec.validate({ obj: null, params: { limit: 4, apply: true } });
        let j = queue.enqueue({ appId: 'live', type: 'vod.duration.reconcile', params, createdBy: 'test' }).job;
        j = await worker.runNow(j.id);
        assert.strictEqual(j.status, 'succeeded', j.error);
        let res = JSON.parse(j.result);
        assert.deepStrictEqual([res.mode, res.counts.checked, res.counts.repaired, res.next_after_id], ['apply', 4, 3, ids.missing]);
        assert.ok(fs.existsSync(path.join(path.dirname(process.env.DB_PATH), 'reports', res.report)), 'the report is written');
        assert.deepStrictEqual([vod(ids.wallClock).duration_seconds, vod(ids.wallClock).duration_source], [6, 'probe']);
        assert.deepStrictEqual([vod(ids.remote).duration_seconds, vod(ids.remote).duration_source], [8, 'probe']);
        assert.deepStrictEqual([vod(ids.missing).duration_seconds, vod(ids.missing).duration_source], [6, 'probe']);
        assert.strictEqual(db.getSetting('duration_reconcile.cursor.live'), ids.missing, 'the cursor is kept for the next run');
        const obj = db.get('SELECT metadata FROM media_objects WHERE id = ?', [vod(ids.wallClock).object_id]);
        assert.strictEqual(JSON.parse(obj.metadata).duration_seconds, 6, 'the object is re-projected');
        j = queue.enqueue({ appId: 'live', type: 'vod.duration.reconcile', params: spec.validate({ obj: null, params: { limit: 4, apply: true } }), createdBy: 'test2' }).job;
        res = JSON.parse((await worker.runNow(j.id)).result);
        assert.deepStrictEqual([res.range.after_id, res.counts.checked, res.range.done, res.next_after_id], [ids.missing, 3, true, 0], 'continues, reaches the end, wraps');
        const report = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.DB_PATH), 'reports', JSON.parse(queue.list('live', { type: 'vod.duration.reconcile' }).jobs.slice(-1)[0].result).report), 'utf8'));
        const rb0 = reconcile.rollback(report.rows);
        assert.deepStrictEqual(rb0, { restored: 0, would_restore: 3, changed_since: 0 });
        const rb = reconcile.rollback(report.rows, { apply: true });
        assert.strictEqual(rb.restored, 3);
        assert.deepStrictEqual([vod(ids.wallClock).duration_seconds, vod(ids.wallClock).duration_source], [3600, null], 'rolled back');
        console.log('✅ the job repairs confirmed values in bounded batches, keeps its cursor, writes a report; the report rolls back');

        // ── 4. The script: dry run by default, --apply needs --backup, --rollback ──
        let r = await runCli('vod-duration-reconcile.js', ['--app', 'live', '--all', '--batch', '3']);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(/Would repair 3/.test(r.stdout), r.stdout);
        assert.strictEqual(vod(ids.wallClock).duration_seconds, 3600, 'dry run changed nothing');
        r = await runCli('vod-duration-reconcile.js', ['--apply']);
        assert.strictEqual(r.status, 2, 'apply without a backup is refused');
        const backup = path.join(tmp, 'bk', 'reconcile.json');
        r = await runCli('vod-duration-reconcile.js', ['--app', 'live', '--all', '--apply', '--backup', backup]);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(fs.existsSync(backup) && fs.existsSync(backup.replace(/\.json$/, '.media.db')), 'rollback file and database copy');
        assert.strictEqual(vod(ids.wallClock).duration_seconds, 6);
        r = await runCli('vod-duration-reconcile.js', ['--app', 'live', '--apply', '--backup', backup]);
        assert.strictEqual(r.status, 2, 'never overwrites a backup');
        r = await runCli('vod-duration-reconcile.js', ['--rollback', backup]);
        assert.ok(/Would restore 3/.test(r.stdout), r.stdout);
        r = await runCli('vod-duration-reconcile.js', ['--rollback', backup, '--apply']);
        assert.ok(/Restored 3/.test(r.stdout), r.stdout);
        assert.strictEqual(vod(ids.wallClock).duration_seconds, 3600);
        console.log('✅ scripts/vod-duration-reconcile.js: dry run by default, --apply with a checked backup, --rollback');
    }

    // ── 5. vods-orphans/ report: matches and recommendations, read-only ──
    {
        const B = buckets['b2-bucket'];
        const V = process.env.VOD_PATH;
        const bytes = (n, fill) => Buffer.alloc(n, fill);
        // canonical present, same size → duplicate
        const dupId = insVod({ file: '/x/vod-live-501-1726900000001.mp4', stored: 10, provider: 'b2' });
        B.set('vods/vod-live-501-1726900000001.mp4', bytes(5000, 1));
        B.set('vods-orphans/vod-live-501-1726900000001.mp4', bytes(5000, 1));
        // canonical present, other size → review
        insVod({ file: '/x/vod-live-502-1726900000002.mp4', stored: 10, provider: 'b2' });
        B.set('vods/vod-live-502-1726900000002.mp4', bytes(4000, 2));
        B.set('vods-orphans/vod-live-502-1726900000002.mp4', bytes(4500, 2));
        // no canonical, no local → the only copy
        const onlyId = insVod({ file: '/x/vod-live-503-1726900000003.mp4', stored: 10, provider: 'b2' });
        B.set('vods-orphans/vod-live-503-1726900000003.mp4', bytes(3000, 3));
        // still local with the same size → keep until offloaded
        fs.writeFileSync(path.join(V, 'vod-live-504-1726900000004.mp4'), bytes(2000, 4));
        insVod({ file: path.join(V, 'vod-live-504-1726900000004.mp4'), stored: 10 });
        B.set('vods-orphans/vod-live-504-1726900000004.mp4', bytes(2000, 4));
        // the row is gone (its object says when)
        B.set('vods-orphans/vod-live-9999-1726900000005.mp4', bytes(1000, 5));
        db.run(`INSERT INTO media_objects (id, app_id, namespace, kind, lifecycle_status, legacy_ref, deleted_at) VALUES ('med_01TESTGONE000000000000000A', 'live', 'live', 'vod', 'deleted', 'legacy:live:vod:9999', '2026-09-20 10:00:00')`);
        // a name that matches nothing
        B.set('vods-orphans/notes.txt', bytes(10, 6));
        // a row whose storage_key points INTO the prefix: that object is the canonical copy
        const keyedId = insVod({ file: '/x/vod-live-506-1726900000006.mp4', stored: 10, provider: 'b2', key: 'vods-orphans/vod-live-506-1726900000006.mp4' });
        B.set('vods-orphans/vod-live-506-1726900000006.mp4', bytes(700, 7));

        const writesBefore = s3log.filter(([m]) => m !== 'GET' && m !== 'HEAD').length;
        const rep = await orphans.buildReport({ provider: 'b2' });
        const rec = Object.fromEntries(rep.objects.map(o => [path.basename(o.key), o.recommendation]));
        assert.deepStrictEqual(rec, {
            'notes.txt': 'review_unknown',
            'vod-live-501-1726900000001.mp4': 'delete_duplicate',
            'vod-live-502-1726900000002.mp4': 'review_size_differs',
            'vod-live-503-1726900000003.mp4': 'keep_only_copy',
            'vod-live-504-1726900000004.mp4': 'keep_until_offloaded',
            'vod-live-506-1726900000006.mp4': 'keep_only_copy',
            'vod-live-9999-1726900000005.mp4': 'delete_row_gone',
        });
        const gone = rep.objects.find(o => o.key.includes('9999'));
        assert.ok(/deleted 2026-09-20/.test(gone.reason), gone.reason);
        assert.strictEqual(rep.objects.find(o => o.key.includes('-501-')).match.id, dupId);
        assert.strictEqual(rep.objects.find(o => o.key.includes('-503-')).match.id, onlyId);
        assert.strictEqual(rep.objects.find(o => o.key.includes('-506-')).match.id, keyedId);
        assert.deepStrictEqual([rep.totals.objects, rep.by_recommendation.keep_only_copy.objects, rep.by_recommendation.keep_only_copy.bytes], [7, 2, 3700]);
        assert.strictEqual(rep.read_only, true);
        assert.strictEqual(s3log.filter(([m]) => m !== 'GET' && m !== 'HEAD').length, writesBefore, 'the report never writes to the bucket');
        assert.strictEqual(B.size, [...B.keys()].length);
        const out = path.join(tmp, 'orphans.json');
        const r = await runCli('vods-orphans-report.js', ['--out', out]);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(/7 object\(s\)/.test(r.stdout) && /Nothing was deleted/.test(r.stdout), r.stdout);
        assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).totals.objects, 7);
        assert.ok(B.has('vods-orphans/vod-live-501-1726900000001.mp4'), 'every orphan is still there');
        console.log('✅ vods-orphans report: each object matched and recommended (only copy, duplicate, row gone, …), nothing deleted');
    }

    db.close();
    s3.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All duration reconcile and orphan report tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
