/**
 * OpenVibe.Media — queue the timeline of a finished video (docs/media-fabric.md §3, F3.c)
 *
 * queueCmaf(appId, objectId) enqueues `object.cmaf` for a ready media object that has no source timeline yet: from the
 * finalize of a recording (server/vod/finalize.js), and lazily from GET …/download?format=json so a VOD older than F3.1
 * gets one on its first request. Nothing happens (null) with MEDIA_HLS_ENABLED off, for a missing, unready or non-media
 * object, or once the timeline exists. One job per object: dedupeActive joins a queued or running cut, and the
 * idempotency key `object.cmaf:<id>` answers a later call with the same job. → the job id, or null.
 */
'use strict';

const config = require('../config');

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

module.exports = { queueCmaf };
