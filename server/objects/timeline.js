/**
 * OpenVibe.Media — the timeline index (media_timeline; docs/media-fabric.md §3, F3.1).
 *
 * A video object is a timeline of CMAF segments per rendition. This module is the store: it answers
 * "the bytes for 01:47:12.350" (segmentAt) and "the segments of a rendition in order" (segments) without
 * opening a file, and writes the playlists from the rows. Segment 0 of a rendition is its init segment.
 *
 * Bytes: <object>/<rendition>/<name> is the segment's key; a copy on this node's disk sits at
 * OBJECTS_PATH/.timeline/<app>/<object>/<rendition>/<name> (local_path), and a durable one under the same key on
 * durable_provider. The object.cmaf job (server/jobs/cmaf.js) writes the source rendition; the public routes
 * /o/:id/master.m3u8 and /o/:id/source/… (objects/routes.js) serve it behind MEDIA_HLS_ENABLED.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');

const SOURCE = 'source';
const INIT_NAME = 'init.mp4';
const FIELDS = ['name', 'start_ms', 'end_ms', 'keyframe_ms', 'key', 'local_path', 'durable_provider', 'packed_object_id', 'byte_offset', 'byte_length', 'sha256', 'durability'];

function localRoot() { return path.join(path.resolve(config.objects.path), '.timeline'); }
function localPathFor(obj, rendition, name) { return path.join(localRoot(), obj.app_id, obj.id, rendition, name); }
function keyFor(objectId, rendition, name) { return `${objectId}/${rendition}/${name}`; }
function segmentName(seq) { return seq === 0 ? INIT_NAME : `${String(seq).padStart(6, '0')}.m4s`; }

/** Every row of a rendition in order, the init segment (seq 0) first. */
async function list(objectId, rendition = SOURCE) {
    return await db.all('SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? ORDER BY seq', [objectId, rendition]);
}

/** The media segments of a rendition in order (no init segment). */
async function segments(objectId, rendition = SOURCE) {
    return await db.all('SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > 0 ORDER BY seq', [objectId, rendition]);
}

async function byName(objectId, rendition, name) {
    return await db.get('SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? AND name = ?', [objectId, rendition, name]) || null;
}

async function has(objectId, rendition = SOURCE) {
    return !!(await db.get('SELECT 1 AS x FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > 0 LIMIT 1', [objectId, rendition]));
}

/** The segment holding the instant tMs (milliseconds from the start): start_ms <= t < end_ms, or null past either end. */
async function segmentAt(objectId, rendition, tMs) {
    const t = Math.floor(Number(tMs));
    if (!Number.isFinite(t) || t < 0) return null;
    const row = await db.get(`SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > 0 AND start_ms <= ?
                              ORDER BY start_ms DESC, seq DESC LIMIT 1`, [objectId, rendition, t]);
    return row && t < Number(row.end_ms) ? row : null;
}

function same(a, b) {
    return FIELDS.every((f) => (a[f] == null ? null : String(a[f])) === (b[f] == null ? null : String(b[f])));
}

/**
 * Make the rows of one rendition exactly `rows` (each { seq, name, start_ms, … }), in one transaction: a row that already
 * says the same is not written, a changed one is updated, rows past the new end are dropped. → { inserted, updated, unchanged, removed }.
 */
async function replace(objectId, rendition, rows, { jobId = null } = {}) {
    const out = { inserted: 0, updated: 0, unchanged: 0, removed: 0 };
    await db.getDb().tx(async () => {
        const before = new Map((await list(objectId, rendition)).map((r) => [Number(r.seq), r]));
        for (const r of rows) {
            const prev = before.get(r.seq);
            if (prev && same(prev, r)) { out.unchanged++; continue; }
            await db.run(`INSERT INTO media_timeline (object_id, rendition, seq, ${FIELDS.join(', ')}, job_id)
                          VALUES (?, ?, ?, ${FIELDS.map(() => '?').join(', ')}, ?)
                          ON CONFLICT (object_id, rendition, seq) DO UPDATE SET ${FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
                              job_id = excluded.job_id, updated_at = ov_now()`,
            [objectId, rendition, r.seq, ...FIELDS.map((f) => r[f] ?? null), jobId]);
            out[prev ? 'updated' : 'inserted']++;
        }
        const last = rows.reduce((m, r) => Math.max(m, r.seq), -1);
        out.removed = (await db.run('DELETE FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > ?', [objectId, rendition, last])).changes || 0;
    });
    return out;
}

/**
 * The object's whole timeline is gone with its bytes (a purge, or a vod/clip deleted for good): local files, durable
 * copies (best effort), then the rows. Callers have already refused a held object. → rows removed.
 */
async function removeObject(objectId) {
    if (!objectId) return 0;
    const rows = await db.all('SELECT * FROM media_timeline WHERE object_id = ?', [objectId]);
    if (!rows.length) return 0;
    const root = localRoot() + path.sep;
    const vodStorage = require('../vod/vod-storage');
    const dirs = new Set();
    for (const r of rows) {
        if (r.local_path && path.resolve(r.local_path).startsWith(root)) {
            try { fs.unlinkSync(r.local_path); } catch { /* already gone */ }
            dirs.add(path.dirname(r.local_path));
        }
        if (r.durable_provider && vodStorage.providerConfigured(r.durable_provider)) {
            await vodStorage.deleteObject(r.durable_provider, r.key).catch((err) => console.warn(`[Timeline] ${r.durable_provider}:${r.key} not deleted: ${err.message}`));
        }
    }
    for (const d of dirs) {
        for (const p of [d, path.dirname(d)]) { try { fs.rmdirSync(p); } catch { /* not empty or gone */ } }
    }
    return (await db.run('DELETE FROM media_timeline WHERE object_id = ?', [objectId])).changes || 0;
}

// ── Playlists (from the rows, never from files) ──────────────

const secs = (ms) => (Number(ms) / 1000).toFixed(3);

/** `?exp=…&sig=…` carried onto every URI of a signed playlist, so a private object's segments pass the same check. */
function withQuery(uri, query) { return query ? `${uri}?${query}` : uri; }

/** The media playlist of a finished rendition: VOD, ENDLIST, one EXTINF per segment with its timeline duration. */
function mediaPlaylist(rows, { query = '' } = {}) {
    const segs = rows.filter((r) => Number(r.seq) > 0);
    const init = rows.find((r) => Number(r.seq) === 0);
    const target = Math.max(1, ...segs.map((r) => Math.ceil((Number(r.end_ms) - Number(r.start_ms)) / 1000)));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${segs.length ? Number(segs[0].seq) : 1}`,
        '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (init) lines.push(`#EXT-X-MAP:URI="${withQuery(init.name, query)}"`);
    for (const r of segs) lines.push(`#EXTINF:${secs(Number(r.end_ms) - Number(r.start_ms))},`, withQuery(r.name, query));
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
}

/** The master playlist: one variant per rendition (only `source` in F3.1), BANDWIDTH = its peak segment bitrate. */
function masterPlaylist(renditions, { query = '' } = {}) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const { name, rows } of renditions) {
        const segs = rows.filter((r) => Number(r.seq) > 0);
        const rate = (r) => Math.ceil(Number(r.byte_length) * 8 * 1000 / Math.max(1, Number(r.end_ms) - Number(r.start_ms)));
        const peak = Math.max(1, ...segs.map(rate));
        const total = segs.reduce((a, r) => a + Number(r.end_ms) - Number(r.start_ms), 0);
        const avg = Math.max(1, Math.ceil(segs.reduce((a, r) => a + Number(r.byte_length), 0) * 8 * 1000 / Math.max(1, total)));
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${peak},AVERAGE-BANDWIDTH=${avg}`, withQuery(`${name}/index.m3u8`, query));
    }
    lines.push('');
    return lines.join('\n');
}

module.exports = {
    SOURCE, INIT_NAME, localRoot, localPathFor, keyFor, segmentName,
    list, segments, byName, has, segmentAt, replace, removeObject, mediaPlaylist, masterPlaylist,
};
