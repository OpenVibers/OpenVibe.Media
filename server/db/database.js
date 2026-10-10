/**
 * OpenVibe.Media — Database
 *
 * Lean port of the predecessor's vod/clip helpers with app_id (tenant)
 * scoping on every query. PostgreSQL through openvibe-sdk/db (ADR-035); every helper is async.

 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createDb } = require('openvibe-sdk/db');
const config = require('../config');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', '..', 'data', 'pglite');

let database = null;

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite (MEDIA_PGLITE_DIR overrides it). Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the
 * embedded handle. The schema, its triggers (retention holds, object deletes, object change events) and the default
 * settings are migrations/NNNN_*.sql; timestamps stay text in the `YYYY-MM-DD HH:MM:SS` UTC shape (ov_now(), datetime()
 * in the migration).
 */
async function openDb(cfg = config, { log = console, registry } = {}) {
    if (!cfg.db.url) {
        if (cfg.nodeEnv === 'production') throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh media)');
        const dir = process.env.MEDIA_PGLITE_DIR || DEV_PGLITE;
        // A drill reads its copy as it is (a local embedded copy outside production: the N-1 test).
        if (require('../drill').enabled) return createDb({ pglite: dir, service: 'media-drill', registry, log });
        log.warn(`[DB] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'media', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    // A restore drill (MEDIA_DRILL) reads the restored copy as it is: no migration, nothing written.
    if (require('../drill').enabled) return createDb({ url: cfg.db.url, service: 'media-drill', registry, log });
    if (!cfg.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: cfg.db.directUrl, service: 'media-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: cfg.db.url, service: 'media', registry, log });
}

/** Open the process-wide database once, at boot (server/index.js, scripts). */
async function initDb(cfg = config, opts) {
    if (!database && globalThis.__ovMediaTestDb) database = globalThis.__ovMediaTestDb;   // tests (test/helpers/pg-preload.mjs)
    if (!database) database = await openDb(cfg, opts);
    return database;
}

/** The process-wide database initDb() opened (clips a restart left 'processing' are re-cut by vod/clip-jobs.start()). */
function getDb() {
    // A test process gets a migrated database from test/helpers/pg-preload.mjs (node --import), before any test code.
    if (!database && globalThis.__ovMediaTestDb) database = globalThis.__ovMediaTestDb;
    if (!database) throw new Error('the database is not open: await initDb() at boot');
    return database;
}

/** Tests: use this handle as the process-wide database. */
function setDb(db) { database = db; }

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
 * Object-first write (WS-G task 1, C-75 retired 2026-10-10): run write() — a change to a projected
 * vods/clips/files row — and re-project the row's media_object in the same transaction
 * (objects/model.js withObject). Throws, with nothing written, when either part fails.
 */
async function withObject(kind, ids, write) {
    return await require('../objects/model').withObject(kind, ids, write);
}

// ── Generic helpers ──────────────────────────────────────────

async function run(sql, params = []) {
    return await getDb().prepare(sql).run(...(Array.isArray(params) ? params : [params]));
}

async function get(sql, params = []) {
    return await getDb().prepare(sql).get(...(Array.isArray(params) ? params : [params]));
}

async function all(sql, params = []) {
    return await getDb().prepare(sql).all(...(Array.isArray(params) ? params : [params]));
}

async function close() {
    const db = database;
    database = null;
    // The test process's database (pg-preload.mjs) stays open: a test that closes and reopens gets it back.
    if (db && db !== globalThis.__ovMediaTestDb) await db.close().catch(() => {});
}

// ── Settings ─────────────────────────────────────────────────

async function getSetting(key) {
    const row = await get('SELECT value, type FROM media_settings WHERE key = ?', [key]);
    if (!row) return null;
    if (row.type === 'number') return Number(row.value);
    if (row.type === 'boolean') return row.value === 'true' || row.value === '1';
    return row.value;
}

async function setSetting(key, value, type = 'string') {
    await run(`INSERT INTO media_settings (key, value, type) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ov_now()`,
        [key, String(value), type]);
}

// ── Apps (tenants) ───────────────────────────────────────────

function hashApiKey(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
}

async function getApp(appId) {
    return await get('SELECT * FROM apps WHERE app_id = ?', [appId]);
}

async function listApps() {
    return await all('SELECT app_id, name, webhook_url, allowed_origins, quota_bytes, created_at FROM apps ORDER BY app_id');
}

async function upsertApp({ app_id, name, api_key, webhook_url, webhook_secret, allowed_origins, quota_bytes }) {
    if (!app_id || !api_key) throw new Error('app_id and api_key required');
    // Developer-project tenants never get an API key: they are reached only with their project's app tokens.
    if (/^prj_/.test(String(app_id))) throw new Error(`${app_id} is a developer-project tenant id; API keys are never issued for those`);
    const existing = await getApp(app_id);
    if (existing && existing.project_id) throw new Error(`${app_id} is a developer-project tenant; API keys are never issued for those`);
    const origins = JSON.stringify(Array.isArray(allowed_origins) ? allowed_origins : []);
    await run(`INSERT INTO apps (app_id, name, api_key_hash, webhook_url, webhook_secret, allowed_origins, quota_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET
             name = excluded.name,
             api_key_hash = excluded.api_key_hash,
             webhook_url = excluded.webhook_url,
             webhook_secret = excluded.webhook_secret,
             allowed_origins = excluded.allowed_origins,
             quota_bytes = excluded.quota_bytes`,
        [app_id, name || app_id, hashApiKey(api_key), webhook_url || null, webhook_secret || null, origins, quota_bytes || 0]);
    const row = await getApp(app_id);
    await ensureRootNamespace(row);
    return row;
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

async function ensureProjectTenant(projectId, env, quotaBytes) {
    const id = projectTenantId(projectId, env);
    await run(`INSERT INTO apps (app_id, name, api_key_hash, quota_bytes, project_id, env)
         VALUES (?, ?, '', ?, ?, ?) ON CONFLICT DO NOTHING`, [id, `project ${projectId} (${env})`, quotaBytes, projectId, env]);
    const row = await getApp(id);
    if (!row || row.project_id !== projectId || row.env !== env || row.api_key_hash) {
        const err = new Error(`tenant id ${id} is taken by a tenant that is not this project's ${env} tenant`);
        err.code = 'media.tenant.conflict';
        throw err;
    }
    await ensureRootNamespace(row);
    return row;
}

/** Is this tenant a developer project's sandbox? Its content is never served from public URLs. */
async function isSandboxTenant(appId) {
    if (!appId) return false;
    const r = await get('SELECT env FROM apps WHERE app_id = ?', [appId]);
    return !!(r && r.env === 'sandbox');
}

function appAllowedOrigins(app) {
    try { return JSON.parse(app.allowed_origins || '[]'); } catch { return []; }
}

// ── Namespaces (roadmap WS-G task 2; objects/namespaces.js) ──

/**
 * A tenant's root namespace: its app id for a first-party tenant; app.<project_id> for a developer
 * project's production tenant and app.<project_id>.sandbox for its sandbox tenant (so a grant of
 * app.<project_id>.* covers both, and the token's env still picks the tenant).
 */
function rootNamespace(app) {
    if (!app || !app.app_id) return null;
    if (app.project_id) return app.env === 'sandbox' ? `app.${app.project_id}.sandbox` : `app.${app.project_id}`;
    return app.app_id;
}

/** Who owns a tenant's namespaces: service:<app_id> (a first-party tenant) or project:<prj_…>. */
function namespaceOwner(app) {
    return app.project_id ? `project:${app.project_id}` : `service:${app.app_id}`;
}

/** The tenant's root namespace row, created when missing. Returns its name. */
async function ensureRootNamespace(app) {
    const ns = rootNamespace(app);
    if (!ns) return null;
    await run('INSERT INTO media_namespaces (namespace, app_id, parent, owner) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING', [ns, app.app_id, namespaceOwner(app)]);
    return ns;
}


// ── VOD helpers ──────────────────────────────────────────────

// The row and its media_object in one transaction (a clips-only recording has no object).
async function createVod({ app_id, stream_id, stream_key, managed_stream_id, user_id, title, description, file_path, file_size, duration_seconds, thumbnail_url, master_file_path, meta, visibility, clips_only }) {
    const vis = visibility ? _normVisibility(visibility) : 'public';
    return await withObject('vod', (r) => r.lastInsertRowid, async () => await run(
        `INSERT INTO vods (app_id, stream_id, stream_key, managed_stream_id, user_id, title, description, file_path, master_file_path, file_size, duration_seconds, thumbnail_url, meta_json, is_public, visibility, clips_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [app_id, stream_id || null, stream_key || null, managed_stream_id || null, user_id || null, title || 'Recording', description || '',
         file_path || null, master_file_path || null, file_size || 0, duration_seconds || 0, thumbnail_url || null,
         JSON.stringify(meta || {}), vis === 'public' ? 1 : 0, vis, clips_only ? 1 : 0]
    ));
}

/** Legacy lookup: resolve a row by its file's basename (old /api/vods/file/<name> URLs). */
async function _byFileBasename(table, basename, appId) {
    const name = path.basename(String(basename || ''));
    if (!name) return null;
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [`%${name}`, appId] : [`%${name}`];
    // ILIKE narrows the scan; exact basename match is confirmed in JS (LIKE
    // wildcards inside the filename can't produce false positives that way).
    const rows = await all(`SELECT * FROM ${table} WHERE file_path ILIKE ?${clause}`, params);
    return rows.find(r => r.file_path && path.basename(r.file_path) === name) || null;
}
async function getVodByFileBasename(basename, appId = null) { return await _byFileBasename('vods', basename, appId); }
async function getClipByFileBasename(basename, appId = null) { return await _byFileBasename('clips', basename, appId); }

async function getVodById(id, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [id, appId] : [id];
    return await get(`SELECT *, COALESCE(duration_seconds, probe_duration_seconds, 0) AS duration_seconds
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
 * A list's `since` filter as a text datetime ('YYYY-MM-DD HH:MM:SS', UTC), or null. Accepts that
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

async function listVods(appId, filters = {}) {
    const { limit = 50, offset = 0, order = 'newest' } = filters;
    const { conds, params } = _vodConds(appId, filters);
    params.push(limit, offset);
    return await all(`SELECT * FROM vods WHERE ${conds.join(' AND ')} ORDER BY ${_listOrder(order)} LIMIT ? OFFSET ?`, params);
}

/** Latest finished public VOD (id + thumbnail) per managed stream — one batch query. */
async function latestVodThumbsByManagedStreams(appId, managedStreamIds) {
    const ids = (managedStreamIds || []).map(n => parseInt(n, 10)).filter(Number.isFinite);
    if (!ids.length) return {};
    const ph = ids.map(() => '?').join(',');
    const rows = await all(`
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
async function getAppStats(appId) {
    const c = async (sql, p = []) => { try { return (await get(sql, p))?.n || 0; } catch { return 0; } };
    const win = async (sql, extraParams = []) => ({
        d: await c(sql, [...extraParams, '-1 day']),
        w: await c(sql, [...extraParams, '-7 days']),
        m: await c(sql, [...extraParams, '-30 days']),
    });
    const vodBase = "FROM vods WHERE app_id = ? AND is_public = 1 AND COALESCE(is_recording,0) = 0 AND COALESCE(clips_only,0) = 0";
    const clipBase = "FROM clips WHERE app_id = ? AND COALESCE(is_public,1) = 1";
    return {
        vods: await c(`SELECT COUNT(*) n ${vodBase}`, [appId]),
        clips: await c(`SELECT COUNT(*) n ${clipBase}`, [appId]),
        // Pastes belong to Community, and Live reads them there; null keys remain for one release for N-1 clients.
        pastes: null,
        pasteImages: null,
        pasteText: null,
        durationSeconds: await c(`SELECT COALESCE(SUM(duration_seconds),0) n ${vodBase}`, [appId]),
        recent: {
            vods: await win(`SELECT COUNT(*) n ${vodBase} AND created_at >= datetime('now', ?)`, [appId]),
            clips: await win(`SELECT COUNT(*) n ${clipBase} AND created_at >= datetime('now', ?)`, [appId]),
            hours: (async () => {
                const w = await win(`SELECT COALESCE(SUM(duration_seconds),0) n ${vodBase} AND created_at >= datetime('now', ?)`, [appId]);
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
    hours:  { base: "FROM vods WHERE app_id = ? AND is_public = 1 AND COALESCE(is_recording,0) = 0 AND COALESCE(clips_only,0) = 0", agg: 'COALESCE(SUM(duration_seconds),0) / 3600.0' },
};
async function getAppStatSeries(appId, metric, days = 30) {
    const def = STAT_SERIES[metric];
    if (!def) return null;
    days = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const since = `-${days - 1} days`;
    const rows = await all(`SELECT substr(datetime(created_at), 1, 10) AS day, ${def.agg} AS value ${def.base} AND created_at >= substr(datetime('now', ?), 1, 10) GROUP BY day`, [appId, since]);
    const byDay = new Map(rows.map((r) => [r.day, Number(r.value) || 0]));
    const points = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        points.push({ day, value: Number((byDay.get(day) || 0).toFixed(2)) });
    }
    const one = async (sql, p) => Number((await get(sql, p))?.value) || 0;
    const before = await one(`SELECT ${def.agg} AS value ${def.base} AND created_at < substr(datetime('now', ?), 1, 10)`, [appId, since]);
    const prevTotal = await one(`SELECT ${def.agg} AS value ${def.base} AND created_at >= substr(datetime('now', ?), 1, 10) AND created_at < substr(datetime('now', ?), 1, 10)`, [appId, `-${2 * days - 1} days`, since]);
    const total = Number(points.reduce((n, p) => n + p.value, 0).toFixed(2));
    return { metric, days, points, total, before: Number(before.toFixed(2)), prev_total: Number(prevTotal.toFixed(2)) };
}

async function countVods(appId, filters = {}) {
    const { conds, params } = _vodConds(appId, filters);
    return (await get(`SELECT COUNT(*) AS count FROM vods WHERE ${conds.join(' AND ')}`, params))?.count || 0;
}

const VALID_VISIBILITY = new Set(['public', 'unlisted', 'private']);
function _normVisibility(v) { return VALID_VISIBILITY.has(v) ? v : 'public'; }

// Set VOD/clip visibility; is_public mirrors (1 iff public) so listing filters hold. Row and object together.
async function setVodVisibility(vodId, visibility) {
    const vis = _normVisibility(visibility);
    return await withObject('vod', vodId, async () => await run('UPDATE vods SET visibility = ?, is_public = ? WHERE id = ?', [vis, vis === 'public' ? 1 : 0, vodId]));
}

async function updateVodHealth(vodId, { status, score, issues = [], probeDuration, probeFormat, quarantine = false, keepPublic = false }) {
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
    return await withObject('vod', vodId, async () => await run(`UPDATE vods SET ${updates.join(', ')} WHERE id = ?`, params));
}

/** A measured duration (source probe | remux) replaces the stored one (the object's size and duration with it). */
async function repairVodDuration(vodId, duration, fileSize, source = 'probe') {
    return await withObject('vod', vodId, async () => await run(
        `UPDATE vods SET duration_seconds = ?, file_size = ?, probe_duration_seconds = ?, duration_source = ?, last_health_scan_at = datetime('now') WHERE id = ?`,
        [duration, fileSize, duration, source, vodId]
    ));
}

// VODs the periodic health job should scan: finished (not recording), and either never
// scanned or last scanned longer ago than `staleDays`. Never-scanned + oldest-scanned first.
async function getVodsNeedingHealthScan({ staleDays = 30, limit = 3 } = {}) {
    return await all(`SELECT * FROM vods
        WHERE COALESCE(is_recording, 0) = 0
          AND (health_status IS NULL OR health_status NOT IN ('corrupt','zero_byte','missing_file'))
          AND (last_health_scan_at IS NULL OR last_health_scan_at <= datetime('now', ?))
        ORDER BY (last_health_scan_at IS NULL) DESC, last_health_scan_at ASC
        LIMIT ?`, [`-${Math.max(1, staleDays)} days`, limit]);
}

// Genuinely-broken VODs quarantined long enough that they should be cleaned up.
async function getQuarantinedVodsForCleanup({ graceDays = 14, limit = 5 } = {}) {
    return await all(`SELECT * FROM vods
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
async function createClip({ app_id, vod_id, stream_id, user_id, channel_user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds, is_public, visibility, auto_generated, status }) {
    const pub = (is_public === 0 || is_public === false) ? 0 : 1;
    const vis = visibility ? _normVisibility(visibility) : (pub ? 'public' : 'unlisted');
    return await withObject('clip', (r) => r.lastInsertRowid, async () => await run(
        `INSERT INTO clips (app_id, vod_id, stream_id, user_id, channel_user_id, title, description, file_path, thumbnail_url, start_time, end_time, duration_seconds, is_public, visibility, auto_generated, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [app_id, vod_id || null, stream_id || null, user_id || null, channel_user_id || null, title || 'Untitled Clip', description || '',
         file_path || '', thumbnail_url || null, start_time || 0, end_time || 0, duration_seconds || 0,
         vis === 'public' ? 1 : 0, vis, auto_generated ? 1 : 0, status || 'ready']
    ));
}

async function getClipById(id, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [id, appId] : [id];
    return await get(`SELECT * FROM clips WHERE id = ?${clause}`, params);
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

async function listClips(appId, filters = {}) {
    const { limit = 50, offset = 0, order = 'newest' } = filters;
    const { conds, params } = _clipConds(appId, filters);
    params.push(limit, offset);
    return await all(`SELECT * FROM clips WHERE ${conds.join(' AND ')} ORDER BY ${_listOrder(order)} LIMIT ? OFFSET ?`, params);
}

async function countClips(appId, filters = {}) {
    const { conds, params } = _clipConds(appId, filters);
    return (await get(`SELECT COUNT(*) AS count FROM clips WHERE ${conds.join(' AND ')}`, params))?.count || 0;
}

async function setClipVisibility(clipId, visibility) {
    const vis = _normVisibility(visibility);
    return await withObject('clip', clipId, async () => await run('UPDATE clips SET visibility = ?, is_public = ? WHERE id = ?', [vis, vis === 'public' ? 1 : 0, clipId]));
}

async function findDuplicateClip({ appId, streamId = null, vodId = null, startTime = 0, endTime = 0, startWindow = 8, endWindow = 10, createdSinceMinutes = 10 }) {
    const filters = [];
    const params = [appId];
    if (streamId) { filters.push('stream_id = ?'); params.push(streamId); }
    if (vodId) { filters.push('vod_id = ?'); params.push(vodId); }
    if (!filters.length) return null;
    return await get(`
        SELECT * FROM clips
        WHERE app_id = ? AND (${filters.join(' OR ')})
          AND ABS(COALESCE(start_time, 0) - ?) <= ?
          AND ABS(COALESCE(end_time, 0) - ?) <= ?
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC
        LIMIT 1
    `, [...params, startTime || 0, startWindow, endTime || 0, endWindow, `-${Math.max(1, createdSinceMinutes)} minutes`]);
}

// ── File helpers ─────────────────────────────────────────────

// The row and its media_object in one transaction (the file is already on disk, sha256 computed by the route).
async function createFile({ key, app_id, user_id, original_name, size, mime, sha256 }) {
    return await withObject('file', key, async () => await run(
        `INSERT INTO files (key, app_id, user_id, original_name, size, mime, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [key, app_id, user_id || null, original_name || null, size || 0, mime || 'application/octet-stream', sha256 || null]
    ));
}

async function getFileByKey(key, appId = null) {
    const clause = appId ? ' AND app_id = ?' : '';
    const params = appId ? [key, appId] : [key];
    return await get(`SELECT * FROM files WHERE key = ?${clause}`, params);
}

// ── App assets (emotes / channel sounds) ─────────────────────
async function upsertAsset({ app_id, kind, name, file_path, mime, user_id, username, channel_username, duration_seconds, meta }) {
    const info = await run(`
        INSERT INTO assets (app_id, kind, name, file_path, mime, user_id, username, channel_username, duration_seconds, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, kind, name, channel_username) DO UPDATE SET
            file_path = excluded.file_path, mime = excluded.mime,
            user_id = excluded.user_id, username = excluded.username,
            duration_seconds = excluded.duration_seconds, meta_json = excluded.meta_json RETURNING id`,
        [app_id, kind, name, file_path, mime || 'application/octet-stream', user_id ?? null,
         username || '', channel_username || '', duration_seconds || 0, JSON.stringify(meta || {})]);
    return await get('SELECT * FROM assets WHERE app_id = ? AND kind = ? AND name = ? AND channel_username = ?',
        [app_id, kind, name, channel_username || '']);
}
async function getAssetById(id) { return await get('SELECT * FROM assets WHERE id = ?', [id]); }
async function listAssets(appId, { kind = null, limit = 100, offset = 0 } = {}) {
    const conds = ['app_id = ?']; const params = [appId];
    if (kind) { conds.push('kind = ?'); params.push(kind); }
    params.push(limit, offset);
    return await all(`SELECT * FROM assets WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
}
async function countAssets(appId, { kind = null } = {}) {
    const conds = ['app_id = ?']; const params = [appId];
    if (kind) { conds.push('kind = ?'); params.push(kind); }
    return (await get(`SELECT COUNT(*) c FROM assets WHERE ${conds.join(' AND ')}`, params)).c;
}
async function deleteAsset(id) { return await run('DELETE FROM assets WHERE id = ?', [id]); }

async function listFiles(appId, { limit = 100, offset = 0 } = {}) {
    return await all('SELECT * FROM files WHERE app_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [appId, limit, offset]);
}

// The object is marked deleted by trg_files_object_deleted in the same statement.
async function deleteFileRow(key) {
    return await run('DELETE FROM files WHERE key = ?', [key]);
}

async function appFilesBytes(appId) {
    return (await get('SELECT COALESCE(SUM(size), 0)::bigint AS bytes FROM files WHERE app_id = ?', [appId]))?.bytes || 0;
}

// ── Legacy import (cutover from the old streamer DB) ─────────


module.exports = {
    openDb, initDb, getDb, setDb, MIGRATIONS, run, get, all, close, withObject, heldSql,
    getSetting, setSetting,
    // apps
    hashApiKey, getApp, listApps, upsertApp, appAllowedOrigins, projectTenantId, ensureProjectTenant, isSandboxTenant,
    // namespaces
    rootNamespace, namespaceOwner, ensureRootNamespace,
    // vods
    createVod, getVodById, getVodByFileBasename, listVods, countVods, setVodVisibility, vodStatus,
    latestVodThumbsByManagedStreams, getAppStats, getAppStatSeries,
    upsertAsset, getAssetById, listAssets, countAssets, deleteAsset,
    updateVodHealth, repairVodDuration, getVodsNeedingHealthScan, getQuarantinedVodsForCleanup,
    // clips
    createClip, getClipById, getClipByFileBasename, listClips, countClips, setClipVisibility, findDuplicateClip,
    // files
    createFile, getFileByKey, listFiles, deleteFileRow, appFilesBytes,
    // migration
};
