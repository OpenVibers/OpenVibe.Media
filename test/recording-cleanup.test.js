'use strict';
// The recording clean-up (server/vod/recording-cleanup.js; job storage.recordings.cleanup) and the retried remote
// delete (vod-storage.js deleteVodObjects). Against a fake S3 spoken to by the real AWS SDK:
//   - a file of a deleted VOD goes (B2, R2 and local), unless it is under the grace period or its VOD is held;
//   - a duplicate of a living VOD goes only when the VOD's own copy is there with the same size;
//   - a name with no VOD id, a different-size copy and every other prefix (backups, vods-orphans/) stay;
//   - a dry run deletes nothing; the job is service-wide only and queued daily;
//   - a failed remote delete is tried again until it succeeds.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-cleanup-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    const OLD = '2026-09-21T00:00:00.000Z';
    const buckets = { 'b2-bucket': new Map(), 'r2-bucket': new Map() };
    const put = (bucket, key, size, modified = OLD) => buckets[bucket].set(key, { size, modified });
    const deletes = [];
    let failDeletes = 0;
    const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const s3 = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            const u = new URL(req.url, 'http://x');
            const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/');
            const key = rest.join('/');
            const store = buckets[bucket];
            if (!store) { res.writeHead(404); return res.end(); }
            if (req.method === 'DELETE') {
                if (failDeletes > 0) { failDeletes--; res.writeHead(500, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>InternalError</Code></Error>'); }
                deletes.push(`${bucket}:${key}`); store.delete(key); res.writeHead(204); return res.end();
            }
            if (!key && u.searchParams.get('list-type') === '2') {
                const prefix = u.searchParams.get('prefix') || '';
                const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
                res.writeHead(200, { 'Content-Type': 'application/xml' });
                return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${
                    keys.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${store.get(k).modified}</LastModified><ETag>"e"</ETag><Size>${store.get(k).size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')}</ListBucketResult>`);
            }
            const obj = store.get(key);
            if (!obj) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Length': obj.size, ETag: '"e"' });
            res.end(req.method === 'GET' ? Buffer.alloc(obj.size) : undefined);
        });
    });
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${s3.address().port}`;
    const env = {
        MEDIA_DATA_DIR: path.join(tmp, 'data'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
        MEDIA_B2_ENDPOINT: endpoint, MEDIA_B2_BUCKET: 'b2-bucket', MEDIA_B2_KEY_ID: 'k', MEDIA_B2_APP_KEY: 's', MEDIA_B2_REGION: 'us-west-004',
        MEDIA_R2_ENDPOINT: endpoint, MEDIA_R2_BUCKET: 'r2-bucket', MEDIA_R2_ACCESS_KEY_ID: 'k', MEDIA_R2_SECRET_ACCESS_KEY: 's',
        AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED', AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
        MEDIA_PUBLIC_URL: 'https://media.test',
    };
    Object.assign(process.env, env);
    delete process.env.MEDIA_RECORDING_CLEANUP_DAYS;
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const queue = require('../server/jobs/queue');
    require('../server/jobs/types');
    const cleanup = require('../server/vod/recording-cleanup');
    const job = require('../server/jobs/recording-cleanup');
    const storage = require('../server/vod/vod-storage');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-cleanup' });
    const raw = db.getDb();
    const ins = raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, file_size, is_public, visibility, duration_seconds, storage_provider, storage_key) OVERRIDING SYSTEM VALUE
                             VALUES (?, 'live', ?, ?, ?, 1, 'public', 60, ?, ?) RETURNING id`);
    const local = (name, size, ageDays) => { const p = path.join(env.VOD_PATH, name); fs.writeFileSync(p, Buffer.alloc(size)); if (ageDays) { const t = (Date.now() - ageDays * 86400000) / 1000; fs.utimesSync(p, t, t); } return p; };

    // ── Fixtures ──
    // VOD 10 lives in B2 at its own key; two older copies of it sit under live.vods/ (one the same size, one not).
    await ins.run(10, 'kept', '/old/vod-live-10-1758000000010.webm', 40, 'b2', 'vods/vod-live-10-1758000000010.webm');
    put('b2-bucket', 'vods/vod-live-10-1758000000010.webm', 40);
    put('b2-bucket', 'live.vods/objects/2026/05/01/media-live-vod-10.webm', 40);          // duplicate: goes
    put('b2-bucket', 'live.vods/objects/2026/05/02/media-live-vod-10.webm', 41);          // another size: stays
    // VOD 11 lives locally only; an old B2 copy of another size stays.
    await ins.run(11, 'local', local('vod-live-11-1758000000011.webm', 30), 30, 'local', null);
    put('b2-bucket', 'vods/vod-live-11-1758000000099.webm', 31);
    // Deleted VODs 612 and 613 left copies; 613 is held. 614's copy is new (inside the grace period).
    put('b2-bucket', 'vods/vod-612-1758000000612.webm', 50);
    put('r2-bucket', 'vods/vod-612-1758000000612.webm', 50);
    put('b2-bucket', 'live.vods/objects/2026/05/03/media-hobostreamer-vod-612.webm', 70);
    put('b2-bucket', 'vods/vod-613-1758000000613.webm', 60);
    put('b2-bucket', 'vods/vod-614-1758000000614.webm', 60, new Date().toISOString());
    const heldObj = await model.createObject({ app_id: 'live', kind: 'vod', lifecycle_status: 'deleted', visibility: 'private', size_bytes: 60 });
    await raw.prepare("UPDATE media_objects SET legacy_ref = 'legacy:live:vod:613' WHERE id = ?").run(heldObj);
    await model.placeHold({ object_id: heldObj, kind: 'evidence', reason: 'test', created_by: 'test' });
    // Out of scope: a name with no VOD id, the parked prefix, the backups.
    put('b2-bucket', 'vods/random-upload.webm', 10);
    put('b2-bucket', 'vods-orphans/vod-700-1758000000700.webm', 10);
    put('b2-bucket', 'openvibe-pgbackrest/archive/0001.zst', 10);
    // Local: a deleted VOD's old file goes, a fresh one stays, a living VOD's file stays.
    const goneLocal = local('vod-live-612-1758000000612.webm', 20, 10);
    const freshLocal = local('vod-live-615-1758000000615.webm', 20, 0);

    // ── A dry run lists and deletes nothing ──
    const dry = await cleanup.run({ dryRun: true });
    assert.deepStrictEqual(dry.deleted, { row_gone: 4, duplicate: 1 }, JSON.stringify(dry.items));
    assert.strictEqual(deletes.length, 0, 'a dry run deletes nothing');
    assert.ok(fs.existsSync(goneLocal));

    // ── The real run ──
    const r = await cleanup.run();
    assert.deepStrictEqual(r.deleted, { row_gone: 4, duplicate: 1 });
    assert.strictEqual(r.bytes, 50 + 50 + 70 + 20 + 40);
    assert.deepStrictEqual(deletes.sort(), [
        'b2-bucket:live.vods/objects/2026/05/01/media-live-vod-10.webm',
        'b2-bucket:live.vods/objects/2026/05/03/media-hobostreamer-vod-612.webm',
        'b2-bucket:vods/vod-612-1758000000612.webm',
        'r2-bucket:vods/vod-612-1758000000612.webm',
    ].sort());
    assert.ok(!fs.existsSync(goneLocal) && fs.existsSync(freshLocal), 'the old local file of a deleted VOD goes; a fresh one stays');
    for (const k of ['vods/vod-live-10-1758000000010.webm', 'live.vods/objects/2026/05/02/media-live-vod-10.webm', 'vods/vod-live-11-1758000000099.webm',
        'vods/vod-613-1758000000613.webm', 'vods/vod-614-1758000000614.webm', 'vods/random-upload.webm', 'vods-orphans/vod-700-1758000000700.webm', 'openvibe-pgbackrest/archive/0001.zst']) {
        assert.ok(buckets['b2-bucket'].has(k), `${k} stays`);
    }
    assert.ok(r.kept.held >= 1 && r.kept.young >= 2 && r.kept.size_differs >= 2 && r.kept.no_vod_id >= 1, JSON.stringify(r.kept));
    assert.match(cleanup.summarize(r), /^deleted 4 file\(s\) of deleted VODs and 1 duplicate\(s\)/);
    assert.deepStrictEqual([cleanup.vodIdOf('vod-live-2-1758000000002.webm'), cleanup.vodIdOf('vod-1621-1786231355470.webm'), cleanup.vodIdOf('media-hobostreamer-vod-612.webm'), cleanup.vodIdOf('vod-1453-1785217692199.master.mkv'), cleanup.vodIdOf('random.webm')],
        [2, 1621, 612, 1453, null]);

    // ── The job: service-wide only, queued once a day ──
    assert.throws(() => job.spec.validate({ appId: 'live', params: {} }), /whole service/);
    assert.deepStrictEqual(job.spec.validate({ appId: queue.SYSTEM_APP, params: { dry_run: true } }), { dry_run: true });
    const day = Date.UTC(2026, 10, 3, 12);
    assert.strictEqual(await job.schedule(day), 1);
    assert.strictEqual(await job.schedule(day + 3600 * 1000), 0, 'once a day');
    process.env.MEDIA_RECORDING_CLEANUP_DAYS = '0';
    assert.strictEqual(await job.schedule(day + 3 * 86400 * 1000), 0, '0 turns it off');

    // ── A failed remote delete is tried again ──
    storage._setDeleteRetryDelays([20, 20, 20]);
    put('b2-bucket', 'vods/vod-live-20-1758000000020.webm', 9);
    deletes.length = 0;
    failDeletes = 2;
    await storage.deleteVodObjects({ id: 20, file_path: '/old/vod-live-20-1758000000020.webm', storage_key: 'vods/vod-live-20-1758000000020.webm' });
    for (let i = 0; i < 50 && buckets['b2-bucket'].has('vods/vod-live-20-1758000000020.webm'); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(!buckets['b2-bucket'].has('vods/vod-live-20-1758000000020.webm'), 'the B2 copy went on a retry');

    console.log('recording clean-up: all checks passed');
    s3.close();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
