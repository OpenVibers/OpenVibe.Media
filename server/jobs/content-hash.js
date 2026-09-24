/**
 * OpenVibe.Media — job type object.hash (light lane): sha256 of local copies, in bounded batches.
 *
 * Ready objects that have no content_hash and a present local copy get one: the file is read once
 * (streaming), and the hash is recorded on the object (content_hash, plus metadata.hash_basis
 * { key, size, at }: the file it was computed from) and on its local location (checksum,
 * verified_at). Scheduled copy verification then compares local copies against it, and a
 * re-projection that finds the local file at another path or size drops a hash this job made
 * (server/objects/model.js project()), so a remux or re-cut never leaves a stale one.
 *
 * Skipped (and counted): a file changed in the last MEDIA_HASH_SETTLE_S (120 s) or while it was
 * read, a local size that differs from the object's recorded size (the copy is another version),
 * files over MEDIA_HASH_MAX_FILE_MB, and anything past the run's byte budget (next run).
 *
 *   object_id set   hash that object only
 *   params { limit (1-500, default 50), budget_mb (default MEDIA_HASH_BUDGET_MB, 4096) }
 *   result { hashed, bytes, skipped: { reason: n }, remaining }
 * Scheduled per tenant every MEDIA_HASH_INTERVAL_MIN (15; 0 = only on demand).
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');
const queue = require('./queue');

const { JobError } = queue;
const TYPE = 'object.hash';
const MB = 1024 * 1024;

function envInt(name, fallback) {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) ? v : fallback;
}
const settings = () => ({
    budgetMb: Math.max(1, envInt('MEDIA_HASH_BUDGET_MB', 4096)),
    maxFileMb: Math.max(1, envInt('MEDIA_HASH_MAX_FILE_MB', 20480)),
    settleS: Math.max(0, envInt('MEDIA_HASH_SETTLE_S', 120)),
    intervalMin: envInt('MEDIA_HASH_INTERVAL_MIN', 15),
});

function sha256File(p, signal) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p, { highWaterMark: MB });
        const onAbort = () => s.destroy(new Error('aborted'));
        if (signal) { if (signal.aborted) return reject(new Error('aborted')); signal.addEventListener('abort', onAbort, { once: true }); }
        s.on('data', d => h.update(d));
        s.on('end', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(h.digest('hex')); });
        s.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
    });
}

const CANDIDATES = `SELECT o.id, o.size_bytes, l.id AS loc_id, l.key AS loc_key
    FROM media_objects o JOIN media_locations l ON l.object_id = o.id AND l.provider = 'local' AND l.state = 'present'
    WHERE o.lifecycle_status = 'ready' AND o.content_hash IS NULL`;

function remaining(appId) {
    return db.get(`SELECT COUNT(*) AS n FROM (${CANDIDATES} AND o.app_id = ?)`, [appId]).n;
}

function validate({ obj, params }) {
    const p = params || {};
    const limit = p.limit == null ? 50 : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new JobError('media.job.invalid', 'params.limit must be 1-500', { permanent: true });
    const out = { limit };
    if (p.budget_mb != null) {
        const b = Number(p.budget_mb);
        if (!Number.isInteger(b) || b < 1 || b > 1024 * 1024) throw new JobError('media.job.invalid', 'params.budget_mb must be a positive integer', { permanent: true });
        out.budget_mb = b;
    }
    if (obj && obj.content_hash) throw new JobError('media.job.invalid', 'the object already has a content hash', { permanent: true });
    return out;
}

/** Record one hash, only if nothing changed since the file was read. Returns true when written. */
function record(c, hash, st) {
    let wrote = false;
    db.getDb().transaction(() => {
        const o = db.get('SELECT content_hash, metadata, lifecycle_status FROM media_objects WHERE id = ?', [c.id]);
        const l = db.get('SELECT key, state FROM media_locations WHERE id = ?', [c.loc_id]);
        if (!o || o.content_hash || o.lifecycle_status !== 'ready' || !l || l.key !== c.loc_key || l.state !== 'present') return;
        let md = {};
        try { md = JSON.parse(o.metadata || '{}') || {}; } catch { md = {}; }
        md.hash_basis = { key: c.loc_key, size: st.size, at: new Date().toISOString() };
        db.run('UPDATE media_objects SET content_hash = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND content_hash IS NULL', [hash, JSON.stringify(md), c.id]);
        db.run(`UPDATE media_locations SET checksum = ?, size_bytes = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND key = ?`, [hash, st.size, c.loc_id, c.loc_key]);
        wrote = true;
    })();
    return wrote;
}

/** One bounded batch for a tenant (or one object). Used by the job and by tests. */
async function hashBatch({ appId, objectId = null, limit = 50, budgetMb = settings().budgetMb, signal = null, now = Date.now() } = {}) {
    const s = settings();
    const budget = budgetMb * MB;
    const rows = objectId
        ? db.all(`${CANDIDATES} AND o.id = ? AND o.app_id = ?`, [objectId, appId])
        : db.all(`${CANDIDATES} AND o.app_id = ? ORDER BY o.id LIMIT ?`, [appId, limit]);
    const out = { hashed: 0, bytes: 0, skipped: {}, remaining: 0 };
    const skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1; };
    for (const c of rows) {
        if (signal && signal.aborted) break;
        let st;
        try { st = fs.statSync(c.loc_key); } catch { skip('file_missing'); continue; }
        if (!st.isFile()) { skip('not_a_file'); continue; }
        if (now - st.mtimeMs < s.settleS * 1000) { skip('recently_changed'); continue; }
        if (Number(c.size_bytes) > 0 && st.size !== Number(c.size_bytes)) { skip('size_differs_from_object'); continue; }
        if (st.size > s.maxFileMb * MB) { skip('over_max_file_size'); continue; }
        if (out.bytes > 0 && out.bytes + st.size > budget) { skip('budget'); continue; }
        let hash;
        try { hash = await sha256File(c.loc_key, signal); } catch (err) { if (signal && signal.aborted) break; skip('read_error'); continue; }
        let after;
        try { after = fs.statSync(c.loc_key); } catch { skip('file_missing'); continue; }
        if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) { skip('changed_while_reading'); continue; }
        out.bytes += st.size;
        if (record(c, hash, st)) out.hashed++; else skip('changed_in_database');
    }
    out.remaining = remaining(appId);
    return out;
}

async function run(job, ctx = {}) {
    const p = validate({ obj: null, params: job.params });
    return hashBatch({ appId: job.app_id, objectId: job.object_id || null, limit: p.limit, budgetMb: p.budget_mb || settings().budgetMb, signal: ctx.signal });
}

/** Queue one batch per tenant that has unhashed local copies, every MEDIA_HASH_INTERVAL_MIN. */
function schedule(nowMs = Date.now()) {
    const minutes = settings().intervalMin;
    if (!(minutes > 0)) return 0;
    const period = Math.floor(nowMs / (minutes * 60 * 1000));
    let n = 0;
    for (const { app_id: appId } of db.all(`SELECT DISTINCT o.app_id FROM (${CANDIDATES}) c JOIN media_objects o ON o.id = c.id`)) {
        try {
            const r = queue.enqueue({ appId, type: TYPE, params: { limit: 50 }, idempotencyKey: `${TYPE}:${minutes}m:${period}`, createdBy: 'system:schedule' });
            if (r.created) n++;
        } catch (err) { console.warn(`[Jobs] could not schedule ${TYPE} for ${appId}: ${err.message}`); }
    }
    return n;
}

module.exports = {
    TYPE,
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 30 * 60 * 1000, needsObject: false, validate, run },
    hashBatch, schedule, sha256File, remaining,
};
