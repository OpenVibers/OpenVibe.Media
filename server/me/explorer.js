/**
 * OpenVibe.Media — the object explorer's reads for one person (roadmap WS-G task 12;
 * docs/object-model.md#object-explorer).
 *
 * Everything here is scoped to one Network subject (usr_…): the objects whose owner_subject is that
 * subject, in every tenant. Nobody else's object is ever read into an answer, and no tenant's quota
 * or namespace policy is shown (a person owns no tenant; the tenants' quotas are their operators').
 *
 *   list(subject, filters)   a page of the person's objects, newest first (cursor = the last id)
 *   detail(subject, id)      one of them with its copies, derivatives and recent jobs, or null
 *   usage(subject)           the person's objects and bytes per tenant and namespace, by lifecycle
 *   parseFilters(query)      ?cursor&limit&status&kind&q&app → { filters } | { error }
 *
 * Read-only: nothing here writes, and none of it runs at load.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');
const drill = require('../drill');
const model = require('../objects/model');
const readiness = require('../objects/readiness');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ID_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const APP_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const STATUS_FILTERS = [...model.LIFECYCLES, 'all'];
/** Relations whose `from` object was made out of the `to` object (a clip is its own work, not a derivative). */
const DERIVED_RELATIONS = ['derived_from', 'thumbnail_of'];

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or ISO → ISO 8601, or null. */
function iso(v) {
    if (!v) return null;
    const s = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) && !s.includes('T') ? `${s.replace(' ', 'T')}Z` : s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const text = (v, n = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/** ?cursor&limit&status&kind&q&app → { filters } or { error } (a 400). */
function parseFilters(query = {}) {
    const q = query || {};
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const f = { limit: DEFAULT_LIMIT, cursor: null, status: null, kind: null, q: null, app: null };
    const limit = one(q.limit);
    if (limit != null && limit !== '') {
        const n = Number(limit);
        if (!Number.isInteger(n) || n < 1) return { error: 'limit must be a positive integer' };
        f.limit = Math.min(n, MAX_LIMIT);
    }
    const cursor = one(q.cursor);
    if (cursor != null && cursor !== '') {
        if (!ID_RE.test(String(cursor))) return { error: 'Bad cursor' };
        f.cursor = String(cursor);
    }
    const status = one(q.status);
    if (status != null && status !== '') {
        if (!STATUS_FILTERS.includes(String(status))) return { error: `status must be one of ${STATUS_FILTERS.join(', ')}` };
        f.status = String(status);
    }
    const kind = one(q.kind);
    if (kind != null && kind !== '') {
        if (!model.KINDS.includes(String(kind))) return { error: `kind must be one of ${model.KINDS.join(', ')}` };
        f.kind = String(kind);
    }
    const search = one(q.q);
    if (search != null && String(search).trim() !== '') f.q = String(search).trim().slice(0, 100);
    const app = one(q.app);
    if (app != null && app !== '') {
        if (!APP_RE.test(String(app))) return { error: 'Bad app' };
        f.app = String(app);
    }
    return { filters: f };
}

/** The tenant as the person sees it: id, name, whether it is a developer project's sandbox. */
function tenantOf(appId, cache = new Map()) {
    if (!cache.has(appId)) {
        const app = db.getApp(appId);
        cache.set(appId, {
            app_id: appId,
            name: (app && app.name) || appId,
            project_id: (app && app.project_id) || null,
            sandbox: !!(app && app.env === 'sandbox'),
        });
    }
    return cache.get(appId);
}

/** Non-deleted objects made out of each of `ids`: Map<id, count>. */
function derivativeCounts(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(', ');
    const rels = DERIVED_RELATIONS.map(() => '?').join(', ');
    const rows = db.all(`SELECT x.src AS src, COUNT(DISTINCT x.d) AS n FROM (
            SELECT v.object_id AS src, v.derived_object_id AS d FROM media_variants v WHERE v.object_id IN (${ph})
            UNION
            SELECT r.to_object_id, r.from_object_id FROM media_relationships r WHERE r.to_object_id IN (${ph}) AND r.relation IN (${rels})
        ) x JOIN media_objects d ON d.id = x.d AND d.lifecycle_status != 'deleted' GROUP BY x.src`, [...ids, ...ids, ...DERIVED_RELATIONS]);
    for (const r of rows) out.set(r.src, r.n);
    return out;
}

/** Bytes of a single-part PUT still streaming in (OBJECTS_PATH/.tmp/<id>-<rand>), or null. A drill reads no storage. */
function inFlightBytes(ctx, id) {
    if (drill.enabled) return null;
    const dir = path.join(config.objects.path, '.tmp');
    if (!ctx.tmp) {
        ctx.tmp = [];
        try { ctx.tmp = fs.readdirSync(dir); } catch { /* no upload has streamed yet */ }
    }
    const name = ctx.tmp.find(n => n.startsWith(`${id}-`));
    if (!name) return null;
    try { return fs.statSync(path.join(dir, name)).size; } catch { return null; }
}

/**
 * How far a native upload has got: a multipart session's parts received, the bytes a PUT stored (the
 * upload then waits for complete), or a PUT still streaming. Bytes received vs the declared size.
 */
function uploadProgress(obj, locs, ctx) {
    const declared = Number(obj.size_bytes) || 0;
    const session = db.get("SELECT * FROM media_uploads WHERE object_id = ? AND status IN ('active', 'completing') ORDER BY created_at DESC LIMIT 1", [obj.id]);
    const reservation = db.get('SELECT expires_at FROM media_quota_reservations WHERE object_id = ?', [obj.id]);
    let out;
    if (session) {
        const parts = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b FROM media_upload_parts WHERE upload_id = ?', [session.id]);
        out = {
            method: 'multipart', waiting_for: session.status === 'completing' ? 'assembly' : 'parts',
            received_bytes: parts.b, parts_received: parts.n, parts_expected: session.parts_expected,
            session_expires_at: iso(session.expires_at),
        };
    } else {
        const stored = locs.find(l => l.provider === 'local' && l.state === 'present');
        if (stored) {
            out = { method: 'single', waiting_for: 'complete', received_bytes: Number(stored.size_bytes) || 0 };
        } else {
            const streaming = inFlightBytes(ctx, obj.id);
            out = { method: 'single', waiting_for: 'bytes', received_bytes: streaming || 0, streaming: streaming != null };
        }
    }
    out.declared_bytes = declared || null;
    out.percent = declared ? Math.min(100, Math.floor((out.received_bytes * 100) / declared)) : null;
    out.expires_at = reservation ? iso(reservation.expires_at) : null;   // unfinished by then: the upload fails
    return out;
}

/** One object as its owner sees it: no keys, paths, staff notes or other people's data. */
function item(obj, ctx, derivatives = 0) {
    const md = model.parseJson(obj.metadata, {}) || {};
    const locs = model.listLocations(obj.id);
    const r = readiness.compute(obj, locs);
    const tenant = tenantOf(obj.app_id, ctx.tenants);
    const ready = obj.lifecycle_status === 'ready';
    return {
        id: obj.id,
        app_id: obj.app_id,
        tenant,
        namespace: obj.namespace,
        kind: obj.kind,
        filename: text(md.filename, 200),
        title: text(md.title),
        mime_type: obj.mime_type || null,
        size_bytes: Number(obj.size_bytes) || 0,
        visibility: obj.visibility,
        lifecycle_status: obj.lifecycle_status,
        readiness: { metadata: r.metadata, bytes_verified: r.bytes_verified, playable: r.playable, reason: r.reason },
        // Only whether a retention hold keeps it; its kind, reason, note and who placed it are staff's.
        held: model.isHeld(obj.id),
        derivatives,
        upload: obj.lifecycle_status === 'uploading' && !obj.legacy_ref ? uploadProgress(obj, locs, ctx) : null,
        failure: obj.lifecycle_status === 'failed' ? text(md.failure, 60) : null,
        deleted: obj.lifecycle_status === 'deleted'
            ? { deleted_at: iso(obj.deleted_at), retention_until: iso(md.retention_until), purged: !!md.purged_at } : null,
        public_url: obj.visibility !== 'private' && ready && !tenant.sandbox ? (model.legacyPublicUrl(obj) || `${config.publicUrl}/o/${obj.id}`) : null,
        managed_by: obj.legacy_ref ? 'v1' : 'v2',
        created_at: iso(obj.created_at),
        updated_at: iso(obj.updated_at),
    };
}

/** A page of the subject's objects, newest first: { objects, next_cursor, limit }. */
function list(subject, filters = {}) {
    const f = { limit: DEFAULT_LIMIT, ...filters };
    const conds = ['o.owner_subject = @subject'];
    const p = { subject };
    if (f.cursor) { conds.push('o.id < @cursor'); p.cursor = f.cursor; }
    if (f.status === 'all') { /* everything, deleted included */ } else if (f.status) { conds.push('o.lifecycle_status = @status'); p.status = f.status; } else conds.push("o.lifecycle_status != 'deleted'");
    if (f.kind) { conds.push('o.kind = @kind'); p.kind = f.kind; }
    if (f.app) { conds.push('o.app_id = @app'); p.app = f.app; }
    if (f.q) {
        const field = (k) => `instr(lower(COALESCE(CASE WHEN json_valid(o.metadata) THEN json_extract(o.metadata, '$.${k}') END, '')), @ql) > 0`;
        conds.push(`(o.id = @q OR ${field('filename')} OR ${field('title')} OR instr(lower(COALESCE(o.mime_type, '')), @ql) > 0)`);
        p.q = f.q; p.ql = f.q.toLowerCase();
    }
    const limit = Math.min(Math.max(Number(f.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const rows = db.all(`SELECT o.* FROM media_objects o WHERE ${conds.join(' AND ')} ORDER BY o.id DESC LIMIT ${limit + 1}`, p);
    const page = rows.slice(0, limit);
    const counts = derivativeCounts(page.map(o => o.id));
    const ctx = { tenants: new Map() };
    return {
        objects: page.map(o => item(o, ctx, counts.get(o.id) || 0)),
        next_cursor: rows.length > limit ? page[page.length - 1].id : null,
        limit,
    };
}

/** One of the subject's objects (med_ id or legacy ref) with copies, derivatives and jobs; null when it is not theirs. */
function detail(subject, idOrRef) {
    const key = String(idOrRef || '');
    const obj = key.startsWith('legacy:') ? model.getObjectByLegacyRef(key) : (ID_RE.test(key) ? model.getObject(key) : null);
    if (!obj || !subject || obj.owner_subject !== subject) return null;
    const ctx = { tenants: new Map() };
    const derived = new Map();
    for (const v of db.all('SELECT variant_name, derived_object_id FROM media_variants WHERE object_id = ? ORDER BY id', [obj.id])) {
        derived.set(v.derived_object_id, v.variant_name);
    }
    for (const r of db.all(`SELECT relation, from_object_id FROM media_relationships WHERE to_object_id = ? AND relation IN (${DERIVED_RELATIONS.map(() => '?').join(', ')}) ORDER BY id`,
        [obj.id, ...DERIVED_RELATIONS])) {
        if (!derived.has(r.from_object_id)) derived.set(r.from_object_id, r.relation === 'thumbnail_of' ? 'thumbnail' : 'derived');
    }
    const derivatives = [];
    for (const [id, name] of derived) {
        const d = model.getObject(id);
        if (!d) continue;
        derivatives.push({ id: d.id, name, kind: d.kind, visibility: d.visibility, lifecycle_status: d.lifecycle_status, size_bytes: Number(d.size_bytes) || 0, mine: d.owner_subject === subject, created_at: iso(d.created_at) });
    }
    // What it was made from, when that is the person's too (a clip of someone else's stream names no one's VOD).
    const src = db.get(`SELECT r.relation, r.to_object_id FROM media_relationships r JOIN media_objects s ON s.id = r.to_object_id
                        WHERE r.from_object_id = ? AND r.relation IN ('derived_from', 'thumbnail_of', 'clip_of') AND s.owner_subject = ? ORDER BY r.id LIMIT 1`, [obj.id, subject]);
    const jobs = db.all(`SELECT id, job_type, status, error_code, attempts, max_attempts, created_at, finished_at FROM media_jobs
                         WHERE object_id = ? ORDER BY id DESC LIMIT 10`, [obj.id]).map(j => ({
        id: j.id, type: j.job_type, status: j.status, error_code: j.error_code || null, attempts: j.attempts, max_attempts: j.max_attempts,
        created_at: iso(j.created_at), finished_at: iso(j.finished_at),
    }));
    return {
        ...item(obj, ctx, derivatives.filter(d => d.lifecycle_status !== 'deleted').length),
        content_hash: obj.content_hash || null,
        locations: model.listLocations(obj.id).map(l => ({
            provider: l.provider, storage_class: l.storage_class, state: l.state, size_bytes: l.size_bytes,
            verified_at: iso(l.verified_at), canonical: l.provider === obj.canonical_provider,
        })),
        derivative_list: derivatives,
        source: src ? { id: src.to_object_id, relation: src.relation } : null,
        jobs,
    };
}

/** Counts per lifecycle status → { objects (not deleted), stored_bytes (ready + archived), by_status }. */
function group(rows) {
    const by = {};
    let objects = 0, stored = 0;
    for (const r of rows) {
        const s = by[r.status] || (by[r.status] = { objects: 0, bytes: 0 });
        s.objects += r.n; s.bytes += r.b;
        if (r.status !== 'deleted') objects += r.n;
        if (r.status === 'ready' || r.status === 'archived') stored += r.b;
    }
    return { objects, stored_bytes: stored, by_status: by };
}

/**
 * The subject's usage: their own objects and bytes per tenant and namespace (never a tenant's totals or
 * quota). Uploading bytes are the declared sizes; deleted ones are kept until the retention purge.
 */
function usage(subject) {
    const rows = db.all(`SELECT app_id, namespace, lifecycle_status AS status, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b
                         FROM media_objects WHERE owner_subject = ? GROUP BY app_id, namespace, lifecycle_status ORDER BY app_id, namespace`, [subject]);
    const tenants = new Map();
    const cache = new Map();
    for (const r of rows) {
        if (!tenants.has(r.app_id)) tenants.set(r.app_id, { rows: [], namespaces: new Map() });
        const t = tenants.get(r.app_id);
        t.rows.push(r);
        if (!t.namespaces.has(r.namespace)) t.namespaces.set(r.namespace, []);
        t.namespaces.get(r.namespace).push(r);
    }
    return {
        subject,
        totals: group(rows),
        tenants: [...tenants].map(([appId, t]) => ({
            ...tenantOf(appId, cache),
            ...group(t.rows),
            namespaces: [...t.namespaces].map(([namespace, nsRows]) => ({ namespace, ...group(nsRows) })),
        })),
        quotas: null,
        note: 'Your own objects only. Quotas are set per app and namespace by their operators and are not shown here.',
    };
}

module.exports = { list, detail, usage, parseFilters, iso, DEFAULT_LIMIT, MAX_LIMIT, STATUS_FILTERS, ID_RE };
