/**
 * OpenVibe.Media — namespaces, quotas and upload reservations (roadmap WS-G task 2;
 * docs/object-model.md#namespaces-grants-and-quotas)
 *
 * Every object lives in a namespace, and every namespace is a media_namespaces row: the tenant it
 * belongs to, its owner, a policy, quotas and a snapshot of its usage. A tenant has one root:
 *
 *   first-party tenant            its app id                    live, community, tools, …
 *   developer project, production app.<project_id>              (tenant prj_<ULID>)
 *   developer project, sandbox    app.<project_id>.sandbox      (tenant prj_<ULID>-sandbox)
 *
 * and children below it (<root>.<segment>, up to three segments), made by the first upload that
 * names one. Which verbs a token may use in which namespace is decided in server/auth.js; this module
 * keeps the rows, the policy and the quotas.
 *
 * Quotas. A namespace's limit covers its subtree (itself and its children). quota_bytes NULL inherits
 * (the root takes its tenant's apps.quota_bytes, a child has no limit of its own), 0 is no limit.
 * Usage counts native objects that are ready (in a developer project, also soft-deleted ones until
 * their bytes are purged), the tenant's v1 files at the root, and the reservations of uploads in
 * progress. An upload reserves its declared size at init (checked against every limit from its
 * namespace up to the root), re-reserves the bytes it actually stored, and is checked again with its
 * real size at complete, when the reservation is settled; abort releases it down to the bytes still
 * stored; the hourly sweep fails an upload whose reservation expired and frees its bytes. Checks count
 * from the rows, never from the snapshot; reconcile() refreshes the snapshot.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');

const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_DEPTH = 3;
const POLICY_KEYS = ['kinds', 'visibilities', 'max_object_bytes', 'strict_verbs'];

function parsePolicy(s) {
    try {
        const p = typeof s === 'string' ? JSON.parse(s || '{}') : s;
        return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch { return {}; }
}

/** A policy an operator sets: only the known keys, each of the right shape. Returns { policy } or { error }. */
function validatePolicy(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'policy must be an object' };
    const unknown = Object.keys(p).filter(k => !POLICY_KEYS.includes(k));
    if (unknown.length) return { error: `unknown policy key(s): ${unknown.join(', ')} (known: ${POLICY_KEYS.join(', ')})` };
    const model = require('./model');
    if (p.kinds != null && !(Array.isArray(p.kinds) && p.kinds.every(k => model.KINDS.includes(k)))) return { error: `kinds must be a list of ${model.KINDS.join(', ')}` };
    if (p.visibilities != null && !(Array.isArray(p.visibilities) && p.visibilities.every(v => model.VISIBILITIES.includes(v)))) return { error: `visibilities must be a list of ${model.VISIBILITIES.join(', ')}` };
    if (p.max_object_bytes != null && !(Number.isInteger(p.max_object_bytes) && p.max_object_bytes >= 0)) return { error: 'max_object_bytes must be a whole number of bytes (0 = no limit)' };
    if (p.strict_verbs != null && typeof p.strict_verbs !== 'boolean') return { error: 'strict_verbs must be true or false' };
    return { policy: p };
}

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// ── Rows ─────────────────────────────────────────────────────

function get(namespace) {
    return namespace ? db.get('SELECT * FROM media_namespaces WHERE namespace = ?', [String(namespace)]) : null;
}

function listForTenant(appId) {
    return db.all('SELECT * FROM media_namespaces WHERE app_id = ? ORDER BY namespace', [appId]);
}

/** Is `ns` the namespace `base` or below it? */
function within(base, ns) {
    return ns === base || String(ns || '').startsWith(`${base}.`);
}

/** The tenant's rows from its root down to `namespace` (those that exist), root first. */
function chain(appId, namespace) {
    const parts = String(namespace || '').split('.');
    const names = parts.map((_, i) => parts.slice(0, i + 1).join('.'));
    if (!names.length) return [];
    const rows = db.all(`SELECT * FROM media_namespaces WHERE app_id = ? AND namespace IN (${names.map(() => '?').join(', ')})`, [appId, ...names]);
    return rows.sort((a, b) => a.namespace.length - b.namespace.length);
}

/** Policy in force in `namespace`: the root's, overridden key by key by each child on the way down. */
function effectivePolicy(appId, namespace) {
    return Object.assign({}, ...chain(appId, namespace).map(r => parsePolicy(r.policy)));
}

function isStrict(appId, namespace) {
    return effectivePolicy(appId, namespace).strict_verbs === true;
}

/**
 * The namespace a request names in tenant `app`: nothing = the root; the root's full name or a name
 * below it; or a name relative to the root ('avatars' = '<root>.avatars'). Returns { namespace } or { error }.
 */
function resolveName(app, requested) {
    const root = db.rootNamespace(app);
    if (requested == null || requested === '') return { namespace: root };
    const s = String(requested).trim();
    if (s === root) return { namespace: root };
    const rel = s.startsWith(`${root}.`) ? s.slice(root.length + 1) : s;
    const segs = rel.split('.');
    if (segs.length > MAX_DEPTH || !segs.every(x => SEGMENT_RE.test(x)) || `${root}.${rel}`.length > 200) {
        return { error: `namespace must be ${root} or a name below it: up to ${MAX_DEPTH} segments of a-z, 0-9, _ and - (e.g. ${root}.avatars)` };
    }
    // The production root's `sandbox` child would read as the project's sandbox tenant.
    if (app.project_id && app.env !== 'sandbox' && segs[0] === 'sandbox') return { error: `${root}.sandbox is the project's sandbox tenant` };
    return { namespace: `${root}.${rel}` };
}

/**
 * The row for `namespace` in tenant `app`, with the chain above it created when missing. Returns the
 * row, or { error, status, code } when the tenant already has MEDIA_NAMESPACE_MAX_CHILDREN children
 * or the name belongs to another tenant.
 */
function ensure(app, namespace) {
    const root = db.ensureRootNamespace(app);
    const found = get(namespace);
    if (found) {
        return found.app_id === app.app_id ? found
            : { error: `namespace ${namespace} belongs to another tenant`, status: 409, code: 'media.namespace.conflict' };
    }
    if (!within(root, namespace)) return { error: `namespace ${namespace} is not below ${root}`, status: 400, code: 'media.namespace.invalid' };
    const segs = namespace.slice(root.length + 1).split('.');
    const names = segs.map((_, i) => `${root}.${segs.slice(0, i + 1).join('.')}`);
    const missing = names.filter(n => !get(n));
    const children = db.get('SELECT COUNT(*) AS n FROM media_namespaces WHERE app_id = ? AND parent IS NOT NULL', [app.app_id]).n;
    if (children + missing.length > config.objects.maxChildNamespaces) {
        return { error: `a tenant has at most ${config.objects.maxChildNamespaces} namespaces below its root`, status: 413, code: 'media.quota.namespaces_exceeded' };
    }
    let parent = root;
    for (const name of names) {
        db.run('INSERT OR IGNORE INTO media_namespaces (namespace, app_id, parent, owner) VALUES (?, ?, ?, ?)', [name, app.app_id, parent, db.namespaceOwner(app)]);
        parent = name;
    }
    return get(namespace);
}

// ── Usage and quotas ─────────────────────────────────────────

/**
 * What the subtree of `namespace` uses now, from the rows: { used_bytes, used_objects, reserved_bytes,
 * reserved_objects }. The root's subtree is the whole tenant, v1 files included. `excludeId` leaves
 * one object (and its reservation) out, for re-checking that object.
 */
function usage(app, namespace, { excludeId = null } = {}) {
    const root = db.rootNamespace(app);
    const whole = namespace === root;
    const where = whole ? '' : ' AND (o.namespace = @ns OR substr(o.namespace, 1, @plen) = @prefix)';
    const rwhere = whole ? '' : ' AND (r.namespace = @ns OR substr(r.namespace, 1, @plen) = @prefix)';
    const p = { app: app.app_id, ns: namespace, plen: String(namespace).length + 1, prefix: `${namespace}.`, ex: excludeId || '' };
    // Developer projects (third-party uploaders) pay for soft-deleted bytes until they are purged: they stay
    // on disk for the retention period, and upload -> delete -> upload would otherwise grow the disk.
    const retained = app.project_id ? " OR (o.lifecycle_status = 'deleted' AND json_extract(o.metadata, '$.purged_at') IS NULL)" : '';
    const used = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(o.size_bytes), 0) AS b FROM media_objects o
        WHERE o.app_id = @app AND o.legacy_ref IS NULL AND (o.lifecycle_status = 'ready'${retained}) AND o.id != @ex${where}`, p);
    // A reservation counts while its object is still uploading (a settled or failed one never double-counts).
    const reserved = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(r.bytes), 0) AS b FROM media_quota_reservations r
        JOIN media_objects o ON o.id = r.object_id AND o.lifecycle_status = 'uploading'
        WHERE r.app_id = @app AND r.object_id != @ex${rwhere}`, p);
    const files = whole ? db.get('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM files WHERE app_id = ?', [app.app_id]) : { n: 0, b: 0 };
    return { used_bytes: used.b + files.b, used_objects: used.n + files.n, reserved_bytes: reserved.b, reserved_objects: reserved.n };
}

/** The limits of one row: { bytes, objects, bytes_from } (0 = none). A root with no quota_bytes takes its tenant's. */
function limitsOf(app, row) {
    const inherits = row.quota_bytes == null;
    const bytes = inherits ? (row.parent == null ? Number(app.quota_bytes) || 0 : 0) : Number(row.quota_bytes) || 0;
    return { bytes, objects: Number(row.quota_objects) || 0, bytes_from: bytes ? (inherits ? 'tenant' : 'namespace') : null };
}

/**
 * Would adding `bytes` and `objects` to `namespace` break a limit? Checked for the namespace and every
 * ancestor with a limit (the root always carries the tenant's quota), and against the effective
 * policy's max_object_bytes. Returns null, or { status, code, detail, extra } for a problem answer.
 */
function checkQuota(app, namespace, { bytes = 0, objects = 0, excludeId = null } = {}) {
    const root = db.rootNamespace(app);
    const rows = chain(app.app_id, namespace);
    if (!rows.length || rows[0].namespace !== root) rows.unshift({ namespace: root, parent: null, quota_bytes: null, quota_objects: null });
    const policy = Object.assign({}, ...rows.map(r => parsePolicy(r.policy)));
    const maxObject = Number(policy.max_object_bytes) || 0;
    if (maxObject && bytes > maxObject) {
        return { status: 413, code: 'media.object.too_large', detail: `Objects in ${namespace} are limited to ${maxObject} bytes`, extra: { namespace, max_object_bytes: maxObject } };
    }
    for (const row of rows.slice().reverse()) {
        const lim = limitsOf(app, row);
        if (!lim.bytes && !lim.objects) continue;
        const u = usage(app, row.namespace, { excludeId });
        if (lim.bytes && u.used_bytes + u.reserved_bytes + bytes > lim.bytes) {
            return {
                status: 413, code: 'media.quota.exceeded', detail: `The storage quota of ${row.namespace} would be exceeded`,
                extra: { namespace: row.namespace, quota_bytes: lim.bytes, used_bytes: u.used_bytes, reserved_bytes: u.reserved_bytes },
            };
        }
        if (lim.objects && objects > 0 && u.used_objects + u.reserved_objects + objects > lim.objects) {
            return {
                status: 413, code: 'media.quota.objects_exceeded', detail: `The object quota of ${row.namespace} would be exceeded`,
                extra: { namespace: row.namespace, quota_objects: lim.objects, used_objects: u.used_objects, reserved_objects: u.reserved_objects },
            };
        }
    }
    return null;
}

// ── Reservations ─────────────────────────────────────────────

function reservation(objectId) {
    return objectId ? db.get('SELECT * FROM media_quota_reservations WHERE object_id = ?', [objectId]) : null;
}

/** Hold `bytes` of quota for the upload of `obj` (replacing what it held); expiry moves forward, never back. */
function reserve(obj, bytes, { hours = config.objects.reservationHours } = {}) {
    db.run(`INSERT INTO media_quota_reservations (object_id, app_id, namespace, bytes, expires_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(object_id) DO UPDATE SET bytes = excluded.bytes, namespace = excluded.namespace,
                expires_at = MAX(expires_at, excluded.expires_at), updated_at = CURRENT_TIMESTAMP`,
    [obj.id, obj.app_id, obj.namespace, Math.max(0, Number(bytes) || 0), sqlTime(Date.now() + hours * 3600 * 1000)]);
}

/** An upload step happened: its reservation's expiry moves forward. */
function touch(objectId, { hours = config.objects.reservationHours } = {}) {
    db.run('UPDATE media_quota_reservations SET expires_at = MAX(expires_at, ?), updated_at = CURRENT_TIMESTAMP WHERE object_id = ?',
        [sqlTime(Date.now() + hours * 3600 * 1000), objectId]);
}

/** The upload ended (complete, or the object was deleted): the object's own row counts from now on. */
function settle(objectId) {
    db.run('DELETE FROM media_quota_reservations WHERE object_id = ?', [objectId]);
}

/** An aborted or expired session: keep holding only what is still stored for the object (a PUT's bytes). */
function release(objectId) {
    const obj = db.get('SELECT lifecycle_status FROM media_objects WHERE id = ?', [objectId]);
    const stored = obj && obj.lifecycle_status === 'uploading'
        ? db.get("SELECT size_bytes FROM media_locations WHERE object_id = ? AND provider = 'local' AND state = 'present'", [objectId]) : null;
    if (stored && Number(stored.size_bytes) > 0) db.run('UPDATE media_quota_reservations SET bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE object_id = ?', [Number(stored.size_bytes), objectId]);
    else settle(objectId);
}

/**
 * The hourly sweep: an upload whose reservation expired, with no multipart session open, is failed
 * (metadata.failure upload_expired), its stored bytes are deleted and its reservation goes; a
 * reservation whose object is no longer uploading is dropped. Returns { expired, dropped }.
 */
function expireReservations() {
    const rows = db.all(`SELECT r.object_id, r.app_id, r.namespace, o.lifecycle_status, o.legacy_ref, o.metadata FROM media_quota_reservations r
                         LEFT JOIN media_objects o ON o.id = r.object_id WHERE r.expires_at < datetime('now') ORDER BY r.expires_at LIMIT 1000`);
    const multipart = require('./multipart');
    const root = path.resolve(config.objects.path) + path.sep;
    const touched = new Map();
    let expired = 0, dropped = 0;
    for (const r of rows) {
        if (r.lifecycle_status !== 'uploading' || r.legacy_ref) { settle(r.object_id); dropped++; continue; }
        if (multipart.activeFor(r.object_id)) continue;   // its session expires on its own, then this does
        try {
            const md = parsePolicy(r.metadata);
            md.failure = 'upload_expired';
            md.expired_at = new Date().toISOString();
            const locs = db.all("SELECT * FROM media_locations WHERE object_id = ? AND provider = 'local'", [r.object_id]);
            db.getDb().transaction(() => {
                db.run("UPDATE media_objects SET lifecycle_status = 'failed', metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lifecycle_status = 'uploading'",
                    [JSON.stringify(md), r.object_id]);
                for (const l of locs) db.run('DELETE FROM media_locations WHERE id = ?', [l.id]);
                settle(r.object_id);
            })();
            for (const l of locs) if (path.resolve(l.key).startsWith(root)) { try { fs.unlinkSync(l.key); } catch { /* already gone */ } }
            expired++;
            touched.set(`${r.app_id}\n${r.namespace}`, r);
        } catch (err) {
            // A retention hold refuses the lifecycle change: the reservation stays until the hold is released.
            console.warn(`[Namespaces] Could not expire the upload of ${r.object_id}: ${err.message}`);
        }
    }
    for (const r of touched.values()) { const app = db.getApp(r.app_id); if (app) reconcileChain(app, r.namespace); }
    return { expired, dropped };
}

// ── Snapshot (the used_* / reserved_* columns) ───────────────

function reconcile(app, namespace) {
    const u = usage(app, namespace);
    db.run(`UPDATE media_namespaces SET used_bytes = ?, used_objects = ?, reserved_bytes = ?, reserved_objects = ?,
                   reconciled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE namespace = ? AND app_id = ?`,
    [u.used_bytes, u.used_objects, u.reserved_bytes, u.reserved_objects, namespace, app.app_id]);
    return u;
}

/** Refresh `namespace` and every namespace above it (after a write changed its usage). */
function reconcileChain(app, namespace) {
    try {
        for (const row of chain(app.app_id, namespace)) reconcile(app, row.namespace);
    } catch (err) { console.warn(`[Namespaces] reconcile ${namespace}: ${err.message}`); }
}

/** Refresh every row (the hourly job). Returns how many. */
function reconcileAll() {
    const apps = new Map();
    let n = 0;
    for (const row of db.all('SELECT namespace, app_id FROM media_namespaces ORDER BY app_id, namespace')) {
        if (!apps.has(row.app_id)) apps.set(row.app_id, db.getApp(row.app_id) || { app_id: row.app_id });
        reconcile(apps.get(row.app_id), row.namespace);
        n++;
    }
    return n;
}

// ── Public shape ─────────────────────────────────────────────

/** A namespace as its owner reads it; `fresh` is usage() just computed (else the snapshot is shown). */
function publicShape(app, row, fresh = null) {
    const lim = limitsOf(app, row);
    const u = fresh || { used_bytes: row.used_bytes, used_objects: row.used_objects, reserved_bytes: row.reserved_bytes, reserved_objects: row.reserved_objects };
    const out = {
        namespace: row.namespace,
        parent: row.parent || null,
        root: row.parent == null,
        owner: row.owner,
        policy: parsePolicy(row.policy),
        effective_policy: effectivePolicy(row.app_id, row.namespace),
        quota: { bytes: lim.bytes || null, objects: lim.objects || null, bytes_from: lim.bytes_from },
        usage: { ...u, reconciled_at: fresh ? new Date().toISOString() : row.reconciled_at || null },
        created_at: row.created_at,
    };
    if (db.isSandboxTenant(row.app_id)) out.sandbox = true;
    return out;
}

module.exports = {
    SEGMENT_RE, POLICY_KEYS, parsePolicy, validatePolicy,
    get, listForTenant, within, chain, effectivePolicy, isStrict, resolveName, ensure,
    usage, limitsOf, checkQuota,
    reservation, reserve, touch, settle, release, expireReservations,
    reconcile, reconcileChain, reconcileAll, publicShape,
};
