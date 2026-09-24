/**
 * OpenVibe.Media — report on the B2 `vods-orphans/` prefix (hazard H3: 55 objects, 14.5 GB on
 * 2026-09-21). Report only: it lists, matches and recommends; it never deletes, moves or writes.
 *
 * Each object under the prefix is matched to a VOD or clip by its file name (the basename of
 * vods.file_path / storage_key, clips.file_path; else the vod-<app>-<id>-<ms>.<ext> name the
 * recorder gives recordings), and checked against that row's canonical copy (HEAD vods/<basename>
 * on the same provider), its R2 copy and its local file. Recommendations:
 *
 *   keep_only_copy        the row exists and no canonical, R2 or local copy does: this IS the recording
 *                         (restore it to its canonical key; never delete)
 *   keep_until_offloaded  no canonical copy yet, but the local file has the same size
 *   delete_duplicate      the canonical copy exists with the same size
 *   review_size_differs   a copy exists but with another size (keep until someone compares them)
 *   delete_row_gone       the name points at a VOD/clip id whose row no longer exists (deleted); its
 *                         object says when, if the model saw it
 *   review_row_mismatch   the id exists but its row points at another file
 *   review_unknown        the name matches nothing
 * `delete_*` are candidates for the owner to approve, never acted on here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const PREFIX = 'vods-orphans/';
const RECOMMENDATIONS = ['keep_only_copy', 'keep_until_offloaded', 'delete_duplicate', 'review_size_differs', 'delete_row_gone', 'review_row_mismatch', 'review_unknown'];

const vodStorage = () => require('./vod-storage');

/** vod-<app>-<id>-<epoch ms>.<ext> (+ .master.mkv) → { app, id, recorded_at } or null. */
function parseRecordingName(base) {
    const m = /^vod-(.+)-(\d+)-(\d{12,14})(?:\.master)?\.[a-z0-9]+$/i.exec(String(base || ''));
    if (!m) return null;
    return { app: m[1], id: Number(m[2]), recorded_at: new Date(Number(m[3])).toISOString() };
}

function rowByBasename(base) {
    const vod = db.getVodByFileBasename(base);
    if (vod) return { kind: 'vod', row: vod };
    const byKey = db.all('SELECT * FROM vods WHERE storage_key LIKE ?', [`%${base}`]).find(r => path.basename(r.storage_key || '') === base);
    if (byKey) return { kind: 'vod', row: byKey };
    const clip = db.getClipByFileBasename(base);
    if (clip) return { kind: 'clip', row: clip };
    return null;
}

function objectFor(kind, app, id) {
    try { return db.get('SELECT id, lifecycle_status, deleted_at FROM media_objects WHERE legacy_ref = ?', [`legacy:${app}:${kind}:${id}`]); } catch { return null; }
}

async function head(provider, key) {
    const vs = vodStorage();
    if (!vs.providerConfigured(provider)) return { configured: false };
    try { const h = await vs.headObject(provider, key); return h ? { configured: true, size: Number(h.size) } : { configured: true, size: null }; } catch (err) { return { configured: true, error: err.message }; }
}

function localSize(row) {
    const vs = vodStorage();
    for (const p of [vs.localPathForVod(row), row.file_path].filter(Boolean)) {
        try { const st = fs.statSync(p); if (st.isFile()) return st.size; } catch { /* next */ }
    }
    return null;
}

/** One orphan object → its row, the copies that exist, and a recommendation. */
async function assess(obj, { provider = 'b2' } = {}) {
    const vs = vodStorage();
    const base = path.basename(obj.key);
    const parsed = parseRecordingName(base);
    const out = { key: obj.key, size: obj.size, last_modified: obj.last_modified, name: parsed, match: null, copies: {}, recommendation: null, reason: null };
    const found = rowByBasename(base);
    if (!found) {
        if (parsed) {
            const byId = db.get('SELECT * FROM vods WHERE id = ? AND app_id = ?', [parsed.id, parsed.app]);
            if (byId) {
                out.match = { kind: 'vod', id: byId.id, app_id: byId.app_id, file: path.basename(byId.file_path || ''), storage_provider: byId.storage_provider || 'local' };
                out.recommendation = 'review_row_mismatch';
                out.reason = `vod ${byId.id} exists but points at ${out.match.file || 'no file'}`;
                return out;
            }
            const o = objectFor('vod', parsed.app, parsed.id);
            out.match = { kind: 'vod', id: parsed.id, app_id: parsed.app, row: 'gone', object: o ? { id: o.id, lifecycle_status: o.lifecycle_status, deleted_at: o.deleted_at } : null };
            out.recommendation = 'delete_row_gone';
            out.reason = `vod ${parsed.id} (${parsed.app}) no longer exists${o && o.deleted_at ? ` (deleted ${o.deleted_at})` : ''}; recorded ${parsed.recorded_at}`;
            return out;
        }
        out.recommendation = 'review_unknown';
        out.reason = 'the name matches no VOD or clip';
        return out;
    }
    const { kind, row } = found;
    const canonicalKey = vs.keyForVod(row);
    out.match = { kind, id: row.id, app_id: row.app_id, storage_provider: row.storage_provider || 'local', canonical_key: canonicalKey, health_status: row.health_status || null,
        is_public: row.is_public, visibility: row.visibility || null, duration_seconds: row.duration_seconds || 0 };
    if (canonicalKey === obj.key) {
        // The row's storage_key points into the orphan prefix: this object is its canonical copy.
        out.recommendation = 'keep_only_copy';
        out.reason = `${kind} ${row.id}'s storage_key is this object: it is the canonical copy (never delete)`;
        return out;
    }
    out.copies.canonical = await head(provider, canonicalKey);
    if ((row.storage_provider || 'local') === 'r2') out.copies.r2 = await head('r2', canonicalKey);
    out.copies.local = localSize(row);
    const sizes = [out.copies.canonical && out.copies.canonical.size, out.copies.r2 && out.copies.r2.size].filter(s => s != null);
    if (sizes.includes(obj.size)) {
        out.recommendation = 'delete_duplicate';
        out.reason = `${kind} ${row.id}'s canonical copy ${canonicalKey} exists with the same size`;
    } else if (sizes.length || (out.copies.local != null && out.copies.local !== obj.size)) {
        out.recommendation = 'review_size_differs';
        out.reason = `${kind} ${row.id} has a copy of another size (${[...sizes, out.copies.local].filter(s => s != null).join(', ')} vs ${obj.size} bytes)`;
    } else if (out.copies.local === obj.size) {
        out.recommendation = 'keep_until_offloaded';
        out.reason = `${kind} ${row.id} is still local (same size); the orphan is redundant once it is offloaded to ${canonicalKey}`;
    } else {
        out.recommendation = 'keep_only_copy';
        out.reason = `the only copy of ${kind} ${row.id}: restore it to ${canonicalKey} (never delete)`;
    }
    return out;
}

/** The whole report: { prefix, provider, bucket, generated_at, totals, by_recommendation, objects }. */
async function buildReport({ provider = 'b2', prefix = PREFIX, list = null } = {}) {
    const vs = vodStorage();
    const objects = list || await vs.listObjects(provider, prefix);
    const rows = [];
    for (const o of objects) rows.push(await assess(o, { provider }));
    const by = Object.fromEntries(RECOMMENDATIONS.map(r => [r, { objects: 0, bytes: 0 }]));
    let bytes = 0;
    for (const r of rows) { by[r.recommendation].objects++; by[r.recommendation].bytes += r.size; bytes += r.size; }
    return {
        kind: 'media.vods_orphans.report', version: 1, generated_at: new Date().toISOString(), provider, bucket: vs.bucketFor(provider), prefix,
        read_only: true, totals: { objects: rows.length, bytes, gb: Number((bytes / 1e9).toFixed(2)) }, by_recommendation: by, objects: rows,
        note: 'Report only: nothing was deleted, moved or written. delete_* rows are candidates for the owner to approve.',
    };
}

module.exports = { PREFIX, RECOMMENDATIONS, parseRecordingName, assess, buildReport };
