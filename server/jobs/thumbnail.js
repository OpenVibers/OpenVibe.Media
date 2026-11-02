/**
 * OpenVibe.Media — job type thumbnail.regenerate (light lane)
 *
 * The thumbnail (re)generation POST /api/v1/:app/thumbnails/:kind/:id did inline now runs as a job:
 * the route enqueues it (joining an identical job that is still queued or running) and waits for it,
 * so its answer is unchanged. The v2 jobs API can queue it too, for a vod or clip object.
 *
 *   params { kind: 'vod' | 'clip', id: <row id> }   (derived from the object's legacy ref when omitted)
 *   result { url, kind, id }
 * A virtual clip (clip-jobs makeVirtual: a window over its VOD's timeline, no file of its own) takes its
 * picture from its VOD, half a second after the clip's start.
 * Failures: media_unavailable (no local file and no cloud copy, an empty file, or a recording the
 * health scan found zero-byte / missing; permanent, answered 404 by the v1 route), no_video (an
 * audio-only recording: no frame exists; permanent, 404), not_found (permanent), generate_failed
 * (ffmpeg produced no frame from real media; retried).
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

async function rowOf(appId, kind, id) {
    return kind === 'vod' ? await db.getVodById(id, appId) : await db.getClipById(id, appId);
}

/** Normalized params, or JobError (400). The row must exist in this tenant (and match the object when one is named). */
async function validate({ appId, obj, params }) {
    const t = targetOf(obj, params || {});
    const row = await rowOf(appId, t.kind, t.id);
    if (!row) throw new JobError('media.job.not_found', `${t.kind} ${t.id} not found`, { status: 404, permanent: true });
    if (obj && row.object_id && row.object_id !== obj.id) throw new JobError('media.job.invalid', `the object is not ${t.kind} ${t.id}`, { permanent: true });
    return t;
}

async function run(job) {
    const { kind, id } = targetOf(null, job.params);
    const row = await rowOf(job.app_id, kind, id);
    if (!row) throw new JobError('not_found', `${kind} ${id} not found`, { permanent: true });
    const thumbService = require('../thumbnails/thumbnail-service');
    // A recording the health scan found empty or gone has no frame to take (five such VODs failed as
    // generate_failed on 2026-09-23: ffmpeg was run on 0-byte files and Live got a 500).
    // A virtual clip has no file: its frame comes from its VOD (five such clips failed every page view as
    // generate_failed on 2026-10-17: ffmpeg was pointed at the clip row's own path, which never existed).
    // A clip whose cut failed has no picture to take: its window could not be read (clips 495-498 of VOD 6010,
    // 2026-10-27: their window lies in the recording's damaged end, and every page view after a Live restart ran this
    // job again and got a 500).
    if (kind === 'clip' && row.status === 'failed' && !row.file_path) {
        throw new JobError('media_unavailable', 'The clip was never cut, so it has no picture', { permanent: true, status: 404 });
    }
    const virtual = kind === 'clip' && !row.file_path && row.vod_id != null;
    const recording = virtual ? await db.getVodById(row.vod_id, job.app_id) : (kind === 'vod' ? row : null);
    if (virtual && !recording) throw new JobError('media_unavailable', `The clip's recording (vod ${row.vod_id}) is gone`, { permanent: true, status: 404 });
    if (recording && ['zero_byte', 'missing_file'].includes(recording.health_status)) {
        throw new JobError('media_unavailable', `The recording is ${recording.health_status === 'zero_byte' ? 'empty (0 bytes)' : 'missing'}`, { permanent: true, status: 404 });
    }
    // The size the row recorded, wherever the file lives now: VOD 1803 (526 bytes) is on R2, where the local size check
    // below never runs, and its job failed as retryable on every page that showed it (109 times on 2026-11-02).
    const recordedSize = Number((recording || row).file_size);
    if (Number.isFinite(recordedSize) && recordedSize > 0 && recordedSize < TOO_SMALL_FOR_A_FRAME) {
        throw new JobError('media_unavailable', `The media file is too small to hold a picture (${recordedSize} bytes)`, { permanent: true, status: 404 });
    }
    // A recording ffmpeg could draw no frame from three times this week will not give one on the fourth try (VOD 6030,
    // 907 KB on B2 with a clean health scan: 47 failed jobs in two days). It is answered as unavailable (404), which the
    // callers keep for a long while, instead of a 500 that every page asks about again.
    if (await failedBefore(job.app_id, kind, id) >= GIVE_UP_AFTER) {
        throw new JobError('media_unavailable', `No frame could be drawn from this ${kind} (${GIVE_UP_AFTER} tries this week)`, { permanent: true, status: 404 });
    }
    let source = null;
    if (kind === 'clip' && row.file_path && require('fs').existsSync(row.file_path)) source = { kind: 'file', value: row.file_path };
    else source = await require('../vod/vod-storage').resolveMediaSource(virtual ? recording : row);
    if (!source) throw new JobError('media_unavailable', 'Media file unavailable', { permanent: true, status: 404 });
    if (source.kind === 'file') {
        let size = 0;
        try { size = require('fs').statSync(source.value).size; } catch { size = 0; }
        if (!size) throw new JobError('media_unavailable', 'The media file is empty (0 bytes)', { permanent: true, status: 404 });
        // A few hundred bytes hold a container header and no frame (VOD 1803: 526 bytes for "51 seconds", health "ok"):
        // ffmpeg fails every time, and a retryable failure had every page that shows it ask again (2026-11-02).
        if (size < TOO_SMALL_FOR_A_FRAME) throw new JobError('media_unavailable', `The media file is too small to hold a picture (${size} bytes)`, { permanent: true, status: 404 });
    }
    // An audio-only source (a browser broadcast with no camera, Media#240) has no frame to take. Its picture is the
    // streamer's avatar card, made once here and stored like any thumbnail, and the row is marked audio_only. This used
    // to be a permanent `no_video` failure, which every page then asked about again (Live backed off to once a day).
    if (await thumbService.hasVideoStream(source.value) === false) {
        const url = kind === 'vod'
            ? await thumbService.generateVodThumbnail(id, source.value, { audioOnly: true })
            : await thumbService.generateClipThumbnail(id, source.value, { audioOnly: true, ...(virtual ? { seekSeconds: (Number(row.start_time) || 0) + 0.5 } : {}) });
        if (!url) throw new JobError('generate_failed', 'Failed to make the audio-only picture');
        return { url, kind, id, audio_only: true };
    }
    const url = kind === 'vod'
        ? await thumbService.generateVodThumbnail(id, source.value)
        : await thumbService.generateClipThumbnail(id, source.value, virtual ? { seekSeconds: (Number(row.start_time) || 0) + 0.5 } : {});
    // A recording the health scan flagged for review that gives no frame is damaged where the frame was taken (VOD 6013,
    // 2026-10-27: no duration, VP9 data ffmpeg cannot decode): that is not going to change by asking again.
    if (!url && recording && recording.health_status === 'needs_review') {
        throw new JobError('media_unavailable', 'The recording is damaged where a frame would be taken (its health scan flagged it for review)', { permanent: true, status: 404 });
    }
    if (!url) throw new JobError('generate_failed', 'Failed to generate thumbnail');
    return { url, kind, id };
}

// Under 1 KB is a container header at most, with no frame in it: no picture to take.
const TOO_SMALL_FOR_A_FRAME = 1024;
// Failed draws of one recording in the last week after which the job stops trying.
const GIVE_UP_AFTER = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** This recording's thumbnail jobs that failed to draw a frame (generate_failed) in the last week. */
async function failedBefore(appId, kind, id) {
    const since = new Date(Date.now() - WEEK_MS).toISOString().replace('T', ' ').slice(0, 19);
    const r = await db.get(`SELECT COUNT(*) AS n FROM media_jobs WHERE job_type = 'thumbnail.regenerate' AND status = 'failed'
        AND error_code = 'generate_failed' AND app_id = ? AND params = ? AND created_at > ?`, [appId, JSON.stringify({ kind, id }), since]);
    return Number((r && r.n) || 0);
}

module.exports = {
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 2 * 60 * 1000, needsObject: false, backoffS: () => 20, validate, run },
    targetOf,
    failedBefore,
    GIVE_UP_AFTER,
};
