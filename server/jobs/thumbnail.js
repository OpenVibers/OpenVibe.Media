/**
 * OpenVibe.Media — job type thumbnail.regenerate (light lane)
 *
 * The thumbnail (re)generation POST /api/v1/:app/thumbnails/:kind/:id did inline now runs as a job:
 * the route enqueues it (joining an identical job that is still queued or running) and waits for it,
 * so its answer is unchanged. The v2 jobs API can queue it too, for a vod or clip object.
 *
 *   params { kind: 'vod' | 'clip', id: <row id> }   (derived from the object's legacy ref when omitted)
 *   result { url, kind, id }
 * Failures: media_unavailable (no local file and no cloud copy, an empty file, or a recording the
 * health scan found zero-byte / missing; permanent, answered 404 by the v1 route), not_found
 * (permanent), generate_failed (ffmpeg produced no frame from real media; retried).
 */
'use strict';

const db = require('../db/database');
const { JobError } = require('./queue');

function targetOf(obj, params = {}) {
    let kind = params.kind != null ? String(params.kind) : null;
    let id = params.id != null ? Number(params.id) : null;
    if ((!kind || id == null) && obj) {
        const ref = require('../objects/model').parseLegacyRef(obj.legacy_ref);
        if (ref && (ref.kind === 'vod' || ref.kind === 'clip')) { kind = kind || ref.kind; id = id != null ? id : Number(ref.id); }
    }
    if (kind !== 'vod' && kind !== 'clip') throw new JobError('media.job.invalid', "thumbnail.regenerate needs a vod or clip (params.kind 'vod' | 'clip' and params.id, or a vod/clip object)", { permanent: true });
    if (!Number.isInteger(id) || id < 1) throw new JobError('media.job.invalid', 'thumbnail.regenerate needs params.id (the vod or clip id)', { permanent: true });
    return { kind, id };
}

function rowOf(appId, kind, id) {
    return kind === 'vod' ? db.getVodById(id, appId) : db.getClipById(id, appId);
}

/** Normalized params, or JobError (400). The row must exist in this tenant (and match the object when one is named). */
function validate({ appId, obj, params }) {
    const t = targetOf(obj, params || {});
    const row = rowOf(appId, t.kind, t.id);
    if (!row) throw new JobError('media.job.not_found', `${t.kind} ${t.id} not found`, { status: 404, permanent: true });
    if (obj && row.object_id && row.object_id !== obj.id) throw new JobError('media.job.invalid', `the object is not ${t.kind} ${t.id}`, { permanent: true });
    return t;
}

async function run(job) {
    const { kind, id } = targetOf(null, job.params);
    const row = rowOf(job.app_id, kind, id);
    if (!row) throw new JobError('not_found', `${kind} ${id} not found`, { permanent: true });
    const thumbService = require('../thumbnails/thumbnail-service');
    // A recording the health scan found empty or gone has no frame to take (five such VODs failed as
    // generate_failed on 2026-09-23: ffmpeg was run on 0-byte files and Live got a 500).
    if (kind === 'vod' && ['zero_byte', 'missing_file'].includes(row.health_status)) {
        throw new JobError('media_unavailable', `The recording is ${row.health_status === 'zero_byte' ? 'empty (0 bytes)' : 'missing'}`, { permanent: true, status: 404 });
    }
    let source = null;
    if (kind === 'clip' && row.file_path && require('fs').existsSync(row.file_path)) source = { kind: 'file', value: row.file_path };
    else source = await require('../vod/vod-storage').resolveMediaSource(row);
    if (!source) throw new JobError('media_unavailable', 'Media file unavailable', { permanent: true, status: 404 });
    if (source.kind === 'file') {
        let size = 0;
        try { size = require('fs').statSync(source.value).size; } catch { size = 0; }
        if (!size) throw new JobError('media_unavailable', 'The media file is empty (0 bytes)', { permanent: true, status: 404 });
    }
    const url = kind === 'vod'
        ? await thumbService.generateVodThumbnail(id, source.value)
        : await thumbService.generateClipThumbnail(id, source.value);
    if (!url) throw new JobError('generate_failed', 'Failed to generate thumbnail');
    return { url, kind, id };
}

module.exports = {
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 2 * 60 * 1000, needsObject: false, backoffS: () => 20, validate, run },
    targetOf,
};
