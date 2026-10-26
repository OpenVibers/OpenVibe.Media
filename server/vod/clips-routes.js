/**
 * OpenVibe.Media — Clips API routes (mounted at /api/v1/:app/clips)
 *
 * POST   /        { vod_id, start_s, end_s, title?, user_id? } → { id, status }
 *                 The cut runs in the background (works on the local file or a
 *                 presigned B2/R2 URL); clip.ready|clip.failed events are queued on
 *                 completion. Also accepts a live cut against a still-recording
 *                 VOD (clamped to flushed footage, like the predecessor).
 * GET    /:id     clip meta (status: processing | ready | failed)
 * GET    /        list (?limit&offset&vod_id&stream_id&user_id&auto_generated&status&since)
 * POST   /:id/trim { start_s, end_s } (seconds into the clip) → narrowed in place, cut again from the source
 * PUT    /:id     update title/visibility (and auto_generated, app key only)
 * DELETE /:id     delete file + offloaded objects + row
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const db = require('../db/database');
const tools = require('./media-tools');
const { tenantAuth, tenantCors } = require('../auth');
const cache = require('openvibe-shared/cache-policy');
const objects = require('../objects/model');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

// ── Direct clip upload (browser MediaRecorder blob → multipart `video`) ──
// Blobs can arrive with codec-qualified types, empty types, or
// application/octet-stream depending on the browser/platform.
const CLIP_MIME_TO_EXT = { 'video/webm': '.webm', 'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/ogg': '.ogg' };
function baseMediaType(mime) { return (mime || '').split(';')[0].trim().toLowerCase(); }
const clipUploadStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        const dir = path.resolve(config.vod.clipsPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = CLIP_MIME_TO_EXT[baseMediaType(file.mimetype)] || '.webm';
        cb(null, `clip-${req.params.app}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
});
const clipUpload = multer({
    storage: clipUploadStorage,
    limits: { fileSize: config.vod.maxSizeMb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const base = baseMediaType(file.mimetype);
        if (CLIP_MIME_TO_EXT[base] || base === 'application/octet-stream' || base === '' || base.startsWith('video/')) cb(null, true);
        else cb(new Error('Only video files are allowed for clips'));
    },
});

// { readiness: true } (API responses) adds the object's readiness levels (server/objects/readiness.js);
// the clip.ready / clip.failed payloads leave them out, as vodPublic's do. `hls` selects the playlist
// fields: undefined = discover them for this row (a single-item read), false = omit them (an event payload
// must never carry a signed URL into the outbox), an object = the answer a list route already batched.
async function clipPublic(clip, { readiness = false, hls } = {}) {
    if (!clip) return null;
    const out = {
        unique_views: clip.unique_views || 0,

        id: clip.id,
        app_id: clip.app_id,
        vod_id: clip.vod_id,
        stream_id: clip.stream_id,
        channel_user_id: clip.channel_user_id || null,
        user_id: clip.user_id,
        title: clip.title,
        description: clip.description,
        status: clip.status || (clip.file_path ? 'ready' : 'processing'),
        cut_error: clip.cut_error || null,
        cut_attempts: Number(clip.cut_attempts) || 0,
        cut_next_at: clip.cut_next_at || null,
        will_retry: clip.status === 'failed' && !!clip.cut_next_at,
        start_time: clip.start_time,
        end_time: clip.end_time,
        duration: clip.duration_seconds || 0,
        duration_seconds: clip.duration_seconds || 0,
        // Basename only — the inherited SPA derives its playback URL from this.
        file_path: clip.file_path ? path.basename(clip.file_path) : null,
        // Absolute URLs — cross-origin consumers render these directly.
        playback_url: `${config.publicUrl}/c/${clip.id}`,
        thumbnail_url: require('./finalize')._absUrl(clip.thumbnail_url),
        visibility: clip.visibility || 'public',
        is_public: (clip.visibility || (clip.is_public ? 'public' : 'private')) === 'public',
        storage_provider: clip.storage_provider || 'local',
        auto_generated: !!clip.auto_generated,
        ai_overview: clip.ai_overview || null,
        ai_analyzed_at: clip.ai_analyzed_at || null,
        view_count: clip.view_count || 0,
        created_at: clip.created_at,
    };
    // The HLS master playlist of the clip's object, when it has one (objects/hls.js): the same field and access rules as
    // GET /o/:id/download?format=json — unsigned for an open object, a signed playlist (+ hls_expires_at) for a private
    // or sandbox one. Absent with MEDIA_HLS_ENABLED off, before the object is ready, and until its timeline (or, for a
    // virtual clip, its source's window) has a segment; object.cmaf is queued for a materialized clip that has none.
    // Never throws.
    if (hls === undefined) Object.assign(out, await require('../objects/hls').discovery(clip.object_id) || {});
    else if (hls) Object.assign(out, hls);
    if (readiness) out.readiness = await require('../objects/readiness').forRow(clip);
    return out;
}

/** Sanitize user-provided title: strip HTML tags, limit length */
function sanitizeClipTitle(title, fallback = 'Untitled Clip') {
    if (!title || typeof title !== 'string') return fallback;
    return title.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').trim().slice(0, 200) || fallback;
}

/** Private, including legacy rows that have no visibility and is_public = 0. */
function _isPrivate(row) {
    return (row.visibility || (row.is_public ? 'public' : 'private')) === 'private';
}

async function _getClipScoped(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(404).json({ error: 'Clip not found' }); return null; }
    const clip = await db.getClipById(id, req.appId);
    if (!clip) { res.status(404).json({ error: 'Clip not found' }); return null; }
    return clip;
}

/**
 * The clip a write names (update, delete, re-cut). The app key alone is trusted; a call acting for one
 * of its users (X-OV-User-Id) writes only that user's own clips: someone else's private one answers
 * exactly as a missing one would, anything else 403.
 */
async function _getClipForWrite(req, res) {
    const clip = await _getClipScoped(req, res);
    if (!clip || req.authType !== 'user') return clip;
    if (clip.user_id != null && String(clip.user_id) === String(req.userId)) return clip;
    if (_isPrivate(clip)) res.status(404).json({ error: 'Clip not found' });
    else res.status(403).json({ error: 'Not your clip' });
    return null;
}

const VALID_VIS = new Set(['public', 'unlisted', 'private']);
/** A boolean query/body field: 1, 0, or null when absent or unreadable. */
const flag = (v) => (['1', 'true'].includes(String(v)) ? 1 : ['0', 'false'].includes(String(v)) ? 0 : null);

// ── Create clip ──────────────────────────────────────────────
// JSON body: a window of a VOD. Over a source with a CMAF timeline (MEDIA_HLS_ENABLED) the clip is virtual: ready at
// once (201, clip.ready event), no ffmpeg, played as HLS over the source's segments (docs/media-fabric.md §4, F3.5).
// With `materialize: true`, or a source without a timeline, it is cut into its own file (202, background clip.cut event).
// Multipart `video`: direct upload of an already-cut blob (201, ready) —
// inherited browser-MediaRecorder clip path.
/**
 * How much of a recording in progress is in its file: the end of its last whole fragment (vod/fmp4-index.js, exact and
 * a few small reads) for the recorder's fragmented MP4, else ffprobe's duration.
 */
async function recordedSeconds(filePath) {
    if (/\.mp4$/i.test(filePath)) {
        try {
            const index = await require('./fmp4-index').refresh(filePath);
            const first = !index.broken && index.fragments[0];
            const last = first && index.fragments[index.fragments.length - 1];
            if (last) return last.start + last.duration - first.start;   // like ffprobe's duration: from the first frame
        } catch { /* probe it */ }
    }
    try { return (await tools.probeVodInfo(filePath)).duration || 0; } catch { return 0; }
}

router.post('/', tenantAuth({ verb: 'write', allowUser: true }), clipUpload.single('video'), async (req, res) => {
    try {
        const body = req.body || {};
        if (req.file) return await _createUploadedClip(req, res);
        const vodId = parseInt(body.vod_id, 10);
        if (!Number.isFinite(vodId)) return res.status(400).json({ error: 'vod_id is required' });
        const vod = await db.getVodById(vodId, req.appId);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        // An acting user cannot cut someone else's private VOD, and is not told it exists.
        if (req.authType === 'user' && _isPrivate(vod) && !(vod.user_id != null && String(vod.user_id) === String(req.userId))) {
            return res.status(404).json({ error: 'VOD not found' });
        }

        let startTime = Number.parseFloat(body.start_s ?? body.start_time);
        let endTime = Number.parseFloat(body.end_s ?? body.end_time);
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
            return res.status(400).json({ error: 'start_s and end_s are required' });
        }
        if (startTime < 0 || endTime < 0) return res.status(400).json({ error: 'Time values cannot be negative' });

        let duration = endTime - startTime;
        const maxClipDuration = await db.getSetting('max_clip_duration') || 60;
        if (duration < 1) return res.status(400).json({ error: 'Clip must be at least 1 second' });
        if (duration > maxClipDuration) return res.status(400).json({ error: `Clips are limited to ${maxClipDuration} seconds` });

        // Duplicate detection — reuse a just-made clip for the same window.
        const duplicate = await db.findDuplicateClip({
            appId: req.appId, vodId, streamId: vod.stream_id || null,
            startTime, endTime,
        });
        if (duplicate && duplicate.status !== 'failed') {
            return res.status(200).json({ id: duplicate.id, status: duplicate.status, deduplicated: true });
        }

        const clipJobs = require('./clip-jobs');
        const win = flag(body.materialize) !== 1 && await clipJobs.timelineWindow(vod, startTime, endTime);
        // Resolve a source ffmpeg can read: local file, or presigned B2/R2 URL (a virtual clip reads no file).
        const vodStorage = require('./vod-storage');
        const source = win ? null : await vodStorage.resolveMediaSource(vod);
        if (!win && !source) return res.status(404).json({ error: 'VOD media unavailable' });

        // Live recording: clamp to what's ACTUALLY on disk, not wall-clock — a
        // seek past end-of-file emits a header-only "broken clip". The window keeps its length: it moves back to end at
        // the recorded edge. Clip 505 (2026-10-26) asked for 30 s past a recording whose newest keyframe was 70 s old,
        // and squeezing the start up to the edge left a 1 s window whose cut failed three times.
        if (vod.is_recording && source && source.kind === 'file') {
            const recordedDur = await recordedSeconds(source.value);
            if (recordedDur > 0) {
                const safeEdge = Math.max(0, recordedDur - 0.5);
                if (endTime > safeEdge) {
                    endTime = safeEdge;
                    startTime = Math.max(0, Math.min(startTime, endTime - duration));
                }
                duration = endTime - startTime;
                if (duration < 1) {
                    return res.status(422).json({ error: 'Not enough recorded footage yet — try again in a moment.' });
                }
            }
        } else if (vod.duration_seconds && Number.isFinite(vod.duration_seconds)) {
            if (startTime > vod.duration_seconds + 5) return res.status(400).json({ error: 'Start time exceeds video duration' });
            if (endTime > vod.duration_seconds + 10) endTime = vod.duration_seconds;
            duration = endTime - startTime;
            if (duration < 1) return res.status(400).json({ error: 'Clip window is outside the video' });
        }

        const userId = body.user_id != null ? body.user_id : (req.userId ?? null);
        const visibility = VALID_VIS.has(body.visibility) ? body.visibility : 'public';
        // The app's own automation (an AI auto-clip) says so with auto_generated; a call acting for
        // one of its users is a person's clip whatever it claims. The flag and the description used
        // to be dropped here, so every auto-clip was stored as if a person had made it.
        const byApp = req.authType === 'app';
        const result = await db.createClip({
            app_id: req.appId,
            vod_id: vodId,
            stream_id: vod.stream_id || (body.stream_id != null ? parseInt(body.stream_id, 10) || null : null),
            user_id: userId,
            channel_user_id: body.channel_user_id != null ? body.channel_user_id : (vod.user_id ?? null),
            title: sanitizeClipTitle(body.title, vod.title ? `Clip: ${vod.title}`.slice(0, 200) : 'Untitled Clip'),
            description: typeof body.description === 'string' ? body.description.replace(/<[^>]*>/g, '').trim().slice(0, 1000) : '',
            auto_generated: byApp && flag(body.auto_generated) === 1,
            file_path: '',
            start_time: startTime,
            end_time: endTime,
            duration_seconds: duration,
            is_public: visibility === 'public' ? 1 : 0,
            visibility,
            status: 'processing',
        });   // the row and its object (uploading) in one transaction
        const clipId = result.lastInsertRowid;
        const appId = req.appId;
        if (win) {
            await clipJobs.makeVirtual(clipId, win);
            return res.status(201).json({ ...await clipPublic(await db.getClipById(clipId, appId), { readiness: true }) });
        }

        // The cut is a media job (clip.cut, WS-G task 3): media.job.* events, retries with backoff, and a
        // job id the caller's UI follows (GET /api/v2/:app/jobs/:id) and reattaches to after a reload.
        // clip.ready / clip.failed events come from the cut itself.
        const { job } = await clipJobs.enqueueCut(appId, clipId, {
            reason: 'cut', createdBy: req.authType === 'user' ? `app:${appId}:user:${req.userId}` : `app:${appId}`, ownerUserId: userId ?? null,
        });

        res.status(202).json({ id: clipId, status: 'processing', job_id: job.id });
    } catch (err) {
        console.error('[Clips] Create error:', err.message);
        if (req.file) tools.cleanupTempFile(req.file.path);
        res.status(500).json({ error: 'Failed to create clip' });
    }
});

/**
 * Direct clip upload: the blob is already cut client-side — remux it for
 * seeking (rebases cluster timestamps hours from zero on long streams),
 * probe the real duration, store as ready. There is no asynchronous outcome.
 */
async function _createUploadedClip(req, res) {
    const body = req.body || {};
    const clipPath = req.file.path;
    try {
        await tools.remuxForSeeking(clipPath);

        let duration = 0;
        try { duration = (await tools.probeVodInfo(clipPath)).duration || 0; } catch { /* */ }
        if (!duration || tools.getFileSizeSafe(clipPath) === 0) {
            tools.cleanupTempFile(clipPath);
            return res.status(422).json({ error: 'Clip upload was corrupt or empty. Please try again.' });
        }
        const maxClipDuration = await db.getSetting('max_clip_duration') || 60;
        if (duration > maxClipDuration + 5) {
            tools.cleanupTempFile(clipPath);
            return res.status(400).json({ error: `Clips are limited to ${maxClipDuration} seconds` });
        }

        const startTime = Number.parseFloat(body.start_s ?? body.start_time);
        const endTime = Number.parseFloat(body.end_s ?? body.end_time);
        const visibility = VALID_VIS.has(body.visibility) ? body.visibility : 'public';
        const vodId = body.vod_id != null ? parseInt(body.vod_id, 10) || null : null;
        const result = await db.createClip({
            app_id: req.appId,
            vod_id: vodId,
            stream_id: body.stream_id != null ? parseInt(body.stream_id, 10) || null : null,
            user_id: body.user_id != null ? body.user_id : (req.userId ?? null),
            channel_user_id: body.channel_user_id != null ? body.channel_user_id : null,
            title: sanitizeClipTitle(body.title, 'Untitled Clip'),
            file_path: clipPath,
            start_time: Number.isFinite(startTime) ? startTime : 0,
            end_time: Number.isFinite(endTime) ? endTime : duration,
            duration_seconds: duration,
            is_public: visibility === 'public' ? 1 : 0,
            visibility,
            status: 'ready',
        });   // the row and its object (ready, local copy present) in one transaction
        const clipId = result.lastInsertRowid;

        require('../thumbnails/thumbnail-service').generateClipThumbnail(clipId, clipPath)
            .catch(err => console.warn(`[Clips] Thumbnail failed for clip ${clipId}:`, err.message));

        console.log(`[Clips] Direct upload: clip ${clipId} (${req.appId}, ${duration.toFixed ? duration.toFixed(1) : duration}s)`);
        res.status(201).json({ ...await clipPublic(await db.getClipById(clipId, req.appId), { readiness: true }) });
    } catch (err) {
        console.error('[Clips] Upload error:', err.message);
        tools.cleanupTempFile(clipPath);
        res.status(500).json({ error: 'Failed to save uploaded clip' });
    }
}

// ── List ─────────────────────────────────────────────────────
// Filters follow the inherited query shapes: vod_id, stream_id, user_id
// (creator), channel_user_id / source_streamer_id (owner of the clipped
// channel), hide_self, include_private, order, limit/offset. Also:
//   auto_generated=1|0   clips the app's automation cut (1) or a person made (0)
//   status=ready         playable clips only (no processing / failed rows)
//   since=<datetime>     created at or after (ISO 8601 or 'YYYY-MM-DD HH:MM:SS', UTC)
router.get('/', tenantAuth({ verb: 'list', allowUser: true }), async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const channelUserId = req.query.channel_user_id ?? req.query.source_streamer_id;
        const filters = {
            limit, offset,
            vod_id: req.query.vod_id != null ? parseInt(req.query.vod_id, 10) : null,
            stream_id: req.query.stream_id != null ? parseInt(req.query.stream_id, 10) : null,
            user_id: req.query.user_id != null ? req.query.user_id : null,
            channel_user_id: channelUserId != null ? channelUserId : null,
            hide_self: ['1', 'true'].includes(String(req.query.hide_self || '')),
            // Only the owning app may list private/unlisted rows (see vods list).
            include_private: req.authType === 'app' && ['1', 'true'].includes(String(req.query.include_private || '')),
            order: req.query.order || req.query.sort,   // `sort` = inherited alias
            auto_generated: flag(req.query.auto_generated),
            ready_only: String(req.query.status || '') === 'ready',
            since: req.query.since || null,
        };
        const clips = await db.listClips(req.appId, filters);
        const total = await db.countClips(req.appId, filters);
        const hls = await require('../objects/hls').discoveryMany(clips);
        res.json({ clips: await Promise.all(clips.map(async c => await clipPublic(c, { readiness: true, hls: hls.get(String(c.object_id)) || null }))), total, limit, offset, hasMore: offset + clips.length < total });
    } catch (err) {
        console.error('[Clips] List error:', err.message);
        res.status(500).json({ error: 'Failed to list clips' });
    }
});

// ── Get clip ─────────────────────────────────────────────────
// A short-lived URL of a clip's bytes for a reader with no key (OpenVibe.AI transcribing it); the owning app only.
router.get('/:id/signed-url', tenantAuth({ verb: 'read' }), async (req, res) => {
    if (req.authType !== 'app') return res.status(403).json({ error: 'only the owning app signs a playback URL' });
    const clip = await _getClipScoped(req, res);
    if (!clip) return;
    res.set('Cache-Control', cache.htmlHeaders({ private: true }));
    res.json(require('../objects/signing').signedMediaUrl('clip', clip.id, req.query.ttl));
});

router.get('/:id', tenantAuth({ verb: 'read', allowUser: true }), async (req, res) => {
    try {
        const clip = await _getClipScoped(req, res);
        if (!clip) return;
        // Acting for one of the app's users: another user's private clip looks missing (see GET /vods/:id).
        if (req.authType === 'user' && _isPrivate(clip) && !(clip.user_id != null && String(clip.user_id) === String(req.userId))) {
            return res.status(404).json({ error: 'Clip not found' });
        }
        // Bare object, mirroring GET /vods/:id per CONTRACTS.md.
        // Detail responses carry the transcript too (lists stay light).
        res.json({ ...await clipPublic(clip, { readiness: true }), ai_transcript: clip.ai_transcript || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get clip' });
    }
});

// ── Update (title / visibility) ──────────────────────────────
/**
 * Re-cut a clip whose cut failed. The row already carries everything needed
 * (vod_id, start_time, end_time), so a failure is recoverable rather than
 * permanent — previously a failed clip stayed broken forever with no retry path,
 * and the viewer was shown "the server is cutting your clip" indefinitely.
 * A clip without a file, over a source with a timeline, becomes virtual instead (200, ready); `materialize: true` (body or query)
 * always cuts its own file (clip.cut), and a virtual clip keeps playing while it is cut.
 */
router.post('/:id/recut', tenantAuth({ verb: 'write' }), async (req, res) => {
    try {
        const clip = await _getClipForWrite(req, res);
        if (!clip) return;
        const clipId = clip.id;
        if (clip.status === 'processing') return res.status(409).json({ error: 'Clip is already being cut' });
        if (!clip.vod_id) return res.status(422).json({ error: 'Clip has no source VOD to re-cut from' });
        const clipJobs = require('./clip-jobs');
        const materialize = flag((req.body || {}).materialize ?? req.query.materialize) === 1;
        // A clip that has a file of its own keeps it: only a file-less one (failed, or already virtual) turns virtual.
        if (!materialize && !clip.file_path) {
            const vod = await db.getVodById(clip.vod_id, req.appId);
            const win = await clipJobs.timelineWindow(vod, Number(clip.start_time) || 0, Number(clip.end_time) || 0);
            if (win) {
                await clipJobs.makeVirtual(clipId, win);
                return res.json({ ...await clipPublic(await db.getClipById(clipId, req.appId), { readiness: true }) });
            }
        }
        // A manual retry resets the attempt counter so it gets the full ladder again (not projected: no object change).
        await db.run("UPDATE clips SET cut_attempts = 0 WHERE id = ?", [clipId]);
        const { job } = await clipJobs.enqueueCut(req.appId, clipId, { reason: materialize ? 'materialize' : 're-cut', createdBy: `app:${req.appId}` });
        res.status(202).json({ id: clipId, status: clipJobs.isVirtual(clip) ? 'ready' : 'processing', job_id: job.id });
    } catch (err) {
        console.error('[Clips] Re-cut error:', err.message);
        res.status(500).json({ error: 'Failed to re-cut clip' });
    }
});

// ── Trim ─────────────────────────────────────────────────────
/**
 * Narrow a ready clip in place: { start_s, end_s } are seconds into the clip (at least 1 s apart, inside it). The clip
 * keeps its id, title and links; its window of the source VOD shrinks to that part and it is cut again from the source
 * (202 { id, status: 'processing', job_id }, clip.cut; the superseded file is removed once the new one is in), or, a
 * virtual clip, it plays the narrower window of the source's timeline at once (200, the clip). Asking for the whole
 * clip changes nothing (200, the clip, unchanged: true). A clip with no source VOD (a browser upload, already cut),
 * whose file has moved to cloud storage, or whose source recording cannot be read is not trimmed (422). A clip under a
 * retention hold (its own or its source VOD's, as DELETE decides) is not trimmed (409 media.object.held), nor one that
 * is being cut (409: a cut job that already read the old window would finish it with the old end). A file clip is
 * `processing` from the answer until its cut is in (clip.ready); a cut that fails for good gives the clip its previous
 * window and file back (clip.ready again). An app-key call acting for a user trims only that user's own clips, as for
 * every write.
 */
router.post('/:id/trim', tenantAuth({ verb: 'write' }), async (req, res) => {
    try {
        const clip = await _getClipForWrite(req, res);
        if (!clip) return;
        if (clip.status !== 'ready') return res.status(409).json({ error: clip.status === 'processing' ? 'Clip is still being cut' : 'Clip has no footage to trim' });
        const len = Number(clip.duration_seconds) || 0;
        const from = Number.parseFloat((req.body || {}).start_s);
        let to = Number.parseFloat((req.body || {}).end_s);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'start_s and end_s are required' });
        if (from < 0 || to > len + 0.5) return res.status(400).json({ error: `start_s and end_s must lie inside the clip (0 to ${len.toFixed(1)} s)` });
        to = Math.min(to, len);
        if (to - from < 1) return res.status(400).json({ error: 'Clip must be at least 1 second' });
        if (from < 0.05 && to > len - 0.05) return res.json({ ...await clipPublic(clip, { readiness: true }), unchanged: true });
        if (await objects.isHeldRow(clip)) return res.status(409).json({ error: 'Clip is under a retention hold', code: 'media.object.held' });
        const clipJobs = require('./clip-jobs');
        if (await clipJobs.activeCut(req.appId, clip.id)) return res.status(409).json({ error: 'Clip is still being cut' });
        const vod = clip.vod_id ? await db.getVodById(clip.vod_id, req.appId) : null;
        if (!vod) return res.status(422).json({ error: 'Clip has no source VOD to trim from' });
        const virtual = clipJobs.isVirtual(clip);
        const vodStorage = require('./vod-storage');
        if (!virtual && vodStorage.isRemote(clip)) return res.status(422).json({ error: 'Clip has moved to cloud storage and can no longer be trimmed' });

        const start = (Number(clip.start_time) || 0) + from, end = (Number(clip.start_time) || 0) + to;
        // A plain virtual clip plays the narrower window at once; a materialized one has rows of its own, which the cut rebuilds.
        const obj = virtual ? await objects.getObject(clip.object_id) : null;
        const materialized = !!(obj && /"materialized":\s*true/.test(String(obj.metadata || '')));
        const win = virtual && !materialized && await clipJobs.timelineWindow(vod, start, end);
        // Anything else is cut again: refuse now, before the window changes, when there is nothing to cut it from (no
        // readable source file, and no source timeline for a materialized cut either).
        if (!win && !await vodStorage.resolveMediaSource(vod)
            && !(config.hls.enabled && config.hls.materialized && await clipJobs.timelineWindow(vod, start, end))) {
            return res.status(422).json({ error: 'The source recording is unavailable, so the clip cannot be cut again' });
        }

        // A file clip is processing until the new cut is in (a second trim waits, and so does whoever waits for clip.ready);
        // a virtual one keeps playing. The status condition makes a concurrent trim of the same clip find nothing to update.
        const file = !virtual;
        const prev = { start_time: clip.start_time, end_time: clip.end_time, duration_seconds: clip.duration_seconds };
        const setWindow = async (w, { forward }) => await objects.withObject('clip', clip.id, async () => await db.run(
            `UPDATE clips SET start_time = ?, end_time = ?, duration_seconds = ?, cut_attempts = 0${file ? `, status = '${forward ? 'processing' : 'ready'}'` : ''}
             WHERE id = ?${file && forward ? " AND status = 'ready'" : ''}`, [...w, clip.id]));
        const set = await setWindow([start, end, end - start], { forward: true });
        if (file && !(set && set.changes)) return res.status(409).json({ error: 'Clip is still being cut' });
        if (win) {
            await clipJobs.makeVirtual(clip.id, win);
            return res.json({ ...await clipPublic(await db.getClipById(clip.id, req.appId), { readiness: true }) });
        }
        let job;
        try { ({ job } = await clipJobs.enqueueCut(req.appId, clip.id, { reason: 'trim', createdBy: `app:${req.appId}`, prev })); }
        catch (err) { await setWindow([prev.start_time, prev.end_time, prev.duration_seconds], { forward: false }); throw err; }
        console.log(`[Clips] Clip ${clip.id} trimmed to ${start.toFixed(1)}-${end.toFixed(1)}s of vod ${clip.vod_id}`);
        res.status(202).json({ id: clip.id, status: 'processing', job_id: job.id });
    } catch (err) {
        // A queue refusal (too many cuts queued: 429 with Retry-After) is answered as the queue says; the window is back.
        if (err && err.code === 'media.job.too_many') {
            if (err.retryAfterS) res.set('Retry-After', String(err.retryAfterS));
            return res.status(429).json({ error: err.message, code: err.code });
        }
        console.error('[Clips] Trim error:', err.message);
        res.status(500).json({ error: 'Failed to trim clip' });
    }
});

router.put('/:id', tenantAuth({ verb: 'write' }), async (req, res) => {
    try {
        const clip = await _getClipForWrite(req, res);
        if (!clip) return;
        const { title, description, visibility, auto_generated: autoGen } = req.body || {};
        if (title !== undefined) {
            const t = sanitizeClipTitle(title, '');
            if (!t) return res.status(400).json({ error: 'Title must be 1-200 characters' });
            await objects.withObject('clip', clip.id, async () => await db.run('UPDATE clips SET title = ? WHERE id = ?', [t, clip.id]));
        }
        // The same cleaning as a create: no markup, at most 1000 characters; null or '' clears it.
        if (description !== undefined) {
            if (description !== null && typeof description !== 'string') return res.status(400).json({ error: 'description must be a string' });
            const d = (description || '').replace(/<[^>]*>/g, '').trim().slice(0, 1000);
            await objects.withObject('clip', clip.id, async () => await db.run('UPDATE clips SET description = ? WHERE id = ?', [d, clip.id]));
        }
        // Only the app itself (its automation's own records) may say a clip was machine-made.
        if (autoGen !== undefined && flag(autoGen) !== null) {
            if (req.authType !== 'app') return res.status(403).json({ error: 'auto_generated is set by the app only' });
            await objects.withObject('clip', clip.id, async () => await db.run('UPDATE clips SET auto_generated = ? WHERE id = ?', [flag(autoGen), clip.id]));
        }
        if (visibility !== undefined) {
            await db.setClipVisibility(clip.id, visibility);
            // Made public (or already public): its watch page and the sitemap are indexable now.
            await require('../indexnow-notify').pingWatch('clip', await db.getClipById(clip.id));
        }
        res.json({ clip: await clipPublic(await db.getClipById(clip.id, req.appId), { readiness: true }) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update clip' });
    }
});

// ── Delete ───────────────────────────────────────────────────
router.delete('/:id', tenantAuth({ verb: 'delete' }), async (req, res) => {
    try {
        const clip = await _getClipForWrite(req, res);
        if (!clip) return;
        if (await objects.isHeldRow(clip)) return res.status(409).json({ error: 'Clip is under a retention hold', code: 'media.object.held' });

        // Delete the local file + any offloaded B2/R2 object (clips carry
        // storage_provider/storage_key like VODs).
        if (clip.file_path && fs.existsSync(clip.file_path)) {
            try { fs.unlinkSync(clip.file_path); } catch { /* ignore */ }
        }
        if (clip.storage_provider && clip.storage_provider !== 'local' && clip.storage_key) {
            require('./vod-storage').deleteVodObjects(clip).catch(err =>
                console.warn(`[Clips] Remote object cleanup failed for clip ${clip.id}:`, err.message));
        }
        // The clip's own bytes are its media_timeline rows (F3.5/F3.6): remove them and the bytes only it names. A
        // location another object's rows still name — a materialized clip's interior, the source's segments — is kept
        // (timeline.removeObject, F3.4), so deleting a clip never deletes its source's bytes. Every clip object is
        // asked, not only a `timeline` one: a materialized clip that got a file of its own keeps its provider 'local'
        // while its rows are still there (removeObject returns early when it has none, so a normal file clip is a no-op).
        if (clip.object_id) {
            const tl = await require('../objects/timeline').removeObject(clip.object_id)
                .catch(err => { console.warn(`[Clips] Timeline cleanup failed for clip ${clip.id}:`, err.message); return null; });
            // A durable delete that failed keeps its rows (removeObject) so it is not lost; the clips row (and its
            // object) go below, and the hourly object sweep retries the rows for a projected object whose row is gone.
            if (tl && tl.pending) console.warn(`[Clips] Clip ${clip.id}: ${tl.pending} timeline segment row(s) kept — their durable copy could not be deleted; the object sweep retries`);
        }

        await db.run('DELETE FROM clips WHERE id = ?', [clip.id]);   // its object is marked deleted by the row-delete trigger, same statement
        res.json({ message: 'Clip deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete clip' });
    }
});

module.exports = router;
module.exports.clipPublic = clipPublic;
