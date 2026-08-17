/**
 * OpenVibe.Media — Files API (mounted at /api/v1/:app/files)
 *
 * Generic per-app file storage (new subsystem — no predecessor equivalent):
 *
 * POST   /        multipart 'file' → { key, url, size, mime }
 * GET    /        list (?limit&offset)
 * GET    /:key    meta
 * DELETE /:key    delete
 *
 * Files live at FILES_PATH/<app>/<key> with key = <sha256-prefix>-<name>.
 * Public serving (Content-Type + Range) is at GET /f/:key.
 * Per-app quota: apps.quota_bytes (0 = unlimited) checked against the sum of
 * the app's stored file sizes.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');
const config = require('../config');
const { tenantAuth, tenantCors } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

const upload = multer({
    dest: path.join(config.files.path, '.tmp'),
    limits: { fileSize: config.files.maxSizeMb * 1024 * 1024 },
});

function sanitizeName(name) {
    const base = path.basename(String(name || 'file'));
    return base.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 120) || 'file';
}

function appDir(appId) {
    const dir = path.join(config.files.path, appId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function filePathForKey(row) {
    return path.join(config.files.path, row.app_id, row.key);
}

function filePublic(row) {
    return {
        key: row.key,
        app_id: row.app_id,
        user_id: row.user_id,
        original_name: row.original_name,
        size: row.size,
        mime: row.mime,
        sha256: row.sha256,
        url: `/f/${row.key}`,
        created_at: row.created_at,
    };
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', d => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// ── Upload ───────────────────────────────────────────────────
router.post('/', tenantAuth({ allowUser: true }), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded (multipart field: file)' });

        // Per-app quota check against quota_bytes (0 = unlimited).
        const quota = Number(req.appRow.quota_bytes) || 0;
        if (quota > 0) {
            const used = db.appFilesBytes(req.appId);
            if (used + req.file.size > quota) {
                try { fs.unlinkSync(req.file.path); } catch { /* */ }
                return res.status(413).json({
                    error: 'App file quota exceeded',
                    quota_bytes: quota,
                    used_bytes: used,
                });
            }
        }

        const digest = await sha256File(req.file.path);
        const name = sanitizeName(req.file.originalname);
        const key = `${digest.slice(0, 12)}-${name}`;

        const existing = db.getFileByKey(key);
        if (existing) {
            // Same content + name already stored (any app hash-collides only on
            // identical bytes+name for its own app; cross-app: key is global, so
            // treat a foreign owner as a conflict).
            try { fs.unlinkSync(req.file.path); } catch { /* */ }
            if (existing.app_id !== req.appId) {
                return res.status(409).json({ error: 'Key conflict — rename the file and retry' });
            }
            return res.status(200).json({ ...filePublic(existing), deduplicated: true });
        }

        const dest = path.join(appDir(req.appId), key);
        try {
            fs.renameSync(req.file.path, dest);
        } catch {
            fs.copyFileSync(req.file.path, dest);
            try { fs.unlinkSync(req.file.path); } catch { /* */ }
        }

        const userId = req.authType === 'user' ? req.userId : (req.body?.user_id ?? null);
        db.createFile({
            key,
            app_id: req.appId,
            user_id: userId,
            original_name: req.file.originalname || name,
            size: req.file.size,
            mime: req.file.mimetype || 'application/octet-stream',
            sha256: digest,
        });

        const row = db.getFileByKey(key, req.appId);
        console.log(`[Files] Stored ${key} for app ${req.appId} (${(req.file.size / 1024).toFixed(1)} KB)`);
        res.status(201).json(filePublic(row));
    } catch (err) {
        console.error('[Files] Upload error:', err.message);
        if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* */ } }
        res.status(500).json({ error: 'Failed to store file' });
    }
});

// ── List ─────────────────────────────────────────────────────
router.get('/', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const files = db.listFiles(req.appId, { limit, offset });
        res.json({
            files: files.map(filePublic),
            used_bytes: db.appFilesBytes(req.appId),
            quota_bytes: Number(req.appRow.quota_bytes) || 0,
            limit, offset,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// ── Meta ─────────────────────────────────────────────────────
router.get('/:key', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const row = db.getFileByKey(String(req.params.key), req.appId);
        if (!row) return res.status(404).json({ error: 'File not found' });
        res.json(filePublic(row));
    } catch (err) {
        res.status(500).json({ error: 'Failed to get file' });
    }
});

// ── Delete ───────────────────────────────────────────────────
router.delete('/:key', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const row = db.getFileByKey(String(req.params.key), req.appId);
        if (!row) return res.status(404).json({ error: 'File not found' });
        if (req.authType === 'user' && !(req.userId != null && row.user_id === req.userId)) {
            return res.status(403).json({ error: 'Not authorized to delete this file' });
        }

        const filePath = filePathForKey(row);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* */ }
        db.deleteFileRow(row.key);
        res.json({ message: 'File deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

module.exports = router;
module.exports.filePathForKey = filePathForKey;
module.exports.filePublic = filePublic;
