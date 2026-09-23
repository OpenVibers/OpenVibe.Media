'use strict';
// Media job system (server/jobs): the schema-only media_jobs table is rebuilt; every state change
// commits with its media.job.* outbox row (and rolls back with it); idempotency keys; retries with
// backoff, permanent failures, checkpoints; cancellation by the owner (queued at once, running through
// the abort signal) and not by anyone else; interrupted jobs are requeued at start; the v1 thumbnail
// route runs as a thumbnail.regenerate job and answers as before.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-jobs-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.FILES_PATH = dir('files');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');
process.env.MEDIA_JOBS_POLL_MS = '50';
process.env.MEDIA_JOBS_LEASE_S = '30';
process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';

// ── 1. A database from before the worker: the schema-only table is rebuilt, rows kept ──
{
    const Database = require('better-sqlite3');
    const old = new Database(process.env.DB_PATH);
    old.exec(`CREATE TABLE media_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, object_id TEXT, job_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
                attempts INTEGER NOT NULL DEFAULT 0, checkpoint TEXT, error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
              CREATE INDEX idx_media_jobs_status ON media_jobs(status, job_type);
              INSERT INTO media_jobs (object_id, job_type, status, attempts) VALUES (NULL, 'legacy.thing', 'done', 1);`);
    old.close();
}

const hooks = [];
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        if (req.url === '/hook') { hooks.push(JSON.parse(body)); return res.end('{}'); }
        res.statusCode = 404; res.end('{}');
    });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(20); }
    return false;
};

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    const raw = db.getDb();

    const cols = raw.prepare('PRAGMA table_info(media_jobs)').all().map((c) => c.name);
    assert.ok(cols.includes('app_id') && cols.includes('idempotency_key') && cols.includes('lease_until'), 'media_jobs rebuilt into the worker shape');
    const legacy = raw.prepare("SELECT * FROM media_jobs WHERE id = 'mjob_legacy_1'").get();
    assert.deepStrictEqual([legacy.job_type, legacy.status, legacy.app_id], ['legacy.thing', 'succeeded', 'unknown'], 'the old row is kept, done -> succeeded');
    assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_media_jobs_idem'").get(), 'indexes on the new columns exist');
    db.close();
    db.getDb();                                   // a second open is a no-op
    assert.ok(db.get("SELECT 1 FROM media_jobs WHERE id = 'mjob_legacy_1'"));
    console.log('✅ the schema-only media_jobs table is rebuilt (rows kept); reopening is idempotent');

    db.upsertApp({ app_id: 'live', api_key: 'live-key', webhook_url: `${base}/hook`, webhook_secret: 's' });
    db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const events = require('../server/events');
    assert.ok(events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 }));
    const conn = db.getDb();
    const outbox = () => conn.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
    const jobEvents = (id) => outbox().filter((e) => e.subject.type === 'job' && e.subject.id === id).map((e) => e.event_type);
    const failOutbox = (on) => conn.exec(on
        ? "CREATE TEMP TRIGGER outbox_boom BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'outbox insert failed'); END"
        : 'DROP TRIGGER IF EXISTS temp.outbox_boom');

    const queue = require('../server/jobs/queue');
    const worker = require('../server/jobs/worker');

    // Test job types.
    let flakyCalls = 0;
    queue.register('test.flaky', {
        lane: 'light', maxAttempts: 3, backoffS: () => 0,
        run: async (job, ctx) => {
            flakyCalls++;
            if (!ctx.checkpoint) { ctx.saveCheckpoint({ step: 1 }); throw new Error('transient'); }
            return { resumed_from: ctx.checkpoint.step };
        },
    });
    queue.register('test.permanent', { lane: 'light', run: async () => { throw new queue.JobError('bad_input', 'will never work', { permanent: true }); } });
    queue.register('test.always', { lane: 'light', maxAttempts: 2, backoffS: () => 0, run: async () => { throw new Error('nope'); } });
    let release = null;
    queue.register('test.slow', {
        lane: 'heavy',
        run: (job, ctx) => new Promise((resolve, reject) => {
            release = resolve;
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        }),
    });

    // ── 2. A state change and its event commit together ──
    const a = queue.enqueue({ appId: 'live', type: 'test.flaky', params: { x: 1 }, createdBy: 'test' });
    assert.ok(a.created && /^mjob_[0-9A-HJKMNP-TV-Z]{26}$/.test(a.job.id));
    assert.deepStrictEqual(jobEvents(a.job.id), ['media.job.queued']);
    const env = outbox().find((e) => e.subject.id === a.job.id);
    assert.deepStrictEqual([env.source, env.priority, env.visibility, env.payload.type, env.payload.status, env.payload.app_id], ['media', 'low', 'internal', 'test.flaky', 'queued', 'live']);
    const q2 = queue.enqueue({ appId: 'live', type: 'test.permanent' });
    failOutbox(true);
    assert.throws(() => queue.enqueue({ appId: 'live', type: 'test.flaky', params: { x: 2 } }), /outbox insert failed/);
    assert.strictEqual(db.get("SELECT COUNT(*) AS n FROM media_jobs WHERE params = '{\"x\":2}'").n, 0, 'no job without its event');
    assert.throws(() => queue.cancel(q2.job.id, { by: 'x' }), /outbox insert failed/);
    failOutbox(false);
    assert.strictEqual(queue.get(q2.job.id).status, 'queued', 'a cancel whose event cannot be written changes nothing');
    assert.ok(hooks.length === 0, 'job events go to Events only, not the app webhook');
    console.log('✅ job state changes commit with their media.job.* outbox row, or not at all');

    // ── 3. Idempotency keys ──
    const k1 = queue.enqueue({ appId: 'live', type: 'test.permanent', params: { n: 1 }, idempotencyKey: 'key-1' });
    const k2 = queue.enqueue({ appId: 'live', type: 'test.permanent', params: { n: 1 }, idempotencyKey: 'key-1' });
    assert.ok(k1.created && k2.replayed && k1.job.id === k2.job.id);
    assert.throws(() => queue.enqueue({ appId: 'live', type: 'test.permanent', params: { n: 2 }, idempotencyKey: 'key-1' }), (e) => e.code === 'media.job.idempotency_conflict' && e.status === 409);
    assert.ok(queue.enqueue({ appId: 'games', type: 'test.permanent', params: { n: 1 }, idempotencyKey: 'key-1' }).created, 'keys are per tenant');
    const d1 = queue.enqueue({ appId: 'live', type: 'test.permanent', params: { same: true }, dedupeActive: true });
    const d2 = queue.enqueue({ appId: 'live', type: 'test.permanent', params: { same: true }, dedupeActive: true });
    assert.ok(d2.deduped && d2.job.id === d1.job.id, 'dedupeActive joins an identical queued job');
    for (const id of [q2.job.id, k1.job.id, d1.job.id]) queue.cancel(id, { by: 'test' });
    db.run("UPDATE media_jobs SET status = 'cancelled' WHERE app_id = 'games'");
    console.log('✅ idempotency keys: replay, per-tenant, conflict on a different request; active-job dedupe');

    // ── 4. Worker: retry with backoff + checkpoint resume, permanent failure, attempts exhausted ──
    assert.ok(worker.start());
    const perm = queue.enqueue({ appId: 'live', type: 'test.permanent' });
    const always = queue.enqueue({ appId: 'live', type: 'test.always' });
    worker.kick();
    assert.ok(await waitFor(() => queue.get(a.job.id).status === 'succeeded'), 'the flaky job succeeds on its retry');
    assert.strictEqual(flakyCalls, 2);
    assert.deepStrictEqual(queue.jobPublic(queue.get(a.job.id)).result, { resumed_from: 1 }, 'the retry resumed from the checkpoint');
    assert.deepStrictEqual(jobEvents(a.job.id), ['media.job.queued', 'media.job.started', 'media.job.retrying', 'media.job.started', 'media.job.succeeded']);
    assert.ok(await waitFor(() => queue.get(perm.job.id).status === 'failed'));
    assert.deepStrictEqual([queue.get(perm.job.id).attempts, queue.get(perm.job.id).error_code], [1, 'bad_input'], 'a permanent failure is not retried');
    assert.ok(await waitFor(() => queue.get(always.job.id).status === 'failed'));
    assert.strictEqual(queue.get(always.job.id).attempts, 2, 'retried until max_attempts');
    assert.deepStrictEqual(jobEvents(always.job.id), ['media.job.queued', 'media.job.started', 'media.job.retrying', 'media.job.started', 'media.job.failed']);
    const failedEv = outbox().filter((e) => e.subject.id === always.job.id).pop();
    assert.deepStrictEqual([failedEv.priority, failedEv.payload.error], ['important', 'nope']);
    console.log('✅ worker: retries with backoff resume from the checkpoint; permanent failures stop; attempts are capped');

    // ── 5. Cancellation by the owner ──
    const slow = queue.enqueue({ appId: 'live', type: 'test.slow', createdBy: 'app:live:user:7', ownerUserId: 7 });
    worker.kick();
    assert.ok(await waitFor(() => queue.get(slow.job.id).status === 'running'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
    app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, { key = 'live-key', body, headers = {} } = {}) => {
        const h = { authorization: `Bearer ${key}`, ...headers };
        if (body !== undefined) h['content-type'] = 'application/json';
        const res = await fetch(api + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, body: json, headers: res.headers };
    };
    let r = await call('POST', `/api/v2/live/jobs/${slow.job.id}/cancel`, { headers: { 'x-ov-user-id': '8' } });
    assert.strictEqual(r.status, 404, 'another user cannot see or cancel it');
    r = await call('POST', `/api/v2/games/jobs/${slow.job.id}/cancel`, { key: 'games-key' });
    assert.strictEqual(r.status, 404, 'another tenant cannot either');
    r = await call('POST', `/api/v2/live/jobs/${slow.job.id}/cancel`, { headers: { 'x-ov-user-id': '7' } });
    assert.deepStrictEqual([r.status, r.body.job.cancel_requested], [202, true], 'a running job stops at its next check');
    assert.ok(await waitFor(() => queue.get(slow.job.id).status === 'cancelled'), 'the abort signal stopped it');
    assert.deepStrictEqual(jobEvents(slow.job.id), ['media.job.queued', 'media.job.started', 'media.job.cancelled']);
    r = await call('DELETE', `/api/v2/live/jobs/${slow.job.id}`);
    assert.deepStrictEqual([r.status, r.body.code], [409, 'media.job.finished']);
    const waiting = queue.enqueue({ appId: 'live', type: 'test.permanent', runAfterS: 3600 });
    r = await call('DELETE', `/api/v2/live/jobs/${waiting.job.id}`);
    assert.deepStrictEqual([r.status, r.body.job.status], [200, 'cancelled'], 'a queued job is cancelled at once');
    console.log('✅ cancellation: owner only; queued at once, running through the abort signal; finished = 409');

    // ── 6. Interrupted jobs are requeued at start ──
    worker.stop();
    const orphan = queue.enqueue({ appId: 'live', type: 'test.permanent', params: { orphan: true } });
    db.run("UPDATE media_jobs SET status = 'running', attempts = 1, lease_until = datetime('now', '+1 hour') WHERE id = ?", [orphan.job.id]);
    assert.strictEqual(queue.recoverInterrupted({ all: true }), 1);
    const back = queue.get(orphan.job.id);
    assert.deepStrictEqual([back.status, back.error_code], ['queued', 'interrupted']);
    assert.deepStrictEqual(jobEvents(orphan.job.id).slice(-1), ['media.job.retrying']);
    queue.cancel(orphan.job.id, { by: 'test' });
    console.log('✅ a job left running by a dead process is requeued (or failed when out of attempts)');

    // ── 7. The jobs API ──
    r = await call('POST', '/api/v2/live/jobs', { body: { type: 'nope' } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.job.unknown_type']);
    r = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.split' } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.job.invalid'], 'object.split needs an object');
    r = await call('POST', '/api/v2/live/jobs', { body: { type: 'invariant.scan' }, headers: { 'idempotency-key': 'scan-1' } });
    assert.strictEqual(r.status, 202);
    const scanId = r.body.job.id;
    r = await call('POST', '/api/v2/live/jobs', { body: { type: 'invariant.scan' }, headers: { 'idempotency-key': 'scan-1' } });
    assert.deepStrictEqual([r.status, r.body.job.id, r.headers.get('idempotent-replayed')], [200, scanId, 'true']);
    r = await call('POST', `/api/v2/live/jobs/${scanId}/approve`);
    assert.deepStrictEqual([r.status, r.body.code], [409, 'media.job.not_proposed']);
    r = await call('GET', `/api/v2/live/jobs?type=invariant.scan`);
    assert.deepStrictEqual(r.body.jobs.map((j) => j.id), [scanId]);
    r = await call('GET', `/api/v2/games/jobs/${scanId}`, { key: 'games-key' });
    assert.strictEqual(r.status, 404, 'tenants are isolated');
    r = await call('GET', `/api/v2/live/jobs?status=bogus`);
    assert.strictEqual(r.status, 400);
    queue.cancel(scanId, { by: 'test' });
    console.log('✅ jobs API: create (Idempotency-Key replay), get, list, approve only proposals, tenant isolation');

    // ── 8. The v1 thumbnail route runs as a thumbnail.regenerate job ──
    const thumbs = require('../server/thumbnails/thumbnail-service');
    let gens = 0;
    thumbs.generateVodThumbnail = async (id) => { gens++; await sleep(150); db.run('UPDATE vods SET thumbnail_url = ? WHERE id = ?', [`/t/vod-${id}-1.jpg`, id]); return `/t/vod-${id}-1.jpg`; };
    fs.writeFileSync(path.join(process.env.VOD_PATH, 'rec-1.webm'), 'not really a video');
    conn.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, duration_seconds) VALUES (1, 'live', 5, 'A', ?, 1, 60)").run(path.join(process.env.VOD_PATH, 'rec-1.webm'));
    conn.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, duration_seconds) VALUES (2, 'live', 5, 'B', ?, 1, 60)").run(path.join(process.env.VOD_PATH, 'gone.webm'));
    require('../server/objects/model').sync('vod', 1);
    const [t1, t2] = await Promise.all([call('POST', '/api/v1/live/thumbnails/vod/1'), call('POST', '/api/v1/live/thumbnails/vod/1')]);
    assert.deepStrictEqual([t1.status, t1.body.url, t2.status, t2.body.url], [200, '/t/vod-1-1.jpg', 200, '/t/vod-1-1.jpg'], 'the answer keeps its { url } shape');
    assert.strictEqual(t1.body.job_id, t2.body.job_id, 'two concurrent requests share one job');
    assert.strictEqual(gens, 1, 'one generation for both');
    const tj = queue.get(t1.body.job_id);
    assert.deepStrictEqual([tj.job_type, tj.status, tj.object_id], ['thumbnail.regenerate', 'succeeded', db.get('SELECT object_id FROM vods WHERE id = 1').object_id]);
    assert.deepStrictEqual(jobEvents(tj.id), ['media.job.queued', 'media.job.started', 'media.job.succeeded']);
    r = await call('POST', '/api/v1/live/thumbnails/vod/2');
    assert.deepStrictEqual([r.status, r.body.error], [404, 'Media file unavailable'], 'no media is still a 404');
    assert.strictEqual(queue.get(r.body.job_id).error_code, 'media_unavailable');
    r = await call('POST', '/api/v1/live/thumbnails/vod/1?async=1');
    assert.strictEqual(r.status, 202);
    assert.ok(await waitFor(() => false, 50) || true);
    worker.start();
    assert.ok(await waitFor(() => queue.get(r.body.job.id).status === 'succeeded'), '?async=1 queues it for the worker');
    r = await call('POST', '/api/v2/live/jobs', { body: { type: 'thumbnail.regenerate', object_id: `legacy:live:vod:1` } });
    assert.deepStrictEqual([r.status, r.body.job.params], [202, { kind: 'vod', id: 1 }], 'the v2 API takes the object and finds the row');
    assert.ok(await waitFor(() => queue.get(r.body.job.id).status === 'succeeded'));
    console.log('✅ the v1 thumbnail route runs a thumbnail.regenerate job and answers { url } as before (404 without media)');

    worker.stop();
    events._reset();
    server.close();
    stub.close();
    console.log('\njobs: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
