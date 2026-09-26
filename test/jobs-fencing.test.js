'use strict';
// Job fencing (server/jobs/queue.js, WS-P lifecycle follow-up): a claim writes a random lease_token on the
// job row; renew, checkpoint, succeed, fail and markCancelled match the id AND that token. Two claimants:
// A's lease runs out, recovery requeues the job and B claims it; A's late heartbeat, checkpoint and
// completion are refused (logged, counted, metric), B's win. The column is added to an older database
// (ADD COLUMN only), and a job a pre-fencing process left running (NULL token) is still recovered at boot.
// The worker aborts a handler whose heartbeat finds the job taken, and its report is refused.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-fencing-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.FILES_PATH = dir('files');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');
process.env.MEDIA_JOBS_POLL_MS = '50';
process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(20); }
    return false;
};

(async () => {
    const db = require('../server/db/database');
    const raw = () => db.getDb();

    // ── 1. Additive migration: an older database gains lease_token; its NULL-token running job is recovered ──
    raw();
    db.close();
    {
        const Database = require('better-sqlite3');
        const old = new Database(process.env.DB_PATH);
        old.exec('ALTER TABLE media_jobs DROP COLUMN lease_token');
        old.exec(`INSERT INTO media_jobs (id, app_id, job_type, status, attempts, max_attempts, lease_until)
                  VALUES ('mjob_prefence', 'live', 'test.fence', 'running', 1, 3, datetime('now', '+1 hour'))`);
        old.close();
    }
    const cols = raw().prepare('PRAGMA table_info(media_jobs)').all().map((c) => c.name);
    assert.ok(cols.includes('lease_token'), 'lease_token is added to an older media_jobs');
    assert.strictEqual(db.get("SELECT lease_token FROM media_jobs WHERE id = 'mjob_prefence'").lease_token, null);

    const queue = require('../server/jobs/queue');
    queue.register('test.fence', { lane: 'light', maxAttempts: 3, run: async () => ({ ok: true }) });
    assert.strictEqual(queue.recoverInterrupted({ all: true }), 1, 'a job a pre-fencing process left running (NULL token) is recovered at boot');
    assert.deepStrictEqual([queue.get('mjob_prefence').status, queue.get('mjob_prefence').error_code], ['queued', 'interrupted']);
    queue.cancel('mjob_prefence', { by: 'test' });
    console.log('✅ lease_token is ADD COLUMN on an older database; a NULL-token running job is still recovered at boot');

    // ── 2. Two claimants ──
    const refused = [];
    queue.bus.on('stale', (e) => refused.push(e));
    const metrics = require('openvibe-shared/metrics').createRegistry();
    require('../server/observability').domainMetrics(metrics, { db, recorder: { activeCount: () => 0 }, events: require('../server/events') });
    const metric = (action) => metrics.getMetric('media_job_stale_completions_total').get({ action });
    const warnings = [];
    const warn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(' ')); };

    const changes = [];
    queue.bus.on('change', (row) => changes.push({ id: row.id, status: row.status }));
    const { job } = queue.enqueue({ appId: 'live', type: 'test.fence', createdBy: 'test' });
    const a = queue.claim(['test.fence'], { leaseS: 30 });
    assert.strictEqual(a.id, job.id);
    assert.match(a.lease_token, /^[0-9a-f]{32}$/, 'a claim writes a random token');
    assert.ok(!('lease_token' in queue.jobPublic(a)), 'the token never leaves the service');
    assert.strictEqual(queue.renew(job.id, { leaseS: 30, token: a.lease_token }).held, true, 'the holder renews');

    // A stalls: its lease runs out, recovery takes the job over, B claims it.
    raw().prepare("UPDATE media_jobs SET lease_until = datetime('now', '-1 minute') WHERE id = ?").run(job.id);
    assert.strictEqual(queue.recoverInterrupted({ except: new Set() }), 1);
    assert.deepStrictEqual([queue.get(job.id).status, queue.get(job.id).lease_token], ['queued', null]);
    raw().prepare('UPDATE media_jobs SET run_after = NULL WHERE id = ?').run(job.id);
    const b = queue.claim(['test.fence'], { leaseS: 30 });
    assert.strictEqual(b.id, job.id);
    assert.notStrictEqual(b.lease_token, a.lease_token, 'the second claim has its own token');
    assert.strictEqual(b.attempts, 2);

    // A comes back: everything it writes is refused.
    assert.strictEqual(queue.renew(job.id, { leaseS: 30, token: a.lease_token }).held, false, "A's heartbeat is refused");
    raw().exec('CREATE TABLE IF NOT EXISTS fence_probe (x TEXT)');
    assert.throws(() => queue.saveCheckpoint(job.id, { by: 'A' }, () => raw().prepare("INSERT INTO fence_probe VALUES ('A')").run(), { token: a.lease_token }),
        (err) => err.code === 'media.job.lease_lost');
    assert.strictEqual(raw().prepare('SELECT COUNT(*) AS n FROM fence_probe').get().n, 0, "what A's checkpoint wrote alongside rolled back");
    assert.strictEqual(queue.succeed(job.id, { by: 'A' }, { token: a.lease_token }), null, "A's completion is refused");
    assert.strictEqual(queue.fail(job.id, { message: 'A gave up', token: a.lease_token }), null, "so is A's failure");
    assert.strictEqual(queue.markCancelled(job.id, { token: a.lease_token }), null, 'and its cancel');
    let now = queue.get(job.id);
    assert.deepStrictEqual([now.status, now.result, now.checkpoint, now.lease_token], ['running', null, null, b.lease_token], "B's job is untouched");
    assert.throws(() => queue.succeed(job.id, { by: '?' }), /needs the claim's \{ token \}/, 'a completion without a token is a programming error');

    // B finishes; A's late completion is refused again and B's result stands.
    assert.strictEqual(queue.renew(job.id, { leaseS: 30, token: b.lease_token }).held, true);
    queue.saveCheckpoint(job.id, { by: 'B' }, null, { token: b.lease_token });
    const done = queue.succeed(job.id, { by: 'B' }, { token: b.lease_token });
    assert.deepStrictEqual([done.status, JSON.parse(done.result), done.lease_token], ['succeeded', { by: 'B' }, null]);
    assert.strictEqual(queue.succeed(job.id, { by: 'A' }, { token: a.lease_token }), null);
    now = queue.get(job.id);
    assert.deepStrictEqual([now.status, JSON.parse(now.result)], ['succeeded', { by: 'B' }], "B's result stands");
    assert.deepStrictEqual(changes.filter((r) => r.id === job.id).map((r) => r.status), ['queued', 'running', 'queued', 'running', 'succeeded'],
        'claimed by A, taken back by recovery, claimed by B, succeeded once (B); nothing from A');

    assert.deepStrictEqual(queue.staleStats(), { succeed: 2, fail: 1, cancel: 1, renew: 1, checkpoint: 1 }, 'every refusal is counted');
    assert.deepStrictEqual(refused.map((e) => e.action), ['renew', 'checkpoint', 'succeed', 'fail', 'cancel', 'succeed']);
    assert.deepStrictEqual(['succeed', 'fail', 'cancel', 'renew', 'checkpoint'].map(metric), [2, 1, 1, 1, 1], 'media_job_stale_completions_total');
    assert.ok(warnings.some((w) => w.includes(`refused a stale succeed of ${job.id}`) && w.includes('another claim holds it')), warnings.join('\n'));
    assert.ok(warnings.some((w) => w.includes(`refused a stale succeed of ${job.id}`) && w.includes('it is succeeded now')));
    console.warn = warn;
    console.log('✅ two claimants: the stale holder\'s heartbeat, checkpoint and completion are refused (logged, counted); the current holder\'s stand');

    // ── 3. Recovery does not take a job whose holder renewed meanwhile ──
    const second = queue.enqueue({ appId: 'live', type: 'test.fence', createdBy: 'test' }).job;
    const c = queue.claim(['test.fence'], { leaseS: 30 });
    assert.strictEqual(c.id, second.id);
    const seen = raw().prepare('SELECT * FROM media_jobs WHERE id = ?').get(second.id);
    queue.renew(second.id, { leaseS: 30, token: c.lease_token });   // the lease is live again
    assert.strictEqual(queue.fail(second.id, { message: 'x', code: 'interrupted', retryInS: 0, token: seen.lease_token, takeover: true, expired: true }), null,
        'a takeover needs the lease to have run out');
    assert.strictEqual(queue.get(second.id).status, 'running');
    assert.deepStrictEqual(queue.staleStats(), { succeed: 2, fail: 1, cancel: 1, renew: 1, checkpoint: 1 }, 'a declined takeover is not a stale completion');
    assert.ok(queue.succeed(second.id, { ok: 1 }, { token: c.lease_token }));
    console.log('✅ a takeover is fenced on the token it read and on the lease still being expired');

    // ── 4. The worker: a heartbeat that finds its job taken aborts the handler; its report is refused ──
    const worker = require('../server/jobs/worker');
    let started = null, sawAbort = null;
    queue.register('test.slowfence', {
        lane: 'light', maxAttempts: 3,
        run: (j, ctx) => new Promise((resolve, reject) => {
            started = j.id;
            ctx.signal.addEventListener('abort', () => { sawAbort = ctx.signal.reason; reject(ctx.signal.reason); });
        }),
    });
    require('../server/config').jobs.leaseS = 3;   // a heartbeat every second (the floor from the environment is 30 s)
    const slow = queue.enqueue({ appId: 'live', type: 'test.slowfence', createdBy: 'test' }).job;
    worker.start();
    assert.ok(await waitFor(() => started === slow.id && queue.get(slow.id).status === 'running'), 'the worker runs it');
    // Another claimant takes it over (as another process would after the lease ran out).
    const theirs = 'f'.repeat(32);
    raw().prepare('UPDATE media_jobs SET lease_token = ? WHERE id = ?').run(theirs, slow.id);
    assert.ok(await waitFor(() => sawAbort !== null, 5000), 'the heartbeat notices and aborts the handler');
    assert.strictEqual(sawAbort.code, 'media.job.lease_lost');
    await waitFor(() => queue.staleStats().fail === 2);
    const after = queue.get(slow.id);
    assert.deepStrictEqual([after.status, after.lease_token, after.error_code], ['running', theirs, null], "the handler's failure did not overwrite the other claim");
    assert.strictEqual(queue.staleStats().renew, 2);
    worker.stop();
    console.log('✅ the worker aborts a job whose lease it lost, and its failure is refused');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('jobs fencing: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
