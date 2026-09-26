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
 * GET    /tiers/policy     read-only R2 popularity policy: each threshold with its source (default |
 *                           setting), the promote/demote rules, providers, and this app's recent
 *                           decisions (media_tier_decisions) with 24-hour counts
 * GET    /tiers/decisions  this app's R2 promote/demote decisions, newest first
 *                           (?vod_id&action=promote|demote&outcome&limit≤200&before_id)
 * GET    /holds            this app's retention holds, newest first (?all=1 includes released;
 *                           ?object_id|vod_id|clip_id; ?limit≤200&before_id)
 * POST   /holds            place one: { object_id (med_… or legacy ref) | vod_id | clip_id, reason, kind
 *                           (default admin), note, placed_by } → 201. A VOD's hold also protects the clips
 *                           cut from it. The hold row (placed_by/at, released_by/at, note) is the record,
 *                           and each change is logged as an [Admin] line
 * POST   /holds/:holdId/release   { released_by } (also DELETE /holds/:holdId); 409 when already released
 * GET    /ops              this app's operator report (server/me/ops.js, as openvibe.media/me/ops shows
 *                           it to Network staff): failed jobs, missing media, backfill, tiering, namespaces
 * POST   /ops/recompute    refresh this app's namespaces' usage snapshot from the rows
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
                if (require('../objects/model').isHeldRow(vod)) { result.error = 'VOD is under a retention hold'; results.push(result); continue; }

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
// One revision of the media.storage_tier configuration (server/vod/tier-config.js): validated as a whole
// (422 with the rules broken), recorded with the app that asked and the reason; the sweep restarts with it.
router.put('/tiers/settings', async (req, res) => {
    try {
        const updates = {};
        for (const key of Object.keys(vodStorage.DEFAULTS)) {
            if (req.body?.[key] === undefined) continue;
            let val = req.body[key];
            if (typeof vodStorage.DEFAULTS[key] === 'number') val = Number(val);
            if (typeof vodStorage.DEFAULTS[key] === 'boolean') val = val === true || val === 'true' || val === 1 || val === '1';
            updates[key] = val;
        }
        if (!Object.keys(updates).length) return res.status(400).json({ error: `Nothing to change; known settings: ${Object.keys(vodStorage.DEFAULTS).join(', ')}` });
        const snap = await vodStorage.setSettings(updates, { actor: { type: 'service', id: req.appId }, reason: String(req.body?.reason || 'PUT /tiers/settings').slice(0, 300) });
        console.log(`[Admin] Storage tier settings: revision ${snap.revision} (${req.appId}):`, updates);
        res.json({ ok: true, revision: snap.revision, settings: vodStorage.getSettings() });
    } catch (err) {
        if (err && err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code, errors: err.errors || undefined });
        console.error('[Admin] Storage tier settings error:', err.message);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// The configuration model's own routes for this namespace (openvibe-shared/config): current values,
// history, apply a whole revision, roll back. /api/v1/:app/admin/storage/config…
// Built on first use (the store reads the database), behind this router's app-key authentication.
let configRoutes = null;
router.use('/config', (req, res, next) => {
    if (!configRoutes) {
        configRoutes = require('openvibe-shared/config').adminRoutes([vodStorage.tierConfig.get(vodStorage.DEFAULTS)], {
            basePath: '/', requireAdmin: (_rq, _rs, nx) => nx(), actor: (rq) => ({ type: 'service', id: rq.appId }),
        });
    }
    configRoutes.handle(req, res, next);
});

// ── R2 policy and decision log (read-only) ──────────────────
function _decisionPublic(r) {
    const parse = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
    return {
        id: r.id, decided_at: r.decided_at, vod_id: r.vod_id, object_id: r.object_id || null, action: r.action,
        from_provider: r.from_provider, to_provider: r.to_provider, outcome: r.outcome, trigger: r.trigger, reason: r.reason,
        inputs: parse(r.inputs), thresholds: parse(r.thresholds), error: r.error || null,
    };
}

router.get('/tiers/policy', (req, res) => {
    try {
        const status = vodStorage.getStatus();
        const counts = { promote: { done: 0, already: 0, refused: 0, failed: 0 }, demote: { done: 0, already: 0, refused: 0, failed: 0 } };
        for (const r of db.all(`SELECT action, outcome, COUNT(*) AS n FROM media_tier_decisions
                                WHERE app_id = ? AND decided_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') GROUP BY action, outcome`, [req.appId])) {
            if (counts[r.action]) counts[r.action][r.outcome] = r.n;
        }
        res.json({
            r2: {
                ...vodStorage.r2Policy(status.settings),
                enabled: !!status.settings.r2Enabled,
                provider: status.providers.r2,
                canonical: status.providers.b2,
            },
            decisions: {
                last_24h: counts,
                recent: db.all('SELECT * FROM media_tier_decisions WHERE app_id = ? ORDER BY id DESC LIMIT 20', [req.appId]).map(_decisionPublic),
            },
            note: 'Read-only. Thresholds change through PUT /tiers/settings (media_settings storage_tier.*); decisions are this app\'s only.',
        });
    } catch (err) {
        console.error('[Admin] Tier policy error:', err.message);
        res.status(500).json({ error: 'Failed to read the tier policy' });
    }
});

router.get('/tiers/decisions', (req, res) => {
    try {
        const q = req.query;
        const conds = ['app_id = ?'], params = [req.appId];
        if (q.vod_id != null) { conds.push('vod_id = ?'); params.push(parseInt(q.vod_id, 10) || 0); }
        if (q.action) {
            if (!['promote', 'demote'].includes(String(q.action))) return res.status(400).json({ error: 'action must be promote or demote' });
            conds.push('action = ?'); params.push(String(q.action));
        }
        if (q.outcome) {
            if (!['done', 'already', 'refused', 'failed'].includes(String(q.outcome))) return res.status(400).json({ error: 'outcome must be done, already, refused or failed' });
            conds.push('outcome = ?'); params.push(String(q.outcome));
        }
        if (q.before_id != null) { conds.push('id < ?'); params.push(parseInt(q.before_id, 10) || 0); }
        const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
        const rows = db.all(`SELECT * FROM media_tier_decisions WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, limit + 1]);
        const page = rows.slice(0, limit);
        res.json({ decisions: page.map(_decisionPublic), next_before_id: rows.length > limit ? page[page.length - 1].id : null, limit });
    } catch (err) {
        console.error('[Admin] Tier decisions error:', err.message);
        res.status(500).json({ error: 'Failed to list tier decisions' });
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
// ctx { trigger, reason } goes into the R2 decision log (media_tier_decisions) for moves into or out of R2.
const MOVERS = {
    local: (id, ctx) => vodStorage.moveToHot(id, ctx),
    hot: (id, ctx) => vodStorage.moveToHot(id, ctx),
    b2: (id) => vodStorage.moveToCold(id),
    cold: (id) => vodStorage.moveToCold(id),
    r2: (id, ctx) => vodStorage.promoteToR2(id, ctx),
};

async function _moveScoped(appId, rawId, target) {
    const id = parseInt(rawId, 10);
    if (!Number.isFinite(id) || !db.getVodById(id, appId)) return { ok: false, error: 'VOD not found' };
    return MOVERS[target](id, { trigger: 'admin', reason: `admin move to ${target} (app ${appId})` });
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

// ═══════════════════════════════════════════════════════════════
// Retention holds (staff) — on media_holds, the same holds as /api/v2/:app/objects/:id/holds
// ═══════════════════════════════════════════════════════════════

const objectsModel = () => require('../objects/model');

/** Staff actions are the app's own (its server fronts its admins), never a call acting for one of its users. */
function _staffOnly(req, res) {
    if (req.authType === 'app') return true;
    res.status(403).json({ error: 'Retention holds are staff actions: call with the app key, not on behalf of a user', code: 'media.hold.forbidden' });
    return false;
}

/**
 * The object a hold request names, in this app: { obj } | { error, status }. object_id is a med_ id or a
 * legacy ref; vod_id / clip_id name a v1 row, which is projected first when it has no object yet.
 */
function _holdTarget(appId, b, { project = true } = {}) {
    const m = objectsModel();
    if (b.object_id != null && b.object_id !== '') {
        const obj = m.resolveObject(String(b.object_id), appId);
        return obj ? { obj } : { status: 404, error: 'No such object in this app' };
    }
    for (const [field, table, kind] of [['vod_id', 'vods', 'vod'], ['clip_id', 'clips', 'clip']]) {
        if (b[field] == null || b[field] === '') continue;
        const id = parseInt(b[field], 10);
        const row = Number.isFinite(id) ? db.get(`SELECT id, object_id FROM ${table} WHERE id = ? AND app_id = ?`, [id, appId]) : null;
        if (!row) return { status: 404, error: `${kind === 'vod' ? 'VOD' : 'Clip'} not found` };
        let objectId = row.object_id;
        if (!objectId && project) { const r = m.safeSync(kind, id); objectId = r && r.id; }
        if (!objectId) return { status: 409, error: `${kind} ${id} has no media object to hold (a clips-only recording is never published)` };
        return { obj: m.getObject(objectId) };
    }
    return { status: 400, error: 'object_id, vod_id or clip_id required' };
}

/** A hold with the object it is on and, for a VOD, how many clips cut from it it protects. */
function _holdOut(h) {
    const m = objectsModel();
    const obj = m.getObject(h.object_id);
    const out = { ...m.holdPublic(h), object: obj ? { id: obj.id, kind: obj.kind, legacy_ref: obj.legacy_ref || null, lifecycle_status: obj.lifecycle_status } : null };
    if (obj && obj.kind === 'vod') {
        out.clips_protected = db.get(`SELECT COUNT(*) AS n FROM clips c WHERE c.vod_id IN (SELECT id FROM vods WHERE object_id = @o)
                                      OR c.object_id IN (SELECT from_object_id FROM media_relationships WHERE to_object_id = @o AND relation = 'clip_of')`, { o: obj.id }).n;
    }
    return out;
}

router.get('/holds', (req, res) => {
    try {
        const q = req.query;
        const conds = ['o.app_id = ?'], params = [req.appId];
        if (!['1', 'true'].includes(String(q.all || ''))) conds.push('h.released_at IS NULL');
        if (q.object_id != null || q.vod_id != null || q.clip_id != null) {
            const t = _holdTarget(req.appId, { object_id: q.object_id, vod_id: q.vod_id, clip_id: q.clip_id }, { project: false });
            if (!t.obj) return res.status(t.status).json({ error: t.error });
            conds.push('h.object_id = ?'); params.push(t.obj.id);
        }
        if (q.before_id != null) { conds.push('h.id < ?'); params.push(parseInt(q.before_id, 10) || 0); }
        const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
        const rows = db.all(`SELECT h.* FROM media_holds h JOIN media_objects o ON o.id = h.object_id WHERE ${conds.join(' AND ')} ORDER BY h.id DESC LIMIT ?`, [...params, limit + 1]);
        const page = rows.slice(0, limit);
        res.json({ holds: page.map(_holdOut), next_before_id: rows.length > limit ? page[page.length - 1].id : null, limit });
    } catch (err) {
        console.error('[Admin] Hold list error:', err.message);
        res.status(500).json({ error: 'Failed to list holds' });
    }
});

router.post('/holds', (req, res) => {
    try {
        if (!_staffOnly(req, res)) return;
        const b = req.body || {};
        const m = objectsModel();
        const kind = b.kind == null || b.kind === '' ? 'admin' : String(b.kind);
        if (!m.HOLD_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${m.HOLD_KINDS.join(', ')}` });
        const reason = String(b.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'reason required (why the object must be kept)' });
        const t = _holdTarget(req.appId, b);
        if (!t.obj) return res.status(t.status).json({ error: t.error });
        const by = String(b.placed_by || b.created_by || `app:${req.appId}`).slice(0, 200);
        const hold = m.placeHold({ object_id: t.obj.id, kind, reason, created_by: by, note: b.note });
        const out = _holdOut(hold);
        console.log(`[Admin] Retention hold ${hold.id} placed on ${t.obj.id} (${t.obj.legacy_ref || t.obj.kind}) by ${by} (${req.appId}): ${kind}, ${JSON.stringify(reason.slice(0, 200))}`
            + (out.clips_protected ? `; protects ${out.clips_protected} clip(s) cut from it` : ''));
        res.status(201).json(out);
    } catch (err) {
        console.error('[Admin] Hold place error:', err.message);
        res.status(500).json({ error: 'Failed to place the hold' });
    }
});

function _releaseHold(req, res) {
    try {
        if (!_staffOnly(req, res)) return;
        const hold = db.get('SELECT h.* FROM media_holds h JOIN media_objects o ON o.id = h.object_id WHERE h.id = ? AND o.app_id = ?',
            [parseInt(req.params.holdId, 10) || 0, req.appId]);
        if (!hold) return res.status(404).json({ error: 'No such hold in this app' });
        if (hold.released_at) return res.status(409).json({ error: 'The hold was released already', code: 'media.hold.released', hold: _holdOut(hold) });
        const by = String((req.body && req.body.released_by) || `app:${req.appId}`).slice(0, 200);
        const out = _holdOut(objectsModel().releaseHold(hold.id, by));
        console.log(`[Admin] Retention hold ${hold.id} on ${hold.object_id} released by ${by} (${req.appId})`);
        res.json(out);
    } catch (err) {
        console.error('[Admin] Hold release error:', err.message);
        res.status(500).json({ error: 'Failed to release the hold' });
    }
}
router.post('/holds/:holdId/release', _releaseHold);
router.delete('/holds/:holdId', _releaseHold);

// ═══════════════════════════════════════════════════════════════
// Operator report (WS-G task 12) — the same report as openvibe.media/me/ops, scoped to this app
// ═══════════════════════════════════════════════════════════════

/** The operator views are the app's own (its server fronts its admins), never a call acting for one of its users. */
function _opsStaffOnly(req, res) {
    if (req.authType === 'app') return true;
    res.status(403).json({ error: 'The operator report is for the app itself: call with the app key, not on behalf of a user', code: 'media.ops.forbidden' });
    return false;
}

// GET /ops?limit — failed jobs, missing media, backfill status, tiering diagnostics and the namespaces'
// usage snapshot of this app (server/me/ops.js; the sweep and the provider switches are service-wide).
router.get('/ops', (req, res) => {
    try {
        if (!_opsStaffOnly(req, res)) return;
        res.json(require('../me/ops').report({ appId: req.appId, limit: req.query.limit }));
    } catch (err) {
        console.error('[Admin] Ops report error:', err.message);
        res.status(500).json({ error: 'Failed to build the operator report' });
    }
});

// POST /ops/recompute — refresh this app's namespaces' usage snapshot from the rows.
router.post('/ops/recompute', (req, res) => {
    try {
        if (!_opsStaffOnly(req, res)) return;
        const out = require('../me/ops').recompute({ appId: req.appId });
        console.log(`[Admin] Namespace usage recomputed (${req.appId}): ${out.namespaces} namespace(s)`);
        res.json(out);
    } catch (err) {
        console.error('[Admin] Usage recompute error:', err.message);
        res.status(500).json({ error: 'Failed to recompute usage' });
    }
});

// ── GET /buckets — bucket usage scan + cost estimate + reachability ──
// Full ListObjectsV2 walk per provider (10-min server cache; ?force=1 rescans).
// Response shape matches the legacy admin UI: { usage, costs, cachedAt } + buckets probe.
router.get('/buckets', async (req, res) => {
    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const [buckets, usage] = await Promise.all([vodStorage.bucketStatus(), vodStorage.getBucketUsage(force)]);
        const costs = vodStorage.estimateCloudCosts(usage);
        res.json({ usage, costs, buckets, cachedAt: Date.now(), checkedAt: new Date().toISOString() });
    } catch (err) {
        console.error('[Admin] Bucket status error:', err.message);
        res.status(500).json({ error: 'Failed to check buckets' });
    }
});

module.exports = router;
