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
async function secret() {
    if (_secret) return _secret;
    _secret = process.env.VIEW_HASH_SECRET || process.env.MEDIA_SECRET || '';
    if (!_secret && process.env.NODE_ENV === 'production') {
        // Hashes already on disk were derived from the old secret; without it they can never match again.
        // Never the value, only the name.
        console.warn('[views] VIEW_HASH_SECRET and MEDIA_SECRET are unset in production; visitor hashes fall back to the persisted per-process secret and past hashes stop matching.');
    }
    if (!_secret) {
        // Persist a random secret so visitor hashes stay stable across restarts.
        try {
            const row = await db.get("SELECT value FROM media_settings WHERE key = 'view_hash_secret'");
            if (row && row.value) _secret = row.value;
            else { _secret = crypto.randomBytes(24).toString('hex'); await db.run("INSERT INTO media_settings (key, value, description, type) VALUES ('view_hash_secret', ?, 'Internal: salt for hashed visitor ids (do not share)', 'string') ON CONFLICT (key) DO UPDATE SET value = excluded.value, description = excluded.description, type = excluded.type, updated_at = ov_now()", [_secret]); }
        } catch { _secret = 'openvibe-media'; }
    }
    return _secret;
}
async function cooldownSec() { const v = parseInt(await db.getSetting('view_cooldown_sec'), 10); return Number.isFinite(v) && v >= 0 ? v : 6 * 3600; }
async function rateLimitPerMin() { const v = parseInt(await db.getSetting('view_ip_events_per_min'), 10); return Number.isFinite(v) && v > 0 ? v : 60; }


// req.ip under 'trust proxy' = loopback (server/client-ip.js): the forwarding headers count only
// when the local proxy sent them, so a direct caller cannot pose as many visitors.
const { clientIp } = require('../client-ip');
async function visitorForIp(ip) { return 'ip:' + crypto.createHmac('sha256', await secret()).update(String(ip || 'unknown')).digest('hex').slice(0, 24); }

// Per-IP event budget (sliding minute), in memory — protects the DB from a spammer, not a metric.
const _ipEvents = new Map(); // ip → [timestamps]
async function _overBudget(ip) {
    const now = Date.now(); const cut = now - 60000;
    let arr = _ipEvents.get(ip) || [];
    arr = arr.filter(t => t > cut);
    if (arr.length >= await rateLimitPerMin()) { _ipEvents.set(ip, arr); return true; }
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
async function recordView(type, id, o = {}) {
    const t = TABLES[type];
    if (!t || !id) return { counted: false, unique: false, reason: 'bad-type' };
    const req = o.req || null;
    const ip = o.ip || (req ? clientIp(req) : 'unknown');
    const ua = o.userAgent || (req && req.headers['user-agent']) || '';
    const userId = o.userId != null ? o.userId : (req && req.userId != null ? req.userId : null);
    if (userId != null && o.ownerUserId != null && String(userId) === String(o.ownerUserId)) return { counted: false, unique: false, reason: 'owner' };
    if (BOT_UA.test(ua)) return { counted: false, unique: false, reason: 'bot' };
    if (await _overBudget(ip)) return { counted: false, unique: false, reason: 'rate-limited' };
    const visitor = userId != null ? `u:${userId}` : await visitorForIp(ip);
    const cd = await cooldownSec();
    try {
        const row = await db.get('SELECT last_at, visits FROM content_visits WHERE content_type = ? AND content_id = ? AND visitor = ?', [type, id, visitor]);
        if (!row) {
            await db.run('INSERT INTO content_visits (content_type, content_id, visitor) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [type, id, visitor]);
            await db.run(`UPDATE ${t.table} SET ${t.raw} = COALESCE(${t.raw},0) + 1, unique_views = COALESCE(unique_views,0) + 1 WHERE id = ?`, [id]);
            return { counted: true, unique: true, ...await counts(type, id) };
        }
        const lastMs = new Date(String(row.last_at).replace(' ', 'T') + 'Z').getTime();
        if (cd > 0 && Date.now() - lastMs < cd * 1000) return { counted: false, unique: false, reason: 'cooldown', ...await counts(type, id) };
        await db.run('UPDATE content_visits SET last_at = ov_now(), visits = visits + 1 WHERE content_type = ? AND content_id = ? AND visitor = ?', [type, id, visitor]);
        await db.run(`UPDATE ${t.table} SET ${t.raw} = COALESCE(${t.raw},0) + 1 WHERE id = ?`, [id]);
        return { counted: true, unique: false, ...await counts(type, id) };
    } catch (e) {
        console.warn('[Views] record failed:', e.message);
        return { counted: false, unique: false, reason: 'error' };
    }
}

async function counts(type, id) {
    const t = TABLES[type]; if (!t) return {};
    const r = await db.get(`SELECT COALESCE(${t.raw},0) AS view_count, COALESCE(unique_views,0) AS unique_views FROM ${t.table} WHERE id = ?`, [id]);
    return r || { view_count: 0, unique_views: 0 };
}
async function countsMany(type, ids) {
    const t = TABLES[type]; if (!t || !ids.length) return {};
    const rows = await db.all(`SELECT id, COALESCE(${t.raw},0) AS view_count, COALESCE(unique_views,0) AS unique_views FROM ${t.table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
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
async function prune(days = 30) {
    try { return (await db.run("DELETE FROM content_visits WHERE last_at < datetime('now', ?)", [`-${days} days`])).changes; } catch { return 0; }
}

module.exports = { recordView, counts, countsMany, isInitialPlaybackRequest, clientIp, prune, TABLES };
