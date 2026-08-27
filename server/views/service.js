/**
 * OpenVibe.Media — view counting (owned here for every app and every content type).
 *
 * Two numbers per item, both maintained by this module:
 *   view_count    "views": one per VISIT. A visitor (logged-in user id, else a keyed hash of
 *                 the client IP — raw IPs are never stored) counts again only after the
 *                 cooldown window (media_settings.view_cooldown_sec, default 6h). Refresh
 *                 spam, seeking (range requests) and reloads inside the window count once.
 *   unique_views  distinct visitors, ever.
 *
 * Also: the owner's own views never count; obvious bots/crawlers are ignored; a single IP
 * firing view events at an absurd rate (any content) is dropped after a per-minute budget.
 *
 * Entry points: recordView() from Media's own public routes (/v /c /p) and from the
 * app-facing API (POST /api/v1/:app/views) that Live/Tools call for pages they render.
 */
'use strict';
const crypto = require('crypto');
const db = require('../db/database');

const TABLES = { vod: { table: 'vods', raw: 'view_count' }, clip: { table: 'clips', raw: 'view_count' }, paste: { table: 'pastes', raw: 'views' }, file: { table: 'files', raw: 'view_count' } };
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview|discordbot|twitterbot|whatsapp|telegram|curl\/|wget\/|python-requests|go-http-client|headless/i;

let _secret = null;
function secret() {
    if (_secret) return _secret;
    _secret = process.env.VIEW_HASH_SECRET || process.env.MEDIA_SECRET || process.env.INTERNAL_API_KEY || '';
    if (!_secret) {
        // Persist a random secret so visitor hashes stay stable across restarts.
        try {
            const row = db.get("SELECT value FROM media_settings WHERE key = 'view_hash_secret'");
            if (row && row.value) _secret = row.value;
            else { _secret = crypto.randomBytes(24).toString('hex'); db.run("INSERT OR REPLACE INTO media_settings (key, value, description, type) VALUES ('view_hash_secret', ?, 'Internal: salt for hashed visitor ids (do not share)', 'string')", [_secret]); }
        } catch { _secret = 'openvibe-media'; }
    }
    return _secret;
}
function cooldownSec() { const v = parseInt(db.getSetting('view_cooldown_sec'), 10); return Number.isFinite(v) && v >= 0 ? v : 6 * 3600; }
function rateLimitPerMin() { const v = parseInt(db.getSetting('view_ip_events_per_min'), 10); return Number.isFinite(v) && v > 0 ? v : 60; }

function ensureSchema() {
    db.getDb().exec(`
        CREATE TABLE IF NOT EXISTS content_visits (
            content_type TEXT NOT NULL,          -- vod | clip | paste | file
            content_id INTEGER NOT NULL,
            visitor TEXT NOT NULL,               -- 'u:<userId>' or 'ip:<hmac>'
            first_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            visits INTEGER DEFAULT 1,
            PRIMARY KEY (content_type, content_id, visitor)
        );
        CREATE INDEX IF NOT EXISTS idx_content_visits_item ON content_visits(content_type, content_id);
        CREATE INDEX IF NOT EXISTS idx_content_visits_last ON content_visits(last_at);
    `);
    for (const [, t] of Object.entries(TABLES)) {
        try {
            const cols = db.getDb().prepare(`PRAGMA table_info(${t.table})`).all().map(c => c.name);
            if (!cols.length) continue;                       // table absent in this deployment
            if (!cols.includes('unique_views')) db.getDb().exec(`ALTER TABLE ${t.table} ADD COLUMN unique_views INTEGER DEFAULT 0`);
            if (!cols.includes(t.raw)) db.getDb().exec(`ALTER TABLE ${t.table} ADD COLUMN ${t.raw} INTEGER DEFAULT 0`);
        } catch (e) { console.warn(`[Views] ${t.table} columns:`, e.message); }
    }
    // One-time import of the legacy unique-IP table (raw IPs → hashed visitors) so existing
    // counts survive; view_count on vods/clips already equals the unique count, so seed
    // unique_views from it and leave view_count as the (identical) starting point.
    try {
        const done = db.get("SELECT value FROM media_settings WHERE key = 'views_migrated_v2'");
        if (!done) {
            const rows = db.all('SELECT content_type, content_id, ip, created_at FROM content_views');
            const ins = db.getDb().prepare('INSERT OR IGNORE INTO content_visits (content_type, content_id, visitor, first_at, last_at, visits) VALUES (?, ?, ?, ?, ?, 1)');
            const tx = db.getDb().transaction(() => { for (const r of rows) ins.run(r.content_type, r.content_id, visitorForIp(r.ip), r.created_at, r.created_at); });
            tx();
            db.run('UPDATE vods SET unique_views = (SELECT COUNT(*) FROM content_visits v WHERE v.content_type = \'vod\' AND v.content_id = vods.id)');
            db.run('UPDATE clips SET unique_views = (SELECT COUNT(*) FROM content_visits v WHERE v.content_type = \'clip\' AND v.content_id = clips.id)');
            db.run('UPDATE vods SET view_count = MAX(COALESCE(view_count,0), unique_views)');
            db.run('UPDATE clips SET view_count = MAX(COALESCE(view_count,0), unique_views)');
            db.run("INSERT OR REPLACE INTO media_settings (key, value, description, type) VALUES ('views_migrated_v2', '1', 'Internal: legacy content_views imported', 'boolean')");
            console.log(`[Views] imported ${rows.length} legacy unique-view row(s)`);
        }
    } catch (e) { console.warn('[Views] legacy import:', e.message); }
    try {
        const seed = db.getDb().prepare('INSERT OR IGNORE INTO media_settings (key, value, description, type) VALUES (?, ?, ?, ?)');
        seed.run('view_cooldown_sec', '21600', 'A visitor counts as a new view of the same item only after this many seconds (anti refresh-spam). 0 = every visit', 'number');
        seed.run('view_ip_events_per_min', '60', 'Drop view events from an IP that fires more than this many per minute (across all content)', 'number');
    } catch { /* */ }
}

function clientIp(req) {
    return (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').toString();
}
function visitorForIp(ip) { return 'ip:' + crypto.createHmac('sha256', secret()).update(String(ip || 'unknown')).digest('hex').slice(0, 24); }

// Per-IP event budget (sliding minute), in memory — protects the DB from a spammer, not a metric.
const _ipEvents = new Map(); // ip → [timestamps]
function _overBudget(ip) {
    const now = Date.now(); const cut = now - 60000;
    let arr = _ipEvents.get(ip) || [];
    arr = arr.filter(t => t > cut);
    if (arr.length >= rateLimitPerMin()) { _ipEvents.set(ip, arr); return true; }
    arr.push(now); _ipEvents.set(ip, arr);
    if (_ipEvents.size > 5000) for (const [k, v] of _ipEvents) if (!v.some(t => t > cut)) _ipEvents.delete(k);
    return false;
}

/**
 * Record a view.
 * @param {'vod'|'clip'|'paste'|'file'} type
 * @param {number} id
 * @param {object} o { req?, ip?, userId?, ownerUserId?, userAgent? }
 * @returns {{ counted:boolean, unique:boolean, reason?:string, view_count?:number, unique_views?:number }}
 */
function recordView(type, id, o = {}) {
    const t = TABLES[type];
    if (!t || !id) return { counted: false, unique: false, reason: 'bad-type' };
    const req = o.req || null;
    const ip = o.ip || (req ? clientIp(req) : 'unknown');
    const ua = o.userAgent || (req && req.headers['user-agent']) || '';
    const userId = o.userId != null ? o.userId : (req && req.userId != null ? req.userId : null);
    if (userId != null && o.ownerUserId != null && String(userId) === String(o.ownerUserId)) return { counted: false, unique: false, reason: 'owner' };
    if (BOT_UA.test(ua)) return { counted: false, unique: false, reason: 'bot' };
    if (_overBudget(ip)) return { counted: false, unique: false, reason: 'rate-limited' };
    const visitor = userId != null ? `u:${userId}` : visitorForIp(ip);
    const cd = cooldownSec();
    try {
        const row = db.get('SELECT last_at, visits FROM content_visits WHERE content_type = ? AND content_id = ? AND visitor = ?', [type, id, visitor]);
        if (!row) {
            db.run('INSERT OR IGNORE INTO content_visits (content_type, content_id, visitor) VALUES (?, ?, ?)', [type, id, visitor]);
            db.run(`UPDATE ${t.table} SET ${t.raw} = COALESCE(${t.raw},0) + 1, unique_views = COALESCE(unique_views,0) + 1 WHERE id = ?`, [id]);
            return { counted: true, unique: true, ...counts(type, id) };
        }
        const lastMs = new Date(String(row.last_at).replace(' ', 'T') + 'Z').getTime();
        if (cd > 0 && Date.now() - lastMs < cd * 1000) return { counted: false, unique: false, reason: 'cooldown', ...counts(type, id) };
        db.run('UPDATE content_visits SET last_at = CURRENT_TIMESTAMP, visits = visits + 1 WHERE content_type = ? AND content_id = ? AND visitor = ?', [type, id, visitor]);
        db.run(`UPDATE ${t.table} SET ${t.raw} = COALESCE(${t.raw},0) + 1 WHERE id = ?`, [id]);
        return { counted: true, unique: false, ...counts(type, id) };
    } catch (e) {
        console.warn('[Views] record failed:', e.message);
        return { counted: false, unique: false, reason: 'error' };
    }
}

function counts(type, id) {
    const t = TABLES[type]; if (!t) return {};
    const r = db.get(`SELECT COALESCE(${t.raw},0) AS view_count, COALESCE(unique_views,0) AS unique_views FROM ${t.table} WHERE id = ?`, [id]);
    return r || { view_count: 0, unique_views: 0 };
}
function countsMany(type, ids) {
    const t = TABLES[type]; if (!t || !ids.length) return {};
    const rows = db.all(`SELECT id, COALESCE(${t.raw},0) AS view_count, COALESCE(unique_views,0) AS unique_views FROM ${t.table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const out = {}; for (const r of rows) out[r.id] = { view_count: r.view_count, unique_views: r.unique_views };
    return out;
}

/** Playback requests: only the first byte-range of a session should count. */
function isInitialPlaybackRequest(req) {
    if (req.method !== 'GET') return false;
    const range = req.headers.range;
    return !range || /^bytes=0-/.test(String(range));
}

/** Old visit rows are only needed for the cooldown; keep the table small (uniques stay in the counters). */
function prune(days = 30) {
    try { return db.run("DELETE FROM content_visits WHERE last_at < datetime('now', ?)", [`-${days} days`]).changes; } catch { return 0; }
}

module.exports = { ensureSchema, recordView, counts, countsMany, isInitialPlaybackRequest, clientIp, prune, TABLES };
