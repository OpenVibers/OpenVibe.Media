/**
 * OpenVibe.Media — HLS discovery for an object (docs/media-fabric.md §3, F3.c)
 *
 * One place answers "does this object have a serviceable HLS timeline, and what is its playlist URL?": the v2
 * /o/:id/download?format=json route (objects/routes.js) and the v1 VOD and clip shapes (vod/finalize.js vodPublic,
 * vod/clips-routes.js clipPublic) all use it, so the field and its access rules cannot drift between them.
 *
 * A playlist exists when MEDIA_HLS_ENABLED is on and the object's source timeline has a media row (seq > 0) — its own
 * rows, or for a virtual clip (F3.5) its source's window rows. With none, object.cmaf is queued (idempotent) and no URL
 * is answered, unless the object is a virtual clip (its source's window plays it; it is never cut a timeline of its own).
 *
 * The URL is built exactly as the v2 route does: an open object (not private, not in a sandbox tenant) gets the plain
 * /o/<id>/master.m3u8; a closed one gets a signed playlist (purpose 'hls', signing.signedPlaylistUrl) and its expiry.
 */
'use strict';

const config = require('../config');
const db = require('../db/database');
const model = require('./model');
const signing = require('./signing');

/**
 * The window of a clip object over its source (F3.5): { sourceId, startMs, endMs } from its `clip_of` edge (metadata
 * start_time/end_time in seconds), or null — not a clip, no edge, or a source that is not this tenant's ready object.
 */
async function clipWindow(obj) {
    if (!obj || obj.kind !== 'clip') return null;
    const rel = await db.get(`SELECT to_object_id, metadata FROM media_relationships WHERE from_object_id = ? AND relation = 'clip_of' ORDER BY id LIMIT 1`, [obj.id]);
    if (!rel) return null;
    const src = await model.getObject(rel.to_object_id);
    if (!src || src.app_id !== obj.app_id || src.lifecycle_status !== 'ready') return null;
    const md = model.parseJson(rel.metadata, {});
    const startMs = Math.max(0, Math.round(Number(md.start_time) * 1000) || 0);
    const endMs = Math.round(Number(md.end_time) * 1000) || 0;
    return endMs > startMs ? { sourceId: src.id, startMs, endMs } : null;
}

/**
 * The source rendition an object's playlists are written from: its own rows, or — a clip without its own timeline (a
 * virtual clip, F3.5) — timeline.clipRows over its source's rows, cut to the clip's window. The window is the token's
 * scope: a clip's signature (checked against the clip's own id) reaches only the names these rows carry.
 */
async function timelineOf(obj) {
    const timeline = require('./timeline');
    const own = await timeline.list(obj.id, timeline.SOURCE);
    if (own.some((r) => Number(r.seq) > 0)) return { rows: own, window: null };
    const window = await clipWindow(obj);
    if (!window) return { rows: [], window: null };
    return { rows: timeline.clipRows(await timeline.list(window.sourceId, timeline.SOURCE), window.startMs, window.endMs), window };
}

/** Whether an object is served openly: not private and not in a developer-project sandbox tenant (GET /o/:id's rule). */
async function isOpen(obj) {
    return obj.visibility !== 'private' && !await db.isSandboxTenant(obj.app_id);
}

/** What an object with a serviceable timeline is discovered by: { hls_url, hls_expires_at? } (open stays unsigned). */
function playlistFor(obj, open) {
    if (open) return { hls_url: `${config.publicUrl}/o/${obj.id}/master.m3u8` };
    const signed = signing.signedPlaylistUrl(obj.id);
    return { hls_url: signed.url, hls_expires_at: signed.expires_at };
}

/**
 * The HLS answer for an already-loaded ready object, or null: { hls_url, hls_expires_at? } once the timeline exists;
 * otherwise object.cmaf is queued (idempotent) for an object that could still get one and nothing is answered. Never
 * throws — a lookup or queue failure is logged and the object simply has no hls_url this time.
 */
async function discoveryForObject(obj) {
    if (!config.hls.enabled || !obj || obj.lifecycle_status !== 'ready') return null;
    try {
        const tl = await timelineOf(obj);
        if (!tl.rows.some((r) => Number(r.seq) > 0)) {
            if (!tl.window) {
                try { await require('./timeline-queue').queueCmaf(obj.app_id, obj.id); } catch (err) { console.warn(`[HLS] Timeline queue failed for ${obj.id}:`, err.message); }
            }
            return null;
        }
        return playlistFor(obj, await isOpen(obj));
    } catch (err) {
        console.warn(`[HLS] Discovery failed for ${obj.id}:`, err.message);
        return null;
    }
}

/** discoveryForObject for a v1 row's object_id (null/absent id answers nothing). */
async function discovery(objectId) {
    if (!config.hls.enabled || !objectId) return null;
    try {
        return await discoveryForObject(await model.getObject(String(objectId)));
    } catch (err) {
        console.warn(`[HLS] Discovery failed for ${objectId}:`, err.message);
        return null;
    }
}

module.exports = { timelineOf, discoveryForObject, discovery };
