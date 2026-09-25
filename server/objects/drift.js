/**
 * OpenVibe.Media — object drift report (WS-G task 1: retiring compatibility shim C-75)
 *
 * Every write to an inherited vods/clips/files/pastes row now makes its media_object in the same
 * transaction (model.withObject). This report checks that nothing has drifted anyway: for each
 * projected row it derives what the object must say, with the same <kind>Projection() functions
 * the writes use, and compares that with the object on record, on the fields a sync writes:
 *
 *   kind, visibility, lifecycle_status, size_bytes, legacy_ref, app_id, owner_app, owner_user_id
 *
 * and the link to it (the row's object_id; for a vod/clip thumbnail, its parent's thumbnail
 * variant). Each checked row is ok, or has one or more of:
 *   missing   no object under its legacy ref, nor at the row's object_id
 *   unlinked  the row's object_id (the thumbnail variant) is not the object its legacy ref names
 *   mismatch  the object disagrees with the row on one of the fields above
 * Rows that have no object by design (clips-only recordings, screenshot pastes without a file,
 * external thumbnail URLs) are counted as skipped; text pastes are not projected and not listed.
 *
 * READ-ONLY. Pure SQL over a small `q` interface ({ all(sql, params), get(sql, params) }), so the
 * script (scripts/object-drift-report.js) runs it on a database opened read-only; beyond that it
 * only stats local files, as the projection does. Nothing is written, re-projected or moved.
 */
'use strict';

const model = require('./model');

const FIELDS = ['kind', 'visibility', 'lifecycle_status', 'size_bytes', 'legacy_ref', 'app_id', 'owner_app', 'owner_user_id'];
const KINDS = ['vod', 'clip', 'file', 'screenshot', 'avatar', 'thumbnail'];
const PAGE = 500;
const OBJECT_COLS = `id, ${FIELDS.join(', ')}`;

/** The compared fields as project() writes them from a projection input. */
function expectedFields(p) {
    return {
        kind: p.kind, visibility: p.visibility, lifecycle_status: p.lifecycle_status, size_bytes: Number(p.size_bytes) || 0,
        legacy_ref: p.legacy_ref, app_id: p.app_id, owner_app: p.owner_app || p.app_id, owner_user_id: p.owner_user_id ?? null,
    };
}

// SQLite hands integers back as numbers and TEXT as strings; an app-local user id may be either.
const same = (a, b) => (a == null ? '' : String(a)) === (b == null ? '' : String(b));

/** Every row of `table` (optionally one tenant's) in key order, a page at a time. */
function* eachRow(q, table, keyCol, { appId = null, where = null } = {}) {
    const conds = [];
    const params = [];
    if (appId) { conds.push('app_id = ?'); params.push(appId); }
    if (where) conds.push(where);
    let last = null;
    for (;;) {
        const c = last == null ? conds : [...conds, `${keyCol} > ?`];
        const page = q.all(`SELECT * FROM ${table}${c.length ? ` WHERE ${c.join(' AND ')}` : ''} ORDER BY ${keyCol} LIMIT ${PAGE}`,
            last == null ? params : [...params, last]);
        for (const r of page) yield r;
        if (page.length < PAGE) return;
        last = page[page.length - 1][keyCol];
    }
}

function buildReport(q, { appId = null, limit = 20 } = {}) {
    const report = {
        generated_at: new Date().toISOString(),
        app_id: appId,
        limit,
        fields: FIELDS,
        kinds: Object.fromEntries(KINDS.map(k => [k, { rows: 0, ok: 0, skipped: 0, drifted: 0, missing: 0, unlinked: 0, mismatch: 0, examples: [] }])),
        field_counts: Object.fromEntries(FIELDS.map(f => [f, 0])),
        total_rows: 0,
        total_drift: 0,
    };
    // Objects by legacy ref, loaded once (the compared columns only); a row's object_id is looked up when its ref finds none.
    const byRef = new Map(q.all(`SELECT ${OBJECT_COLS} FROM media_objects WHERE legacy_ref IS NOT NULL`).map(o => [o.legacy_ref, o]));
    const byId = (id) => (id ? q.get(`SELECT ${OBJECT_COLS} FROM media_objects WHERE id = ?`, [id]) || null : null);

    /** Compare one row's projection with its object. Returns the object found (or null). */
    const check = (kind, where, p, linkedId) => {
        const k = report.kinds[kind];
        k.rows++;
        report.total_rows++;
        const found = byRef.get(p.legacy_ref) || byId(linkedId);
        const problems = [];
        const diff = {};
        if (!found) {
            problems.push('missing');
        } else {
            if (!same(linkedId, found.id)) { problems.push('unlinked'); diff.object_id = { row: linkedId || null, object: found.id }; }
            const want = expectedFields(p);
            for (const f of FIELDS) {
                if (same(want[f], found[f])) continue;
                diff[f] = { row: want[f], object: found[f] ?? null };
                report.field_counts[f]++;
            }
            if (FIELDS.some(f => f in diff)) problems.push('mismatch');
        }
        if (!problems.length) { k.ok++; return found; }
        k.drifted++;
        report.total_drift++;
        for (const pr of problems) k[pr]++;
        if (k.examples.length < limit) k.examples.push({ ...where, legacy_ref: p.legacy_ref, object_id: found ? found.id : null, problems, diff });
        return found;
    };
    const skip = (kind) => { report.kinds[kind].skipped++; };
    const thumbnailOf = (row, table, parentKind, parent) => {
        const tp = model.thumbnailProjection(row, parentKind);
        if (!tp) return;
        if (tp.skipped) return skip('thumbnail');
        const variant = parent ? q.get("SELECT derived_object_id FROM media_variants WHERE object_id = ? AND variant_name = 'thumbnail'", [parent.id]) : null;
        check('thumbnail', { table, id: row.id, of: parentKind }, tp, variant ? variant.derived_object_id : null);
    };

    for (const row of eachRow(q, 'vods', 'id', { appId })) {
        const p = model.vodProjection(row);
        if (p.skipped) { skip('vod'); continue; }
        thumbnailOf(row, 'vods', 'vod', check('vod', { table: 'vods', id: row.id }, p, row.object_id));
    }
    for (const row of eachRow(q, 'clips', 'id', { appId })) {
        thumbnailOf(row, 'clips', 'clip', check('clip', { table: 'clips', id: row.id }, model.clipProjection(row), row.object_id));
    }
    for (const row of eachRow(q, 'files', 'key', { appId })) {
        check('file', { table: 'files', id: row.key }, model.fileProjection(row), row.object_id);
    }
    for (const row of eachRow(q, 'pastes', 'id', { appId, where: "type = 'screenshot'" })) {
        const p = model.pasteProjection(row);
        if (p.skipped) { skip('screenshot'); continue; }
        check(p.kind, { table: 'pastes', id: row.id, slug: row.slug }, p, row.object_id);
    }
    return report;
}

const fmt = (v) => (v == null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v));

function formatReport(r) {
    const lines = [`Object drift report — ${r.generated_at}${r.app_id ? ` (app ${r.app_id})` : ' (all apps)'}`];
    lines.push(`  ${'kind'.padEnd(11)} ${'rows'.padStart(7)} ${'ok'.padStart(7)} ${'drifted'.padStart(8)} ${'missing'.padStart(8)} ${'unlinked'.padStart(9)} ${'mismatch'.padStart(9)} ${'skipped'.padStart(8)}`);
    for (const [kind, c] of Object.entries(r.kinds)) {
        lines.push(`  ${kind.padEnd(11)} ${String(c.rows).padStart(7)} ${String(c.ok).padStart(7)} ${String(c.drifted).padStart(8)} ${String(c.missing).padStart(8)} ${String(c.unlinked).padStart(9)} ${String(c.mismatch).padStart(9)} ${String(c.skipped).padStart(8)}`);
    }
    const fields = Object.entries(r.field_counts).filter(([, n]) => n).map(([f, n]) => `${f} ${n}`);
    lines.push(`  fields that disagree: ${fields.join(', ') || 'none'}`);
    lines.push(`  total drift: ${r.total_drift} of ${r.total_rows} row(s)${r.total_drift ? '' : ' — none'}`);
    for (const [kind, c] of Object.entries(r.kinds)) {
        if (!c.examples.length) continue;
        lines.push(`  ${kind} examples (${c.examples.length} of ${c.drifted}):`);
        for (const e of c.examples) {
            const what = Object.entries(e.diff).map(([f, d]) => `${f} row=${fmt(d.row)} object=${fmt(d.object)}`).join('; ');
            lines.push(`    ${e.table} ${e.id}${e.of ? ` (${e.of} thumbnail)` : ''} ${e.object_id || '-'} ${e.problems.join('+')}${what ? `: ${what}` : ` (${e.legacy_ref})`}`);
        }
    }
    return lines.join('\n');
}

module.exports = { buildReport, formatReport, expectedFields, FIELDS, KINDS };
