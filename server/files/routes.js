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
 * Files live in the tenant's root namespace. Its quotas (bytes: apps.quota_bytes unless the root
 * sets its own, 0 = unlimited; objects: the root's quota_objects) count v1 files, native v2 objects
 * and uploads in progress (objects/namespaces.js).
 *
 * Network principal tokens, for the tenant's root namespace (server/auth.js VERBS): upload needs
 * write (media.object.upload), delete needs delete (media.object.delete, or media.object.upload),
 * list needs list (media.object.list, or media.object.read), meta needs read (media.object.read).
 * Developer-project tenants
 * (:app = prj_<ULID>, app tokens only, ADR-014): sandbox files are never served
 * publicly — their `url` is a short-lived signed /f/:key URL.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');
const config = require('../config');
const namespaces = require('../objects/namespaces');
const { tenantAuth, tenantCors } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

// (multer creates `dest` when it is built; a restore drill takes no upload and creates no directory.)
const upload = multer({
    ...(require('../drill').enabled ? { storage: multer.memoryStorage() } : { dest: path.join(config.files.path, '.tmp') }),
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
    const sandbox = db.isSandboxTenant(row.app_id);
    const signed = sandbox ? require('../objects/signing').signedFileUrl(row.key) : null;
    return {
        key: row.key,
        app_id: row.app_id,
        user_id: row.user_id,
        original_name: row.original_name,
        size: row.size,
        mime: row.mime,
        sha256: row.sha256,
        url: signed ? signed.url : `/f/${row.key}`,
        ...(sandbox ? { sandbox: true, url_expires_at: signed.expires_at } : {}),
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
router.post('/', tenantAuth({ allowUser: true, verb: 'write' }), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded (multipart field: file)' });

        const digest = await sha256File(req.file.path);
        const name = sanitizeName(req.file.originalname);
        // Keys are global. A developer-project tenant's keys carry a tag of the tenant id, so two
        // tenants never collide on (and so never learn about) each other's identical uploads.
        const tag = req.appRow.project_id ? `${crypto.createHash('sha256').update(`tenant:${req.appId}`).digest('hex').slice(0, 8)}-` : '';
        const key = `${digest.slice(0, 12)}-${tag}${name}`;

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

        // The root namespace's quotas (bytes and objects: files + native objects + uploads in progress).
        // Checked after the last await, so nothing else is stored between this check and the row below
        // (concurrent uploads each saw the same usage when it ran before hashing).
        const root = db.rootNamespace(req.appRow);
        const q = namespaces.checkQuota(req.appRow, root, { bytes: req.file.size, objects: 1 });
        if (q) {
            try { fs.unlinkSync(req.file.path); } catch { /* */ }
            return res.status(413).json({ error: q.code === 'media.quota.objects_exceeded' ? 'App object quota exceeded' : 'App file quota exceeded', code: q.code, ...q.extra });
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
        namespaces.reconcileChain(req.appRow, root);
        console.log(`[Files] Stored ${key} for app ${req.appId} (${(req.file.size / 1024).toFixed(1)} KB)`);
        res.status(201).json(filePublic(row));
    } catch (err) {
        console.error('[Files] Upload error:', err.message);
        if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* */ } }
        res.status(500).json({ error: 'Failed to store file' });
    }
});

// ── List ─────────────────────────────────────────────────────
router.get('/', tenantAuth({ allowUser: true, verb: 'list' }), (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const files = db.listFiles(req.appId, { limit, offset });
        res.json({
            files: files.map(filePublic),
            used_bytes: require('../objects/model').usedBytes(req.appId),
            quota_bytes: Number(req.appRow.quota_bytes) || 0,
            limit, offset,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// ── Meta ─────────────────────────────────────────────────────
router.get('/:key', tenantAuth({ allowUser: true, verb: 'read' }), (req, res) => {
    try {
        const row = db.getFileByKey(String(req.params.key), req.appId);
        if (!row) return res.status(404).json({ error: 'File not found' });
        res.json(filePublic(row));
    } catch (err) {
        res.status(500).json({ error: 'Failed to get file' });
    }
});

// ── Delete ───────────────────────────────────────────────────
router.delete('/:key', tenantAuth({ allowUser: true, verb: 'delete' }), (req, res) => {
    try {
        const row = db.getFileByKey(String(req.params.key), req.appId);
        if (!row) return res.status(404).json({ error: 'File not found' });
        if (req.authType === 'user' && !(req.userId != null && row.user_id === req.userId)) {
            return res.status(403).json({ error: 'Not authorized to delete this file' });
        }
        if (require('../objects/model').isHeldRow(row)) return res.status(409).json({ error: 'File is under a retention hold', code: 'media.object.held' });

        const filePath = filePathForKey(row);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* */ }
        db.deleteFileRow(row.key);
        namespaces.reconcileChain(req.appRow, db.rootNamespace(req.appRow));
        res.json({ message: 'File deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

module.exports = router;
module.exports.filePathForKey = filePathForKey;
module.exports.filePublic = filePublic;
