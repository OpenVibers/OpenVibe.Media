/**
 * OpenVibe.Media — Admin storage API (mounted at /api/v1/:app/admin/storage)
 *
 * Storage-management endpoints ported from the predecessor's admin panel,
 * app-key auth only: admins reach these through their app's server, which
 * holds the key. DB-derived stats are scoped to the calling app; disk totals
 * and directory sizes are host-wide (the data dirs are shared across apps) —
 * responses say so in a `note` field.
 *
 * GET    /                 disk usage + per-directory breakdown + per-app DB stats
 * GET    /vods             detailed VOD listing (?limit&offset&sort&order&provider&tier)
 * DELETE /vods/bulk        { ids: [...] } — delete VODs everywhere, per-id results
 * GET    /tiers            tier/offload status (global + app-scoped counts, job state)
 * PUT    /tiers/settings   update storage_tier.* settings (persisted in media_settings)
 * POST   /tiers/sweep      trigger a tiering sweep now
 * POST   /tiers/move       { vod_id, target: local|hot|b2|cold|r2 }
 * POST   /tiers/bulk-move  { ids: [...], target } (max 50)
 * GET    /buckets          sanitized B2/R2 bucket config + live reachability probe
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');
const vodStorage = require('../vod/vod-storage');
const recorder = require('../vod/recorder');
const tools = require('../vod/media-tools');
const thumbService = require('../thumbnails/thumbnail-service');
const { tenantAuth, tenantCors } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);
router.use(tenantAuth());   // app API key only — no user-JWT access to admin storage

const SHARED_DIRS_NOTE = 'Disk totals and directory sizes are host-wide (data directories are shared across apps); DB-derived stats are scoped to this app.';

/** Recursively compute { bytes, files } for a directory (predecessor helper). */
function dirStatsRecursive(dirPath) {
    let bytes = 0, files = 0;
    try {
        const resolved = path.resolve(dirPath);
        if (!fs.existsSync(resolved)) return { bytes: 0, files: 0 };
        for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
            const full = path.join(resolved, entry.name);
            if (entry.isDirectory()) {
                const sub = dirStatsRecursive(full);
                bytes += sub.bytes;
                files += sub.files;
            } else if (entry.isFile()) {
                try { bytes += fs.statSync(full).size; files++; } catch { /* race / perms */ }
            }
        }
    } catch { /* missing / inaccessible */ }
    return { bytes, files };
}

function _providerCounts(table, appId, withBytes) {
    const rows = db.all(`
        SELECT COALESCE(storage_provider, 'local') AS provider,
               COUNT(*) AS count${withBytes ? ', COALESCE(SUM(file_size), 0) AS bytes' : ''}
        FROM ${table} WHERE app_id = ?
        GROUP BY COALESCE(storage_provider, 'local')
    `, [appId]);
    const out = {};
    for (const r of rows) out[r.provider] = withBytes ? { count: r.count, bytes: r.bytes } : { count: r.count };
    return out;
}

// ── GET / — disk usage & per-directory breakdown ─────────────
router.get('/', (req, res) => {
    try {
        const disk = vodStorage.diskUsage(config.vod.path);

        // Shared on-disk directories (host-wide — files aren't segregated per app).
        const directories = [
            { name: 'vods',       path: config.vod.path },
            { name: 'clips',      path: config.vod.clipsPath },
            { name: 'pastes',     path: config.pastes.path },
            { name: 'thumbnails', path: config.thumbnails.path },
            { name: 'files',      path: config.files.path },
        ];
        const breakdown = directories.map(d => ({ name: d.name, ...dirStatsRecursive(d.path) }));

        let dbBytes = 0;
        try { dbBytes = fs.statSync(config.db.path).size; } catch { /* */ }

        // App-scoped DB stats
        const vodStats = db.get(`
            SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes,
                   COALESCE(MIN(created_at), '') AS oldest, COALESCE(MAX(created_at), '') AS newest
            FROM vods WHERE app_id = ?
        `, [req.appId]) || {};
        const clipStats = db.get('SELECT COUNT(*) AS count FROM clips WHERE app_id = ?', [req.appId]) || {};
        const pasteStats = db.get(`
            SELECT COUNT(*) AS count,
                   SUM(CASE WHEN type = 'screenshot' THEN 1 ELSE 0 END) AS screenshots
            FROM pastes WHERE app_id = ?
        `, [req.appId]) || {};
        const fileStats = db.get('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files WHERE app_id = ?', [req.appId]) || {};

        res.json({
            app_id: req.appId,
            note: SHARED_DIRS_NOTE,
            disk,
            database: { bytes: dbBytes },
            breakdown,
            vodStats,
            clipStats,
            pasteStats,
            fileStats,
            byProvider: {
                vods: _providerCounts('vods', req.appId, true),
                clips: _providerCounts('clips', req.appId, false),   // clips carry no file_size column
            },
        });
    } catch (err) {
        console.error('[Admin] Storage error:', err.message);
        res.status(500).json({ error: 'Failed to analyze storage' });
    }
});

// ── GET /vods — detailed VOD listing ─────────────────────────
const PROVIDER_ALIASES = { hot: 'local', local: 'local', cold: 'b2', b2: 'b2', r2: 'r2' };

router.get('/vods', (req, res) => {
    try {
        const sort = req.query.sort || 'size'; // size, date, duration, tier, views, accessed
        const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

        let orderBy;
        switch (sort) {
            case 'date':     orderBy = `created_at ${order}`; break;
            case 'duration': orderBy = `duration_seconds ${order}`; break;
            case 'tier':     orderBy = `COALESCE(storage_provider, 'local') ${order}, file_size DESC`; break;
            case 'views':    orderBy = `view_count ${order}`; break;
            case 'accessed': orderBy = `last_accessed_at ${order}`; break;
            default:         orderBy = `file_size ${order}`; break;
        }

        const conds = ['app_id = ?'];
        const params = [req.appId];
        // `provider` filters storage_provider directly; `tier` accepts the
        // predecessor's hot/cold vocabulary as aliases.
        const providerFilter = PROVIDER_ALIASES[String(req.query.provider || req.query.tier || '').toLowerCase()];
        if (providerFilter) { conds.push("COALESCE(storage_provider, 'local') = ?"); params.push(providerFilter); }

        const vods = db.all(`
            SELECT id, title, file_path, file_size, duration_seconds, is_public, visibility,
                   is_recording, clips_only, created_at, view_count, health_status,
                   storage_provider, storage_tier, storage_key, last_accessed_at,
                   stream_id, user_id, thumbnail_url
            FROM vods
            WHERE ${conds.join(' AND ')}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
        const total = db.get(`SELECT COUNT(*) AS c FROM vods WHERE ${conds.join(' AND ')}`, params).c;

        // Reconcile DB tier with what's actually on disk / in object storage.
        const enriched = vods.map(v => {
            let diskSize = 0, exists = false, tier = vodStorage.providerOf(v);
            if (v.file_path) {
                const localPath = vodStorage.localPathForVod(v);
                if (fs.existsSync(localPath)) {
                    try { diskSize = fs.statSync(localPath).size; } catch { /* */ }
                    exists = true;
                    tier = 'local';
                } else if (vodStorage.isRemote(v)) {
                    diskSize = v.file_size || 0;
                    exists = true;
                } else {
                    tier = 'missing';
                }
            }
            return { ...v, diskSize, fileExists: exists, actualTier: tier };
        });

        // Per-user summary (app-local user ids; Media holds no user profiles)
        const userSummary = db.all(`
            SELECT user_id, COUNT(*) AS vodCount, COALESCE(SUM(file_size), 0) AS totalSize
            FROM vods WHERE app_id = ?
            GROUP BY user_id
            ORDER BY totalSize DESC
            LIMIT 20
        `, [req.appId]);

        res.json({ vods: enriched, total, limit, offset, userSummary });
    } catch (err) {
        console.error('[Admin] VOD storage error:', err.message);
        res.status(500).json({ error: 'Failed to list VOD storage' });
    }
});

// ── DELETE /vods/bulk — bulk delete VODs by id ───────────────
router.delete('/vods/bulk', async (req, res) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'ids array required' });
        }
        if (ids.length > 200) {
            return res.status(400).json({ error: 'Max 200 VODs per bulk delete' });
        }

        let deleted = 0, freed = 0;
        const results = [];
        for (const rawId of ids) {
            const id = parseInt(rawId, 10);
            const result = { id: Number.isFinite(id) ? id : rawId, ok: false };
            try {
                const vod = Number.isFinite(id) ? db.getVodById(id, req.appId) : null;
                if (!vod) { result.error = 'VOD not found'; results.push(result); continue; }

                if (recorder.isRecording(vod.id)) recorder.stopRecording(vod.id);
                try { require('../vod/routes').activeChunkUploads.delete(vod.id); } catch { /* */ }

                // Delete media everywhere (local + B2 + R2) + sidecars/master
                if (vod.file_path) {
                    freed += vod.file_size || 0;
                    await vodStorage.deleteVodObjects(vod);
                    tools.cleanupSeekableFile(vod.file_path);
                    try { if (vod.master_file_path && fs.existsSync(vod.master_file_path)) fs.unlinkSync(vod.master_file_path); } catch { /* */ }
                }
                // Thumbnail file
                if (vod.thumbnail_url && String(vod.thumbnail_url).startsWith('/t/')) {
                    const thumbFile = path.join(thumbService.THUMB_DIR, path.basename(vod.thumbnail_url));
                    try { if (fs.existsSync(thumbFile)) fs.unlinkSync(thumbFile); } catch { /* */ }
                }

                db.run('DELETE FROM vods WHERE id = ?', [vod.id]);
                db.run("DELETE FROM content_views WHERE content_type = 'vod' AND content_id = ?", [vod.id]);
                result.ok = true;
                deleted++;
            } catch (err) {
                result.error = err.message;
            }
            results.push(result);
        }

        console.log(`[Admin] Bulk VOD delete (${req.appId}): ${deleted}/${ids.length} deleted, ${(freed / 1048576).toFixed(1)} MB freed`);
        res.json({ deleted, freed, results });
    } catch (err) {
        console.error('[Admin] Bulk VOD delete error:', err.message);
        res.status(500).json({ error: 'Bulk delete failed' });
    }
});

// ═══════════════════════════════════════════════════════════════
// Storage tiers — local / Backblaze B2 / Cloudflare R2
// ═══════════════════════════════════════════════════════════════

// ── GET /tiers — tier/offload status ─────────────────────────
router.get('/tiers', (req, res) => {
    try {
        const status = vodStorage.getStatus();   // settings, providers, disk, global tier counts, sweepRunning

        // App-scoped tier counts
        const appCounts = db.get(`
            SELECT
                SUM(CASE WHEN COALESCE(storage_provider, 'local') = 'local' THEN 1 ELSE 0 END) AS localCount,
                SUM(CASE WHEN storage_provider = 'b2' THEN 1 ELSE 0 END) AS b2Count,
                SUM(CASE WHEN storage_provider = 'r2' THEN 1 ELSE 0 END) AS r2Count,
                SUM(CASE WHEN COALESCE(storage_provider, 'local') = 'local' THEN file_size ELSE 0 END) AS localBytes,
                SUM(CASE WHEN storage_provider = 'b2' THEN file_size ELSE 0 END) AS b2Bytes,
                SUM(CASE WHEN storage_provider = 'r2' THEN file_size ELSE 0 END) AS r2Bytes
            FROM vods WHERE app_id = ?
        `, [req.appId]) || {};

        // VODs of this app currently eligible for the next cold-offload sweep
        const s = status.settings;
        const pendingOffload = db.get(`
            SELECT COUNT(*) AS c FROM vods
            WHERE app_id = ?
              AND COALESCE(storage_provider, 'local') = 'local'
              AND COALESCE(is_recording, 0) = 0
              AND created_at <= datetime('now', ?)
              AND COALESCE(view_count, 0) <= ?
              AND (last_accessed_at IS NULL OR last_accessed_at <= datetime('now', ?))
        `, [req.appId, `-${s.minAgeDays} days`, s.maxViewsForCold, `-${s.minLastAccessDays} days`])?.c || 0;

        res.json({
            ...status,
            note: 'providers/local/tiers/clipTiers are service-wide; `app` is scoped to this app.',
            app: {
                app_id: req.appId,
                tiers: {
                    local: { count: appCounts.localCount || 0, bytes: appCounts.localBytes || 0 },
                    b2: { count: appCounts.b2Count || 0, bytes: appCounts.b2Bytes || 0 },
                    r2: { count: appCounts.r2Count || 0, bytes: appCounts.r2Bytes || 0 },
                },
                pendingOffload,
            },
        });
    } catch (err) {
        console.error('[Admin] Storage tier status error:', err.message);
        res.status(500).json({ error: 'Failed to get tier status' });
    }
});

// ── PUT /tiers/settings — update tier settings ───────────────
router.put('/tiers/settings', (req, res) => {
    try {
        const allowed = Object.keys(vodStorage.DEFAULTS);
        const updates = {};
        for (const key of allowed) {
            if (req.body?.[key] !== undefined) {
                let val = req.body[key];
                // Coerce types to match defaults
                if (typeof vodStorage.DEFAULTS[key] === 'number') val = Number(val);
                if (typeof vodStorage.DEFAULTS[key] === 'boolean') val = !!val;
                vodStorage.setSetting(key, val);
                updates[key] = val;
            }
        }
        // Restart sweep timer with new settings
        vodStorage.stop();
        vodStorage.start();
        console.log(`[Admin] Storage tier settings updated (${req.appId}):`, updates);
        res.json({ ok: true, settings: vodStorage.getSettings() });
    } catch (err) {
        console.error('[Admin] Storage tier settings error:', err.message);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ── POST /tiers/sweep — trigger a sweep now ──────────────────
router.post('/tiers/sweep', async (req, res) => {
    try {
        const result = await vodStorage.runSweep();
        console.log(`[Admin] Manual sweep triggered (${req.appId}):`, result);
        res.json(result);
    } catch (err) {
        console.error('[Admin] Sweep error:', err.message);
        res.status(500).json({ error: 'Sweep failed' });
    }
});

// target → mover (predecessor's hot/cold vocabulary kept as aliases)
const MOVERS = {
    local: (id) => vodStorage.moveToHot(id),
    hot: (id) => vodStorage.moveToHot(id),
    b2: (id) => vodStorage.moveToCold(id),
    cold: (id) => vodStorage.moveToCold(id),
    r2: (id) => vodStorage.promoteToR2(id),
};

async function _moveScoped(appId, rawId, target) {
    const id = parseInt(rawId, 10);
    if (!Number.isFinite(id) || !db.getVodById(id, appId)) return { ok: false, error: 'VOD not found' };
    return MOVERS[target](id);
}

// ── POST /tiers/move — move one VOD between tiers ────────────
router.post('/tiers/move', async (req, res) => {
    try {
        const { vod_id, vodId, target } = req.body || {};
        const id = vod_id ?? vodId;   // vodId = predecessor alias
        if (id == null || !MOVERS[target]) {
            return res.status(400).json({ error: 'vod_id and target (local|hot|b2|cold|r2) required' });
        }
        const result = await _moveScoped(req.appId, id, target);
        if (!result.ok && result.error === 'VOD not found') return res.status(404).json(result);
        console.log(`[Admin] VOD ${id} move to ${target} (${req.appId}):`, result);
        res.json(result);
    } catch (err) {
        console.error('[Admin] Tier move error:', err.message);
        res.status(500).json({ error: 'Move failed' });
    }
});

// ── POST /tiers/bulk-move — bulk move VODs to a tier ─────────
router.post('/tiers/bulk-move', async (req, res) => {
    try {
        const { ids, target } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0 || !MOVERS[target]) {
            return res.status(400).json({ error: 'ids array and target (local|hot|b2|cold|r2) required' });
        }
        if (ids.length > 50) {
            return res.status(400).json({ error: 'Max 50 VODs per bulk move' });
        }
        let moved = 0, bytesTotal = 0;
        const errors = [];
        for (const id of ids) {
            const result = await _moveScoped(req.appId, id, target);
            if (result.ok) { moved++; bytesTotal += result.bytes || 0; }
            else errors.push({ id, error: result.error });
        }
        console.log(`[Admin] Bulk move → ${target} (${req.appId}): ${moved}/${ids.length}`);
        res.json({ moved, bytes: bytesTotal, errors: errors.length ? errors : undefined });
    } catch (err) {
        console.error('[Admin] Bulk move error:', err.message);
        res.status(500).json({ error: 'Bulk move failed' });
    }
});

// ── GET /buckets — bucket config + reachability (no creds) ───
router.get('/buckets', async (req, res) => {
    try {
        const buckets = await vodStorage.bucketStatus();
        res.json({ buckets, checkedAt: new Date().toISOString() });
    } catch (err) {
        console.error('[Admin] Bucket status error:', err.message);
        res.status(500).json({ error: 'Failed to check buckets' });
    }
});

module.exports = router;
