/**
 * OpenVibe.Media — Clips API routes (mounted at /api/v1/:app/clips)
 *
 * POST   /        { vod_id, start_s, end_s, title?, user_id? } → { id, status }
 *                 The cut runs in the background (works on the local file or a
 *                 presigned B2/R2 URL); webhook clip.ready|clip.failed fires on
 *                 completion. Also accepts a live cut against a still-recording
 *                 VOD (clamped to flushed footage, like the predecessor).
 * GET    /:id     clip meta (status: processing | ready | failed)
 * GET    /        list (?limit&offset&vod_id&stream_id&user_id&auto_generated&status&since)
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
const cutter = require('./clip-cutter');
const { tenantAuth, tenantCors } = require('../auth');
const { announce } = require('../webhooks');
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
// the clip.ready / clip.failed payloads leave them out, as vodPublic's do.
function clipPublic(clip, { readiness = false } = {}) {
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
    if (readiness) out.readiness = require('../objects/readiness').forRow(clip);
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

function _getClipScoped(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(404).json({ error: 'Clip not found' }); return null; }
    const clip = db.getClipById(id, req.appId);
    if (!clip) { res.status(404).json({ error: 'Clip not found' }); return null; }
    return clip;
}

const VALID_VIS = new Set(['public', 'unlisted', 'private']);
/** A boolean query/body field: 1, 0, or null when absent or unreadable. */
const flag = (v) => (['1', 'true'].includes(String(v)) ? 1 : ['0', 'false'].includes(String(v)) ? 0 : null);

// ── Create clip ──────────────────────────────────────────────
// JSON body: cut a window out of a VOD (202, background cut + webhook).
// Multipart `video`: direct upload of an already-cut blob (201, ready) —
// inherited browser-MediaRecorder clip path.
router.post('/', tenantAuth({ allowUser: true }), clipUpload.single('video'), async (req, res) => {
    try {
        const body = req.body || {};
        if (req.file) return _createUploadedClip(req, res);
        const vodId = parseInt(body.vod_id, 10);
        if (!Number.isFinite(vodId)) return res.status(400).json({ error: 'vod_id is required' });
        const vod = db.getVodById(vodId, req.appId);
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
        const maxClipDuration = db.getSetting('max_clip_duration') || 60;
        if (duration < 1) return res.status(400).json({ error: 'Clip must be at least 1 second' });
        if (duration > maxClipDuration) return res.status(400).json({ error: `Clips are limited to ${maxClipDuration} seconds` });

        // Duplicate detection — reuse a just-made clip for the same window.
        const duplicate = db.findDuplicateClip({
            appId: req.appId, vodId, streamId: vod.stream_id || null,
            startTime, endTime,
        });
        if (duplicate && duplicate.status !== 'failed') {
            return res.status(200).json({ id: duplicate.id, status: duplicate.status, deduplicated: true });
        }

        if (cutter.isBusy()) {
            return res.status(503).json({ error: 'Server is busy processing other clips. Please try again in a few seconds.' });
        }

        // Resolve a source ffmpeg can read: local file, or presigned B2/R2 URL.
        const vodStorage = require('./vod-storage');
        const source = await vodStorage.resolveMediaSource(vod);
        if (!source) return res.status(404).json({ error: 'VOD media unavailable' });

        // Live recording: clamp to what's ACTUALLY on disk, not wall-clock — a
        // seek past end-of-file emits a header-only "broken clip".
        if (vod.is_recording && source.kind === 'file') {
            let recordedDur = 0;
            try { const pi = await tools.probeVodInfo(source.value); recordedDur = pi.duration || 0; } catch { /* */ }
            if (recordedDur > 0) {
                const safeEdge = Math.max(0, recordedDur - 0.5);
                endTime = Math.min(endTime, safeEdge);
                startTime = Math.max(0, Math.min(startTime, endTime - 1));
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
        const result = db.createClip({
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

        // Cut in the background; webhook on completion.
        (async () => {
            const cut = await cutter.cutClipFile({ source: source.value, startTime, duration });
            if (cut.ok) {
                // Thumbnail first so the clip.ready payload carries it; then the ready transition,
                // the clip's object and its event commit together (webhooks.announce) and the webhook goes out.
                try {
                    await require('../thumbnails/thumbnail-service').generateClipThumbnail(clipId, cut.filePath);
                } catch { /* */ }
                announce(appId, 'clip.ready', {
                    change: () => objects.withObject('clip', clipId, () => db.run('UPDATE clips SET file_path = ?, duration_seconds = ?, end_time = ?, status = ? WHERE id = ?',
                        [cut.filePath, cut.duration, startTime + cut.duration, 'ready', clipId])),
                    payload: () => clipPublic(db.getClipById(clipId)),
                });
                console.log(`[Clips] Clip ${clipId} cut from vod ${vodId} (${startTime.toFixed(1)}-${(startTime + cut.duration).toFixed(1)}s)`);
            } else {
                // First attempt failed: record why and let the retry sweeper take it from here
                // (attempt 2 pulls a cloud-stored VOD back to local disk first).
                const nextAt = new Date(Date.now() + 2 * 60000).toISOString().replace('T', ' ').slice(0, 19);
                announce(appId, 'clip.failed', {
                    change: () => objects.withObject('clip', clipId, () => db.run("UPDATE clips SET status = 'failed', cut_error = ?, cut_attempts = 1, cut_next_at = ? WHERE id = ?", [String(cut.error || 'cut failed').slice(0, 500), nextAt, clipId])),
                    payload: () => clipPublic(db.getClipById(clipId)),
                });
                console.warn(`[Clips] Clip ${clipId} failed: ${cut.error} — auto-retry in 2 min`);
            }
        })().catch(err => console.error('[Clips] Background cut error:', err.message));

        res.status(202).json({ id: clipId, status: 'processing' });
    } catch (err) {
        console.error('[Clips] Create error:', err.message);
        if (req.file) tools.cleanupTempFile(req.file.path);
        res.status(500).json({ error: 'Failed to create clip' });
    }
});

/**
 * Direct clip upload: the blob is already cut client-side — remux it for
 * seeking (rebases cluster timestamps hours from zero on long streams),
 * probe the real duration, store as ready. No webhook (nothing async).
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
        const maxClipDuration = db.getSetting('max_clip_duration') || 60;
        if (duration > maxClipDuration + 5) {
            tools.cleanupTempFile(clipPath);
            return res.status(400).json({ error: `Clips are limited to ${maxClipDuration} seconds` });
        }

        const startTime = Number.parseFloat(body.start_s ?? body.start_time);
        const endTime = Number.parseFloat(body.end_s ?? body.end_time);
        const visibility = VALID_VIS.has(body.visibility) ? body.visibility : 'public';
        const vodId = body.vod_id != null ? parseInt(body.vod_id, 10) || null : null;
        const result = db.createClip({
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
        res.status(201).json({ ...clipPublic(db.getClipById(clipId, req.appId), { readiness: true }) });
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
router.get('/', tenantAuth({ allowUser: true }), (req, res) => {
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
        const clips = db.listClips(req.appId, filters);
        const total = db.countClips(req.appId, filters);
        res.json({ clips: clips.map(c => clipPublic(c, { readiness: true })), total, limit, offset, hasMore: offset + clips.length < total });
    } catch (err) {
        console.error('[Clips] List error:', err.message);
        res.status(500).json({ error: 'Failed to list clips' });
    }
});

// ── Get clip ─────────────────────────────────────────────────
router.get('/:id', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const clip = _getClipScoped(req, res);
        if (!clip) return;
        // Acting for one of the app's users: another user's private clip looks missing (see GET /vods/:id).
        if (req.authType === 'user' && _isPrivate(clip) && !(clip.user_id != null && String(clip.user_id) === String(req.userId))) {
            return res.status(404).json({ error: 'Clip not found' });
        }
        // Bare object, mirroring GET /vods/:id per CONTRACTS.md.
        // Detail responses carry the transcript too (lists stay light).
        res.json({ ...clipPublic(clip, { readiness: true }), ai_transcript: clip.ai_transcript || null });
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
 */
router.post('/:id/recut', tenantAuth(), async (req, res) => {
    try {
        const clipId = parseInt(req.params.id, 10);
        const clip = db.getClipById(clipId);
        if (!clip || clip.app_id !== req.appId) return res.status(404).json({ error: 'Clip not found' });
        if (clip.status === 'processing') return res.status(409).json({ error: 'Clip is already being cut' });
        if (!clip.vod_id) return res.status(422).json({ error: 'Clip has no source VOD to re-cut from' });
        // A manual retry resets the attempt counter so it gets the full ladder again (not projected: no object change).
        db.run("UPDATE clips SET cut_attempts = 0 WHERE id = ?", [clipId]);
        require('./clip-jobs').recutClip(clipId, { reason: 're-cut' }).catch(err => console.error('[Clips] Background re-cut error:', err.message));
        res.status(202).json({ id: clipId, status: 'processing' });
    } catch (err) {
        console.error('[Clips] Re-cut error:', err.message);
        res.status(500).json({ error: 'Failed to re-cut clip' });
    }
});

router.put('/:id', tenantAuth(), (req, res) => {
    try {
        const clip = _getClipScoped(req, res);
        if (!clip) return;
        const { title, visibility, auto_generated: autoGen } = req.body || {};
        if (title !== undefined) {
            const t = sanitizeClipTitle(title, '');
            if (!t) return res.status(400).json({ error: 'Title must be 1-200 characters' });
            objects.withObject('clip', clip.id, () => db.run('UPDATE clips SET title = ? WHERE id = ?', [t, clip.id]));
        }
        // Only the app itself (its automation's own records) may say a clip was machine-made.
        if (autoGen !== undefined && flag(autoGen) !== null) {
            if (req.authType !== 'app') return res.status(403).json({ error: 'auto_generated is set by the app only' });
            objects.withObject('clip', clip.id, () => db.run('UPDATE clips SET auto_generated = ? WHERE id = ?', [flag(autoGen), clip.id]));
        }
        if (visibility !== undefined) db.setClipVisibility(clip.id, visibility);
        res.json({ clip: clipPublic(db.getClipById(clip.id, req.appId), { readiness: true }) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update clip' });
    }
});

// ── Delete ───────────────────────────────────────────────────
router.delete('/:id', tenantAuth(), (req, res) => {
    try {
        const clip = _getClipScoped(req, res);
        if (!clip) return;
        if (objects.isHeldRow(clip)) return res.status(409).json({ error: 'Clip is under a retention hold', code: 'media.object.held' });

        // Delete the local file + any offloaded B2/R2 object (clips carry
        // storage_provider/storage_key like VODs).
        if (clip.file_path && fs.existsSync(clip.file_path)) {
            try { fs.unlinkSync(clip.file_path); } catch { /* ignore */ }
        }
        if (clip.storage_provider && clip.storage_provider !== 'local' && clip.storage_key) {
            require('./vod-storage').deleteVodObjects(clip).catch(err =>
                console.warn(`[Clips] Remote object cleanup failed for clip ${clip.id}:`, err.message));
        }

        db.run('DELETE FROM clips WHERE id = ?', [clip.id]);   // its object is marked deleted by the row-delete trigger, same statement
        res.json({ message: 'Clip deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete clip' });
    }
});

module.exports = router;
module.exports.clipPublic = clipPublic;
