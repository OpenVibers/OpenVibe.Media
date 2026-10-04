'use strict';
// storage.move.cleanup (server/jobs/move-cleanup.js): the alert half of a two-phase move's cleanup. An object whose
// move failed three times in the last 7 days (a later `done` resets the count; refused, already and dry_run rows are
// not failures) raises one storage.alert of kind move_cleanup_failed: media_storage_alerts_total{kind} once, one
// Events outbox row carrying the list. The job is service-wide (queue.SYSTEM_APP only), scheduled every
// MEDIA_MOVE_CLEANUP_MINUTES (0 = never), and changes nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-movecleanup-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        MEDIA_DATA_DIR: path.join(tmp, 'data'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
    });
    delete process.env.MEDIA_MOVE_CLEANUP_MINUTES;
    process.env.EVENTS_URL = '';
    const db = require('../server/db/database');
    const queue = require('../server/jobs/queue');
    require('../server/jobs/types');
    const job = require('../server/jobs/move-cleanup');
    const worker = require('../server/jobs/worker');
    const metrics = require('openvibe-shared/metrics');
    const registry = metrics.createRegistry();
    require('../server/observability').domainMetrics(registry, { db, recorder: { activeCount: () => 0 }, events: { status: async () => ({ enabled: false }) } });
    const alerts = async () => {
        const m = /media_storage_alerts_total\{kind="move_cleanup_failed"\} (\d+)/.exec(await registry.metricsAsync());
        return m ? Number(m[1]) : 0;
    };
    // The Events outbox is off in a test: count what vod-storage hands events.record (the outbox row's source).
    const recorded = [];
    const events = require('../server/events');
    const realRecord = events.record;
    events.record = async (event, appId, data) => { if (event === 'storage.alert' && data.kind === 'move_cleanup_failed') recorded.push(data); return realRecord(event, appId, data); };
    const outbox = async () => recorded.length;
    const row = (objectId, action, outcome, ago = '0 hours', error = null) => db.run(
        `INSERT INTO media_object_tier_decisions (decided_at, object_id, app_id, action, outcome, trigger, reason, error)
         VALUES (ov_now_iso(?), ?, 'live', ?, ?, 'sweep', 'test', ?)`, [`-${ago}`, objectId, action, outcome, error]);
    const many = async (n, id, action, startH, error = null) => { for (let i = 0; i < n; i++) await row(id, action, 'failed', `${startH + i} hours`, error); };

    // ── The threshold, the lookback and what counts as a failure ──
    await many(3, 'obj-three', 'demote', 1, 'the R2 copy is still there after the delete');
    await many(2, 'obj-two', 'demote', 1, 'boom');
    for (const outcome of ['refused', 'dry_run', 'already', 'refused', 'dry_run']) await row('obj-refused', 'demote', outcome);
    await many(3, 'obj-old', 'demote', 24 * 7 + 5);          // all three failures before the lookback
    await many(2, 'obj-split', 'demote', 1); await row('obj-split', 'promote', 'failed', '1 hours');   // 2 + 1 of another action
    await many(3, 'obj-reset', 'demote', 10); await row('obj-reset', 'demote', 'done', '5 hours');     // a done after them resets the count
    await many(3, 'obj-after', 'promote', 1); await row('obj-after', 'promote', 'done', '20 hours');   // the done is older: the failures count
    const found = await job.failedMoves();
    assert.deepStrictEqual(found.map((r) => `${r.object_id}:${r.action}:${r.fails}`).sort(), ['obj-after:promote:3', 'obj-three:demote:3'], JSON.stringify(found));
    assert.strictEqual(found.find((r) => r.object_id === 'obj-three').last_error, 'the R2 copy is still there after the delete');
    assert.strictEqual(job.FAIL_THRESHOLD, 3);
    console.log('✅ failedMoves: three failures within the lookback, per object and action; a later done, refusals and dry runs do not count');

    // ── SYSTEM_APP only ──
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-movecleanup' });
    assert.throws(() => job.spec.validate({ appId: 'live', params: {} }), (e) => e.status === 403 && e.code === 'media.job.forbidden');
    assert.deepStrictEqual(job.spec.validate({ appId: queue.SYSTEM_APP, params: {} }), {});
    const express = require('express');
    const http = require('http');
    const app = express();
    app.use(express.json());
    app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const data = JSON.stringify({ type: job.TYPE });
    const res = await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/v2/live/jobs', method: 'POST',
            headers: { Authorization: 'Bearer live-key-movecleanup', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(b || '{}') })); });
        rq.on('error', reject);
        rq.end(data);
    });
    server.close();
    assert.deepStrictEqual([res.status, res.body.code], [403, 'media.job.forbidden']);
    console.log('✅ a tenant cannot enqueue storage.move.cleanup; the system app can');

    // ── Scheduling ──
    assert.strictEqual(await job.schedule(Date.now()), 1, 'queued');
    assert.strictEqual(await job.schedule(Date.now()), 0, 'once per period');
    process.env.MEDIA_MOVE_CLEANUP_MINUTES = '0';
    assert.strictEqual(await job.schedule(Date.now() + 3 * 3600 * 1000), 0, 'MEDIA_MOVE_CLEANUP_MINUTES=0 schedules nothing');
    delete process.env.MEDIA_MOVE_CLEANUP_MINUTES;
    const queued = await db.get("SELECT * FROM media_jobs WHERE job_type = 'storage.move.cleanup'");
    assert.deepStrictEqual([queued.app_id, queued.status, queued.created_by], [queue.SYSTEM_APP, 'queued', 'system:schedule']);
    console.log('✅ scheduled once per period under the system app; 0 disables');

    // ── Run: one metric increment, one event listing the objects; a second run inside the cooldown adds none ──
    const before = { rows: Number((await db.get('SELECT COUNT(*) AS n FROM media_object_tier_decisions')).n), alerts: await alerts(), outbox: await outbox() };
    const done = await worker.runNow(queued.id);
    assert.strictEqual(done.status, 'succeeded', done.error || '');
    const result = JSON.parse(done.result);
    assert.deepStrictEqual([result.scanned, result.alerted, result.objects.map((o) => o.object_id).sort()], [2, 2, ['obj-after', 'obj-three']]);
    assert.deepStrictEqual([await alerts(), await outbox()], [before.alerts + 1, before.outbox + 1], 'one metric increment and one event');
    const payload = recorded[recorded.length - 1];
    assert.strictEqual(payload.count, 2, JSON.stringify(payload));
    assert.strictEqual(Number((await db.get('SELECT COUNT(*) AS n FROM media_object_tier_decisions')).n), before.rows, 'report only: no row changed');
    const again = JSON.parse((await worker.runNow((await queue.enqueue({ appId: queue.SYSTEM_APP, type: job.TYPE, params: {}, idempotencyKey: 'again' })).job.id)).result);
    assert.deepStrictEqual([again.scanned, again.alerted, await alerts(), await outbox()], [2, 0, before.alerts + 1, before.outbox + 1], 'the 6 h cooldown holds the second alert');
    console.log('✅ run: one media_storage_alerts_total{kind="move_cleanup_failed"} and one storage.alert event listing the objects');

    // ── Nothing failing: nothing sent ──
    await db.run('DELETE FROM media_object_tier_decisions');
    const quiet = JSON.parse((await worker.runNow((await queue.enqueue({ appId: queue.SYSTEM_APP, type: job.TYPE, params: {}, idempotencyKey: 'quiet' })).job.id)).result);
    assert.deepStrictEqual([quiet.scanned, quiet.alerted, await outbox()], [0, 0, before.outbox + 1]);
    console.log('✅ no object over the threshold: no alert');

    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('move cleanup: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
