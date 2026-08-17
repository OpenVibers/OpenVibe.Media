/**
 * OpenVibe.Media — Database
 *
 * Lean port of the predecessor's vod/clip/paste helpers with app_id (tenant)
 * scoping on every query. better-sqlite3 in WAL mode.
 *
 * Migration path: `importLegacyRows(table, rows, appId)` bulk-inserts rows from
 * the old streamer DB unchanged — only columns that exist in the new table are
 * used (extras ignored), ids preserved, app_id backfilled. The cutover script
 * can do:  ATTACH old db, SELECT * per table, importLegacyRows('vods', rows, 'live').
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('../config');

let database = null;

function getDb() {
    if (database) return database;
    const dataDir = path.dirname(config.db.path);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    database = new Database(config.db.path);
    database.pragma('journal_mode = WAL');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    database.exec(schema);
    migrateColumns();
    seedSettings();
    return database;
}

// Additive column migrations for DBs created before the column existed
// (CREATE TABLE IF NOT EXISTS won't add columns to an existing table).
function migrateColumns() {
    const wanted = {
        vods: [['managed_stream_id', 'INTEGER']],
        clips: [['channel_user_id', 'INTEGER']],
    };
    for (const [table, cols] of Object.entries(wanted)) {
        const existing = database.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        for (const [name, type] of cols) {
            if (existing.includes(name)) continue;
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
            console.log(`[DB] Added ${table}.${name}`);
        }
    }
}

function seedSettings() {
    const defaults = [
        // Clip system
        ['max_clip_duration', '60', 'Maximum clip length in seconds', 'number'],
        // Paste system (same keys the inherited routes read)
        ['paste_max_size_kb', '512', 'Maximum paste content size in KB', 'number'],
        ['paste_screenshot_max_size_mb', '8', 'Maximum screenshot upload size in MB', 'number'],
        ['paste_cooldown_seconds', '30', 'Cooldown between paste submissions in seconds (user-JWT callers)', 'number'],
        ['paste_max_per_user_per_day', '200', 'Maximum pastes per user per day (0 = unlimited)', 'number'],
        ['paste_comment_cooldown_seconds', '10', 'Cooldown between paste comments in seconds', 'number'],
        ['paste_comment_max_length', '2000', 'Maximum paste comment length in characters', 'number'],
        ['paste_comment_anon_allowed', 'true', 'Allow anonymous comments on pastes', 'boolean'],
    ];
    const stmt = database.prepare('INSERT OR IGNORE INTO media_settings (key, value, description, type) VALUES (?, ?, ?, ?)');
    for (const [k, v, d, t] of defaults) stmt.run(k, v, d, t);
}

// ── Generic helpers ──────────────────────────────────────────

function run(sql, params = []) {
    return getDb().prepare(sql).run(...(Array.isArray(params) ? params : [params]));
}

function get(sql, params = []) {
    return getDb().prepare(sql).get(...(Array.isArray(params) ? params : [params]));
}

function all(sql, params = []) {
    return getDb().prepare(sql).all(...(Array.isArray(params) ? params : [params]));
}

function close() {
    if (database) { try { database.close(); } catch { /* ignore */ } database = null; }
}

// ── Settings ─────────────────────────────────────────────────

function getSetting(key) {
    const row = get('SELECT value, type FROM media_settings WHERE key = ?', [key]);
    if (!row) return null;
    if (row.type === 'number') return Number(row.value);
    if (row.type === 'boolean') return row.value === 'true' || row.value === '1';
    return row.value;
}

function setSetting(key, value, type = 'string') {
    run(`INSERT INTO media_settings (key, value, type) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        [key, String(value), type]);
}

// ── Apps (tenants) ───────────────────────────────────────────

function hashApiKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function getApp(appId) {
    return get('SELECT * FROM apps WHERE app_id = ?', [appId]);
}

function listApps() {
    return all('SELECT app_id, name, webhook_url, allowed_origins, quota_bytes, created_at FROM apps ORDER BY app_id');
}

function upsertApp({ app_id, name, api_key, webhook_url, webhook_secret, allowed_origins, quota_bytes }) {
    if (!app_id || !api_key) throw new Error('app_id and api_key required');
    const origins = JSON.stringify(Array.isArray(allowed_origins) ? allowed_origins : []);
    run(`INSERT INTO apps (app_id, name, api_key_hash, webhook_url, webhook_secret, allowed_origins, quota_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET
             name = excluded.name,
             api_key_hash = excluded.api_key_hash,
             webhook_url = excluded.webhook_url,
             webhook_secret = excluded.webhook_secret,
             allowed_origins = excluded.allowed_origins,
             quota_bytes = excluded.quota_bytes`,
        [app_id, name || app_id, hashApiKey(api_key), webhook_url || null, webhook_secret || null, origins, quota_bytes || 0]);
    return getApp(app_id);
}

function appAllowedOrigins(app) {
    try { return JSON.parse(app.allowed_origins || '[]'); } catch { return []; }
}

// ── VOD helpers ──────────────────────────────────────────────

function createVod({ app_id, stream_id, stream_key, managed_stream_id, user_id, title, description, file_path, file_size, duration_seconds, thumbnail_url, master_file_path, meta }) {
    return run(
        `INSERT INTO vods (app_id, stream_id, stream_key, managed_stream_id, user_id, title, description, file_path, master_file_path, file_size, duration_seconds, thumbnail_url, meta_json, is_public)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [app_id, stream_id || null, stream_key || null, managed_stream_id || null, user_id || null, title || 'Recording', description || '',
         file_path || null, master_file_path || null, file_size || 0, duration_seconds || 0, thumbnail_url || null,
         JSON.stringify(meta || {})]
    );
}

/** Legacy lookup: resolve a row by its file's basename (old /api/vods/file/<name> URLs). */
function _byFileBasename(table, basename, appId) {
    const name = path.basename(String(basename || ''));
    if (!name) return null;
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [`%${name}`, appId] : [`%${name}`];
    // LIKE narrows the scan; exact basename match is confirmed in JS (LIKE
    // wildcards inside the filename can't produce false positives that way).
    const rows = all(`SELECT * FROM ${table} WHERE file_path LIKE ?${clause}`, params);
    return rows.find(r => r.file_path && path.basename(r.file_path) === name) || null;
}
function getVodByFileBasename(basename, appId = null) { return _byFileBasename('vods', basename, appId); }
function getClipByFileBasename(basename, appId = null) { return _byFileBasename('clips', basename, appId); }

function getVodById(id, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [id, appId] : [id];
    return get(`SELECT *, COALESCE(duration_seconds, probe_duration_seconds, 0) AS duration_seconds
                FROM vods WHERE id = ?${clause}`, params);
}

// Sort orders shared by the vod/clip lists (inherited query shapes). The
// predecessor's 'peak_viewers' needed a streams join that lives in the owning
// app now — view_count is the closest popularity proxy here.
const LIST_ORDERS = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    views: 'view_count DESC, created_at DESC',
    peak_viewers: 'view_count DESC, created_at DESC',
};
function _listOrder(order) { return LIST_ORDERS[order] || LIST_ORDERS.newest; }

function _vodConds(appId, { user_id = null, stream_id = null, managed_stream_id = null, include_private = false, includeRecording = true } = {}) {
    const conds = ['app_id = ?', 'COALESCE(clips_only, 0) = 0'];
    const params = [appId];
    if (!includeRecording) conds.push('COALESCE(is_recording, 0) = 0');
    if (!include_private) conds.push('is_public = 1');
    if (user_id != null) { conds.push('user_id = ?'); params.push(user_id); }
    if (stream_id != null) { conds.push('stream_id = ?'); params.push(stream_id); }
    if (managed_stream_id != null) { conds.push('managed_stream_id = ?'); params.push(managed_stream_id); }
    return { conds, params };
}

function listVods(appId, filters = {}) {
    const { limit = 50, offset = 0, order = 'newest' } = filters;
    const { conds, params } = _vodConds(appId, filters);
    params.push(limit, offset);
    return all(`SELECT * FROM vods WHERE ${conds.join(' AND ')} ORDER BY ${_listOrder(order)} LIMIT ? OFFSET ?`, params);
}

function countVods(appId, filters = {}) {
    const { conds, params } = _vodConds(appId, filters);
    return get(`SELECT COUNT(*) AS count FROM vods WHERE ${conds.join(' AND ')}`, params)?.count || 0;
}

const VALID_VISIBILITY = new Set(['public', 'unlisted', 'private']);
function _normVisibility(v) { return VALID_VISIBILITY.has(v) ? v : 'public'; }

// Set VOD/clip visibility; is_public mirrors (1 iff public) so listing filters hold.
function setVodVisibility(vodId, visibility) {
    const vis = _normVisibility(visibility);
    return run('UPDATE vods SET visibility = ?, is_public = ? WHERE id = ?', [vis, vis === 'public' ? 1 : 0, vodId]);
}

function updateVodHealth(vodId, { status, score, issues = [], probeDuration, probeFormat, quarantine = false, keepPublic = false }) {
    const updates = [];
    const params = [];
    if (status) { updates.push('health_status = ?'); params.push(status); }
    if (typeof score === 'number') { updates.push('health_score = ?'); params.push(score); }
    if (issues) { updates.push('health_issues_json = ?'); params.push(JSON.stringify(issues)); }
    if (typeof probeDuration === 'number') { updates.push('probe_duration_seconds = ?'); params.push(probeDuration); }
    if (probeFormat !== undefined) { updates.push('probe_format_json = ?'); params.push(JSON.stringify(probeFormat || {})); }
    if (quarantine) {
        updates.push("quarantined_at = datetime('now')");
        if (!keepPublic) updates.push('is_public = 0');
    }
    updates.push("last_health_scan_at = datetime('now')");
    params.push(vodId);
    if (!updates.length) return null;
    return run(`UPDATE vods SET ${updates.join(', ')} WHERE id = ?`, params);
}

function repairVodDuration(vodId, duration, fileSize) {
    return run(
        `UPDATE vods SET duration_seconds = ?, file_size = ?, probe_duration_seconds = ?, last_health_scan_at = datetime('now') WHERE id = ?`,
        [duration, fileSize, duration, vodId]
    );
}

// VODs the periodic health job should scan: finished (not recording), and either never
// scanned or last scanned longer ago than `staleDays`. Never-scanned + oldest-scanned first.
function getVodsNeedingHealthScan({ staleDays = 30, limit = 3 } = {}) {
    return all(`SELECT * FROM vods
        WHERE COALESCE(is_recording, 0) = 0
          AND (health_status IS NULL OR health_status NOT IN ('corrupt','zero_byte','missing_file'))
          AND (last_health_scan_at IS NULL OR last_health_scan_at <= datetime('now', ?))
        ORDER BY (last_health_scan_at IS NULL) DESC, last_health_scan_at ASC
        LIMIT ?`, [`-${Math.max(1, staleDays)} days`, limit]);
}

// Genuinely-broken VODs quarantined long enough that they should be cleaned up.
function getQuarantinedVodsForCleanup({ graceDays = 14, limit = 5 } = {}) {
    return all(`SELECT * FROM vods
        WHERE quarantined_at IS NOT NULL
          AND quarantined_at <= datetime('now', ?)
          AND health_status IN ('corrupt','zero_byte','missing_file')
          AND COALESCE(is_recording, 0) = 0
        ORDER BY quarantined_at ASC
        LIMIT ?`, [`-${Math.max(1, graceDays)} days`, limit]);
}

// Derived VOD status for the API: pending → recording → ready | failed.
function vodStatus(vod) {
    if (!vod) return 'unknown';
    if (vod.is_recording) return 'recording';
    if (['corrupt', 'zero_byte', 'missing_file'].includes(vod.health_status)) return 'failed';
    if (vod.file_path && (vod.duration_seconds > 0 || vod.file_size > 0)) return 'ready';
    return 'pending';
}

// ── Clip helpers ─────────────────────────────────────────────

function createClip({ app_id, vod_id, stream_id, user_id, channel_user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds, is_public, auto_generated, status }) {
    const pub = (is_public === 0 || is_public === false) ? 0 : 1;
    return run(
        `INSERT INTO clips (app_id, vod_id, stream_id, user_id, channel_user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds, is_public, visibility, auto_generated, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [app_id, vod_id || null, stream_id || null, user_id || null, channel_user_id || null, title || 'Untitled Clip', description || '',
         file_path || '', thumbnail_url || null, start_time || 0, end_time || 0, duration_seconds || 0,
         pub, pub ? 'public' : 'unlisted', auto_generated ? 1 : 0, status || 'ready']
    );
}

function getClipById(id, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [id, appId] : [id];
    return get(`SELECT * FROM clips WHERE id = ?${clause}`, params);
}

function _clipConds(appId, { vod_id = null, stream_id = null, user_id = null, channel_user_id = null, include_private = false, hide_self = false } = {}) {
    const conds = ['app_id = ?'];
    const params = [appId];
    if (!include_private) conds.push('is_public = 1');
    if (vod_id != null) { conds.push('vod_id = ?'); params.push(vod_id); }
    if (stream_id != null) { conds.push('stream_id = ?'); params.push(stream_id); }
    if (user_id != null) { conds.push('user_id = ?'); params.push(user_id); }
    // channel_user_id = owner of the clipped channel ("clips taken OF this streamer")
    if (channel_user_id != null) { conds.push('channel_user_id = ?'); params.push(channel_user_id); }
    // hide_self hides self-clips (creator == channel owner) — clips-taken tab default
    if (hide_self) conds.push('(channel_user_id IS NULL OR channel_user_id != user_id)');
    return { conds, params };
}

function listClips(appId, filters = {}) {
    const { limit = 50, offset = 0, order = 'newest' } = filters;
    const { conds, params } = _clipConds(appId, filters);
    params.push(limit, offset);
    return all(`SELECT * FROM clips WHERE ${conds.join(' AND ')} ORDER BY ${_listOrder(order)} LIMIT ? OFFSET ?`, params);
}

function countClips(appId, filters = {}) {
    const { conds, params } = _clipConds(appId, filters);
    return get(`SELECT COUNT(*) AS count FROM clips WHERE ${conds.join(' AND ')}`, params)?.count || 0;
}

function setClipVisibility(clipId, visibility) {
    const vis = _normVisibility(visibility);
    return run('UPDATE clips SET visibility = ?, is_public = ? WHERE id = ?', [vis, vis === 'public' ? 1 : 0, clipId]);
}

function findDuplicateClip({ appId, streamId = null, vodId = null, startTime = 0, endTime = 0, startWindow = 8, endWindow = 10, createdSinceMinutes = 10 }) {
    const filters = [];
    const params = [appId];
    if (streamId) { filters.push('stream_id = ?'); params.push(streamId); }
    if (vodId) { filters.push('vod_id = ?'); params.push(vodId); }
    if (!filters.length) return null;
    return get(`
        SELECT * FROM clips
        WHERE app_id = ? AND (${filters.join(' OR ')})
          AND ABS(COALESCE(start_time, 0) - ?) <= ?
          AND ABS(COALESCE(end_time, 0) - ?) <= ?
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC
        LIMIT 1
    `, [...params, startTime || 0, startWindow, endTime || 0, endWindow, `-${Math.max(1, createdSinceMinutes)} minutes`]);
}

// ── Paste helpers ────────────────────────────────────────────

function getPasteBySlug(slug, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [slug, appId] : [slug];
    return get(`SELECT * FROM pastes WHERE slug = ?${clause}`, params);
}

function likePaste(pasteId, userId) {
    run('INSERT OR IGNORE INTO paste_likes (paste_id, user_id) VALUES (?, ?)', [pasteId, userId]);
    run('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?', [pasteId, pasteId]);
    return get('SELECT likes FROM pastes WHERE id = ?', [pasteId]);
}

function unlikePaste(pasteId, userId) {
    run('DELETE FROM paste_likes WHERE paste_id = ? AND user_id = ?', [pasteId, userId]);
    run('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?', [pasteId, pasteId]);
    return get('SELECT likes FROM pastes WHERE id = ?', [pasteId]);
}

function hasUserLikedPaste(pasteId, userId) {
    return !!get('SELECT 1 FROM paste_likes WHERE paste_id = ? AND user_id = ?', [pasteId, userId]);
}

function incrementPasteCopies(slug) {
    return run('UPDATE pastes SET copies = copies + 1 WHERE slug = ?', [slug]);
}

function countUserPastesToday(appId, userId, ip) {
    if (userId) {
        return get("SELECT COUNT(*) as c FROM pastes WHERE app_id = ? AND user_id = ? AND created_at > datetime('now', '-1 day')", [appId, userId])?.c || 0;
    }
    if (ip) {
        return get("SELECT COUNT(*) as c FROM pastes WHERE app_id = ? AND ip_address = ? AND created_at > datetime('now', '-1 day')", [appId, ip])?.c || 0;
    }
    return 0;
}

function getLastPasteTime(appId, userId, ip) {
    let row;
    if (userId) {
        row = get('SELECT created_at FROM pastes WHERE app_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1', [appId, userId]);
    } else if (ip) {
        row = get('SELECT created_at FROM pastes WHERE app_id = ? AND ip_address = ? ORDER BY created_at DESC LIMIT 1', [appId, ip]);
    }
    return row ? new Date(row.created_at + (row.created_at.includes('Z') ? '' : 'Z')).getTime() : 0;
}

/** App-scoped paste stats (predecessor's admin stats shape). */
function getPasteStats(appId) {
    const row = get(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN type = 'paste' THEN 1 ELSE 0 END) AS textPastes,
               SUM(CASE WHEN type = 'screenshot' THEN 1 ELSE 0 END) AS screenshots,
               SUM(CASE WHEN forked_from IS NOT NULL THEN 1 ELSE 0 END) AS forks,
               COALESCE(SUM(views), 0) AS totalViews,
               COALESCE(SUM(copies), 0) AS totalCopies,
               COALESCE(SUM(likes), 0) AS totalLikes
        FROM pastes WHERE app_id = ?
    `, [appId]) || {};
    return {
        total: row.total || 0,
        textPastes: row.textPastes || 0,
        screenshots: row.screenshots || 0,
        forks: row.forks || 0,
        totalViews: row.totalViews || 0,
        totalCopies: row.totalCopies || 0,
        totalLikes: row.totalLikes || 0,
    };
}

// ── Paste comment helpers ────────────────────────────────────

function createPasteComment({ paste_id, user_id, parent_id, anon_name, message, ip_address }) {
    return run(
        `INSERT INTO paste_comments (paste_id, user_id, parent_id, anon_name, message, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [paste_id, user_id || null, parent_id || null, anon_name || null, message, ip_address || null]
    );
}

function getPasteComments(pasteId, limit = 50, offset = 0) {
    return all(`
        SELECT * FROM paste_comments
        WHERE paste_id = ? AND is_deleted = 0 AND parent_id IS NULL
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `, [pasteId, limit, offset]);
}

function getPasteCommentReplies(parentId) {
    return all(`
        SELECT * FROM paste_comments
        WHERE parent_id = ? AND is_deleted = 0
        ORDER BY created_at ASC
    `, [parentId]);
}

function getPasteCommentById(commentId) {
    return get('SELECT * FROM paste_comments WHERE id = ?', [commentId]);
}

function getPasteCommentCount(pasteId) {
    return get('SELECT COUNT(*) as count FROM paste_comments WHERE paste_id = ? AND is_deleted = 0', [pasteId])?.count || 0;
}

function deletePasteComment(commentId) {
    return run('UPDATE paste_comments SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [commentId]);
}

function getRecentPasteCommentsByIp(ip, seconds = 10) {
    return all(`
        SELECT * FROM paste_comments
        WHERE ip_address = ? AND created_at > datetime('now', '-' || ? || ' seconds')
        ORDER BY created_at DESC
    `, [ip, seconds]);
}

// ── File helpers ─────────────────────────────────────────────

function createFile({ key, app_id, user_id, original_name, size, mime, sha256 }) {
    return run(
        `INSERT INTO files (key, app_id, user_id, original_name, size, mime, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [key, app_id, user_id || null, original_name || null, size || 0, mime || 'application/octet-stream', sha256 || null]
    );
}

function getFileByKey(key, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [key, appId] : [key];
    return get(`SELECT * FROM files WHERE key = ?${clause}`, params);
}

function listFiles(appId, { limit = 100, offset = 0 } = {}) {
    return all('SELECT * FROM files WHERE app_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [appId, limit, offset]);
}

function deleteFileRow(key) {
    return run('DELETE FROM files WHERE key = ?', [key]);
}

function appFilesBytes(appId) {
    return get('SELECT COALESCE(SUM(size), 0) AS bytes FROM files WHERE app_id = ?', [appId])?.bytes || 0;
}

// ── Legacy import (cutover from the old streamer DB) ─────────

/**
 * Bulk-insert rows exported from the predecessor DB. Only columns present in
 * the destination table are used; missing ones take schema defaults; app_id is
 * backfilled. Row ids are preserved (INSERT OR IGNORE keeps re-runs idempotent).
 * Returns { inserted, skipped }.
 */
function importLegacyRows(table, rows, appId = 'live') {
    const allowed = new Set(['vods', 'clips', 'pastes', 'paste_likes', 'paste_comments', 'content_views', 'files']);
    if (!allowed.has(table)) throw new Error(`importLegacyRows: table ${table} not importable`);
    if (!Array.isArray(rows) || !rows.length) return { inserted: 0, skipped: 0 };

    const cols = getDb().prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    const colSet = new Set(cols);
    const hasAppId = colSet.has('app_id');

    let inserted = 0, skipped = 0;
    const tx = getDb().transaction((batch) => {
        for (const raw of batch) {
            const row = { ...raw };
            if (hasAppId && row.app_id == null) row.app_id = appId;
            const keys = Object.keys(row).filter(k => colSet.has(k));
            if (!keys.length) { skipped++; continue; }
            const sql = `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
            const res = getDb().prepare(sql).run(...keys.map(k => row[k]));
            if (res.changes > 0) inserted++; else skipped++;
        }
    });
    tx(rows);
    return { inserted, skipped };
}

module.exports = {
    getDb, run, get, all, close,
    getSetting, setSetting,
    // apps
    hashApiKey, getApp, listApps, upsertApp, appAllowedOrigins,
    // vods
    createVod, getVodById, getVodByFileBasename, listVods, countVods, setVodVisibility, vodStatus,
    updateVodHealth, repairVodDuration, getVodsNeedingHealthScan, getQuarantinedVodsForCleanup,
    // clips
    createClip, getClipById, getClipByFileBasename, listClips, countClips, setClipVisibility, findDuplicateClip,
    // pastes
    getPasteBySlug, likePaste, unlikePaste, hasUserLikedPaste, incrementPasteCopies,
    countUserPastesToday, getLastPasteTime, getPasteStats,
    createPasteComment, getPasteComments, getPasteCommentReplies, getPasteCommentById,
    getPasteCommentCount, deletePasteComment, getRecentPasteCommentsByIp,
    // files
    createFile, getFileByKey, listFiles, deleteFileRow, appFilesBytes,
    // migration
    importLegacyRows,
};
