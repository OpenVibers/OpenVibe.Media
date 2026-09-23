/**
 * OpenVibe.Media — job type invariant.scan: the size-invariant validator (light lane)
 *
 * Scans one tenant's public playback objects (server/objects/invariant.js: ready vods/clips that are
 * public or unlisted), records media_invariant_violations, and PROPOSES one job per object above the
 * max (MEDIA_PUBLIC_OBJECT_MAX_MB, 500 MB):
 *
 *   object.split  when the duration is known: stream-copy parts of about the target size
 *                 (MEDIA_PUBLIC_OBJECT_TARGET_MB), each a new private object derived from the source
 *   object.remux  when it is not: a stream-copy remux writes the index and duration, so a split can be
 *                 planned from the remuxed copy
 *
 * Proposals wait in status `proposed` for the owner (approve -> queued, cancel -> cancelled): nothing
 * is split, remuxed, re-encoded or made private automatically. Idempotency key
 * invariant:<object id>:<type>, so a later scan never proposes the same thing twice and an owner's
 * "no" (cancelled) stands. A proposal whose object stopped violating (made private, deleted, shrunk)
 * is withdrawn (cancelled by system:invariant.scan).
 *
 *   result { thresholds, counts, violations, proposed, already_proposed, withdrawn, by_type }
 */
'use strict';

const db = require('../db/database');
const invariant = require('../objects/invariant');
const model = require('../objects/model');
const queue = require('./queue');

const MAX_PARTS = 1000;
const SYSTEM = 'system:invariant.scan';

/** What to propose for one violating object: { type, params }. */
function planFor(obj, t = invariant.thresholds()) {
    const md = model.parseJson(obj.metadata, {});
    const size = Number(obj.size_bytes) || 0;
    const duration = Number(md.duration_seconds) || 0;
    const target = Math.max(1, t.targetBytes);
    const parts = Math.min(MAX_PARTS, Math.max(2, Math.ceil(size / target)));
    const base = { source_size_bytes: size, target_bytes: t.targetBytes, max_bytes: t.maxBytes, reason: 'public_object_too_large' };
    if (duration > 0) {
        return { type: 'object.split', params: { ...base, parts, segment_seconds: Math.max(1, Math.ceil(duration / parts)), source_duration_seconds: duration } };
    }
    return { type: 'object.remux', params: { ...base, note: 'duration unknown: a stream-copy remux writes it (and the seek index), then a split can be planned' } };
}

function proposalKey(objectId, type) {
    return `invariant:${objectId}:${type}`;
}

/**
 * The validator. `dryRun` writes nothing (no violation rows, no proposals) and returns what it would
 * propose. Used by the job below and by scripts/media-jobs.js scan.
 */
function scanTenant(appId, { dryRun = false, scanJobId = null } = {}) {
    const report = invariant.scan({ record: !dryRun, appId });
    const t = report.thresholds;
    const out = {
        thresholds: t, counts: report.counts, violations: 0, proposed: 0, already_proposed: 0, withdrawn: 0,
        by_type: {}, dry_run: dryRun, proposals: [],
    };
    const violating = new Set();
    for (const v of report.objects) {
        if (v.level !== 'violation') continue;
        out.violations++;
        violating.add(v.object_id);
        const obj = model.getObject(v.object_id);
        if (!obj) continue;
        const plan = planFor(obj, t);
        out.by_type[plan.type] = (out.by_type[plan.type] || 0) + 1;
        const key = proposalKey(obj.id, plan.type);
        if (dryRun) {
            const prior = db.get('SELECT id, status FROM media_jobs WHERE app_id = ? AND idempotency_key = ?', [appId, key]);
            if (prior) out.already_proposed++; else out.proposed++;
            out.proposals.push({ object_id: obj.id, legacy_ref: obj.legacy_ref, size_bytes: obj.size_bytes, type: plan.type, params: plan.params, existing: prior || null });
            continue;
        }
        try {
            const r = queue.enqueue({
                appId, type: plan.type, objectId: obj.id, params: plan.params, status: 'proposed',
                idempotencyKey: key, createdBy: scanJobId ? `${SYSTEM}:${scanJobId}` : SYSTEM,
            });
            if (r.created) out.proposed++; else out.already_proposed++;
        } catch (err) {
            if (err.code !== 'media.job.idempotency_conflict') throw err;
            out.already_proposed++;             // proposed before with other numbers: the earlier proposal (and any decision on it) stands
        }
    }
    // Withdraw open proposals whose object no longer breaks the policy.
    const open = db.all(`SELECT id, object_id FROM media_jobs WHERE app_id = ? AND status = 'proposed' AND created_by LIKE ?`, [appId, `${SYSTEM}%`]);
    for (const p of open) {
        if (violating.has(p.object_id)) continue;
        if (dryRun) { out.withdrawn++; continue; }
        const r = queue.cancel(p.id, { by: SYSTEM, reason: 'the object no longer breaks the public size policy' });
        if (r && r.job && r.job.status === 'cancelled') out.withdrawn++;
    }
    if (!dryRun) delete out.proposals;
    return out;
}

async function run(job) {
    return scanTenant(job.app_id, { scanJobId: job.id });
}

function validate({ obj }) {
    if (obj) throw new queue.JobError('media.job.invalid', 'invariant.scan covers the whole tenant: leave object_id out', { permanent: true });
    return {};
}

module.exports = {
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 10 * 60 * 1000, needsObject: false, validate, run },
    planFor, scanTenant, proposalKey,
};
