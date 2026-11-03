/**
 * OpenVibe.Media — job type storage.recordings.cleanup (light lane): deletes recording files nothing uses
 * (server/vod/recording-cleanup.js has the rules: files of deleted VODs, and duplicates whose VOD's own copy is there
 * with the same size; a grace period, holds and every other prefix are respected). Service-wide, like
 * storage.orphans.scan: it runs under queue.SYSTEM_APP, which no tenant reaches.
 *
 *   params { dry_run?: boolean }   result { deleted, bytes, kept, failed, checked, summary }
 *
 * Queued once a day (MEDIA_RECORDING_CLEANUP_DAYS, 1; 0 = never) by the worker, which does not start in a drill.
 */
'use strict';

const queue = require('./queue');
const cleanup = require('../vod/recording-cleanup');

const { JobError } = queue;
const TYPE = 'storage.recordings.cleanup';

function validate({ appId, obj, params }) {
    if (appId !== queue.SYSTEM_APP) throw new JobError('media.job.forbidden', `${TYPE} covers the whole service's storage: it runs on its schedule`, { status: 403, permanent: true });
    if (obj) throw new JobError('media.job.invalid', `${TYPE} covers the whole storage: leave object_id out`, { permanent: true });
    return { dry_run: !!(params && params.dry_run) };
}

async function run(job) {
    const r = await cleanup.run({ dryRun: !!(job.params && job.params.dry_run) });
    const summary = cleanup.summarize(r);
    console.log(`[Cleanup] recordings: ${summary}`);
    return { deleted: r.deleted, bytes: r.bytes, kept: r.kept, failed: r.failed, checked: r.checked, summary };
}

/** Queue one clean-up every MEDIA_RECORDING_CLEANUP_DAYS (default 1; 0 = never). Returns how many were queued. */
async function schedule(nowMs = Date.now()) {
    const raw = parseInt(process.env.MEDIA_RECORDING_CLEANUP_DAYS || '', 10);
    const days = Number.isFinite(raw) ? raw : 1;
    if (!(days > 0)) return 0;
    const period = Math.floor(nowMs / (days * 86400 * 1000));
    try {
        const r = await queue.enqueue({ appId: queue.SYSTEM_APP, type: TYPE, params: {}, idempotencyKey: `${TYPE}:${days}d:${period}`, createdBy: 'system:schedule' });
        return r.created ? 1 : 0;
    } catch (err) {
        console.warn(`[Jobs] could not schedule ${TYPE}: ${err.message}`);
        return 0;
    }
}

module.exports = { TYPE, spec: { lane: 'light', maxAttempts: 2, timeoutMs: 2 * 60 * 60 * 1000, needsObject: false, validate, run }, schedule };
