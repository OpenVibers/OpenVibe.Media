'use strict';
// The storage orphan report (server/vod/orphans-report.js buildStorageReport; job storage.orphans.scan;
// scripts/vods-orphans-report.js --storage): files under the data directories and B2/R2 keys that no row
// names, copies the database records that are not there, and multipart uploads left open, here and in the
// buckets. Report only: the test snapshots every file, the tables and the buckets before and after and
// finds them unchanged, and a fake S3 (spoken to by the real AWS SDK) counts any write or delete. The job
// runs service-wide under queue.SYSTEM_APP, is scheduled every MEDIA_ORPHAN_SCAN_DAYS, and tenants cannot
// enqueue it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-orphans-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };

const buckets = { 'b2-bucket': new Map(), 'r2-bucket': new Map() };
const openUploads = { 'b2-bucket': [{ key: 'vods/half-uploaded.webm', id: 'up-b2-1' }], 'r2-bucket': [] };
let writes = 0;
const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const s3 = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/');
        const key = rest.join('/');
        const store = buckets[bucket];
        if (!store) { res.writeHead(404); return res.end(); }
        if (req.method !== 'GET' && req.method !== 'HEAD') { writes++; res.writeHead(403, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
        if (!key && u.searchParams.has('uploads')) {
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${bucket}</Bucket><IsTruncated>false</IsTruncated>${
                openUploads[bucket].map(x => `<Upload><Key>${xml(x.key)}</Key><UploadId>${x.id}</UploadId><Initiated>2026-09-01T00:00:00.000Z</Initiated></Upload>`).join('')}</ListMultipartUploadsResult>`);
        }
        if (!key && u.searchParams.get('list-type') === '2') {
            const prefix = u.searchParams.get('prefix') || '';
            const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${
                keys.map(k => `<Contents><Key>${xml(k)}</Key><LastModified>2026-09-21T00:00:00.000Z</LastModified><ETag>"e"</ETag><Size>${store.get(k).length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')}</ListBucketResult>`);
        }
        const obj = store.get(key);
        if (!obj) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Length': obj.length, ETag: '"e"' });
        res.end(req.method === 'GET' ? obj : undefined);
    });
});

(async () => {
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${s3.address().port}`;
    const env = {
        DB_PATH: path.join(tmp, 'data', 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
        MEDIA_B2_ENDPOINT: endpoint, MEDIA_B2_BUCKET: 'b2-bucket', MEDIA_B2_KEY_ID: 'k', MEDIA_B2_APP_KEY: 's', MEDIA_B2_REGION: 'us-west-004',
        MEDIA_R2_ENDPOINT: endpoint, MEDIA_R2_BUCKET: 'r2-bucket', MEDIA_R2_ACCESS_KEY_ID: 'k', MEDIA_R2_SECRET_ACCESS_KEY: 's',
        AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED', AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
        MEDIA_PUBLIC_URL: 'https://media.test',
    };
    Object.assign(process.env, env);
    delete process.env.MEDIA_ORPHAN_SCAN_DAYS;
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const queue = require('../server/jobs/queue');
    require('../server/jobs/types');
    const orphans = require('../server/vod/orphans-report');
    const storageJob = require('../server/jobs/storage-orphans');
    db.upsertApp({ app_id: 'live', api_key: 'live-key-orphans' });
    const raw = db.getDb();
    const write = (d, name, bytes = 16, ageMs = 0) => {
        const p = path.join(d, name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.alloc(bytes, 7));
        if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(p, t, t); }
        return p;
    };
    const HOUR = 3600 * 1000;

    // ── Fixtures: what the database names ──
    const ins = raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, file_size, is_public, visibility, duration_seconds, storage_provider, storage_key, thumbnail_url)
                             VALUES (?, 'live', ?, ?, ?, 1, 'public', 60, ?, ?, ?)`);
    ins.run(1, 'local', write(env.VOD_PATH, 'vod-live-1-1758000000001.webm', 40), 40, 'local', null, '/t/vod-1-111.jpg');
    write(env.THUMBNAILS_PATH, 'vod-1-111.jpg');
    ins.run(2, 'in B2', '/old/vod-live-2-1758000000002.webm', 20, 'b2', 'vods/vod-live-2-1758000000002.webm', null);
    buckets['b2-bucket'].set('vods/vod-live-2-1758000000002.webm', Buffer.alloc(20));
    ins.run(3, 'served from R2', '/old/vod-live-3-1758000000003.webm', 30, 'r2', 'vods/vod-live-3-1758000000003.webm', null);
    buckets['b2-bucket'].set('vods/vod-live-3-1758000000003.webm', Buffer.alloc(30));
    buckets['r2-bucket'].set('vods/vod-live-3-1758000000003.webm', Buffer.alloc(30));
    ins.run(4, 'back in B2, R2 copy left', '/old/vod-live-4-1758000000004.webm', 50, 'b2', 'vods/vod-live-4-1758000000004.webm', null);
    buckets['b2-bucket'].set('vods/vod-live-4-1758000000004.webm', Buffer.alloc(50));
    buckets['r2-bucket'].set('vods/vod-live-4-1758000000004.webm', Buffer.alloc(50));
    ins.run(5, 'local file lost', path.join(env.VOD_PATH, 'vod-live-5-1758000000005.webm'), 10, 'local', null, null);
    ins.run(6, 'B2 key lost', '/old/vod-live-6-1758000000006.webm', 60, 'b2', 'vods/vod-live-6-1758000000006.webm', null);
    for (const id of [1, 2, 3, 4, 5, 6]) model.sync('vod', id);
    raw.prepare(`INSERT INTO files (key, app_id, original_name, size, mime) VALUES ('abc123-notes.txt', 'live', 'notes.txt', 16, 'text/plain')`).run();
    write(path.join(env.FILES_PATH, 'live'), 'abc123-notes.txt');
    model.sync('file', 'abc123-notes.txt');
    // A native object soft-deleted inside its retention period keeps its bytes wanted.
    const kept = model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready', visibility: 'private', size_bytes: 16 });
    const keptPath = write(path.join(env.OBJECTS_PATH, 'live'), kept, 16);
    model.upsertLocation(kept, { provider: 'local', key: keptPath, state: 'present', size_bytes: 16, verified: true });
    model.softDelete(model.getObject(kept));
    // A clip deleted by its row: the object is deleted, its file stayed behind.
    raw.prepare(`INSERT INTO clips (id, app_id, vod_id, title, file_path, status) VALUES (21, 'live', 1, 'gone clip', ?, 'ready')`).run(write(env.CLIPS_PATH, 'clip-live-21.webm', 12));
    model.sync('clip', 21);
    const clipObj = db.get('SELECT object_id FROM clips WHERE id = 21').object_id;
    raw.prepare('DELETE FROM clips WHERE id = 21').run();
    // Media's own multipart sessions: one open and expired (its parts wanted), one expired session's parts dir with no session.
    raw.prepare(`INSERT INTO media_uploads (id, object_id, app_id, part_size, total_size, parts_expected, status, expires_at)
                 VALUES ('mup_OPEN', ?, 'live', 8, 16, 2, 'active', datetime('now', '-1 hour'))`).run(kept);
    raw.prepare("INSERT INTO media_upload_parts (upload_id, part_number, size_bytes, sha256) VALUES ('mup_OPEN', 1, 8, 'x')").run();
    write(path.join(env.OBJECTS_PATH, '.parts', 'mup_OPEN'), '1', 8, 3 * HOUR);

    // ── What storage holds that no row names ──
    write(env.VOD_PATH, 'vod-live-99-1758000000099.webm', 1000);                 // the recorder's name; row 99 never existed
    write(env.VOD_PATH, 'mystery.bin', 500);
    write(env.VOD_PATH, 'vod-live-1-1758000000001.seekable.webm', 5);            // a sidecar of vod 1: wanted
    write(env.THUMBNAILS_PATH, 'stream-live-1.jpg');                             // a live thumbnail: expected
    write(path.join(env.OBJECTS_PATH, '.tmp'), 'med_OLD-abcd', 30, 3 * HOUR);    // an upload that never finished
    write(path.join(env.OBJECTS_PATH, '.tmp'), 'med_NOW-abcd', 30);              // one in flight right now
    write(path.join(env.OBJECTS_PATH, '.parts', 'mup_GONE'), '1', 8, 3 * HOUR);  // parts with no session
    buckets['b2-bucket'].set('vods/stray.webm', Buffer.alloc(70));
    buckets['b2-bucket'].set('vods-orphans/vod-live-7-1758000000007.webm', Buffer.alloc(80));

    // ── Everything before, to prove nothing changes ──
    const snapshotFiles = () => {
        const out = [];
        const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (p !== path.join(tmp, 'data')) walk(p); } else out.push(`${path.relative(tmp, p)}:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`); } };
        walk(tmp);
        return out.sort();
    };
    const TABLES = ['vods', 'clips', 'files', 'pastes', 'media_objects', 'media_locations', 'media_holds', 'media_uploads', 'media_upload_parts'];
    const snapshotDb = () => Object.fromEntries(TABLES.map(t => [t, crypto.createHash('sha256').update(JSON.stringify(raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).digest('hex')]));
    const snapshotBuckets = () => JSON.stringify(Object.entries(buckets).map(([b, m]) => [b, [...m.keys()].sort()]));
    const before = { files: snapshotFiles(), db: snapshotDb(), buckets: snapshotBuckets() };

    const report = await orphans.buildStorageReport({ limit: 50 });

    // ── Unreferenced local files ──
    const local = Object.fromEntries(report.unreferenced_local.map(f => [`${f.root}/${f.path.split(path.sep).join('/')}`, f]));
    assert.deepStrictEqual(Object.keys(local).sort(), [
        'clips/clip-live-21.webm', 'objects/.parts/mup_GONE/1', 'objects/.tmp/med_OLD-abcd', 'vods/mystery.bin', 'vods/vod-live-99-1758000000099.webm',
    ], 'exactly the files no row names');
    assert.ok(/whose row is gone/.test(local['vods/vod-live-99-1758000000099.webm'].hint), 'a recorder name says whose recording it was');
    assert.strictEqual(local['clips/clip-live-21.webm'].hint, `bytes of deleted object ${clipObj} (legacy:live:clip:21)`);
    assert.ok(/no session/.test(local['objects/.parts/mup_GONE/1'].hint));
    assert.ok(/never finished/.test(local['objects/.tmp/med_OLD-abcd'].hint));
    assert.strictEqual(local['vods/mystery.bin'].hint, null);
    assert.strictEqual(report.unreferenced_local[0].path, 'vod-live-99-1758000000099.webm', 'largest first');
    assert.deepStrictEqual([report.totals.unreferenced_local.files, report.totals.unreferenced_local.bytes], [5, 1000 + 500 + 30 + 8 + 12]);
    assert.deepStrictEqual(report.totals.expected, { live_thumbnails: 1, in_flight: 1 }, 'live thumbnails and uploads in flight are expected, not orphans');
    console.log('✅ unreferenced local files: recordings without a row, strays, bytes of deleted objects, stale temps and parts');

    // ── Unreferenced bucket keys ──
    const remote = Object.fromEntries(report.unreferenced_remote.map(k => [`${k.provider}:${k.key}`, k]));
    assert.deepStrictEqual(Object.keys(remote).sort(), ['b2:vods-orphans/vod-live-7-1758000000007.webm', 'b2:vods/stray.webm', 'r2:vods/vod-live-4-1758000000004.webm']);
    assert.ok(/vods-orphans-report/.test(remote['b2:vods-orphans/vod-live-7-1758000000007.webm'].hint), 'parked recordings point at the prefix report');
    assert.strictEqual(remote['r2:vods/vod-live-4-1758000000004.webm'].hint, 'an R2 copy of vod 4, which is served from b2');
    assert.deepStrictEqual(report.totals.unreferenced_remote, { b2: { keys: 2, bytes: 150 }, r2: { keys: 1, bytes: 50 } });
    assert.deepStrictEqual([report.scope.providers.b2.listed, report.scope.providers.b2.keys, report.scope.providers.r2.keys], [true, 5, 2]);
    console.log('✅ unreferenced bucket keys: strays, parked recordings, an R2 copy left behind by a demotion');

    // ── Copies the database records that are not there ──
    const missing = report.missing.map(m => `${m.legacy_ref}:${m.provider}`).sort();
    assert.deepStrictEqual(missing, ['legacy:live:vod:5:local', 'legacy:live:vod:6:b2'], 'a lost local file and a lost B2 key');
    assert.deepStrictEqual(report.totals.missing, { locations: 2, by_provider: { local: 1, b2: 1 } });
    console.log('✅ missing copies: rows whose location is not in storage');

    // ── Multipart uploads left open ──
    assert.deepStrictEqual(report.multipart_local.map(u => [u.upload_id, u.expired, u.parts_received]), [['mup_OPEN', true, 1]]);
    assert.deepStrictEqual(report.totals.multipart_local, { open: 1, expired: 1 });
    assert.deepStrictEqual(report.multipart_remote.map(u => [u.provider, u.key, u.upload_id, u.key_named_by_a_row]), [['b2', 'vods/half-uploaded.webm', 'up-b2-1', false]]);
    assert.deepStrictEqual(report.totals.multipart_remote, { b2: 1, r2: 0 });
    console.log('✅ open multipart uploads: Media\'s expired sessions and the buckets\' own');

    // ── Report only ──
    assert.deepStrictEqual(snapshotFiles(), before.files, 'no file was deleted, moved or touched');
    assert.deepStrictEqual(snapshotDb(), before.db, 'no row changed');
    assert.strictEqual(snapshotBuckets(), before.buckets, 'no bucket key changed');
    assert.strictEqual(writes, 0, 'no PUT, POST or DELETE reached a bucket');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'vod', 'orphans-report.js'), 'utf8');
    assert.ok(!/unlink|rmSync|rmdirSync|renameSync|DeleteObject|deleteObject|uploadFile|copyBetweenProviders|\b(DELETE|UPDATE|INSERT)\s/.test(src), 'the report module holds no delete, move or write');
    console.log('✅ report only: files, rows and buckets are unchanged; the module has no delete, move or write');

    // ── The job: service-wide, scheduled, not for tenants ──
    assert.strictEqual(storageJob.schedule(Date.now()), 1, 'the monthly scan is queued');
    assert.strictEqual(storageJob.schedule(Date.now()), 0, 'once per period');
    process.env.MEDIA_ORPHAN_SCAN_DAYS = '0';
    assert.strictEqual(storageJob.schedule(Date.now() + 90 * 86400 * 1000), 0, 'MEDIA_ORPHAN_SCAN_DAYS=0 schedules nothing');
    delete process.env.MEDIA_ORPHAN_SCAN_DAYS;
    const job = db.get("SELECT * FROM media_jobs WHERE job_type = 'storage.orphans.scan'");
    assert.deepStrictEqual([job.app_id, job.status, job.created_by], [queue.SYSTEM_APP, 'queued', 'system:schedule']);
    const done = await require('../server/jobs/worker').runNow(job.id);
    assert.strictEqual(done.status, 'succeeded', done.error || '');
    const result = JSON.parse(done.result);
    assert.strictEqual(result.totals.unreferenced_local.files, 5);
    const reportFile = path.join(tmp, 'data', 'reports', result.report);
    assert.ok(fs.existsSync(reportFile), 'the job writes its report under <data>/reports');
    assert.strictEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')).job_id, job.id);
    assert.deepStrictEqual(snapshotFiles(), before.files, 'the job deleted nothing either');
    assert.strictEqual(writes, 0);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const post = (p, body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST',
            headers: { Authorization: 'Bearer live-key-orphans', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
        rq.on('error', reject);
        rq.end(data);
    });
    const r = await post('/api/v2/live/jobs', { type: 'storage.orphans.scan' });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'media.job.forbidden'], 'a tenant cannot run the service-wide scan');
    server.close();
    console.log('✅ storage.orphans.scan: scheduled once per period under the system app, writes its report, refused to tenants');

    // ── The script, on demand ──
    const out = path.join(tmp, 'script-report.json');
    const text = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'vods-orphans-report.js'), '--storage', '--no-remote', '--out', out],
        { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.ok(/Unreferenced local files: 5/.test(text) && /Nothing was deleted or moved/.test(text), text);
    const scripted = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual([scripted.totals.unreferenced_local.files, Object.keys(scripted.scope.providers).length], [5, 0], '--no-remote lists no bucket');
    assert.deepStrictEqual(snapshotFiles().filter(f => !f.startsWith('script-report.json')), before.files);
    console.log('✅ scripts/vods-orphans-report.js --storage runs the same report on demand');

    s3.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('storage orphans: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
