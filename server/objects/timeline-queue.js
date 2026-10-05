/**
 * OpenVibe.Media — queue a finished video's timeline and its packing (docs/media-fabric.md §3, F3)
 *
 * queueCmaf(appId, objectId) enqueues `object.cmaf` for a ready media object that has no source timeline yet: from the
 * finalize of a recording (server/vod/finalize.js), and lazily from GET …/download?format=json so a VOD older than F3.1
 * gets one on its first request. Nothing happens (null) with MEDIA_HLS_ENABLED off, for a missing, unready or non-media
 * object, or once the timeline exists. One job per object: dedupeActive joins a queued or running cut, and the
 * idempotency key `object.cmaf:<id>` answers a later call with the same job. → the job id, or null.
 *
 * queuePack(appId, objectId, { rendition }) enqueues `object.pack` once a cut's rows are committed (server/jobs/cmaf.js,
 * server/jobs/rendition.js), so packing follows the cut by itself instead of an operator's hand. Nothing happens (null)
 * with MEDIA_HLS_ENABLED off or for a missing or non-media object. One job at a time per object and rendition:
 * dedupeActive joins a queued or running pack, so a rerun while it is active joins it and a later cut queues a new one.
 * → the job id, or null.
 *
 * queueRendition(appId, objectId, { rendition }) enqueues `rendition.create` for a ready media object that does not have
 * that rendition yet (docs/media-fabric.md §5, F4): lazily, from the master playlist route and from
 * GET …/download?format=json (objects/hls.js). Nothing happens (null) with MEDIA_HLS_ENABLED or MEDIA_RENDITIONS off,
 * for a missing, unready, held or non-media object, for a virtual clip (it plays its source's window), or once the rows
 * exist. One job per object, rendition AND source cut: dedupeActive joins a queued or running one, and the idempotency
 * key `rendition.create:<id>:<name>:<srcver>` (srcver = a short hash of the source rows) answers a later request with
 * the same job — so a source below the rung's height settles after the one job that decided to skip it, while a re-cut
 * source gets a new key and is queued again. → the job id, or null.
 */
'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * The identity of the source cut a rendition is made against: the first 16 hex of sha256 over the source rows' (seq,
 * sha256) in seq order. A re-cut changes the rows and so the key; the same cut keeps deduping a skipped or failed job.
 */
function sourceVersion(rows) {
    const h = crypto.createHash('sha256');
    for (const r of rows) h.update(`${Number(r.seq)}:${r.sha256 || ''}\n`);
    return h.digest('hex').slice(0, 16);
}

async function queueCmaf(appId, objectId, { segment_seconds = null } = {}) {
    if (!config.hls.enabled || !appId || !objectId) return null;
    const obj = await require('./model').getObject(objectId);
    if (!obj || obj.lifecycle_status !== 'ready' || !require('../jobs/derive').isMediaObject(obj)) return null;
    if (await require('./timeline').has(obj.id)) return null;
    const queue = require('../jobs/queue');
    const params = require('../jobs/cmaf').spec.validate({ appId, obj, params: segment_seconds != null ? { segment_seconds } : {} });
    const r = await queue.enqueue({
        appId, type: 'object.cmaf', objectId: obj.id, params,
        dedupeActive: true, idempotencyKey: `object.cmaf:${obj.id}`, createdBy: 'system:timeline',
    });
    if (r.created) require('../jobs/worker').kick();
    return r.job ? r.job.id : null;
}

async function queuePack(appId, objectId, { rendition = null } = {}) {
    if (!config.hls.enabled || !appId || !objectId) return null;
    const obj = await require('./model').getObject(objectId);
    if (!obj || !require('../jobs/derive').isMediaObject(obj)) return null;
    const queue = require('../jobs/queue');
    const params = require('../jobs/pack').spec.validate({ appId, obj, params: rendition ? { rendition } : {} });
    const r = await queue.enqueue({
        appId, type: 'object.pack', objectId: obj.id, params,
        dedupeActive: true, createdBy: 'system:timeline',
    });
    if (r.created) require('../jobs/worker').kick();
    return r.job ? r.job.id : null;
}

/**
 * The renditions this server ships for the master playlist: the ladder names of rendition.create. Kept here so the
 * routes and this module agree without objects/hls.js requiring the job.
 */
function renditionNames() { return require('../jobs/rendition').renditionNames(); }

/**
 * Queue `rendition.create` for each rung the object does not have yet (one, '720p'), joined per object and rendition.
 * `rendition` names a single rung instead of the whole ladder. → the first job id, or null when nothing was queued.
 */
async function queueRendition(appId, objectId, { rendition = null } = {}) {
    if (!config.hls.enabled || !config.hls.renditions || !appId || !objectId) return null;
    const obj = await require('./model').getObject(objectId);
    if (!obj || obj.lifecycle_status !== 'ready' || !require('../jobs/derive').isMediaObject(obj)) return null;
    // A held object is left alone (as the rendition job itself refuses it): queue nothing, so a hold does not burn jobs.
    if (await require('./model').isHeld(obj.id)) return null;
    const timeline = require('./timeline');
    // A virtual clip (no timeline of its own) plays its source's window: it gets no rendition of its own.
    if (obj.kind === 'clip' && !await timeline.has(obj.id)) return null;
    const queue = require('../jobs/queue');
    const names = rendition ? [String(rendition)] : renditionNames();
    const srcVer = sourceVersion(await timeline.list(obj.id, timeline.SOURCE));
    let first = null;
    for (const name of names) {
        if (await timeline.has(obj.id, name)) continue;
        const params = require('../jobs/rendition').spec.validate({ appId, obj, params: { rendition: name } });
        const r = await queue.enqueue({
            appId, type: 'rendition.create', objectId: obj.id, params,
            dedupeActive: true, idempotencyKey: `rendition.create:${obj.id}:${name}:${srcVer}`, createdBy: 'system:rendition',
        });
        if (r.created) require('../jobs/worker').kick();
        if (first == null && r.job) first = r.job.id;
    }
    return first;
}

module.exports = { queueCmaf, queuePack, queueRendition };
