'use strict';
/**
 * Media's authority resource index (ADR-048 §3, plan T13 step 8; capability media.resource.read):
 *
 *   GET /api/v1/resources[?project=&kind=&cursor=&limit=]  → common.resource-list-result@1
 *   GET /api/v1/resources/:ovrn                            → common.resource-summary@1
 *
 * It pages the resources OpenVibe.Media owns — its media objects (med_<ULID>, media_objects) — as
 * common.resource-summary@1, the shape OpenVibe.Services fans out over and merges. Media lists objects
 * alone: its v1 vods, clips and files are projections over objects (bigint ids) and are never listed
 * (ADR-048, amended 2026-10-07).
 *
 * Tenancy: an object's boundary is the project of the tenant (apps) that owns it — the app_id -> apps.project_id
 * join below. An object under a developer-project tenant carries that project; one under a first-party app
 * tenant ('live', …) has no project and so no OVRN. `?project=prj_…` scopes to that project's rows only — a
 * resource of another project is never returned. Without it the first-party caller (the capability is
 * first-party, resourceConstraints none) sees every Media resource, which is what an authority-wide fan-out
 * needs; if media.resource.read is ever granted to a non-first-party principal, derive the scope from that
 * principal's grants here instead of trusting the query.
 *
 * OVRN: a summary's ovrn is computed with openvibe-contracts' contracts.resources.nameOf, the one formatter,
 * so it is present exactly when the object has a project (nameOf composes ovrn:media:<prj_…>:object/<med_…>
 * and returns null without one). That is also what GET /api/v1/resources/:ovrn reads: only a resource whose
 * computed ovrn equals the one asked for answers.
 */
const express = require('express');
const contracts = require('openvibe-contracts');

const SERVICE = 'media';
const OBJECT_KIND = 'media.object';
const KINDS = [OBJECT_KIND];
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** A subject-ref {type:'user', id} for a stored subject, or null when it is not a usr_ id. */
const userRef = (subject) => (USER_SUBJECT_RE.test(String(subject || '')) ? { type: 'user', id: subject } : null);

/**
 * Media stores timestamps as text in the `YYYY-MM-DD HH:MM:SS` UTC shape (migrations/0001_initial.sql
 * ov_now). common.resource-summary@1's created_at is an RFC 3339 date-time, so render that one; anything
 * already in another shape is passed through.
 */
function isoUtc(ts) {
    const s = String(ts || '');
    return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
}

/**
 * common.resource-summary@1 for a media_objects row joined with its tenant's project (`project` is the
 * `apps.project_id` alias, null for a first-party tenant). Media objects have no name column, so no name.
 */
function objectSummary(o) {
    return {
        id: o.id, kind: OBJECT_KIND, service: SERVICE,
        ...(o.project ? { project_id: o.project } : {}),
        ...(userRef(o.owner_subject) ? { owner: userRef(o.owner_subject) } : {}),
        state: o.lifecycle_status, created_at: isoUtc(o.created_at),
    };
}

/** The summary's ovrn, or null when it has none. nameOf composes only with a project_id and a med_ id. */
function ovrnOf(summary) {
    return contracts.resources.nameOf(summary);
}

/** The summary with its ovrn attached when it has one. */
function named(summary) {
    const ovrn = ovrnOf(summary);
    return ovrn ? { ...summary, ovrn } : summary;
}

/** A stable (kind, id) ordering, so a cursor can be a position in it. */
const order = (x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** The object + tenant-project select every read shares. */
const SELECT_OBJECT = `SELECT o.*, a.project_id AS project FROM media_objects o
    LEFT JOIN apps a ON a.app_id = o.app_id`;

/** The summaries matching the filters: `project` scopes tenancy, `kind` picks one kind. Sorted by (kind, id). */
async function collect(db, { project = null, kind = null } = {}) {
    if (kind && kind !== OBJECT_KIND) return [];
    const rows = project
        ? await db.all(`${SELECT_OBJECT} WHERE a.project_id = ? ORDER BY o.id`, [project])
        : await db.all(`${SELECT_OBJECT} ORDER BY o.id`);
    return rows.map((o) => named(objectSummary(o))).sort(order);
}

/** A cursor is an opaque base64url [kind, id] position; only one this index issued decodes to that. */
const encodeCursor = (s) => Buffer.from(JSON.stringify([s.kind, s.id])).toString('base64url');
function decodeCursor(raw) {
    let v;
    try { v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? v : null;
}
const afterCursor = (s, [kind, id]) => s.kind > kind || (s.kind === kind && s.id > id);

/** The query as filters, or { error } for a value that cannot be honoured. An unknown kind is kept (it matches nothing). */
function filtersOf(query) {
    const project = typeof query.project === 'string' && query.project !== '' ? query.project : null;
    if (project && !PROJECT_ID_RE.test(project)) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, limit, cursor };
}

function router({ guard, db = require('../db/database') }) {
    const open = (res) => res.set('Cache-Control', 'private, max-age=60');
    const bad = (res, detail) => contracts.http.sendProblem(res, 400, 'resources.bad_query', { detail });
    const unknown = (res, name) => contracts.http.sendProblem(res, 404, 'resources.unknown_resource', { detail: `no resource named ${name}` });

    /** One common.resource-list-result@1 page: the filtered, sorted summaries from the cursor, then `limit` of them. */
    async function page(req, res) {
        const f = filtersOf(req.query);
        if (f.error) return bad(res, f.error);
        const all = await collect(db, f);
        const rest = f.cursor ? all.filter((s) => afterCursor(s, f.cursor)) : all;
        const resources = rest.slice(0, f.limit);
        const next_cursor = rest.length > f.limit ? encodeCursor(resources[resources.length - 1]) : null;
        open(res).json({ resources, next_cursor });
    }

    /** GET /api/v1/resources/:ovrn: the summary whose computed ovrn is exactly the one asked for. */
    async function one(req, res) {
        const name = String(req.params.ovrn);
        const parsed = contracts.resources.parse(name);
        let summary = null;
        if (parsed && parsed.service === SERVICE && parsed.type === 'object') {
            const row = await db.get(`${SELECT_OBJECT} WHERE o.id = ?`, [parsed.id]);
            if (row) summary = named(objectSummary(row));
        }
        if (!summary || summary.ovrn !== name) return unknown(res, name);
        open(res).json(summary);
    }

    const r = express.Router();
    r.get('/', guard, page);
    r.get('/:ovrn', guard, one);
    return r;
}

module.exports = { router, SERVICE, KINDS, OBJECT_KIND, DEFAULT_LIMIT, MAX_LIMIT, objectSummary, ovrnOf, collect, encodeCursor, isoUtc };
