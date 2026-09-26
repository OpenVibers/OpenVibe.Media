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
    migrateJobsTable(schema);
    ensureObjectTriggers();
    normalizeThumbnailUrls();
    seedSettings();
    // Clips a restart left 'processing' are marked failed (and re-cut) by vod/clip-jobs.start() when
    // the SERVER boots, not here: every script that opens this database (backfills, reconcilers,
    // operator tools) comes through getDb(), and running it while the service is cutting a clip
    // used to fail that clip under it.
    return database;
}

// One-time normalization: migrated rows stored old-stack thumbnail URLs
// (/api/thumbnails/<name> or absolute variants). Canonical form is /t/<name>
// — the legacy redirect route covers stragglers, but direct URLs cache better.
function normalizeThumbnailUrls() {
    try {
        for (const table of ['vods', 'clips']) {
            const info = database.prepare(
                `UPDATE ${table}
                 SET thumbnail_url = '/t/' || replace(thumbnail_url, rtrim(thumbnail_url, replace(thumbnail_url, '/', '')), '')
                 WHERE thumbnail_url LIKE '%/api/thumbnails/%'`
            ).run();
            if (info.changes) console.log(`[DB] Normalized ${info.changes} legacy thumbnail URLs in ${table}`);
        }
    } catch (e) { console.warn('[DB] thumbnail URL normalization:', e.message); }
}

// Additive column migrations for DBs created before the column existed
// (CREATE TABLE IF NOT EXISTS won't add columns to an existing table).
function migrateColumns() {
    const wanted = {
        vods: [['managed_stream_id', 'INTEGER'], ['object_id', 'TEXT'], ['duration_source', 'TEXT']],
        clips: [['channel_user_id', 'INTEGER'], ['cut_error', 'TEXT'], ['cut_attempts', 'INTEGER DEFAULT 0'], ['cut_next_at', 'DATETIME'], ['object_id', 'TEXT']],
        files: [['object_id', 'TEXT']],
        pastes: [['object_id', 'TEXT']],
        // Developer-project tenants (ADR-014): project_id prj_<ULID>, env sandbox|production. NULL on first-party tenants.
        apps: [['project_id', 'TEXT'], ['env', 'TEXT']],
        media_holds: [['note', 'TEXT']],
        // Job fencing (server/jobs/queue.js): a claim's token; NULL on rows claimed before it existed.
        media_jobs: [['lease_token', 'TEXT']],
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

/**
 * media_jobs was created schema-only (integer id, no app_id, status 'done') before the job worker
 * existed; nothing ever wrote it. Rebuild that shape into the current one from schema.sql, keeping
 * any rows (id mjob_legacy_<n>, tenant from the object, done -> succeeded), then create the indexes
 * that need the new columns. Idempotent: a database already in the new shape only gets its indexes.
 */
function migrateJobsTable(schema) {
    const cols = database.prepare('PRAGMA table_info(media_jobs)').all().map(c => c.name);
    if (!cols.includes('app_id')) {
        const ddl = /CREATE TABLE IF NOT EXISTS media_jobs \([\s\S]*?\n\);/.exec(schema);
        if (!ddl) throw new Error('schema.sql has no media_jobs table');
        database.transaction(() => {
            database.exec('ALTER TABLE media_jobs RENAME TO media_jobs_v0');
            database.exec(ddl[0]);
            const moved = database.prepare(`INSERT INTO media_jobs (id, app_id, object_id, job_type, status, attempts, checkpoint, error, created_at, updated_at)
                SELECT 'mjob_legacy_' || v.id, COALESCE((SELECT o.app_id FROM media_objects o WHERE o.id = v.object_id), 'unknown'), v.object_id, v.job_type,
                       CASE v.status WHEN 'done' THEN 'succeeded' ELSE v.status END, v.attempts, v.checkpoint, v.error, v.created_at, v.updated_at
                FROM media_jobs_v0 v`).run().changes;
            database.exec('DROP TABLE media_jobs_v0');
            console.log(`[DB] Rebuilt media_jobs for the job worker (${moved} row(s) kept)`);
        })();
    }
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, job_type);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_app ON media_jobs(app_id, id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_object ON media_jobs(object_id, job_type, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_jobs_idem ON media_jobs(app_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`);
}

/**
 * SQL: is the object named by the SQL expression `ref` under an unreleased retention hold? Its own
 * hold, or, for a clip, its source VOD's (through the clip_of relationship, or the clip row's vod_id).
 * One rule for the delete triggers below and objects/model.js isHeld().
 */
function heldSql(ref) {
    return `EXISTS (SELECT 1 FROM media_holds h WHERE h.released_at IS NULL AND (h.object_id = ${ref}
        OR h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = ${ref} AND r.relation = 'clip_of')
        OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = ${ref})))`;
}

/**
 * Object-model guards that must hold on EVERY delete path, including the many
 * inherited ones that DELETE a vods/clips/files/pastes row directly:
 *   - a row whose object is under an unreleased retention hold cannot be deleted, and a clip whose
 *     source VOD is held cannot either (even before the clip has an object);
 *   - deleting a projected row marks its media_object deleted (bytes accounting
 *     and reconciliation keep working without touching each call site).
 * Created here, after migrateColumns, because they reference object_id. The hold guards are the _v2
 * triggers (clips follow their VOD's hold); the first-version ones are dropped.
 */
function ensureObjectTriggers() {
    // One transaction: replacing a first-version hold guard never leaves a moment without one.
    database.transaction(_ensureObjectTriggers)();
}

function _ensureObjectTriggers() {
    const held = heldSql;
    // A clip's lookups by object id (the hold rule above) use this index.
    database.exec('CREATE INDEX IF NOT EXISTS idx_clips_object ON clips(object_id)');
    for (const old of ['trg_vods_hold_guard', 'trg_clips_hold_guard', 'trg_files_hold_guard', 'trg_pastes_hold_guard', 'trg_media_objects_hold_guard', 'trg_media_objects_hold_delete']) {
        database.exec(`DROP TRIGGER IF EXISTS ${old}`);
    }
    const vodHeld = `(OLD.vod_id IS NOT NULL AND EXISTS (SELECT 1 FROM media_holds h JOIN vods v ON v.object_id = h.object_id WHERE v.id = OLD.vod_id AND h.released_at IS NULL))`;
    for (const table of ['vods', 'clips', 'files', 'pastes']) {
        database.exec(`
            CREATE TRIGGER IF NOT EXISTS trg_${table}_hold_guard_v2 BEFORE DELETE ON ${table}
            WHEN (OLD.object_id IS NOT NULL AND ${held('OLD.object_id')})${table === 'clips' ? ` OR ${vodHeld}` : ''}
            BEGIN SELECT RAISE(ABORT, 'media object is under a retention hold'); END;
            CREATE TRIGGER IF NOT EXISTS trg_${table}_object_deleted AFTER DELETE ON ${table}
            WHEN OLD.object_id IS NOT NULL
            BEGIN
                UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP),
                       updated_at = CURRENT_TIMESTAMP
                WHERE id = OLD.object_id AND lifecycle_status != 'deleted';
            END;`);
    }
    database.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_media_objects_hold_guard_v2 BEFORE UPDATE OF lifecycle_status ON media_objects
        WHEN NEW.lifecycle_status = 'deleted' AND OLD.lifecycle_status != 'deleted' AND ${held('OLD.id')}
        BEGIN SELECT RAISE(ABORT, 'media object is under a retention hold'); END;
        CREATE TRIGGER IF NOT EXISTS trg_media_objects_hold_delete_v2 BEFORE DELETE ON media_objects
        WHEN ${held('OLD.id')}
        BEGIN SELECT RAISE(ABORT, 'media object is under a retention hold'); END;`);
    // media.object.visibility_changed / media.object.deleted: staged in the changing transaction,
    // whichever path changed the object (projection sync, soft delete, the row-delete triggers above,
    // operator SQL); server/events.js turns the rows into outbox envelopes.
    database.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_media_objects_visibility_event AFTER UPDATE OF visibility ON media_objects
        WHEN OLD.visibility IS NOT NEW.visibility AND NEW.lifecycle_status != 'deleted'
        BEGIN INSERT INTO media_object_changes (object_id, change, previous_visibility, visibility) VALUES (NEW.id, 'visibility_changed', OLD.visibility, NEW.visibility); END;
        CREATE TRIGGER IF NOT EXISTS trg_media_objects_deleted_event AFTER UPDATE OF lifecycle_status ON media_objects
        WHEN NEW.lifecycle_status = 'deleted' AND OLD.lifecycle_status != 'deleted'
        BEGIN INSERT INTO media_object_changes (object_id, change, previous_visibility) VALUES (NEW.id, 'deleted', OLD.visibility); END;`);
}

/**
 * Object-first write (WS-G task 1, retiring C-75): run write() — a change to a projected
 * vods/clips/files/pastes row — and re-project the row's media_object in the same transaction
 * (objects/model.js withObject). Throws, with nothing written, when either part fails.
 */
function withObject(kind, ids, write) {
    return require('../objects/model').withObject(kind, ids, write);
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
    // Developer-project tenants never get an API key: they are reached only with their project's app tokens.
    if (/^prj_/.test(String(app_id))) throw new Error(`${app_id} is a developer-project tenant id; API keys are never issued for those`);
    const existing = getApp(app_id);
    if (existing && existing.project_id) throw new Error(`${app_id} is a developer-project tenant; API keys are never issued for those`);
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

/**
 * Developer-project tenant (ADR-014), created on first use. One project has up to two tenants:
 *   production  app_id = prj_<ULID>
 *   sandbox     app_id = prj_<ULID>-sandbox
 * Both are reached through the project id in the URL; the token's env picks the row. No API key.
 * Returns the row, or throws { code: 'media.tenant.conflict' } when the id is taken by something else.
 */
function projectTenantId(projectId, env) {
    return env === 'sandbox' ? `${projectId}-sandbox` : projectId;
}

function ensureProjectTenant(projectId, env, quotaBytes) {
    const id = projectTenantId(projectId, env);
    run(`INSERT OR IGNORE INTO apps (app_id, name, api_key_hash, quota_bytes, project_id, env)
         VALUES (?, ?, '', ?, ?, ?)`, [id, `project ${projectId} (${env})`, quotaBytes, projectId, env]);
    const row = getApp(id);
    if (!row || row.project_id !== projectId || row.env !== env || row.api_key_hash) {
        const err = new Error(`tenant id ${id} is taken by a tenant that is not this project's ${env} tenant`);
        err.code = 'media.tenant.conflict';
        throw err;
    }
    return row;
}

/** Is this tenant a developer project's sandbox? Its content is never served from public URLs. */
function isSandboxTenant(appId) {
    if (!appId) return false;
    const r = get('SELECT env FROM apps WHERE app_id = ?', [appId]);
    return !!(r && r.env === 'sandbox');
}

function appAllowedOrigins(app) {
    try { return JSON.parse(app.allowed_origins || '[]'); } catch { return []; }
}

// ── VOD helpers ──────────────────────────────────────────────

// The row and its media_object in one transaction (a clips-only recording has no object).
function createVod({ app_id, stream_id, stream_key, managed_stream_id, user_id, title, description, file_path, file_size, duration_seconds, thumbnail_url, master_file_path, meta, visibility, clips_only }) {
    const vis = visibility ? _normVisibility(visibility) : 'public';
    return withObject('vod', (r) => r.lastInsertRowid, () => run(
        `INSERT INTO vods (app_id, stream_id, stream_key, managed_stream_id, user_id, title, description, file_path, master_file_path, file_size, duration_seconds, thumbnail_url, meta_json, is_public, visibility, clips_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [app_id, stream_id || null, stream_key || null, managed_stream_id || null, user_id || null, title || 'Recording', description || '',
         file_path || null, master_file_path || null, file_size || 0, duration_seconds || 0, thumbnail_url || null,
         JSON.stringify(meta || {}), vis === 'public' ? 1 : 0, vis, clips_only ? 1 : 0]
    ));
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

/**
 * A list's `since` filter as an SQLite datetime ('YYYY-MM-DD HH:MM:SS', UTC), or null. Accepts that
 * form or anything Date.parse reads (ISO 8601); anything else is ignored rather than refused.
 */
function sinceParam(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(s)) return s.length === 10 ? `${s} 00:00:00` : s;
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : null;
}

function _vodConds(appId, { user_id = null, stream_id = null, managed_stream_id = null, include_private = false, includeRecording = true, since = null } = {}) {
    const conds = ['app_id = ?', 'COALESCE(clips_only, 0) = 0'];
    const params = [appId];
    if (!includeRecording) conds.push('COALESCE(is_recording, 0) = 0');
    if (!include_private) conds.push('is_public = 1');
    if (user_id != null) { conds.push('user_id = ?'); params.push(user_id); }
    if (stream_id != null) { conds.push('stream_id = ?'); params.push(stream_id); }
    if (managed_stream_id != null) { conds.push('managed_stream_id = ?'); params.push(managed_stream_id); }
    // Created at or after this moment (the "top this week" windows). datetime() on both sides so
    // an imported row stored as ISO text compares by time, not by string.
    const after = sinceParam(since);
    if (after) { conds.push('datetime(created_at) >= datetime(?)'); params.push(after); }
    return { conds, params };
}

function listVods(appId, filters = {}) {
    const { limit = 50, offset = 0, order = 'newest' } = filters;
    const { conds, params } = _vodConds(appId, filters);
    params.push(limit, offset);
    return all(`SELECT * FROM vods WHERE ${conds.join(' AND ')} ORDER BY ${_listOrder(order)} LIMIT ? OFFSET ?`, params);
}

/** Latest finished public VOD (id + thumbnail) per managed stream — one batch query. */
function latestVodThumbsByManagedStreams(appId, managedStreamIds) {
    const ids = (managedStreamIds || []).map(n => parseInt(n, 10)).filter(Number.isFinite);
    if (!ids.length) return {};
    const ph = ids.map(() => '?').join(',');
    const rows = all(`
        SELECT v.managed_stream_id, v.id, v.thumbnail_url
        FROM vods v
        JOIN (SELECT managed_stream_id ms, MAX(created_at) mc FROM vods
              WHERE app_id = ? AND managed_stream_id IN (${ph})
                AND is_public = 1 AND COALESCE(is_recording, 0) = 0 AND COALESCE(clips_only, 0) = 0
              GROUP BY managed_stream_id) latest
          ON v.managed_stream_id = latest.ms AND v.created_at = latest.mc
        WHERE v.app_id = ? AND v.is_public = 1 AND COALESCE(v.is_recording, 0) = 0`,
        [appId, ...ids, appId]);
    const out = {};
    for (const r of rows) { if (out[r.managed_stream_id] == null) out[r.managed_stream_id] = { vod_id: r.id, thumbnail_url: r.thumbnail_url }; }
    return out;
}

/** Aggregate per-app media stats for the owning app's dashboards/heroes. */
function getAppStats(appId) {
    const c = (sql, p = []) => { try { return get(sql, p)?.n || 0; } catch { return 0; } };
    const win = (sql, extraParams = []) => ({
        d: c(sql, [...extraParams, '-1 day']),
        w: c(sql, [...extraParams, '-7 days']),
        m: c(sql, [...extraParams, '-30 days']),
    });
    const vodBase = "FROM vods WHERE app_id = ? AND is_public = 1 AND COALESCE(is_recording,0) = 0 AND COALESCE(clips_only,0) = 0";
    const clipBase = "FROM clips WHERE app_id = ? AND COALESCE(is_public,1) = 1";
    return {
        vods: c(`SELECT COUNT(*) n ${vodBase}`, [appId]),
        clips: c(`SELECT COUNT(*) n ${clipBase}`, [appId]),
        pastes: c('SELECT COUNT(*) n FROM pastes WHERE app_id = ?', [appId]),
        pasteImages: c("SELECT COUNT(*) n FROM pastes WHERE app_id = ? AND type = 'screenshot'", [appId]),
        pasteText: c("SELECT COUNT(*) n FROM pastes WHERE app_id = ? AND COALESCE(type,'paste') <> 'screenshot'", [appId]),
        durationSeconds: c(`SELECT COALESCE(SUM(duration_seconds),0) n ${vodBase}`, [appId]),
        recent: {
            vods: win(`SELECT COUNT(*) n ${vodBase} AND created_at >= datetime('now', ?)`, [appId]),
            clips: win(`SELECT COUNT(*) n ${clipBase} AND created_at >= datetime('now', ?)`, [appId]),
            hours: (() => {
                const w = win(`SELECT COALESCE(SUM(duration_seconds),0) n ${vodBase} AND created_at >= datetime('now', ?)`, [appId]);
                return { d: Math.round(w.d / 3600), w: Math.round(w.w / 3600), m: Math.round(w.m / 3600) };
            })(),
        },
    };
}

// Daily values behind one of the stats above, for an app's "over time" charts. Missing days are
// filled with 0; `before` is the total before the window so a running total can start from it.
const STAT_SERIES = {
    vods:   { base: "FROM vods WHERE app_id = ? AND is_public = 1 AND COALESCE(is_recording,0) = 0 AND COALESCE(clips_only,0) = 0", agg: 'COUNT(*)' },
    clips:  { base: 'FROM clips WHERE app_id = ? AND COALESCE(is_public,1) = 1', agg: 'COUNT(*)' },
    pastes: { base: 'FROM pastes WHERE app_id = ?', agg: 'COUNT(*)' },
    hours:  { base: "FROM vods WHERE app_id = ? AND is_public = 1 AND COALESCE(is_recording,0) = 0 AND COALESCE(clips_only,0) = 0", agg: 'COALESCE(SUM(duration_seconds),0) / 3600.0' },
};
function getAppStatSeries(appId, metric, days = 30) {
    const def = STAT_SERIES[metric];
    if (!def) return null;
    days = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const since = `-${days - 1} days`;
    const rows = all(`SELECT date(created_at) AS day, ${def.agg} AS value ${def.base} AND created_at >= date('now', ?) GROUP BY day`, [appId, since]);
    const byDay = new Map(rows.map((r) => [r.day, Number(r.value) || 0]));
    const points = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        points.push({ day, value: Number((byDay.get(day) || 0).toFixed(2)) });
    }
    const one = (sql, p) => Number(get(sql, p)?.value) || 0;
    const before = one(`SELECT ${def.agg} AS value ${def.base} AND created_at < date('now', ?)`, [appId, since]);
    const prevTotal = one(`SELECT ${def.agg} AS value ${def.base} AND created_at >= date('now', ?) AND created_at < date('now', ?)`, [appId, `-${2 * days - 1} days`, since]);
    const total = Number(points.reduce((n, p) => n + p.value, 0).toFixed(2));
    return { metric, days, points, total, before: Number(before.toFixed(2)), prev_total: Number(prevTotal.toFixed(2)) };
}

function countVods(appId, filters = {}) {
    const { conds, params } = _vodConds(appId, filters);
    return get(`SELECT COUNT(*) AS count FROM vods WHERE ${conds.join(' AND ')}`, params)?.count || 0;
}

const VALID_VISIBILITY = new Set(['public', 'unlisted', 'private']);
function _normVisibility(v) { return VALID_VISIBILITY.has(v) ? v : 'public'; }

// Set VOD/clip visibility; is_public mirrors (1 iff public) so listing filters hold. Row and object together.
function setVodVisibility(vodId, visibility) {
    const vis = _normVisibility(visibility);
    return withObject('vod', vodId, () => run('UPDATE vods SET visibility = ?, is_public = ? WHERE id = ?', [vis, vis === 'public' ? 1 : 0, vodId]));
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
    return withObject('vod', vodId, () => run(`UPDATE vods SET ${updates.join(', ')} WHERE id = ?`, params));
}

/** A measured duration (source probe | remux) replaces the stored one (the object's size and duration with it). */
function repairVodDuration(vodId, duration, fileSize, source = 'probe') {
    return withObject('vod', vodId, () => run(
        `UPDATE vods SET duration_seconds = ?, file_size = ?, probe_duration_seconds = ?, duration_source = ?, last_health_scan_at = datetime('now') WHERE id = ?`,
        [duration, fileSize, duration, source, vodId]
    ));
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

// The row and its media_object in one transaction. `visibility` (public | unlisted | private), when
// given, sets both columns; otherwise is_public picks public or unlisted as before.
function createClip({ app_id, vod_id, stream_id, user_id, channel_user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds, is_public, visibility, auto_generated, status }) {
    const pub = (is_public === 0 || is_public === false) ? 0 : 1;
    const vis = visibility ? _normVisibility(visibility) : (pub ? 'public' : 'unlisted');
    return withObject('clip', (r) => r.lastInsertRowid, () => run(
        `INSERT INTO clips (app_id, vod_id, stream_id, user_id, channel_user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds, is_public, visibility, auto_generated, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [app_id, vod_id || null, stream_id || null, user_id || null, channel_user_id || null, title || 'Untitled Clip', description || '',
         file_path || '', thumbnail_url || null, start_time || 0, end_time || 0, duration_seconds || 0,
         vis === 'public' ? 1 : 0, vis, auto_generated ? 1 : 0, status || 'ready']
    ));
}

function getClipById(id, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [id, appId] : [id];
    return get(`SELECT * FROM clips WHERE id = ?${clause}`, params);
}

function _clipConds(appId, { vod_id = null, stream_id = null, user_id = null, channel_user_id = null, include_private = false, hide_self = false, auto_generated = null, ready_only = false, since = null } = {}) {
    const conds = ['app_id = ?'];
    const params = [appId];
    if (!include_private) conds.push('is_public = 1');
    // Made by the app's own automation (1) or by a person (0); null = both.
    if (auto_generated === 0 || auto_generated === 1) { conds.push('COALESCE(auto_generated, 0) = ?'); params.push(auto_generated); }
    // Only clips that can be played: not still cutting, not failed. Imported rows have no status.
    if (ready_only) conds.push("COALESCE(status, 'ready') = 'ready'");
    const after = sinceParam(since);
    if (after) { conds.push('datetime(created_at) >= datetime(?)'); params.push(after); }
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
    return withObject('clip', clipId, () => run('UPDATE clips SET visibility = ?, is_public = ? WHERE id = ?', [vis, vis === 'public' ? 1 : 0, clipId]));
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

// The row and its media_object in one transaction (the file is already on disk, sha256 computed by the route).
function createFile({ key, app_id, user_id, original_name, size, mime, sha256 }) {
    return withObject('file', key, () => run(
        `INSERT INTO files (key, app_id, user_id, original_name, size, mime, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [key, app_id, user_id || null, original_name || null, size || 0, mime || 'application/octet-stream', sha256 || null]
    ));
}

function getFileByKey(key, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [key, appId] : [key];
    return get(`SELECT * FROM files WHERE key = ?${clause}`, params);
}

// ── App assets (emotes / channel sounds) ─────────────────────
function upsertAsset({ app_id, kind, name, file_path, mime, user_id, username, channel_username, duration_seconds, meta }) {
    const info = run(`
        INSERT INTO assets (app_id, kind, name, file_path, mime, user_id, username, channel_username, duration_seconds, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, kind, name, channel_username) DO UPDATE SET
            file_path = excluded.file_path, mime = excluded.mime,
            user_id = excluded.user_id, username = excluded.username,
            duration_seconds = excluded.duration_seconds, meta_json = excluded.meta_json`,
        [app_id, kind, name, file_path, mime || 'application/octet-stream', user_id ?? null,
         username || '', channel_username || '', duration_seconds || 0, JSON.stringify(meta || {})]);
    return get('SELECT * FROM assets WHERE app_id = ? AND kind = ? AND name = ? AND channel_username = ?',
        [app_id, kind, name, channel_username || '']);
}
function getAssetById(id) { return get('SELECT * FROM assets WHERE id = ?', [id]); }
function listAssets(appId, { kind = null, limit = 100, offset = 0 } = {}) {
    const conds = ['app_id = ?']; const params = [appId];
    if (kind) { conds.push('kind = ?'); params.push(kind); }
    params.push(limit, offset);
    return all(`SELECT * FROM assets WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
}
function countAssets(appId, { kind = null } = {}) {
    const conds = ['app_id = ?']; const params = [appId];
    if (kind) { conds.push('kind = ?'); params.push(kind); }
    return get(`SELECT COUNT(*) c FROM assets WHERE ${conds.join(' AND ')}`, params).c;
}
function deleteAsset(id) { return run('DELETE FROM assets WHERE id = ?', [id]); }

function listFiles(appId, { limit = 100, offset = 0 } = {}) {
    return all('SELECT * FROM files WHERE app_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [appId, limit, offset]);
}

// The object is marked deleted by trg_files_object_deleted in the same statement.
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
 * Returns { inserted, skipped }. The one write path that is not object-first (the cutover
 * import): the boot backfill (objects/backfill.js, rows with no object_id) projects what it inserts.
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
    getDb, run, get, all, close, withObject, heldSql,
    getSetting, setSetting,
    // apps
    hashApiKey, getApp, listApps, upsertApp, appAllowedOrigins, projectTenantId, ensureProjectTenant, isSandboxTenant,
    // vods
    createVod, getVodById, getVodByFileBasename, listVods, countVods, setVodVisibility, vodStatus,
    latestVodThumbsByManagedStreams, getAppStats, getAppStatSeries,
    upsertAsset, getAssetById, listAssets, countAssets, deleteAsset,
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
