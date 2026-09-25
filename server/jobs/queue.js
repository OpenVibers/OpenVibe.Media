/**
 * OpenVibe.Media — job queue (media_jobs; docs/object-model.md#jobs)
 *
 * States:
 *   proposed   waiting for its owner to decide (approve -> queued, cancel -> cancelled). The worker never
 *              picks it up: the size-invariant validator proposes split/remux jobs this way.
 *   queued     due when run_after has passed
 *   running    held by the worker (lease_until renewed while it runs)
 *   succeeded | failed | cancelled   finished
 *
 * Every state change and its media.job.<transition> event commit in ONE SQLite transaction (the same
 * rule as webhooks.announce(), see events.js): an event exists if and only if its change committed.
 * The relay is woken after the commit. Job events go to OpenVibe.Events only (no app webhook).
 *
 * Idempotency: a key is unique per tenant. A repeat with the same key and the same request (type,
 * object, params) answers with the job it made; a different request under a used key is a conflict.
 * `dedupeActive` instead joins an identical job that is still queued or running (thumbnail requests).
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ids } = require('openvibe-contracts');
const db = require('../db/database');
const events = require('../events');

const STATUSES = ['proposed', 'queued', 'running', 'succeeded', 'failed', 'cancelled'];
const FINISHED = ['succeeded', 'failed', 'cancelled'];
const ACTIVE = ['queued', 'running'];
const MAX_ACTIVE_PER_TENANT = 50;   // queued + running jobs one tenant may have (proposals excluded)
// Service-wide maintenance jobs (storage.orphans.scan) belong to no tenant: they run under this app id,
// which has no apps row, so no API credential reaches them, and they announce no events.
const SYSTEM_APP = '_media';

const bus = new EventEmitter();
bus.setMaxListeners(0);

class JobError extends Error {
    /** code: stable machine code; permanent: never retried; status: HTTP status for API answers. */
    constructor(code, message, { permanent = false, status = 400, retryAfterS = null } = {}) {
        super(message);
        this.code = code;
        this.permanent = permanent;
        this.status = status;
        this.retryAfterS = retryAfterS;
    }
}

// ── Types (registered by server/jobs/types.js) ───────────────

const TYPES = new Map();
let builtinsLoaded = false;
function loadBuiltins() {
    if (builtinsLoaded) return;
    builtinsLoaded = true;
    require('./types');
}

/**
 * spec: { lane: 'light'|'heavy', maxAttempts, timeoutMs, needsObject, validate(ctx) -> params, run(job, ctx) -> result,
 *         backoffS(attempt) }
 */
function register(type, spec) {
    TYPES.set(type, { lane: 'light', maxAttempts: 3, timeoutMs: 10 * 60 * 1000, needsObject: false, ...spec, type });
}
function typeSpec(type) {
    loadBuiltins();
    return TYPES.get(type) || null;
}
function typeNames() {
    loadBuiltins();
    return [...TYPES.keys()];
}

// ── Helpers ──────────────────────────────────────────────────

function parseJson(s, fallback) {
    if (s == null || s === '') return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
}

/** JSON with sorted keys, so the same params always hash the same. */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}
function requestHash(type, objectId, params) {
    return crypto.createHash('sha256').update(canonical({ type, object_id: objectId || null, params: params || {} })).digest('hex');
}

function get(id) {
    return id ? db.get('SELECT * FROM media_jobs WHERE id = ?', [String(id)]) : null;
}
function getForApp(id, appId) {
    const row = get(id);
    return row && row.app_id === appId ? row : null;
}

function jobPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        app_id: row.app_id,
        object_id: row.object_id || null,
        type: row.job_type,
        status: row.status,
        params: parseJson(row.params, {}),
        result: parseJson(row.result, null),
        error: row.error || null,
        error_code: row.error_code || null,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        run_after: row.run_after || null,
        cancel_requested: !!row.cancel_requested,
        idempotency_key: row.idempotency_key || null,
        created_by: row.created_by || null,
        owner_user_id: row.owner_user_id ?? null,
        decided_by: row.decided_by || null,
        decided_at: row.decided_at || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        started_at: row.started_at || null,
        finished_at: row.finished_at || null,
    };
}

/** A SQLite UTC time ('YYYY-MM-DD HH:MM:SS') as ISO 8601 UTC ('…T…Z'), or null. */
function isoTime(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The media.job.<transition> event payload: the job's identity, state, counters and times, and whether
 * it has a result. Deliberately not the tenant's params, the idempotency key, the free-text error, the
 * result (a thumbnail URL of a private VOD, for one), created_by/decided_by or owner_user_id (tenant-local
 * user ids): events travel beyond the tenant, and a consumer that needs those GETs the job with its own
 * tenant-scoped token (GET /api/v2/:app/jobs/:id, queue.jobPublic, unchanged).
 */
function jobEvent(row) {
    if (!row) return null;
    return {
        id: row.id,
        app_id: row.app_id,
        object_id: row.object_id || null,
        type: row.job_type,
        status: row.status,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        error_code: row.error_code || null,
        cancel_requested: !!row.cancel_requested,
        has_result: parseJson(row.result, null) != null,
        run_after: isoTime(row.run_after),
        decided_at: isoTime(row.decided_at),
        created_at: isoTime(row.created_at),
        updated_at: isoTime(row.updated_at),
        started_at: isoTime(row.started_at),
        finished_at: isoTime(row.finished_at),
    };
}

/**
 * Run `change()` and, when it reports a change, queue media.job.<transition> for the job, in one
 * transaction; wake the relay and tell waiters after the commit. Returns the job row, or null when
 * `change()` changed nothing (a lost race: the caller decides what that means).
 */
function commit(id, transition, change) {
    let row = null;
    db.getDb().transaction(() => {
        if (!change()) return;
        row = get(id);
        if (transition) events.recordJob(transition, jobEvent(row));
    })();
    if (row) {
        if (transition) events.kick();
        bus.emit('change', row);
        if (FINISHED.includes(row.status)) bus.emit(`finished:${row.id}`, row);
    }
    return row;
}

function update(id, fromStatuses, sets, params = []) {
    const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
    return db.run(`UPDATE media_jobs SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`,
        [...params, id, ...from]).changes > 0;
}

// ── Enqueue ──────────────────────────────────────────────────

/**
 * enqueue({ appId, type, objectId, params, status: 'queued'|'proposed', idempotencyKey, dedupeActive,
 *           createdBy, ownerUserId, maxAttempts, runAfterS })
 *   -> { job, created, replayed, deduped }
 * Throws JobError: media.job.unknown_type, media.job.idempotency_conflict (409), media.job.too_many (429).
 * `params` must already be validated (routes.js / the validator do that through the type's validate()).
 */
function enqueue({ appId, type, objectId = null, params = {}, status = 'queued', idempotencyKey = null, dedupeActive = false,
    createdBy = null, ownerUserId = null, maxAttempts = null, runAfterS = 0 }) {
    const spec = typeSpec(type);
    if (!spec) throw new JobError('media.job.unknown_type', `Unknown job type ${type}`, { status: 400, permanent: true });
    if (!['queued', 'proposed'].includes(status)) throw new Error(`a job starts queued or proposed, not ${status}`);
    const key = idempotencyKey == null || idempotencyKey === '' ? null : String(idempotencyKey).slice(0, 200);
    const hash = requestHash(type, objectId, params);
    let out = null;
    const id = `mjob_${ids.ulid()}`;
    db.getDb().transaction(() => {
        if (key) {
            const prior = db.get('SELECT * FROM media_jobs WHERE app_id = ? AND idempotency_key = ?', [appId, key]);
            if (prior) {
                if (prior.request_hash !== hash) {
                    throw new JobError('media.job.idempotency_conflict', 'This Idempotency-Key was used for a different job request', { status: 409, permanent: true });
                }
                out = { job: prior, created: false, replayed: true, deduped: false };
                return;
            }
        }
        if (dedupeActive) {
            const same = db.get(`SELECT * FROM media_jobs WHERE app_id = ? AND job_type = ? AND request_hash = ? AND status IN ('queued', 'running')
                                 ORDER BY id DESC LIMIT 1`, [appId, type, hash]);
            if (same) { out = { job: same, created: false, replayed: false, deduped: true }; return; }
        }
        if (status === 'queued') {
            const active = db.get("SELECT COUNT(*) AS n FROM media_jobs WHERE app_id = ? AND status IN ('queued', 'running')", [appId]).n;
            if (active >= MAX_ACTIVE_PER_TENANT) {
                throw new JobError('media.job.too_many', `At most ${MAX_ACTIVE_PER_TENANT} jobs may be queued or running per tenant`, { status: 429, retryAfterS: 60 });
            }
        }
        db.run(`INSERT INTO media_jobs (id, app_id, object_id, job_type, status, idempotency_key, request_hash, params, max_attempts,
                    run_after, created_by, owner_user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${runAfterS > 0 ? `datetime('now', '+${Math.round(runAfterS)} seconds')` : 'NULL'}, ?, ?)`,
        [id, appId, objectId, type, status, key, hash, JSON.stringify(params || {}),
            Math.max(1, Math.min(10, Number(maxAttempts) || spec.maxAttempts)), createdBy, ownerUserId ?? null]);
        const row = get(id);
        events.recordJob(status, jobEvent(row));
        out = { job: row, created: true, replayed: false, deduped: false };
    })();
    if (out.created) { events.kick(); bus.emit('change', out.job); }
    return out;
}

// ── Owner decisions ──────────────────────────────────────────

/** proposed -> queued. Returns the job, or null when it is not a proposal (any more). */
function approve(id, { by = null } = {}) {
    return commit(id, 'queued', () => update(id, 'proposed', "status = 'queued', decided_by = ?, decided_at = CURRENT_TIMESTAMP, run_after = NULL", [by]));
}

/**
 * Cancel by the owner. proposed/queued -> cancelled at once. A running job gets cancel_requested and
 * stops at its next check (the worker also aborts it in-process); { job, pending: true } until then.
 * Finished jobs: { job, finished: true } and nothing changes.
 */
function cancel(id, { by = null, reason = null } = {}) {
    const row = get(id);
    if (!row) return null;
    if (FINISHED.includes(row.status)) return { job: row, finished: true };
    if (row.status === 'running') {
        db.run('UPDATE media_jobs SET cancel_requested = 1, decided_by = COALESCE(decided_by, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?', [by, id]);
        try { require('./worker').abort(id); } catch { /* the heartbeat sees the flag */ }
        return { job: get(id), pending: true };
    }
    const done = commit(id, 'cancelled', () => update(id, ['proposed', 'queued'],
        `status = 'cancelled', finished_at = CURRENT_TIMESTAMP, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
         error = COALESCE(?, error), error_code = CASE WHEN ? IS NULL THEN error_code ELSE 'cancelled' END`, [by, reason, reason]));
    if (done) return { job: done };
    return cancel(id, { by, reason });          // it moved on meanwhile (picked up): try again from its new state
}

// ── Worker side ──────────────────────────────────────────────

/**
 * Take the oldest due queued job of these types (or exactly `id`): running, attempts + 1, leased.
 * Returns the row or null.
 */
function claim(types, { leaseS = 120, id = null } = {}) {
    if (!id && !types.length) return null;
    let row = null;
    db.getDb().transaction(() => {
        const next = id
            ? db.get("SELECT id FROM media_jobs WHERE id = ? AND status = 'queued'", [id])
            : db.get(`SELECT id FROM media_jobs WHERE status = 'queued' AND job_type IN (${types.map(() => '?').join(', ')})
                        AND (run_after IS NULL OR run_after <= datetime('now')) ORDER BY id LIMIT 1`, types);
        if (!next) return;
        if (!update(next.id, 'queued', `status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                                          lease_until = datetime('now', '+${Math.round(leaseS)} seconds'), run_after = NULL`)) return;
        row = get(next.id);
        events.recordJob('started', jobEvent(row));
    })();
    if (row) { events.kick(); bus.emit('change', row); }
    return row;
}

/** Extend a running job's lease. Returns { cancelRequested } (false when it is no longer running). */
function renew(id, { leaseS = 120 } = {}) {
    db.run(`UPDATE media_jobs SET lease_until = datetime('now', '+${Math.round(leaseS)} seconds') WHERE id = ? AND status = 'running'`, [id]);
    const row = get(id);
    return { running: !!row && row.status === 'running', cancelRequested: !!(row && row.cancel_requested) };
}

/** Save handler progress; `alsoInTx()` (optional) runs in the same transaction (e.g. the object a part became). */
function saveCheckpoint(id, checkpoint, alsoInTx = null) {
    db.getDb().transaction(() => {
        if (alsoInTx) alsoInTx();
        db.run('UPDATE media_jobs SET checkpoint = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(checkpoint), id]);
    })();
}

function succeed(id, result) {
    return commit(id, 'succeeded', () => update(id, 'running',
        "status = 'succeeded', result = ?, error = NULL, error_code = NULL, lease_until = NULL, finished_at = CURRENT_TIMESTAMP",
        [JSON.stringify(result ?? null)]));
}

/** A failed attempt: queued again after `retryInS` (media.job.retrying), or failed for good. */
function fail(id, { message, code = null, retryInS = null, result = null }) {
    const msg = String(message || 'failed').slice(0, 1000);
    if (retryInS != null) {
        return commit(id, 'retrying', () => update(id, 'running',
            `status = 'queued', error = ?, error_code = ?, lease_until = NULL, run_after = datetime('now', '+${Math.max(0, Math.round(retryInS))} seconds')`,
            [msg, code]));
    }
    return commit(id, 'failed', () => update(id, 'running',
        "status = 'failed', error = ?, error_code = ?, result = COALESCE(?, result), lease_until = NULL, finished_at = CURRENT_TIMESTAMP",
        [msg, code, result == null ? null : JSON.stringify(result)]));
}

/** A running job that stopped because its owner cancelled it. */
function markCancelled(id, { result = null } = {}) {
    return commit(id, 'cancelled', () => update(id, 'running',
        "status = 'cancelled', error = 'cancelled by its owner', error_code = 'cancelled', result = COALESCE(?, result), lease_until = NULL, finished_at = CURRENT_TIMESTAMP",
        [result == null ? null : JSON.stringify(result)]));
}

/**
 * Running jobs nobody holds any more: every one at boot (`all`), otherwise those whose lease ran out.
 * `except` = ids this process is running. Each is retried if it has attempts left, else failed.
 */
function recoverInterrupted({ all = false, except = new Set(), retryInS = 30 } = {}) {
    const rows = db.all(`SELECT * FROM media_jobs WHERE status = 'running'${all ? '' : " AND (lease_until IS NULL OR lease_until < datetime('now'))"}`);
    let n = 0;
    for (const row of rows) {
        if (except.has(row.id)) continue;
        const why = all ? 'interrupted by a restart' : 'the worker stopped renewing its lease';
        if (row.cancel_requested) markCancelled(row.id);
        else if (row.attempts < row.max_attempts) fail(row.id, { message: why, code: 'interrupted', retryInS });
        else fail(row.id, { message: why, code: 'interrupted' });
        n++;
    }
    return n;
}

/** Wait until the job is finished (or `timeoutMs` passes). Resolves with the row as it is then. */
function waitFor(id, timeoutMs = 60000) {
    const now = get(id);
    if (!now || FINISHED.includes(now.status)) return Promise.resolve(now);
    return new Promise((resolve) => {
        const ev = `finished:${id}`;
        const done = (row) => { clearTimeout(t); bus.removeListener(ev, done); resolve(row || get(id)); };
        const t = setTimeout(() => done(null), timeoutMs);
        if (t.unref) t.unref();
        bus.on(ev, done);
    });
}

// ── Reads ────────────────────────────────────────────────────

/** Cursor list, newest first. filters: status, type, objectId, ownerUserId (acting user: own jobs + jobs on own objects). */
function list(appId, { status, type, objectId, cursor, limit = 50, actingUserId = null } = {}) {
    const conds = ['j.app_id = ?'], params = [appId];
    if (cursor) { conds.push('j.id < ?'); params.push(String(cursor)); }
    if (status) { conds.push('j.status = ?'); params.push(String(status)); }
    if (type) { conds.push('j.job_type = ?'); params.push(String(type)); }
    if (objectId) { conds.push('j.object_id = ?'); params.push(String(objectId)); }
    if (actingUserId != null) {
        conds.push('(j.owner_user_id = ? OR EXISTS (SELECT 1 FROM media_objects o WHERE o.id = j.object_id AND o.owner_user_id = ?))');
        params.push(actingUserId, actingUserId);
    }
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const rows = db.all(`SELECT j.* FROM media_jobs j WHERE ${conds.join(' AND ')} ORDER BY j.id DESC LIMIT ?`, [...params, n + 1]);
    const page = rows.slice(0, n);
    return { jobs: page, next_cursor: rows.length > n ? page[page.length - 1].id : null, limit: n };
}

function counts() {
    const out = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of db.all('SELECT status, COUNT(*) AS n FROM media_jobs GROUP BY status')) out[r.status] = r.n;
    return out;
}

/** Delete finished jobs of high-volume types older than `days` (thumbnail requests, scheduled hashing). Others are kept. */
function prune({ days = 30, types = ['thumbnail.regenerate', 'object.hash'] } = {}) {
    return db.run(`DELETE FROM media_jobs WHERE status IN ('succeeded', 'failed', 'cancelled') AND job_type IN (${types.map(() => '?').join(', ')})
                   AND finished_at < datetime('now', ?)`, [...types, `-${Math.max(1, days)} days`]).changes;
}

module.exports = {
    STATUSES, FINISHED, ACTIVE, MAX_ACTIVE_PER_TENANT, SYSTEM_APP, JobError, bus,
    register, typeSpec, typeNames, requestHash, parseJson,
    get, getForApp, jobPublic, jobEvent, list, counts,
    enqueue, approve, cancel,
    claim, renew, saveCheckpoint, succeed, fail, markCancelled, recoverInterrupted, waitFor, prune,
};
