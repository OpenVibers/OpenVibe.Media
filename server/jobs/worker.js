/**
 * OpenVibe.Media — job worker (docs/object-model.md#jobs)
 *
 * Runs media_jobs in-process, in two lanes so a long split never holds up a thumbnail:
 *   light  thumbnail.regenerate, invariant.scan      MEDIA_JOBS_LIGHT_CONCURRENCY (2)
 *   heavy  object.split, object.remux                 MEDIA_JOBS_HEAVY_CONCURRENCY (1); waits while a
 *                                                     recording runs unless MEDIA_JOBS_HEAVY_WHILE_RECORDING=1
 *   finalize  vod.finalize                            MEDIA_JOBS_FINALIZE_CONCURRENCY (1); runs while recording
 *                                                     (it is the work the recorder does when a stream ends)
 *   clips  clip.cut                                   MEDIA_JOBS_CLIPS_CONCURRENCY (2); runs while recording (people
 *                                                     clip live streams and wait for the result)
 *
 * A running job holds a lease (MEDIA_JOBS_LEASE_S) that a heartbeat renews; the heartbeat also notices
 * an owner's cancel request. At start every job left `running` by the previous process is retried (or
 * failed when out of attempts). A failed attempt is retried with backoff unless the handler says the
 * failure is permanent. Handlers get { signal, checkpoint, saveCheckpoint(cp, alsoInTx) } and resume
 * from the checkpoint on a retry.
 *
 * Scheduling: the size-invariant validator (invariant.scan) is enqueued per tenant every
 * MEDIA_INVARIANT_SCAN_HOURS (it proposes split/remux jobs; it never runs them). Orphaned recordings
 * get a vod.finalize every MEDIA_FINALIZE_SWEEP_S (server/jobs/vod-finalize.js). The storage orphan
 * report (storage.orphans.scan, report only) runs every MEDIA_ORPHAN_SCAN_DAYS under queue.SYSTEM_APP.
 */
'use strict';

const config = require('../config');
const db = require('../db/database');
const queue = require('./queue');

const cfg = () => config.jobs;
const running = new Map();        // job id -> { ac, lane }
let timer = null;
let started = false;
let ticking = false;
let lastScheduleAt = 0;
let lastPruneAt = 0;
let kicked = false;

function lanes() {
    const types = queue.typeNames();
    const by = (lane) => types.filter(t => queue.typeSpec(t).lane === lane);
    return [
        { name: 'light', types: by('light'), max: cfg().lightConcurrency },
        { name: 'heavy', types: by('heavy'), max: cfg().heavyConcurrency },
        { name: 'finalize', types: by('finalize'), max: cfg().finalizeConcurrency },
        { name: 'clips', types: by('clips'), max: cfg().clipsConcurrency || 2 },
    ];
}

function inLane(name) {
    let n = 0;
    for (const r of running.values()) if (r.lane === name) n++;
    return n;
}

function recordingActive() {
    try { return require('../vod/recorder').activeCount() > 0; } catch { return false; }
}

function backoffS(spec, attempt) {
    if (typeof spec.backoffS === 'function') return spec.backoffS(attempt);
    return Math.min(3600, 30 * 4 ** Math.max(0, attempt - 1));   // 30 s, 2 min, 8 min, 32 min, 1 h
}

/** Run one claimed job to its end. Never throws. */
async function execute(row, laneName) {
    const spec = queue.typeSpec(row.job_type);
    const ac = new AbortController();
    running.set(row.id, { ac, lane: laneName });
    const leaseS = cfg().leaseS;
    let cancelRequested = !!row.cancel_requested;
    const beat = setInterval(() => {
        try {
            const r = queue.renew(row.id, { leaseS });
            if (r.cancelRequested && !cancelRequested) { cancelRequested = true; ac.abort(new Error('cancelled by its owner')); }
        } catch { /* next beat */ }
    }, Math.max(1000, Math.floor(leaseS * 1000 / 3)));
    if (beat.unref) beat.unref();
    const timeoutMs = spec ? spec.timeoutMs : 1000;
    const limit = setTimeout(() => ac.abort(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    if (limit.unref) limit.unref();
    if (cancelRequested) ac.abort(new Error('cancelled by its owner'));

    const ctx = {
        signal: ac.signal,
        checkpoint: queue.parseJson(row.checkpoint, null),
        attempt: row.attempts,
        saveCheckpoint: (cp, alsoInTx) => { ctx.checkpoint = cp; queue.saveCheckpoint(row.id, cp, alsoInTx); },
        cancelled: () => cancelRequested,
    };
    try {
        if (!spec) throw new queue.JobError('media.job.unknown_type', `No handler for ${row.job_type}`, { permanent: true });
        const result = await spec.run(queue.jobPublic(row), ctx);
        queue.succeed(row.id, result);
    } catch (err) {
        const fresh = queue.get(row.id);
        if (cancelRequested || (fresh && fresh.cancel_requested)) {
            queue.markCancelled(row.id, { result: ctx.checkpoint ? { checkpoint: ctx.checkpoint } : null });
        } else {
            const permanent = !!(err && err.permanent);
            const attempts = fresh ? fresh.attempts : row.attempts;
            const more = !permanent && attempts < (fresh ? fresh.max_attempts : row.max_attempts);
            const retryIn = err && err.retryAfterS != null ? err.retryAfterS : backoffS(spec || {}, attempts);
            queue.fail(row.id, { message: (err && err.message) || String(err), code: (err && err.code) || null, retryInS: more ? retryIn : null });
            if (!more) console.warn(`[Jobs] ${row.job_type} ${row.id} failed: ${(err && err.message) || err}`);
        }
    } finally {
        clearInterval(beat);
        clearTimeout(limit);
        running.delete(row.id);
        kick();
    }
}

/**
 * Run this queued job now, outside the lane limits: the v1 thumbnail route does this so a request
 * is answered as promptly as before the job system (ffmpeg per request, deduplicated per item).
 * Resolves when it finishes; resolves null when someone else already took it.
 */
async function runNow(id) {
    const row = queue.claim([], { id, leaseS: cfg().leaseS });
    if (!row) return null;
    await execute(row, 'direct');
    return queue.get(id);
}

function scheduleInvariantScans(nowMs = Date.now()) {
    const hours = cfg().invariantScanHours;
    if (!hours || hours <= 0) return 0;
    const periodMs = hours * 3600 * 1000;
    const period = Math.floor(nowMs / periodMs);
    let n = 0;
    const tenants = db.all(`SELECT DISTINCT app_id FROM media_objects WHERE kind IN ('vod', 'clip') AND visibility != 'private' AND lifecycle_status = 'ready'`);
    for (const { app_id: appId } of tenants) {
        try {
            const r = queue.enqueue({ appId, type: 'invariant.scan', params: {}, idempotencyKey: `invariant.scan:${hours}h:${period}`, createdBy: 'system:schedule' });
            if (r.created) n++;
        } catch (err) { console.warn(`[Jobs] could not schedule invariant.scan for ${appId}: ${err.message}`); }
    }
    return n;
}

async function tick() {
    if (ticking) { kicked = true; return; }
    ticking = true;
    try {
        do {
            kicked = false;
            queue.recoverInterrupted({ except: new Set(running.keys()) });
            const now = Date.now();
            if (now - lastScheduleAt > 10 * 60 * 1000) {
                lastScheduleAt = now;
                scheduleInvariantScans(now);
                try { require('./duration-reconcile').schedule(now); } catch (err) { console.warn('[Jobs] duration reconcile schedule:', err.message); }
                try { require('./content-hash').schedule(now); } catch (err) { console.warn('[Jobs] content hash schedule:', err.message); }
                try { require('./storage-orphans').schedule(now); } catch (err) { console.warn('[Jobs] storage orphan scan schedule:', err.message); }
            }
            try { require('./vod-finalize').sweepOrphans({ now }); } catch (err) { console.warn('[Jobs] orphan sweep:', err.message); }
            if (now - lastPruneAt > 6 * 3600 * 1000) {
                lastPruneAt = now;
                try { const n = queue.prune({ days: cfg().retentionDays }); if (n) console.log(`[Jobs] pruned ${n} finished thumbnail/hash job(s)`); } catch { /* next time */ }
            }
            for (const lane of lanes()) {
                if (lane.name === 'heavy' && !cfg().heavyWhileRecording && recordingActive()) continue;
                while (inLane(lane.name) < lane.max) {
                    const row = queue.claim(lane.types, { leaseS: cfg().leaseS });
                    if (!row) break;
                    execute(row, lane.name);
                }
            }
        } while (kicked);
    } catch (err) {
        console.warn('[Jobs] tick:', err.message);
    } finally {
        ticking = false;
    }
}

/** Look for work now (after an enqueue or approval). */
function kick() {
    if (!started) return;
    setImmediate(() => { tick().catch(() => {}); });
}

/** Ask a job running in this process to stop (its owner cancelled it). */
function abort(id) {
    const r = running.get(id);
    if (r) r.ac.abort(new Error('cancelled by its owner'));
    return !!r;
}

function start() {
    if (started || !cfg().enabled) return false;
    started = true;
    const n = queue.recoverInterrupted({ all: true });
    if (n) console.log(`[Jobs] ${n} job(s) interrupted by the restart were requeued or failed`);
    lastScheduleAt = Date.now();           // the first scheduled scan waits a few minutes after boot
    timer = setInterval(() => { tick().catch(() => {}); }, cfg().pollMs);
    if (timer.unref) timer.unref();
    setTimeout(() => { tick().catch(() => {}); }, 1000).unref?.();
    console.log(`[Jobs] worker started (light ${cfg().lightConcurrency}, heavy ${cfg().heavyConcurrency}, poll ${cfg().pollMs} ms)`);
    return true;
}

/** Stop polling and abort running jobs; they are requeued at the next start. */
function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    for (const r of running.values()) r.ac.abort(new Error('the service is stopping'));
}

function status() {
    return { enabled: cfg().enabled, started, running: [...running.entries()].map(([id, r]) => ({ id, lane: r.lane })), counts: queue.counts() };
}

module.exports = { start, stop, kick, tick, abort, runNow, execute, status, scheduleInvariantScans, isStarted: () => started, _running: running };
