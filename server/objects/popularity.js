/**
 * OpenVibe.Media — popularity of native v2 objects, counted without identifying anyone (roadmap WS-G task 11;
 * ADR-021; docs/object-model.md#tiering-of-native-objects).
 *
 *   record(obj, req)        GET /o/:id: the request's viewer counts once per object per UTC day
 *   stats({ ids, days })    unique viewers per object over the last `days` UTC days (today included)
 *   rotate()                the hashes and the salt of every finished day are deleted; counts past 30 days too
 *
 * A viewer is the client's network: req.ip (server/client-ip.js: the address nginx saw, never a header a
 * direct caller sends), an IPv6 address reduced to its /64. It is never stored. A row holds HMAC-SHA256(salt
 * of the day, network), 16 hex characters (media_object_viewer_days), and the salt is 32 random bytes per UTC
 * day (media_object_view_salts). Once the day is over, rotate() deletes that day's hashes and its salt: from
 * then on nothing links a count to an address, not even with the database and every secret. What stays is one
 * count per object and day (media_object_views_daily: unique_viewers, last_viewed_at), for 30 days. The same
 * network on two days is two viewer-days, so the 7-day figure is the sum of seven daily counts. One address
 * is one viewer: people behind one NAT count once (the conservative side), and changing the user agent does
 * not make a client count again.
 *
 * Not counted: HEAD and range requests past the first byte (a player's seeks), requests with Sec-GPC: 1 or
 * DNT: 1 (openvibe-shared/analytics privacy.optedOut: no hash is made at all), crawlers and clients without a
 * user agent (privacy.classifyRequest). Projected objects (vods, clips, files) keep their own view counts
 * (server/views/service.js). Nothing runs at load; a restore drill never reaches record() (/o answers 503
 * first) and never rotates.
 */
'use strict';

const crypto = require('crypto');
const net = require('net');
const db = require('../db/database');
const { privacy } = require('openvibe-shared/analytics');
const { clientIp } = require('../client-ip');

const WINDOW_DAYS = 7;          // the rolling window the tiering policy reads
const KEEP_DAYS = 30;           // daily counts are kept this long (ADR-021's bound for raw analytics, applied to the counts too)
const SEEN_MAX = 200000;        // in-memory "already counted today" keys before the set starts over

/** YYYY-MM-DD (UTC) of an epoch-ms time. */
function dayOf(ms = Date.now()) {
    return new Date(ms).toISOString().slice(0, 10);
}

/** The day `n` days after `day` (negative: before). */
function addDays(day, n) {
    return dayOf(Date.parse(`${day}T00:00:00Z`) + n * 864e5);
}

/** The first day of the `days`-day window that ends on (and includes) `today`. */
function windowStart(today, days = WINDOW_DAYS) {
    return addDays(today, -(Math.max(1, Number(days) || 1) - 1));
}

/** The network a viewer is counted as: an IPv4 address (also when IPv4-mapped), or the /64 of an IPv6 address. */
function networkOf(ip) {
    let s = String(ip || '').trim().toLowerCase();
    if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
    if (net.isIPv4(s)) return s;
    s = s.split('%')[0];
    if (!net.isIPv6(s)) return s || 'unknown';
    const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    // An embedded IPv4 tail stands for two groups; only the first four groups are kept, which it never reaches.
    const groups = [...h, ...(tail === null ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0')), ...t];
    return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

// ── The salt of the day ──────────────────────────────────────

let _saltDay = null, _salt = null;

/** The day's random salt: read, or made by the first view of the day (a racing writer keeps the first). */
function daySalt(day) {
    if (_saltDay === day && _salt) return _salt;
    let row = db.get('SELECT salt FROM media_object_view_salts WHERE day = ?', [day]);
    if (!row) {
        db.run('INSERT OR IGNORE INTO media_object_view_salts (day, salt) VALUES (?, ?)', [day, crypto.randomBytes(32).toString('hex')]);
        row = db.get('SELECT salt FROM media_object_view_salts WHERE day = ?', [day]);
    }
    _saltDay = day;
    _salt = row.salt;
    return _salt;
}

/** The stored form of a viewer on one day: 16 hex chars of HMAC-SHA256(salt of the day, network). */
function viewerHash(network, day) {
    return crypto.createHmac('sha256', daySalt(day)).update(String(network)).digest('hex').slice(0, 16);
}

// ── Recording ────────────────────────────────────────────────

let _day = null;
const _seen = new Set();        // `${object}|${viewer}` counted today in this process: no write for a repeat

/** Why this request is not counted, or null when it is a view. */
function notCounted(req) {
    if (!req || req.method !== 'GET') return 'method';
    const range = req.headers && req.headers.range;
    if (range && !/^bytes=0-/.test(String(range))) return 'range';
    if (privacy.optedOut(req.headers)) return 'opted_out';
    if (privacy.classifyRequest(req).isBot) return 'bot';
    return null;
}

/**
 * Count the request's viewer for a native object (legacy_ref NULL), at most once per UTC day. Never throws.
 * → { counted, reason } (reason: not_native, method, range, opted_out, bot, seen, error; null when counted)
 */
function record(obj, req, { now = Date.now() } = {}) {
    try {
        if (!obj || !obj.id || obj.legacy_ref) return { counted: false, reason: 'not_native' };
        const why = notCounted(req);
        if (why) return { counted: false, reason: why };
        const day = dayOf(now);
        if (day !== _day) {
            // The first view of a new day: yesterday's hashes and salt go now (the hourly rotation would too).
            _day = day;
            _seen.clear();
            rotate({ now });
        }
        const viewer = viewerHash(networkOf(clientIp(req)), day);
        const seenKey = `${obj.id}|${viewer}`;
        if (_seen.has(seenKey)) return { counted: false, reason: 'seen' };
        const at = new Date(now).toISOString();
        const added = db.getDb().transaction(() => {
            const r = db.run('INSERT OR IGNORE INTO media_object_viewer_days (day, object_id, viewer) VALUES (?, ?, ?)', [day, obj.id, viewer]);
            if (!r.changes) return false;
            db.run(`INSERT INTO media_object_views_daily (object_id, day, unique_viewers, last_viewed_at) VALUES (?, ?, 1, ?)
                    ON CONFLICT(object_id, day) DO UPDATE SET unique_viewers = unique_viewers + 1, last_viewed_at = excluded.last_viewed_at`, [obj.id, day, at]);
            return true;
        })();
        if (_seen.size >= SEEN_MAX) _seen.clear();
        _seen.add(seenKey);
        return { counted: added, reason: added ? null : 'seen' };
    } catch (err) {
        console.warn('[Popularity] view not recorded:', err.message);
        return { counted: false, reason: 'error' };
    }
}

/**
 * Delete what must not outlive its day: every viewer hash and salt of a day before today, and daily counts
 * older than KEEP_DAYS. → { hashes, salts, counts } (rows deleted)
 */
function rotate({ now = Date.now() } = {}) {
    const today = dayOf(now);
    const out = db.getDb().transaction(() => ({
        hashes: db.run('DELETE FROM media_object_viewer_days WHERE day < ?', [today]).changes,
        salts: db.run('DELETE FROM media_object_view_salts WHERE day < ?', [today]).changes,
        counts: db.run('DELETE FROM media_object_views_daily WHERE day < ?', [addDays(today, -KEEP_DAYS)]).changes,
    }))();
    if (_saltDay && _saltDay < today) { _saltDay = null; _salt = null; }
    return out;
}

/**
 * Unique viewers over the last `days` UTC days (today included), per object: Map(object_id → { unique_viewers,
 * last_viewed_day, last_viewed_at, days_viewed }). `ids` narrows it (else every object with a view in the window).
 */
function stats({ ids = null, days = WINDOW_DAYS, now = Date.now() } = {}) {
    const since = windowStart(dayOf(now), days);
    const list = ids == null ? null : [].concat(ids).filter(Boolean);
    if (list && !list.length) return new Map();
    const rows = db.all(`SELECT object_id, SUM(unique_viewers) AS viewers, MAX(day) AS last_day, MAX(last_viewed_at) AS last_at, COUNT(*) AS days
                         FROM media_object_views_daily WHERE day >= ?${list ? ` AND object_id IN (${list.map(() => '?').join(',')})` : ''}
                         GROUP BY object_id`, [since, ...(list || [])]);
    return new Map(rows.map((r) => [r.object_id, { unique_viewers: r.viewers, last_viewed_day: r.last_day, last_viewed_at: r.last_at, days_viewed: r.days }]));
}

/** The last day anyone viewed the object (in the kept counts), or null. */
function lastViewedDay(objectId) {
    const r = db.get('SELECT MAX(day) AS d FROM media_object_views_daily WHERE object_id = ? AND unique_viewers > 0', [objectId]);
    return (r && r.d) || null;
}

/** Test hook: forget the in-memory day, salt and repeats (as a restart would). */
function _reset() {
    _day = null; _seen.clear(); _saltDay = null; _salt = null;
}

module.exports = { WINDOW_DAYS, KEEP_DAYS, dayOf, addDays, windowStart, networkOf, viewerHash, record, rotate, stats, lastViewedDay, _reset };
