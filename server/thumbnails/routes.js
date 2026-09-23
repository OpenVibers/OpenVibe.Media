/**
 * OpenVibe.Media — Thumbnail API routes (mounted at /api/v1/:app/thumbnails)
 *
 * POST /:kind/:id  (upload or generate) → { url }
 *   kind = 'vod' | 'clip'  → multipart 'thumbnail' (or JSON { image: base64 })
 *                            uploads a custom image; with no image, the
 *                            thumbnail is (re)generated from the media file by a
 *                            thumbnail.regenerate job (server/jobs): the route queues
 *                            it (joining one already queued or running for the same
 *                            item), runs it at once and answers { url } as before.
 *                            ?async=1 answers 202 { job } without waiting.
 *   kind = 'live'|'stream' → upload only; stored under a stable per-app/id
 *                            filename so the URL survives refreshes.
 *
 * Public serving is at GET /t/:id (see public routes).
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');
const thumbService = require('./thumbnail-service');
const { tenantAuth, tenantCors } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

// Multer for raw image upload (max 2 MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
});

function _imageFromRequest(req) {
    if (req.file) return req.file.buffer;
    if (req.body && req.body.image) return req.body.image;
    return null;
}

router.post('/:kind/:id', tenantAuth({ allowUser: true }), upload.single('thumbnail'), async (req, res) => {
    try {
        const kind = String(req.params.kind || '').toLowerCase();
        const id = String(req.params.id);
        const imageData = _imageFromRequest(req);

        // ── Live stream thumbnail (upload from the owning app's broadcaster) ──
        if (kind === 'live' || kind === 'stream') {
            if (!imageData) return res.status(400).json({ error: 'No image data provided' });
            const url = thumbService.saveLiveThumbnail(req.appId, id, imageData);
            if (!url) return res.status(400).json({ error: 'Invalid image data' });
            return res.json({ url });
        }

        if (kind !== 'vod' && kind !== 'clip') {
            return res.status(400).json({ error: "kind must be 'vod', 'clip', or 'live'" });
        }

        const numId = parseInt(id, 10);
        const row = kind === 'vod' ? db.getVodById(numId, req.appId) : db.getClipById(numId, req.appId);
        if (!row) return res.status(404).json({ error: `${kind} not found` });

        // Custom upload → save as the entity's thumbnail.
        if (imageData) {
            let buffer = Buffer.isBuffer(imageData)
                ? imageData
                : Buffer.from(String(imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64');
            if (buffer.length < 4) return res.status(400).json({ error: 'Invalid image data' });
            const filename = `${kind}-${numId}-${Date.now()}.jpg`;
            fs.writeFileSync(path.join(thumbService.THUMB_DIR, filename), buffer);
            const url = `/t/${filename}`;
            const table = kind === 'vod' ? 'vods' : 'clips';
            db.run(`UPDATE ${table} SET thumbnail_url = ? WHERE id = ?`, [url, numId]);
            require('../objects/model').safeSync(kind, numId);
            return res.json({ url });
        }

        // Generate from the media file (local or presigned remote) as a thumbnail.regenerate job.
        const queue = require('../jobs/queue');
        const worker = require('../jobs/worker');
        const r = queue.enqueue({
            appId: req.appId, type: 'thumbnail.regenerate', objectId: row.object_id || null, params: { kind, id: numId },
            dedupeActive: true, maxAttempts: 1, createdBy: `app:${req.appId}${req.authType === 'user' ? `:user:${req.userId}` : ''}`,
            ownerUserId: req.authType === 'user' ? req.userId : null,
        });
        if (['1', 'true'].includes(String(req.query.async || ''))) {
            worker.kick();
            return res.status(202).json({ job: queue.jobPublic(r.job) });
        }
        if (r.created || r.job.status === 'queued') worker.runNow(r.job.id).catch(() => {});   // claims it unless someone already has
        const done = await queue.waitFor(r.job.id, 90 * 1000);
        if (!done || done.status === 'queued' || done.status === 'running') return res.status(202).json({ job: queue.jobPublic(done || r.job) });
        if (done.status === 'succeeded') return res.json({ url: queue.parseJson(done.result, {}).url, job_id: done.id });
        if (done.error_code === 'media_unavailable') return res.status(404).json({ error: 'Media file unavailable', job_id: done.id });
        res.status(500).json({ error: 'Failed to generate thumbnail', job_id: done.id });
    } catch (err) {
        if (err && err.code === 'media.job.too_many') {
            res.set('Retry-After', String(err.retryAfterS || 60));
            return res.status(429).json({ error: err.message });
        }
        console.error('[Thumbnails] Error:', err.message);
        res.status(500).json({ error: 'Failed to process thumbnail' });
    }
});

module.exports = router;
