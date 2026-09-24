/**
 * OpenVibe.Media — job type vod.finalize (finalize lane): finalize a recording whose finalize failed
 * or never ran, with backoff (docs/object-model.md#jobs).
 *
 * Queued by
 *   - the orphan sweep: a vods row still is_recording = 1 that no recorder, chunk upload or finalize
 *     holds and whose file has not grown for MEDIA_FINALIZE_ORPHAN_GRACE_S (default 180 s). At boot
 *     (every recording of the previous process) and every MEDIA_FINALIZE_SWEEP_S (120 s) after that.
 *   - finalize itself, when it could not settle a recording: nothing measurable (duration stored 0,
 *     needs_review), the file could not be stat'ed, or it threw. First retry after 5 minutes.
 *   - the v2 jobs API (POST /api/v2/:app/jobs { type: 'vod.finalize', params: { vod_id } }).
 *
 *   params { vod_id }   (derived from the object's legacy ref when omitted)
 *   result { outcome: ready | needs_review | corrupt | deleted | skipped, vod_id, duration_seconds?,
 *            duration_source?, health_status?, reason? }
 * A run that still cannot measure the recording fails with a retryable code (unmeasurable,
 * stat_failed, finalize_threw); the worker retries it (5 min, 15 min, 45 min, 2 h 15, then 6 h;
 * 6 attempts). When the attempts run out the VOD stays needs_review, hidden, for a person.
 * The job never stops a running recording and never runs while a chunk upload is still adding to it.
 */
'use strict';

const fs = require('fs');
const db = require('../db/database');
const queue = require('./queue');

const { JobError } = queue;
const TYPE = 'vod.finalize';
// Outcomes of a finalize that another attempt may fix (see server/vod/finalize.js FINALIZE_ISSUES).
const RETRYABLE = { probe_failed: 'unmeasurable', inflated_duration: 'unmeasurable', stat_failed: 'stat_failed', finalize_failed: 'finalize_threw' };

function envInt(name, fallback) {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const graceMs = () => envInt('MEDIA_FINALIZE_ORPHAN_GRACE_S', 180) * 1000;
const sweepEveryMs = () => envInt('MEDIA_FINALIZE_SWEEP_S', 120) * 1000;

function issuesOf(vod) {
    try { const v = JSON.parse(vod.health_issues_json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function chunkUploadActive(vodId) {
    try { return require('../vod/routes').activeChunkUploads.has(Number(vodId)); } catch { return false; }
}

/** Something in this process is still writing or finalizing the recording. */
function busy(vodId) {
    try { if (require('../vod/recorder').isRecording(vodId)) return 'recording'; } catch { /* */ }
    try { if (require('../vod/finalize').isFinalizing(vodId)) return 'finalizing'; } catch { /* */ }
    if (chunkUploadActive(vodId)) return 'chunk upload in progress';
    return null;
}

function vodIdOf(obj, params = {}) {
    if (params.vod_id != null) return Number(params.vod_id);
    if (obj) {
        const ref = require('../objects/model').parseLegacyRef(obj.legacy_ref);
        if (ref && ref.kind === 'vod') return Number(ref.id);
    }
    return null;
}

/** API validation: the VOD must be this tenant's (and the named object's). */
function validate({ appId, obj, params }) {
    const id = vodIdOf(obj, params || {});
    if (!Number.isInteger(id) || id < 1) throw new JobError('media.job.invalid', 'vod.finalize needs params.vod_id (or a vod object)', { permanent: true });
    const vod = db.getVodById(id, appId);
    if (!vod) throw new JobError('media.job.not_found', `vod ${id} not found`, { status: 404, permanent: true });
    if (obj && vod.object_id && vod.object_id !== obj.id) throw new JobError('media.job.invalid', `the object is not vod ${id}`, { permanent: true });
    return { vod_id: id };
}

/** Does this VOD still need a finalize? Returns the reason, or null. */
function needsFinalize(vod) {
    if (!vod) return null;
    if (vod.is_recording) return 'orphan';
    const retry = issuesOf(vod).find(i => RETRYABLE[i]);
    return retry && vod.health_status === 'needs_review' ? retry : null;
}

async function run(job) {
    const vodId = Number(job.params && job.params.vod_id);
    const vod = db.getVodById(vodId, job.app_id);
    if (!vod) return { outcome: 'skipped', vod_id: vodId, reason: 'the vod no longer exists' };
    const holder = busy(vodId);
    if (holder === 'finalizing') throw new JobError('busy', 'a finalize of this vod is already running', { retryAfterS: 60 });
    if (holder) return { outcome: 'skipped', vod_id: vodId, reason: `${holder}: that path finalizes it` };
    const why = needsFinalize(vod);
    if (!why) return { outcome: 'skipped', vod_id: vodId, reason: 'already finalized', health_status: vod.health_status };

    try {
        await require('../vod/finalize').finalizeVod(vodId, { fromJob: true });
    } catch (err) {
        throw new JobError('finalize_threw', `finalize failed: ${err.message}`);
    }
    const after = db.getVodById(vodId, job.app_id);
    if (!after) return { outcome: 'deleted', vod_id: vodId, reason: 'no media was ever written (empty or missing file)' };
    if (after.is_recording) throw new JobError('busy', 'the vod is still marked recording after finalize', { retryAfterS: 60 });
    const still = issuesOf(after).find(i => RETRYABLE[i]);
    if (still && after.health_status === 'needs_review') {
        throw new JobError(RETRYABLE[still], `vod ${vodId} still cannot be settled (${issuesOf(after).join(', ')})`);
    }
    return {
        outcome: after.health_status === 'ok' ? 'ready' : after.health_status,
        vod_id: vodId, duration_seconds: after.duration_seconds, duration_source: after.duration_source || null,
        health_status: after.health_status,
    };
}

/**
 * Queue a finalize for this VOD (joins one that is already queued or running). Never throws;
 * returns { job, created } or null. `reason` goes into created_by (system:vod.finalize:<reason>).
 */
function queueFinalize(vodOrId, reason, { runAfterS = 0 } = {}) {
    try {
        const vod = typeof vodOrId === 'object' ? vodOrId : db.getVodById(Number(vodOrId));
        if (!vod) return null;
        const r = queue.enqueue({
            appId: vod.app_id, type: TYPE, objectId: vod.object_id || null, params: { vod_id: vod.id },
            dedupeActive: true, createdBy: `system:${TYPE}:${reason}`, runAfterS,
        });
        if (r.created) {
            console.log(`[Jobs] vod.finalize queued for vod ${vod.id} (${reason}${runAfterS ? `, in ${runAfterS} s` : ''})`);
            try { require('./worker').kick(); } catch { /* next poll */ }
        }
        return { job: r.job, created: r.created };
    } catch (err) {
        console.warn(`[Jobs] could not queue vod.finalize for vod ${typeof vodOrId === 'object' ? vodOrId.id : vodOrId}: ${err.message}`);
        return null;
    }
}

/**
 * Recordings left is_recording = 1 with nothing holding them. `graceMs`: the file must not have
 * changed for this long (a chunk upload resuming after a restart keeps writing it). Returns ids.
 */
function orphans({ grace = graceMs(), now = Date.now() } = {}) {
    const out = [];
    // clips_only recordings too: their finalize discards them (file and row).
    for (const row of db.all('SELECT id, file_path FROM vods WHERE is_recording = 1 ORDER BY id')) {
        if (busy(row.id)) continue;
        let mtime = 0;
        try { mtime = row.file_path ? fs.statSync(row.file_path).mtimeMs : 0; } catch { mtime = 0; }
        if (mtime && now - mtime < grace) continue;
        out.push(row.id);
    }
    return out;
}

let lastSweepAt = 0;

/** Queue vod.finalize for every orphan (due every MEDIA_FINALIZE_SWEEP_S; `force` = now). */
function sweepOrphans({ force = false, now = Date.now(), grace } = {}) {
    if (!force && now - lastSweepAt < sweepEveryMs()) return 0;
    lastSweepAt = now;
    let n = 0;
    for (const id of orphans({ grace, now })) { const r = queueFinalize(id, 'orphan'); if (r && r.created) n++; }
    return n;
}

// 5 min, 15 min, 45 min, 2 h 15, then 6 h.
const backoffS = (attempt) => Math.min(6 * 3600, 300 * 3 ** Math.max(0, attempt - 1));

module.exports = {
    TYPE,
    spec: { lane: 'finalize', maxAttempts: 6, timeoutMs: 60 * 60 * 1000, needsObject: false, backoffS, validate, run },
    queueFinalize, sweepOrphans, orphans, needsFinalize, backoffS, RETRYABLE,
    _resetSweep: () => { lastSweepAt = 0; },
};
