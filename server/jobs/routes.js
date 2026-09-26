/**
 * OpenVibe.Media — Jobs API v2 (mounted at /api/v2/:app/jobs; docs/object-model.md#jobs)
 *
 * GET    /                    cursor list, newest first (?status&type&object_id&limit&cursor)
 * POST   /                    { type, object_id?, params?, max_attempts? } + Idempotency-Key
 *                              -> 202 { job } new | 200 { job } + Idempotent-Replayed: true
 * GET    /:jobId              one job
 * POST   /:jobId/approve      a proposal (status proposed) -> queued
 * POST   /:jobId/cancel       cancel (also DELETE /:jobId): proposed/queued at once -> 200;
 *                              running -> 202 { job } with cancel_requested until it stops; finished -> 409
 *
 * Auth as the objects API: the app key, or a Network token holding the verb (server/auth.js VERBS):
 * list (GET /) and read (GET /:jobId) for the tenant's root namespace; transform (create, approve,
 * cancel: media.derivative.create, or media.object.upload as before) for the namespace of the job's
 * object (the root for a job with none); a developer project's app tokens on its own tenant. With
 * X-OV-User-Id (app key) the caller acts for one of the app's users: it sees and decides only jobs
 * it created or jobs on objects it owns, and creates jobs on its own objects only. Errors are RFC
 * 9457 problems.
 */
'use strict';

const express = require('express');
const { http } = require('openvibe-contracts');
const model = require('../objects/model');
const queue = require('./queue');
const db = require('../db/database');
const { tenantAuth, tenantCors, namespaceGrant } = require('../auth');

const transform = tenantAuth({ verb: 'transform', namespaced: true });
const read = tenantAuth({ verb: 'read' });
const list = tenantAuth({ verb: 'list' });

function problem(res, status, code, detail, extra) {
    return http.sendProblem(res, status, code, { detail, extra });
}

function who(req) {
    if (req.principal) return req.principal.sub;
    return `app:${req.appId}${req.authType === 'user' ? `:user:${req.userId}` : ''}`;
}

function ownsJob(req, job) {
    if (req.authType !== 'user') return true;
    if (job.owner_user_id != null && job.owner_user_id === req.userId) return true;
    const obj = job.object_id ? model.getObject(job.object_id) : null;
    return !!(obj && obj.owner_user_id != null && obj.owner_user_id === req.userId);
}

function load(req, res) {
    const job = queue.getForApp(String(req.params.jobId || ''), req.appId);
    if (!job || !ownsJob(req, job)) { problem(res, 404, 'media.job.not_found', 'No such job in this namespace'); return null; }
    return job;
}

/** Transform is granted per namespace: the job's object's, or the tenant's root for a job with none (else answered). */
function mayTransform(req, res, obj) {
    const g = namespaceGrant(req, 'transform', obj ? obj.namespace : db.rootNamespace(req.appRow));
    if (!g.allowed) { problem(res, 403, g.code, g.reason); return false; }
    return true;
}

function sendJobError(res, err) {
    if (err instanceof queue.JobError) {
        if (err.retryAfterS) res.set('Retry-After', String(err.retryAfterS));
        return problem(res, err.status || 400, err.code, err.message);
    }
    console.error('[Jobs] API error:', err.message);
    return problem(res, 500, 'media.job.failed_request', 'Job request failed');
}

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

router.get('/', list, (req, res) => {
    try {
        const q = req.query;
        if (q.cursor && !/^mjob_[0-9A-Za-z_]{1,40}$/.test(String(q.cursor))) return problem(res, 400, 'media.job.invalid', 'Bad cursor');
        if (q.status && !queue.STATUSES.includes(String(q.status))) return problem(res, 400, 'media.job.invalid', `status must be one of ${queue.STATUSES.join(', ')}`);
        const out = queue.list(req.appId, {
            status: q.status, type: q.type, objectId: q.object_id, cursor: q.cursor, limit: q.limit,
            actingUserId: req.authType === 'user' ? req.userId : null,
        });
        res.json({ jobs: out.jobs.map(queue.jobPublic), next_cursor: out.next_cursor, limit: out.limit });
    } catch (err) { sendJobError(res, err); }
});

router.post('/', transform, (req, res) => {
    try {
        const b = req.body || {};
        const type = String(b.type || '');
        const spec = queue.typeSpec(type);
        if (!spec) return problem(res, 400, 'media.job.unknown_type', `type must be one of ${queue.typeNames().join(', ')}`);
        let obj = null;
        if (b.object_id != null && b.object_id !== '') {
            obj = model.resolveObject(String(b.object_id), req.appId);
            if (!obj || (req.authType === 'user' && obj.visibility === 'private' && obj.owner_user_id !== req.userId)) {
                return problem(res, 404, 'media.object.not_found', 'No such object in this namespace');
            }
            if (req.authType === 'user' && obj.owner_user_id !== req.userId) return problem(res, 403, 'media.object.forbidden', 'Not your object');
        } else if (spec.needsObject) {
            return problem(res, 400, 'media.job.invalid', `${type} needs object_id`);
        }
        if (!mayTransform(req, res, obj)) return;
        if (b.params != null && (typeof b.params !== 'object' || Array.isArray(b.params) || JSON.stringify(b.params).length > 16384)) {
            return problem(res, 400, 'media.job.invalid', 'params must be an object of at most 16 KB');
        }
        const params = spec.validate ? spec.validate({ appId: req.appId, obj, params: b.params || {} }) : (b.params || {});
        const key = req.headers['idempotency-key'] || b.idempotency_key || null;
        if (key != null && !/^[\x21-\x7e]{1,200}$/.test(String(key))) return problem(res, 400, 'media.job.invalid', 'Idempotency-Key must be 1-200 visible ASCII characters');
        const r = queue.enqueue({
            appId: req.appId, type, objectId: obj ? obj.id : null, params, idempotencyKey: key,
            createdBy: who(req), ownerUserId: req.authType === 'user' ? req.userId : null, maxAttempts: b.max_attempts,
        });
        if (r.replayed) res.set('Idempotent-Replayed', 'true');
        else require('./worker').kick();
        res.status(r.created ? 202 : 200).json({ job: queue.jobPublic(r.job) });
    } catch (err) { sendJobError(res, err); }
});

router.get('/:jobId', read, (req, res) => {
    const job = load(req, res);
    if (job) res.json({ job: queue.jobPublic(job) });
});

router.post('/:jobId/approve', transform, (req, res) => {
    try {
        const job = load(req, res);
        if (!job || !mayTransform(req, res, job.object_id ? model.getObject(job.object_id) : null)) return;
        if (job.status !== 'proposed') return problem(res, 409, 'media.job.not_proposed', `The job is ${job.status}; only proposals are approved`);
        const out = queue.approve(job.id, { by: who(req) });
        if (!out) return problem(res, 409, 'media.job.not_proposed', 'The job was decided meanwhile');
        require('./worker').kick();
        res.json({ job: queue.jobPublic(out) });
    } catch (err) { sendJobError(res, err); }
});

function cancelHandler(req, res) {
    try {
        const job = load(req, res);
        if (!job || !mayTransform(req, res, job.object_id ? model.getObject(job.object_id) : null)) return;
        const out = queue.cancel(job.id, { by: who(req) });
        if (out.finished) return problem(res, 409, 'media.job.finished', `The job already ${out.job.status}`);
        res.status(out.pending ? 202 : 200).json({ job: queue.jobPublic(out.job) });
    } catch (err) { sendJobError(res, err); }
}
router.post('/:jobId/cancel', transform, cancelHandler);
router.delete('/:jobId', transform, cancelHandler);

module.exports = router;
