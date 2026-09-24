/**
 * OpenVibe.Media — job type vod.duration.reconcile (heavy lane): one bounded batch of the tenant's
 * finished VODs, stored duration vs a measurement of the real file (local, or the B2/R2 copy through
 * a presigned ranged read). server/vod/duration-reconcile.js has the rules.
 *
 *   params { limit (1-200, default 25), after_id?, apply (default false), confirm_remote (default false) }
 *   result { mode, counts, range, next_after_id, report }   report = the file name under <data>/reports/
 *
 * Without after_id the job walks the tenant's library: it starts where the previous run stopped
 * (media_settings duration_reconcile.cursor.<app>) and wraps to the start when it reaches the end.
 * apply=false only reports. Scheduling is off unless MEDIA_DURATION_RECONCILE_HOURS > 0; scheduled
 * runs repair only with MEDIA_DURATION_RECONCILE_APPLY=1 (batch MEDIA_DURATION_RECONCILE_BATCH, 25).
 */
'use strict';

const path = require('path');
const db = require('../db/database');
const queue = require('./queue');
const reconcile = require('../vod/duration-reconcile');

const { JobError } = queue;
const TYPE = 'vod.duration.reconcile';
const cursorKey = (appId) => `duration_reconcile.cursor.${appId}`;
const bool = (v) => v === true || v === 1 || ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase());

function envInt(name, fallback) {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) ? v : fallback;
}

function validate({ obj, params }) {
    if (obj) throw new JobError('media.job.invalid', `${TYPE} covers the tenant's VODs: leave object_id out`, { permanent: true });
    const p = params || {};
    const limit = p.limit == null ? 25 : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > reconcile.MAX_BATCH) throw new JobError('media.job.invalid', `params.limit must be 1-${reconcile.MAX_BATCH}`, { permanent: true });
    const out = { limit, apply: bool(p.apply), confirm_remote: bool(p.confirm_remote) };
    if (p.after_id != null) {
        const a = Number(p.after_id);
        if (!Number.isInteger(a) || a < 0) throw new JobError('media.job.invalid', 'params.after_id must be a non-negative integer', { permanent: true });
        out.after_id = a;
    }
    return out;
}

async function run(job, ctx = {}) {
    const p = validate({ obj: null, params: job.params });
    const walking = p.after_id == null;
    const afterId = walking ? (Number(db.getSetting(cursorKey(job.app_id))) || 0) : p.after_id;
    const report = await reconcile.reconcileBatch({
        appId: job.app_id, afterId, limit: p.limit, apply: p.apply, confirmRemote: p.confirm_remote, signal: ctx.signal,
    });
    report.job_id = job.id;
    const file = reconcile.writeReport(report);
    const next = report.range.done ? 0 : report.range.last_id;
    if (walking) db.setSetting(cursorKey(job.app_id), next, 'number');
    return { mode: report.mode, counts: report.counts, range: report.range, next_after_id: next, report: path.basename(file) };
}

/** Queue one run per tenant with VODs every MEDIA_DURATION_RECONCILE_HOURS (0 = never). Returns how many. */
function schedule(nowMs = Date.now()) {
    const hours = envInt('MEDIA_DURATION_RECONCILE_HOURS', 0);
    if (!(hours > 0)) return 0;
    const period = Math.floor(nowMs / (hours * 3600 * 1000));
    const apply = bool(process.env.MEDIA_DURATION_RECONCILE_APPLY || '');
    const limit = Math.min(reconcile.MAX_BATCH, Math.max(1, envInt('MEDIA_DURATION_RECONCILE_BATCH', 25)));
    let n = 0;
    for (const { app_id: appId } of db.all('SELECT DISTINCT app_id FROM vods WHERE COALESCE(is_recording, 0) = 0 AND file_path IS NOT NULL')) {
        try {
            const r = queue.enqueue({ appId, type: TYPE, params: { limit, apply, confirm_remote: false }, idempotencyKey: `${TYPE}:${hours}h:${period}`, createdBy: 'system:schedule' });
            if (r.created) n++;
        } catch (err) { console.warn(`[Jobs] could not schedule ${TYPE} for ${appId}: ${err.message}`); }
    }
    return n;
}

module.exports = {
    TYPE,
    spec: { lane: 'heavy', maxAttempts: 2, timeoutMs: 60 * 60 * 1000, needsObject: false, validate, run },
    schedule, cursorKey,
};
