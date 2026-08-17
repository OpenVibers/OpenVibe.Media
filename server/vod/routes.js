/**
 * OpenVibe.Media — VOD API routes (mounted at /api/v1/:app/vods)
 *
 * POST   /                       create VOD               → { id }
 * POST   /:id/ingest/rtmp        { rtmp_url }             → 202 (ffmpeg pulls it)
 * POST   /:id/ingest/rtp/start   { video, audio }         → { videoPort, audioPort }
 * POST   /:id/ingest/rtp/stop    finalize RTP recording   → 200
 * POST   /:id/chunks             multipart chunk append (user JWT ok)
 * POST   /:id/complete           finalize chunked upload
 * POST   /:id/finalize           close recording, kick off thumbnail+probe
 * GET    /:id                    VOD meta
 * GET    /                       list (?limit&offset&user_id&stream_id)
 * PUT    /:id                    update title/description/visibility
 * DELETE /:id                    delete everywhere (local + B2 + R2)
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');
const config = require('../config');
const recorder = require('./recorder');
const tools = require('./media-tools');
const { finalizeVod, vodPublic } = require('./finalize');
const { tenantAuth, tenantCors } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

// ── Chunk upload storage (browser MediaRecorder chunks) ──────
const VOD_MIME_TO_EXT = { 'video/webm': '.webm', 'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/ogg': '.ogg' };

/** Strip codec params from MIME types like "video/webm;codecs=vp9,opus" → "video/webm" */
function baseMediaType(mime) {
    return (mime || '').split(';')[0].trim().toLowerCase();
}

const chunkStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const vodDir = path.resolve(config.vod.path);
        if (!fs.existsSync(vodDir)) fs.mkdirSync(vodDir, { recursive: true });
        cb(null, vodDir);
    },
    filename: (req, file, cb) => {
        const ext = VOD_MIME_TO_EXT[baseMediaType(file.mimetype)] || '.webm';
        cb(null, `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
});
const chunkUpload = multer({
    storage: chunkStorage,
    limits: { fileSize: config.vod.maxSizeMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const base = baseMediaType(file.mimetype);
        if (VOD_MIME_TO_EXT[base] || base === 'application/octet-stream' || base === '' || base.startsWith('video/')) cb(null, true);
        else cb(new Error('Only video chunks are allowed'));
    },
});

/**
 * Active chunked uploads: vodId → { filePath, startTime, chunkCount,
 * currentSegmentId, currentSegmentPath }. Rebuilt from the DB row if the
 * server restarted mid-upload.
 */
const activeChunkUploads = new Map();

function _getVodScoped(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(404).json({ error: 'VOD not found' }); return null; }
    const vod = db.getVodById(id, req.appId);
    if (!vod) { res.status(404).json({ error: 'VOD not found' }); return null; }
    return vod;
}

// ── Create VOD ───────────────────────────────────────────────
router.post('/', tenantAuth(), (req, res) => {
    try {
        const { title, stream_id, stream_key, user_id, meta, visibility, clips_only } = req.body || {};
        const result = db.createVod({
            app_id: req.appId,
            stream_id: stream_id != null ? parseInt(stream_id, 10) || null : null,
            stream_key: stream_key || null,
            user_id: user_id != null ? user_id : null,
            title: (title || 'Recording').toString().slice(0, 300),
            meta,
        });
        const id = result.lastInsertRowid;
        if (clips_only) db.run('UPDATE vods SET clips_only = 1 WHERE id = ?', [id]);
        if (visibility) db.setVodVisibility(id, visibility);
        res.status(201).json({ id });
    } catch (err) {
        console.error('[VOD] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create VOD' });
    }
});

// ── RTMP ingest ──────────────────────────────────────────────
router.post('/:id/ingest/rtmp', tenantAuth(), (req, res) => {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) return;
        const result = recorder.startRtmp(vod, req.body?.rtmp_url);
        if (!result.ok) return res.status(409).json({ error: result.error });
        res.status(202).json({ id: vod.id, status: 'recording' });
    } catch (err) {
        console.error('[VOD] RTMP ingest error:', err.message);
        res.status(500).json({ error: 'Failed to start RTMP ingest' });
    }
});

// ── RTP ingest ───────────────────────────────────────────────
router.post('/:id/ingest/rtp/start', tenantAuth(), (req, res) => {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) return;
        const { video, audio } = req.body || {};
        const result = recorder.startRtp(vod, video, audio);
        if (!result.ok) return res.status(409).json({ error: result.error });
        res.json({ videoPort: result.videoPort, audioPort: result.audioPort || null });
    } catch (err) {
        console.error('[VOD] RTP start error:', err.message);
        res.status(500).json({ error: 'Failed to start RTP ingest' });
    }
});

router.post('/:id/ingest/rtp/stop', tenantAuth(), (req, res) => {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) return;
        const stopped = recorder.stopRecording(vod.id);
        if (!stopped && !vod.is_recording) return res.status(409).json({ error: 'VOD is not recording' });
        // Finalization runs from the ffmpeg exit handler.
        res.json({ id: vod.id, status: 'finalizing' });
    } catch (err) {
        console.error('[VOD] RTP stop error:', err.message);
        res.status(500).json({ error: 'Failed to stop RTP ingest' });
    }
});

// ── Chunked upload (browser MediaRecorder; user JWT ok) ──────
router.post('/:id/chunks', tenantAuth({ allowUser: true }), chunkUpload.single('chunk'), async (req, res) => {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) { if (req.file) tools.cleanupTempFile(req.file.path); return; }
        if (!req.file) return res.status(400).json({ error: 'No chunk data' });
        const segmentId = Math.max(1, parseInt(req.body?.segmentId || req.query.segmentId || '1', 10) || 1);

        let rec = activeChunkUploads.get(vod.id);
        if (!rec && vod.file_path && fs.existsSync(vod.file_path)) {
            // Server restarted mid-upload — resume against the existing file.
            rec = {
                filePath: vod.file_path,
                startTime: new Date(String(vod.created_at).replace(' ', 'T') + 'Z').getTime(),
                chunkCount: 0,
                currentSegmentId: segmentId,
                currentSegmentPath: vod.file_path,
            };
            activeChunkUploads.set(vod.id, rec);
        }

        if (!rec) {
            // First chunk — establish the VOD file (contains the WebM header).
            const ext = VOD_MIME_TO_EXT[baseMediaType(req.file.mimetype)] || '.webm';
            const filename = `vod-${req.appId}-${vod.id}-${Date.now()}${ext}`;
            const filePath = path.resolve(config.vod.path, filename);
            fs.copyFileSync(req.file.path, filePath);
            tools.cleanupTempFile(req.file.path);

            db.run('UPDATE vods SET file_path = ?, file_size = ?, is_recording = 1 WHERE id = ?',
                [filePath, fs.statSync(filePath).size, vod.id]);

            rec = { filePath, startTime: Date.now(), chunkCount: 1, currentSegmentId: segmentId, currentSegmentPath: filePath };
            activeChunkUploads.set(vod.id, rec);

            console.log(`[VOD] Chunked recording started: vod ${vod.id} (${req.appId})`);
            return res.json({ vodId: vod.id, chunkIndex: 0, status: 'created' });
        }

        if (rec.currentSegmentId !== segmentId) {
            // New MediaRecorder segment (fresh WebM header) — buffer separately,
            // concat into the base file (ffmpeg concat demuxer) between segments.
            if (rec.currentSegmentPath && rec.currentSegmentPath !== rec.filePath) {
                await tools.concatWebmFiles(rec.filePath, rec.currentSegmentPath);
            }
            rec.currentSegmentId = segmentId;
            rec.currentSegmentPath = tools.makeSegmentPath(rec.filePath, segmentId);
            fs.copyFileSync(req.file.path, rec.currentSegmentPath);
            tools.cleanupTempFile(req.file.path);
            rec.chunkCount++;
        } else {
            // Append chunk to the current file/segment
            const targetPath = rec.currentSegmentPath || rec.filePath;
            const chunkData = fs.readFileSync(req.file.path);
            fs.appendFileSync(targetPath, chunkData);
            tools.cleanupTempFile(req.file.path);
            rec.chunkCount++;
        }

        // Update file size and duration estimate in DB
        const size = tools.getFileSizeSafe(rec.filePath)
            + (rec.currentSegmentPath && rec.currentSegmentPath !== rec.filePath ? tools.getFileSizeSafe(rec.currentSegmentPath) : 0);
        const elapsed = Math.round((Date.now() - rec.startTime) / 1000);
        db.run('UPDATE vods SET file_size = ?, duration_seconds = ? WHERE id = ?', [size, elapsed, vod.id]);

        // Seekable sidecar for live DVR (every 2 chunks ≈ ~60s)
        if (rec.chunkCount >= 2 && rec.chunkCount % 2 === 0) {
            tools.remuxForLiveSeeking(rec.filePath).catch(() => {});
        }

        res.json({ vodId: vod.id, chunkIndex: rec.chunkCount, status: 'appended' });
    } catch (err) {
        console.error('[VOD] Chunk upload error:', err.message);
        if (req.file) tools.cleanupTempFile(req.file.path);
        res.status(500).json({ error: 'Failed to save chunk' });
    }
});

async function _finalizeHandler(req, res) {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) return;

        // Live ffmpeg recording → stop gracefully; its exit handler finalizes.
        if (recorder.isRecording(vod.id)) {
            recorder.stopRecording(vod.id);
            return res.status(202).json({ id: vod.id, status: 'finalizing' });
        }

        const chunkRec = activeChunkUploads.get(vod.id);
        activeChunkUploads.delete(vod.id);
        const result = await finalizeVod(vod.id, {
            startTimeMs: chunkRec?.startTime,
            segmentPath: chunkRec && chunkRec.currentSegmentPath !== chunkRec.filePath ? chunkRec.currentSegmentPath : null,
        });
        if (!result) return res.status(409).json({ error: 'Nothing to finalize (finalization already in progress or VOD discarded)' });
        res.json({ vod: vodPublic(result) });
    } catch (err) {
        console.error('[VOD] Finalize error:', err.message);
        res.status(500).json({ error: 'Failed to finalize VOD' });
    }
}

router.post('/:id/complete', tenantAuth({ allowUser: true }), _finalizeHandler);
router.post('/:id/finalize', tenantAuth(), _finalizeHandler);

// ── List ─────────────────────────────────────────────────────
router.get('/', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const user_id = req.query.user_id != null ? req.query.user_id : null;
        const stream_id = req.query.stream_id != null ? parseInt(req.query.stream_id, 10) : null;
        const vods = db.listVods(req.appId, { limit, offset, user_id, stream_id });
        const total = db.countVods(req.appId, { user_id, stream_id });
        res.json({ vods: vods.map(vodPublic), total, limit, offset });
    } catch (err) {
        console.error('[VOD] List error:', err.message);
        res.status(500).json({ error: 'Failed to list VODs' });
    }
});

// ── Get VOD meta ─────────────────────────────────────────────
router.get('/:id', tenantAuth({ allowUser: true }), async (req, res) => {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) return;

        // Self-heal a missing duration on a finished local VOD.
        if (!vod.is_recording && (!vod.duration_seconds || vod.duration_seconds <= 0) && vod.file_path && fs.existsSync(vod.file_path)) {
            const duration = await tools.probeVodDuration(vod.file_path);
            if (duration > 0) {
                const fileSize = tools.getFileSizeSafe(vod.file_path);
                db.run('UPDATE vods SET duration_seconds = ?, file_size = ? WHERE id = ?', [duration, fileSize, vod.id]);
                vod.duration_seconds = duration;
                vod.file_size = fileSize;
            }
        }

        res.json({ vod: vodPublic(vod) });
    } catch (err) {
        console.error('[VOD] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get VOD' });
    }
});

// ── Update ───────────────────────────────────────────────────
router.put('/:id', tenantAuth(), (req, res) => {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) return;
        const { title, description, visibility } = req.body || {};
        const updates = [];
        const params = [];
        if (title !== undefined) { updates.push('title = ?'); params.push(String(title).slice(0, 300)); }
        if (description !== undefined) { updates.push('description = ?'); params.push(String(description)); }
        if (updates.length) {
            params.push(vod.id);
            db.run(`UPDATE vods SET ${updates.join(', ')} WHERE id = ?`, params);
        }
        if (visibility !== undefined) db.setVodVisibility(vod.id, visibility);
        res.json({ vod: vodPublic(db.getVodById(vod.id, req.appId)) });
    } catch (err) {
        console.error('[VOD] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update VOD' });
    }
});

// ── Delete ───────────────────────────────────────────────────
router.delete('/:id', tenantAuth(), (req, res) => {
    try {
        const vod = _getVodScoped(req, res);
        if (!vod) return;

        if (recorder.isRecording(vod.id)) recorder.stopRecording(vod.id);
        activeChunkUploads.delete(vod.id);

        // Delete media everywhere (local + B2 + R2)
        if (vod.file_path) {
            require('./vod-storage').deleteVodObjects(vod).catch((err) => {
                console.warn(`[VOD] Object cleanup failed for VOD ${vod.id}:`, err.message);
            });
            tools.cleanupSeekableFile(vod.file_path);
            try { if (vod.master_file_path && fs.existsSync(vod.master_file_path)) fs.unlinkSync(vod.master_file_path); } catch { /* */ }
        }

        db.run('DELETE FROM vods WHERE id = ?', [vod.id]);
        res.json({ message: 'VOD deleted' });
    } catch (err) {
        console.error('[VOD] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete VOD' });
    }
});

router.activeChunkUploads = activeChunkUploads;
module.exports = router;
