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

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');
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

// ── Missing-picture backfill (due based, small batches) ──────
// Most pictures are made at finalize (server/vod/finalize.js). One whose generation failed there, whose
// files were lost, or whose row was made before thumbnails existed had no picture forever: the page then
// showed Media's 1×1 fallback (the owner's empty grey boxes, 2026-11-10). This sweep asks the existing
// thumbnail.regenerate job for a few of them at a time, never retrying one too soon, and logs its count.
const TYPE = 'thumbnail.regenerate';
const MIN_AGE_MS = 10 * 60 * 1000;             // a just-finalized recording may still be working on its picture
const RETRY_FAILED_MS = 6 * 3600 * 1000;        // ffmpeg produced no frame; try again in six hours
const RETRY_UNAVAILABLE_MS = 24 * 3600 * 1000;  // the file is gone/empty/too small; once a day is enough
const RETRY_SUCCEEDED_MS = 60 * 60 * 1000;      // the row had a picture but its file is missing again
const CANDIDATE_WINDOW = 400;                   // rows looked at per sweep per tenant
const cursorKey = (appId) => `thumbnail_backfill.cursor.${appId}`;

function dbTimeMs(value) {
    if (!value) return NaN;
    const t = String(value);
    const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) ? ms : NaN;
}

/** The stored thumbnail's file is on disk: a URL whose file is gone is not a picture (it answers 1×1). */
function hasPicture(row) {
    const url = String((row && row.thumbnail_url) || '');
    if (!url) return false;
    let name;
    try { name = path.basename(new URL(url, 'http://media.invalid').pathname); } catch { name = path.basename(url); }
    if (!name) return false;
    try { return fs.existsSync(path.join(require('../thumbnails/thumbnail-service').THUMB_DIR, name)); } catch { return false; }
}

/** This VOD's latest thumbnail job (any status), for the due time. */
async function lastAttempt(appId, id) {
    return await db.get(`SELECT status, error_code, created_at FROM media_jobs
        WHERE app_id = ? AND job_type = ? AND params::jsonb ->> 'kind' = 'vod' AND params::jsonb ->> 'id' = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`, [appId, TYPE, String(id)]);
}

/** The earliest moment the next attempt may run; Infinity while one is queued or running. */
function dueAt(last) {
    if (!last) return 0;
    if (last.status === 'queued' || last.status === 'running') return Infinity;
    const at = dbTimeMs(last.created_at);
    if (!Number.isFinite(at)) return 0;
    if (last.status === 'failed') {
        return at + (last.error_code === 'media_unavailable' || last.error_code === 'no_video' ? RETRY_UNAVAILABLE_MS : RETRY_FAILED_MS);
    }
    return at + RETRY_SUCCEEDED_MS;
}

/**
 * Queue one small batch of thumbnail.regenerate jobs for public, finished VODs whose stored picture is
 * missing or gone. A VOD is due when no job is active and enough time has passed since its last attempt.
 * → { missing, queued }
 */
async function sweepMissing({ now = Date.now(), limit = null, appId = null, minAgeMs = MIN_AGE_MS } = {}) {
    const batch = Math.max(1, Math.min(20, Number(limit) || config.jobs.thumbnailBackfillBatch || 3));
    const apps = appId ? [{ app_id: appId }]
        : await db.all(`SELECT DISTINCT app_id FROM vods WHERE is_public = 1 AND COALESCE(is_recording, 0) = 0 AND COALESCE(clips_only, 0) = 0`);
    let missing = 0, queued = 0;
    for (const { app_id: app } of apps) {
        // Walk the whole library a window at a time (newest first, then older), not just the newest rows:
        // an old recording with a lost picture is a stored VOD too. The cursor wraps when the walk ends.
        const cursor = Number(await db.getSetting(cursorKey(app))) || 0;
        const rows = await db.all(`SELECT id, created_at, thumbnail_url FROM vods
            WHERE app_id = ? AND is_public = 1
              AND COALESCE(is_recording, 0) = 0 AND COALESCE(clips_only, 0) = 0
              AND (file_path IS NOT NULL OR object_id IS NOT NULL)
              AND COALESCE(health_status, '') NOT IN ('missing_file', 'zero_byte')
              AND id < ?
            ORDER BY id DESC LIMIT ?`, [app, cursor || '9223372036854775807', CANDIDATE_WINDOW]);
        let appMissing = 0, appQueued = 0, examined = 0, lastId = 0;
        for (const row of rows) {
            examined++;
            lastId = Number(row.id);
            if (hasPicture(row)) continue;
            const created = dbTimeMs(row.created_at);
            if (Number.isFinite(created) && now - created < minAgeMs) continue;   // finalize may still make it
            appMissing++;
            if (now < dueAt(await lastAttempt(app, row.id))) continue;
            try {
                const out = await require('./queue').enqueue({
                    appId: app, type: TYPE, params: { kind: 'vod', id: row.id },
                    dedupeActive: true, createdBy: 'system:thumbnail-backfill',
                });
                if (out && out.created && appQueued < batch) appQueued++;
                if (appQueued >= batch) break;
            } catch (err) {
                console.warn(`[Thumbnails] backfill could not queue vod ${row.id}: ${err.message}`);
            }
        }
        // A stopped batch resumes at the row after the one it stopped on; a finished walk wraps to the top.
        const done = examined === CANDIDATE_WINDOW || (examined === rows.length && rows.length < CANDIDATE_WINDOW);
        await db.setSetting(cursorKey(app), done ? 0 : lastId, 'number');
        if (appQueued) console.log(`[Thumbnails] backfill: queued ${appQueued} thumbnail job(s); ${appMissing} recording(s) on ${app} have no usable picture`);
        missing += appMissing;
        queued += appQueued;
    }
    return { missing, queued };
}

module.exports = {
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 2 * 60 * 1000, needsObject: false, backoffS: () => 20, validate, run },
    targetOf,
    failedBefore,
    GIVE_UP_AFTER,
    sweepMissing,
    hasPicture,
    dueAt,
};
