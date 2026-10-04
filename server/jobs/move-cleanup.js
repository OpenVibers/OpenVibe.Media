/**
 * OpenVibe.Media — job type storage.move.cleanup (light lane): the loud half of a two-phase move's second phase
 * (docs/media-fabric.md §6). Once a move's new location is committed the old bytes are deleted; the sweep
 * (server/objects/tiering.js) retries a failed delete after FAILED_BACKOFF_H, and every failure is a `failed` row
 * in media_object_tier_decisions. This job reads those rows: an object whose move failed FAIL_THRESHOLD times
 * within the lookback (a later `done` of the same move starts the count over) raises one storage.alert of kind
 * move_cleanup_failed, which vod-storage's emitStorageEvent counts in media_storage_alerts_total{kind} and
 * delivers as the Events outbox row and per-app webhook. Report only: it never moves, deletes or changes a row.
 *
 *   params {}   service-wide; runs only under queue.SYSTEM_APP (no tenant can enqueue it)
 *   result { scanned, alerted, objects }   objects = the first 50 (object_id, action, fails, first_at, last_at, last_error)
 *
 * Scheduled every MEDIA_MOVE_CLEANUP_MINUTES (60; 0 = never) by the worker, which does not start in a restore drill.
 */
'use strict';

const db = require('../db/database');
const queue = require('./queue');

const { JobError } = queue;
const TYPE = 'storage.move.cleanup';
const FAIL_THRESHOLD = 3;
const LOOKBACK_H = 24 * 7;
const LISTED = 50;

function envInt(name, fallback) {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) ? v : fallback;
}

/** Moves (object + action) with at least `threshold` failures in the window since their last `done`. */
async function failedMoves({ threshold = FAIL_THRESHOLD, lookbackH = LOOKBACK_H } = {}) {
    return (await db.all(`
        SELECT f.object_id, f.action, MAX(f.app_id) AS app_id, COUNT(*) AS fails,
               MIN(f.decided_at) AS first_at, MAX(f.decided_at) AS last_at,
               (ARRAY_AGG(f.error ORDER BY f.decided_at DESC, f.id DESC))[1] AS last_error
          FROM media_object_tier_decisions f
         WHERE f.outcome = 'failed' AND f.decided_at >= ov_now_iso(?)
           AND NOT EXISTS (SELECT 1 FROM media_object_tier_decisions d
                            WHERE d.object_id = f.object_id AND d.action = f.action AND d.outcome = 'done' AND d.decided_at > f.decided_at)
         GROUP BY f.object_id, f.action
        HAVING COUNT(*) >= ?
         ORDER BY MAX(f.decided_at) DESC, f.object_id`, [`-${lookbackH} hours`, threshold])).map((r) => ({ ...r, fails: Number(r.fails) }));
}

function validate({ appId, obj }) {
    if (appId !== queue.SYSTEM_APP) {
        throw new JobError('media.job.forbidden', `${TYPE} covers the whole service's placement: it runs on its schedule`, { status: 403, permanent: true });
    }
    if (obj) throw new JobError('media.job.invalid', `${TYPE} covers every object: leave object_id out`, { permanent: true });
    return {};
}

async function run() {
    const rows = await failedMoves();
    if (!rows.length) return { scanned: 0, alerted: 0, objects: [] };
    const objects = rows.slice(0, LISTED);
    // emitStorageEvent counts media_storage_alerts_total{kind="move_cleanup_failed"} itself (one alert per cooldown, so the
    // payload carries the list and the kind stays a fixed label, never per object).
    const sent = await require('../vod/vod-storage').emitStorageEvent('storage.alert', 'move_cleanup_failed', { count: rows.length, objects });
    return { scanned: rows.length, alerted: sent ? rows.length : 0, objects };
}

/** Queue one run every MEDIA_MOVE_CLEANUP_MINUTES (0 = never). Returns how many were queued (0 or 1). */
async function schedule(nowMs = Date.now()) {
    const minutes = envInt('MEDIA_MOVE_CLEANUP_MINUTES', 60);
    if (!(minutes > 0)) return 0;
    const period = Math.floor(nowMs / (minutes * 60 * 1000));
    try {
        const r = await queue.enqueue({ appId: queue.SYSTEM_APP, type: TYPE, params: {}, idempotencyKey: `${TYPE}:${minutes}m:${period}`, createdBy: 'system:schedule' });
        return r.created ? 1 : 0;
    } catch (err) {
        console.warn(`[Jobs] could not schedule ${TYPE}: ${err.message}`);
        return 0;
    }
}

module.exports = {
    TYPE, FAIL_THRESHOLD, failedMoves,
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 5 * 60 * 1000, needsObject: false, validate, run },
    schedule,
};
