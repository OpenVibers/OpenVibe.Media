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
 * With a source timeline and MEDIA_RENDITIONS on, the missing renditions (F4: rendition.create) are queued the same lazy
 * way, so the master playlist lists them once they exist. A single-item read takes that path (deduped in-process); a
 * list read uses discoveryMany, which answers a whole page in a constant number of queries and never queues anything.
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

// The lazy object.cmaf one read can queue (discoveryForObject) is deduped per process: objectId → last queued ms.
// A bounded Map (QUEUE_MAX entries, expired ones swept first) keeps it from growing without limit; the TTL is a
// window, not correctness — timeline-queue.queueCmaf is itself idempotent, this only spares a hot read its queries.
const QUEUE_TTL_MS = 10 * 60 * 1000;
const QUEUE_MAX = 1000;
const _queuedCmaf = new Map();
const _queuedRenditions = new Map();

/** Run `queue()` for an object at most once per QUEUE_TTL_MS in this process. Never throws. */
async function throttleOnce(map, objectId, queue) {
    const now = Date.now();
    const last = map.get(objectId);
    if (last != null && now - last < QUEUE_TTL_MS) return;
    if (map.size >= QUEUE_MAX) {
        for (const [id, at] of map) if (now - at >= QUEUE_TTL_MS) map.delete(id);
        while (map.size >= QUEUE_MAX) map.delete(map.keys().next().value);
    }
    map.set(objectId, now);
    try { await queue(); } catch (err) { console.warn(`[HLS] Queue failed for ${objectId}:`, err.message); }
}

/** Queue object.cmaf for an object at most once per QUEUE_TTL_MS in this process. Never throws. */
async function queueCmafOnce(appId, objectId) {
    await throttleOnce(_queuedCmaf, objectId, () => require('./timeline-queue').queueCmaf(appId, objectId));
}

/**
 * Queue the missing renditions (rendition.create, F4) for an object at most once per QUEUE_TTL_MS in this process: the
 * lazy path from the master playlist route and GET …/download?format=json. Never throws. Nothing is queued when
 * MEDIA_RENDITIONS is off (timeline-queue.queueRendition checks) or for a virtual clip.
 */
async function queueRenditionsOnce(obj) {
    if (!config.hls.enabled || !config.hls.renditions) return;
    await throttleOnce(_queuedRenditions, obj.id, () => require('./timeline-queue').queueRendition(obj.app_id, obj.id));
}

/**
 * The renditions an object's master playlist offers: `source` first, then every other rendition whose rows exist (the
 * route lists a rendition only once it was produced). `sourceRows` is the object's own source rows when the caller
 * already has them (a virtual clip's window over its source), so it is not read twice.
 */
async function renditionsFor(obj, sourceRows = null) {
    const timeline = require('./timeline');
    const source = sourceRows || (await timelineOf(obj)).rows;
    const out = [{ name: timeline.SOURCE, rows: source }];
    const extra = await db.all('SELECT DISTINCT rendition FROM media_timeline WHERE object_id = ? AND rendition <> ? AND seq > 0 ORDER BY rendition', [obj.id, timeline.SOURCE]);
    for (const r of extra) out.push({ name: r.rendition, rows: await timeline.list(obj.id, r.rendition) });
    return out;
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
            if (!tl.window) await queueCmafOnce(obj.app_id, obj.id);
            return null;
        }
        // The source timeline exists: queue any missing rendition (F4) so the master playlist can list it next time.
        if (!tl.window) await queueRenditionsOnce(obj);
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

/**
 * The HLS answers for a whole page of v1 rows (the VOD/clip lists), in a constant number of queries: the objects,
 * which of them have a timeline, their sandbox tenants, and — only for clip objects with no timeline of their own —
 * the source window they play over (F3.5). discoveryForObject's per-row path would run all of that once per row,
 * and queue object.cmaf for each row without a timeline; a list read must do neither.
 *
 * Returns a Map(object_id → { hls_url, hls_expires_at? }). A row with no serviceable timeline (and any lookup that
 * fails) simply has no entry. Never queues object.cmaf. Never throws.
 */
async function discoveryMany(rows) {
    const out = new Map();
    if (!config.hls.enabled || !Array.isArray(rows) || !rows.length) return out;
    try {
        const objectIds = [...new Set(rows.map((r) => r && r.object_id).filter(Boolean).map(String))];
        if (!objectIds.length) return out;
        const timeline = require('./timeline');

        const ready = (await db.all('SELECT * FROM media_objects WHERE id = ANY(?)', [objectIds]))
            .filter((o) => o.lifecycle_status === 'ready');
        if (!ready.length) return out;
        const readyIds = ready.map((o) => String(o.id));
        const withTimeline = new Set((await db.all(
            'SELECT DISTINCT object_id FROM media_timeline WHERE rendition = ? AND seq > 0 AND object_id = ANY(?)',
            [timeline.SOURCE, readyIds])).map((r) => String(r.object_id)));

        // A clip object without a timeline of its own is a virtual clip: its playlist is its source's window.
        const virtual = new Set();
        const needWindow = ready.filter((o) => o.kind === 'clip' && !withTimeline.has(String(o.id)));
        if (needWindow.length) {
            const rels = await db.all("SELECT from_object_id, to_object_id, metadata FROM media_relationships WHERE relation = 'clip_of' AND from_object_id = ANY(?) ORDER BY id",
                [needWindow.map((o) => String(o.id))]);
            const relOf = new Map();
            for (const r of rels) if (!relOf.has(String(r.from_object_id))) relOf.set(String(r.from_object_id), r);
            const sourceIds = [...new Set(rels.map((r) => String(r.to_object_id)))];
            const sourceOf = new Map((sourceIds.length ? await db.all('SELECT * FROM media_objects WHERE id = ANY(?)', [sourceIds]) : [])
                .map((s) => [String(s.id), s]));
            const sourceRows = new Map();
            if (sourceIds.length) {
                for (const r of await db.all('SELECT * FROM media_timeline WHERE rendition = ? AND object_id = ANY(?) ORDER BY object_id, seq', [timeline.SOURCE, sourceIds])) {
                    const k = String(r.object_id);
                    if (!sourceRows.has(k)) sourceRows.set(k, []);
                    sourceRows.get(k).push(r);
                }
            }
            for (const clip of needWindow) {
                const rel = relOf.get(String(clip.id));
                const src = rel && sourceOf.get(String(rel.to_object_id));
                if (!src || src.app_id !== clip.app_id || src.lifecycle_status !== 'ready') continue;
                const md = model.parseJson(rel.metadata, {});
                const startMs = Math.max(0, Math.round(Number(md.start_time) * 1000) || 0);
                const endMs = Math.round(Number(md.end_time) * 1000) || 0;
                if (!(endMs > startMs)) continue;
                const clipped = timeline.clipRows(sourceRows.get(String(src.id)) || [], startMs, endMs);
                if (clipped.some((r) => Number(r.seq) > 0)) virtual.add(String(clip.id));
            }
        }

        // isSandboxTenant, resolved once per distinct app of the page instead of once per row.
        const appIds = [...new Set(ready.map((o) => String(o.app_id)))];
        const sandbox = new Set((await db.all("SELECT app_id FROM apps WHERE env = 'sandbox' AND app_id = ANY(?)", [appIds]))
            .map((r) => String(r.app_id)));

        for (const obj of ready) {
            const id = String(obj.id);
            if (!withTimeline.has(id) && !virtual.has(id)) continue;
            out.set(id, playlistFor(obj, obj.visibility !== 'private' && !sandbox.has(String(obj.app_id))));
        }
    } catch (err) {
        console.warn('[HLS] Batch discovery failed:', err.message);
    }
    return out;
}

module.exports = { timelineOf, renditionsFor, queueRenditionsOnce, discoveryForObject, discovery, discoveryMany };
