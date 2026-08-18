/**
 * OpenVibe.Media — app asset API (emotes / channel sounds).
 * Mounted at /api/v1/:app/assets, app-key auth only: the owning app syncs its
 * chat assets here so Media is their canonical public home (served at /a/:id,
 * browsable on the media index with uploader + channel attribution).
 *
 *   POST   /            multipart `file` + { kind, name, username?, user_id?,
 *                       channel_username?, duration_seconds?, meta? } → upsert
 *   GET    /?kind=      list
 *   DELETE /:id
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const db = require('../db/database');
const { tenantAuth } = require('../auth');

const ASSET_DIR = config.assets.path;
if (!fs.existsSync(ASSET_DIR)) fs.mkdirSync(ASSET_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = express.Router({ mergeParams: true });

const assetUrl = (a) => `${config.publicUrl}/a/${a.id}`;
function assetPublic(a) {
    return {
        id: a.id, app_id: a.app_id, kind: a.kind, name: a.name,
        url: assetUrl(a), mime: a.mime,
        user_id: a.user_id, username: a.username, channel_username: a.channel_username,
        duration_seconds: a.duration_seconds || 0, created_at: a.created_at,
    };
}

router.post('/', tenantAuth(), upload.single('file'), (req, res) => {
    try {
        const { kind, name } = req.body || {};
        if (!['emote', 'sound'].includes(kind)) return res.status(400).json({ error: "kind must be 'emote' or 'sound'" });
        if (!name || !req.file) return res.status(400).json({ error: 'name and file are required' });
        const ext = (path.extname(req.file.originalname || '') || '').toLowerCase().slice(0, 8) || '.bin';
        const filename = `${kind}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        const filePath = path.join(ASSET_DIR, filename);
        fs.writeFileSync(filePath, req.file.buffer);
        let meta = {};
        try { meta = req.body.meta ? JSON.parse(req.body.meta) : {}; } catch { /* */ }
        const prev = db.get('SELECT file_path FROM assets WHERE app_id = ? AND kind = ? AND name = ? AND channel_username = ?',
            [req.appId, kind, String(name), String(req.body.channel_username || '')]);
        const row = db.upsertAsset({
            app_id: req.appId, kind, name: String(name).slice(0, 100),
            file_path: filePath, mime: req.file.mimetype || 'application/octet-stream',
            user_id: req.body.user_id != null ? parseInt(req.body.user_id, 10) || null : null,
            username: String(req.body.username || '').slice(0, 60),
            channel_username: String(req.body.channel_username || '').slice(0, 60),
            duration_seconds: parseFloat(req.body.duration_seconds) || 0,
            meta,
        });
        // Replaced an earlier upload for the same identity → drop the old file.
        if (prev && prev.file_path && prev.file_path !== filePath && fs.existsSync(prev.file_path)) {
            try { fs.unlinkSync(prev.file_path); } catch { /* */ }
        }
        res.status(201).json({ asset: assetPublic(row) });
    } catch (err) {
        console.error('[Assets] upload error:', err.message);
        res.status(500).json({ error: 'Failed to store asset' });
    }
});

router.get('/', tenantAuth(), (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const kind = ['emote', 'sound'].includes(req.query.kind) ? req.query.kind : null;
        const assets = db.listAssets(req.appId, { kind, limit, offset }).map(assetPublic);
        res.json({ assets, total: db.countAssets(req.appId, { kind }), limit, offset });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list assets' });
    }
});

router.delete('/:id', tenantAuth(), (req, res) => {
    try {
        const a = db.getAssetById(parseInt(req.params.id, 10));
        if (!a || a.app_id !== req.appId) return res.status(404).json({ error: 'Not found' });
        try { if (a.file_path && fs.existsSync(a.file_path)) fs.unlinkSync(a.file_path); } catch { /* */ }
        db.deleteAsset(a.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete asset' });
    }
});

module.exports = router;
module.exports.assetPublic = assetPublic;
