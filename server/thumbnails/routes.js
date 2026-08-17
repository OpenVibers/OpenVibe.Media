/**
 * OpenVibe.Media — Thumbnail API routes (mounted at /api/v1/:app/thumbnails)
 *
 * POST /:kind/:id  (upload or generate) → { url }
 *   kind = 'vod' | 'clip'  → multipart 'thumbnail' (or JSON { image: base64 })
 *                            uploads a custom image; with no image, the
 *                            thumbnail is (re)generated from the media file.
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
            return res.json({ url });
        }

        // Generate from the media file (local or presigned remote).
        const vodStorage = require('../vod/vod-storage');
        const source = await vodStorage.resolveMediaSource(row);
        if (!source) return res.status(404).json({ error: 'Media file unavailable' });
        const url = kind === 'vod'
            ? await thumbService.generateVodThumbnail(numId, source.value)
            : await thumbService.generateClipThumbnail(numId, source.value);
        if (!url) return res.status(500).json({ error: 'Failed to generate thumbnail' });
        res.json({ url });
    } catch (err) {
        console.error('[Thumbnails] Error:', err.message);
        res.status(500).json({ error: 'Failed to process thumbnail' });
    }
});

module.exports = router;
