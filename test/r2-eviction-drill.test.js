'use strict';
// scripts/r2-eviction-drill.js against a fake S3 (B2 and R2 buckets on one local endpoint, spoken to by
// the real AWS SDK through vod-storage) and a local Media serving /v/:id: the dry run changes nothing;
// the drill refuses when the canonical copy looks wrong, when a hold freezes placement, or when there
// is no R2 copy; --execute evicts the R2 copy, proves /v/:id is served from B2 with the same bytes,
// re-warms R2 and proves it again; a failed re-warm leaves the VOD served from B2; the CLI writes the artifact.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
// The fake S3 lives in this process, so the CLI must run without blocking it (no spawnSync).
const runCli = (args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '../scripts/r2-eviction-drill.js'), ...args], { env: process.env, encoding: 'utf8' },
        (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-r2drill-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };

// ── Fake S3: path-style /<bucket>/<key>; HEAD, GET (Range), PUT, DELETE ──
const buckets = { 'b2-bucket': new Map(), 'r2-bucket': new Map() };
const s3log = [];
let refusePutTo = null;
function decodeAwsChunked(buf) {
    const out = [];
    let i = 0;
    for (;;) {
        const nl = buf.indexOf('\r\n', i);
        const size = parseInt(buf.subarray(i, nl).toString().split(';')[0], 16);
        if (!size) break;
        out.push(buf.subarray(nl + 2, nl + 2 + size));
        i = nl + 2 + size + 2;
    }
    return Buffer.concat(out);
}
const s3 = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/');
        const key = rest.join('/');
        const store = buckets[bucket];
        s3log.push([req.method, bucket, key]);
        if (!store) { res.writeHead(404); return res.end(); }
        const obj = store.get(key);
        if (req.method === 'HEAD' || req.method === 'GET') {
            if (!obj) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end(req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : undefined); }
            const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
            if (m && req.method === 'GET') {
                const start = Number(m[1]), end = Math.min(obj.length - 1, m[2] != null ? Number(m[2]) : obj.length - 1);
                res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${obj.length}`, ETag: '"e"' });
                return res.end(obj.subarray(start, end + 1));
            }
            res.writeHead(200, { 'Content-Length': obj.length, ETag: '"e"', 'Content-Type': 'video/webm' });
            return res.end(req.method === 'GET' ? obj : undefined);
        }
        if (req.method === 'PUT') {
            if (refusePutTo === bucket) { res.writeHead(500, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>InternalError</Code></Error>'); }
            let body = Buffer.concat(chunks);
            if (req.headers['x-amz-decoded-content-length'] || /aws-chunked/.test(req.headers['content-encoding'] || '')) body = decodeAwsChunked(body);
            store.set(key, body);
            res.writeHead(200, { ETag: '"e"' });
            return res.end();
        }
        if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(405); res.end();
    });
});

(async () => {
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${s3.address().port}`;
    Object.assign(process.env, {
        DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
        MEDIA_B2_ENDPOINT: endpoint, MEDIA_B2_BUCKET: 'b2-bucket', MEDIA_B2_KEY_ID: 'k', MEDIA_B2_APP_KEY: 's', MEDIA_B2_REGION: 'us-west-004',
        MEDIA_R2_ENDPOINT: endpoint, MEDIA_R2_BUCKET: 'r2-bucket', MEDIA_R2_ACCESS_KEY_ID: 'k', MEDIA_R2_SECRET_ACCESS_KEY: 's',
        AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED', AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
    });
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const storage = require('../server/vod/vod-storage');
    const { runDrill, providerOfUrl } = require('../scripts/r2-eviction-drill');
    const conn = db.getDb();
    require('../server/views/service').ensureSchema();

    // Media serving /v/:id, as production does.
    const express = require('express');
    const app = express();
    app.use('/', require('../server/public/routes'));
    const media = http.createServer(app);
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${media.address().port}`;

    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 123);
    const addVod = (id, { provider = 'r2', visibility = 'public', size = bytes.length } = {}) => {
        const key = `vods/drill-${id}.webm`;
        conn.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, is_public, visibility, duration_seconds, storage_provider, storage_key)
                      VALUES (?, 'live', 5, 'Drill', ?, ?, ?, ?, 60, ?, ?)`).run(id, `/gone/drill-${id}.webm`, size, visibility === 'private' ? 0 : 1, visibility, provider, key);
        buckets['b2-bucket'].set(key, bytes);
        if (provider === 'r2') buckets['r2-bucket'].set(key, bytes);
        model.sync('vod', id);
        return key;
    };
    const deps = { storage, db, model };
    const opts = (o) => ({ http: true, baseUrl, maxMb: 512, ...o });
    assert.strictEqual(providerOfUrl(`${endpoint}/r2-bucket/vods/x.webm?X-Amz-Signature=1`, storage), 'r2');
    assert.strictEqual(providerOfUrl('https://b2-bucket.s3.example/vods/x.webm', { bucketFor: (p) => `${p}-bucket`, endpointFor: () => 'https://s3.example' }), 'b2');

    // ── Dry run: checks only ──
    const key1 = addVod(1);
    let art = await runDrill(opts({ vodId: 1 }), deps);
    assert.strictEqual(art.verdict, 'dry-run', art.reason);
    assert.deepStrictEqual(art.steps.map((s) => s.name), ['plan']);
    assert.ok(buckets['r2-bucket'].has(key1) && db.get('SELECT storage_provider FROM vods WHERE id = 1').storage_provider === 'r2', 'nothing moved');
    assert.ok(!s3log.some(([m]) => m === 'PUT' || m === 'DELETE'), 'no writes to either bucket');
    assert.strictEqual(art.checks.first_mib.b2, art.checks.first_mib.r2);
    console.log('✅ dry run: preconditions and copy checks only, nothing changes');

    // ── Refusals ──
    const key2 = addVod(2);
    buckets['b2-bucket'].set(key2, bytes.subarray(0, 100));
    assert.match((await runDrill(opts({ vodId: 2, execute: true }), deps)).reason, /differ in size/);
    buckets['b2-bucket'].set(key2, Buffer.concat([Buffer.from('X'), bytes.subarray(1)]));
    assert.match((await runDrill(opts({ vodId: 2, execute: true }), deps)).reason, /first MiB/);
    buckets['b2-bucket'].delete(key2);
    assert.match((await runDrill(opts({ vodId: 2, execute: true }), deps)).reason, /B2 canonical copy is missing/);
    assert.ok(buckets['r2-bucket'].has(key2), 'a refused drill deletes nothing');
    addVod(3, { provider: 'b2' });
    assert.match((await runDrill(opts({ vodId: 3, execute: true }), deps)).reason, /not R2/);
    addVod(4);
    const hold = model.placeHold({ object_id: db.get('SELECT object_id FROM vods WHERE id = 4').object_id, kind: 'evidence', reason: 'drill test' });
    assert.match((await runDrill(opts({ vodId: 4, execute: true }), deps)).reason, /retention hold/);
    model.releaseHold(hold.id, 'test');
    addVod(5, { visibility: 'private' });
    assert.match((await runDrill(opts({ vodId: 5, execute: true }), deps)).reason, /private/);
    assert.strictEqual((await runDrill(opts({ pick: true }), deps)).vod_id, 1, '--pick takes the smallest public R2 VOD that is not held');
    console.log('✅ refused: canonical copy wrong size / different bytes / missing, not on R2, held, private over HTTP');

    // ── Execute: evict, served from B2, re-warm, served from R2 ──
    s3log.length = 0;
    art = await runDrill(opts({ vodId: 1, execute: true }), deps);
    assert.strictEqual(art.verdict, 'pass', `${art.reason} ${JSON.stringify(art.steps, null, 1)}`);
    assert.deepStrictEqual(art.steps.map((s) => [s.name.split(':')[0], s.ok]), [['before', true], ['evict', true], ['from B2', true], ['re-warm', true], ['after', true]]);
    assert.deepStrictEqual([art.steps[0].provider, art.steps[2].provider, art.steps[4].provider], ['r2', 'b2', 'r2'], 'GET /v/1 went R2 -> B2 -> R2');
    assert.deepStrictEqual([art.steps[0].status, art.steps[2].range_status], [302, 206]);
    const sha = crypto.createHash('sha256').update(bytes.subarray(0, 1024 * 1024)).digest('hex');
    assert.ok(art.steps.filter((s) => s.first_mib_sha256).every((s) => s.first_mib_sha256 === sha), 'the same bytes every time');
    assert.ok(s3log.some(([m, b]) => m === 'DELETE' && b === 'r2-bucket') && s3log.some(([m, b]) => m === 'PUT' && b === 'r2-bucket'), 'the R2 copy was really deleted and written back');
    assert.ok(!s3log.some(([m, b]) => (m === 'DELETE' || m === 'PUT') && b === 'b2-bucket'), 'B2 was never written');
    assert.deepStrictEqual(buckets['r2-bucket'].get(key1), bytes, 'R2 holds the same bytes again');
    assert.strictEqual(db.get('SELECT storage_provider FROM vods WHERE id = 1').storage_provider, 'r2');
    assert.deepStrictEqual(art.locations.after_evict.map((l) => l.provider).sort(), ['b2']);
    assert.deepStrictEqual(art.locations.after.map((l) => [l.provider, l.state]).sort(), [['b2', 'present'], ['r2', 'present']]);
    console.log('✅ execute: R2 copy evicted, /v served from B2 with the same bytes, R2 re-warmed and serving again');

    // ── A failed re-warm leaves the VOD served from B2 ──
    addVod(6);
    refusePutTo = 'r2-bucket';
    art = await runDrill(opts({ vodId: 6, execute: true, http: false }), deps);
    refusePutTo = null;
    assert.strictEqual(art.verdict, 'fail');
    assert.deepStrictEqual(art.steps.map((s) => s.ok), [true, true, true, false]);
    assert.strictEqual(art.steps[0].via, 'resolvePlayback', '--no-http decides in-process');
    assert.strictEqual(db.get('SELECT storage_provider FROM vods WHERE id = 6').storage_provider, 'b2');
    assert.strictEqual((await storage.resolvePlayback(db.get('SELECT * FROM vods WHERE id = 6'))).provider, 'b2', 'still served, from B2');
    console.log('✅ a failed re-warm stops the drill with the VOD served from B2');

    // ── The CLI writes the artifact ──
    const out = path.join(tmp, 'artifact.json');
    const cli = await runCli(['--vod', '1', '--no-http', '--out', out]);
    assert.strictEqual(cli.status, 0, cli.stderr + cli.stdout);
    const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual([saved.drill, saved.mode, saved.verdict, saved.vod_id], ['r2-eviction', 'dry-run', 'dry-run', 1]);
    const refused = await runCli(['--vod', '3', '--out', path.join(tmp, 'r.json')]);
    assert.strictEqual(refused.status, 2, 'refused -> exit 2');
    console.log('✅ CLI: dry run by default, JSON artifact written, exit codes');

    media.close();
    s3.close();
    console.log('\nr2 eviction drill: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
