/**
 * OpenVibe.Media — job type storage.orphans.scan (light lane): the storage orphan report
 * (server/vod/orphans-report.js buildStorageReport) across the whole service. Report only: it walks the
 * data directories, lists the B2/R2 buckets (keys and open multipart uploads), reads the database and
 * writes <data>/reports/storage-orphans-<time>.json. It never deletes, moves or changes a file, a bucket
 * object or a row.
 *
 *   params { limit (1-100000, default 2000): items listed per section; the totals count everything }
 *   result { totals, providers, summary, report }   report = the file name under <data>/reports/
 *
 * Storage is shared by every tenant, so the job belongs to none: it runs under queue.SYSTEM_APP, which no
 * API credential reaches (no apps row), announces no media.job.* event, and cannot be enqueued through
 * /api/v2/:app/jobs (validate refuses every tenant). Scheduled every MEDIA_ORPHAN_SCAN_DAYS (30; 0 = never)
 * by the worker, which does not start in a restore drill. On demand: scripts/vods-orphans-report.js --storage.
 */
'use strict';

const path = require('path');
const queue = require('./queue');
const orphans = require('../vod/orphans-report');

const { JobError } = queue;
const TYPE = 'storage.orphans.scan';

function envInt(name, fallback) {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) ? v : fallback;
}

function checkParams(params) {
    const p = params || {};
    const limit = p.limit == null ? 2000 : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new JobError('media.job.invalid', 'params.limit must be 1-100000', { permanent: true });
    return { limit };
}

function validate({ appId, obj, params }) {
    if (appId !== queue.SYSTEM_APP) {
        throw new JobError('media.job.forbidden', `${TYPE} covers the whole service's storage: it runs on its schedule or from scripts/vods-orphans-report.js --storage`, { status: 403, permanent: true });
    }
    if (obj) throw new JobError('media.job.invalid', `${TYPE} covers the whole storage: leave object_id out`, { permanent: true });
    return checkParams(params);
}

async function run(job) {
    const p = checkParams(job.params);
    const report = await orphans.buildStorageReport({ limit: p.limit });
    report.job_id = job.id;
    const file = orphans.writeStorageReport(report);
    const summary = orphans.summarizeStorage(report);
    console.log(`[Orphans] ${summary} (report ${path.basename(file)}; nothing was deleted)`);
    return { totals: report.totals, providers: report.scope.providers, summary, report: path.basename(file) };
}

/** Queue one scan every MEDIA_ORPHAN_SCAN_DAYS (0 = never). Returns how many were queued (0 or 1). */
function schedule(nowMs = Date.now()) {
    const days = envInt('MEDIA_ORPHAN_SCAN_DAYS', 30);
    if (!(days > 0)) return 0;
    const period = Math.floor(nowMs / (days * 86400 * 1000));
    try {
        const r = queue.enqueue({ appId: queue.SYSTEM_APP, type: TYPE, params: {}, idempotencyKey: `${TYPE}:${days}d:${period}`, createdBy: 'system:schedule' });
        return r.created ? 1 : 0;
    } catch (err) {
        console.warn(`[Jobs] could not schedule ${TYPE}: ${err.message}`);
        return 0;
    }
}

module.exports = {
    TYPE,
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 2 * 60 * 60 * 1000, needsObject: false, validate, run },
    schedule,
};
