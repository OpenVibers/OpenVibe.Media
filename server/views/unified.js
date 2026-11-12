'use strict';

/**
 * OpenVibe.Media — the one view store for every content kind.
 *
 *   POST /api/v1/views   { events: [{ ref: { service, kind, id, site?, creator? }, how, seconds,
 *                                    of_seconds?, session? }, …] }   (up to 20)
 *   GET  /api/v1/views/counts?service=&kind=&id=  → { ref, counts }
 *        or ?refs=<JSON [{service,kind,id}]>      → { counts: { "service:kind:id": counts } }
 *   GET  /api/v1/views/aggregate?scope=item|creator|site&id=&days=&service=&kind=
 *
 * A view is one per person (or anonymous session) per item per 30 minutes. A preview counts from one second;
 * a watch or live heartbeat counts when playback started (seconds >= 1). Engagement is reached at 30 seconds or a
 * third of the item's length (whichever comes first) for a watch, or 60 seconds of a live stream — once per person
 * and item, ever. `seconds` is cumulative for the session and item: a retry, a seek or a heartbeat sends the same or
 * a larger number and never counts twice.
 *
 * Privacy: the item's counters keep no identifier. The actor table keeps a keyed hash of the person's canonical
 * subject or the anonymous session id; an IP address is used only for the rate limit and a user agent only to
 * refuse a declared crawler. Neither is stored, logged or put in an event.
 *
 * Events: `media.viewed` for each counted view and `media.engaged` for the first engagement, enqueued in the same
 * transaction through OpenVibe.Events (Contracts media.viewed@1 / media.engaged@1).
 */
const crypto = require('crypto');
const db = require('../db/database');
const events = require('../events');
const legacy = require('./service');
const { clientIp } = require('../client-ip');

const WINDOW_MS = 30 * 60_000;          // one view per person/session per item
const LIVE_WINDOW_MS = 90_000;          // a live viewer is "watching now" for this long
const MAX_BATCH = 20;
const MAX_SECONDS = 86_400;
const RATE_PER_MIN = 180;               // events per actor
const IP_RATE_PER_MIN = 600;            // events per address (protection, not a metric)
const BOT_UA = /bot\b|crawl|spider|slurp|facebookexternalhit|preview|discordbot|twitterbot|whatsapp|telegram|curl\/|wget\/|python-requests|go-http-client|headless|phantom|selenium/i;
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const KIND_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SESSION_RE = /^[A-Za-z0-9._~-]{8,128}$/;
const MEDIA_KINDS = new Set(['vod', 'clip', 'recording']);

const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** `service:kind:id` — one key across the store, the API and a feed's counts lookup. */
function keyOf(ref) { return `${ref.service}:${ref.kind}:${ref.id}`; }

/** Validate a ref. Returns { ok, ref, error }. */
function normalizeRef(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'ref.invalid' };
    const service = String(input.service || '');
    const kind = String(input.kind || '');
    const id = input.id == null ? '' : String(input.id);
    if (!SERVICE_RE.test(service)) return { ok: false, error: 'ref.service' };
    if (!KIND_RE.test(kind)) return { ok: false, error: 'ref.kind' };
    if (!id || id.length > 200) return { ok: false, error: 'ref.id' };
    const ref = { service, kind, id };
    if (input.site != null) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(String(input.site))) return { ok: false, error: 'ref.site' };
        ref.site = String(input.site);
    }
    if (input.creator != null) {
        if (String(input.creator).length > 200) return { ok: false, error: 'ref.creator' };
        ref.creator = String(input.creator);
    }
    return { ok: true, ref };
}

/** Validate one event. Returns { ok, event, error }. */
function normalizeEvent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'event.invalid' };
    const r = normalizeRef(input.ref);
    if (!r.ok) return r;
    const how = String(input.how || '');
    if (!['preview', 'watch', 'live'].includes(how)) return { ok: false, error: 'how' };
    const seconds = Number(input.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) return { ok: false, error: 'seconds' };
    const event = { ref: r.ref, how, seconds };
    if (input.of_seconds != null) {
        const of = Number(input.of_seconds);
        if (!Number.isFinite(of) || of <= 0 || of > MAX_SECONDS) return { ok: false, error: 'of_seconds' };
        event.of_seconds = of;
    }
    if (input.session != null) {
        if (!SESSION_RE.test(String(input.session))) return { ok: false, error: 'session' };
        event.session = String(input.session);
    }
    return { ok: true, event };
}

/** The seconds that make a watch engaged. */
function thresholdFor(how, ofSeconds) {
    if (how === 'live') return 60;
    if (Number.isFinite(ofSeconds) && ofSeconds > 0) return Math.max(1, Math.min(30, ofSeconds / 3));
    return 30;
}

// A keyed actor id: no raw anonymous session id and no raw canonical subject is stored with a view.
const _hashes = new Map();
async function actorHash(kind, value) {
    const cacheKey = `${kind}:${value}`;
    const kept = _hashes.get(cacheKey);
    if (kept) return kept;
    const secret = await legacy.hashSecret();
    const hash = crypto.createHmac('sha256', String(secret || '')).update(cacheKey).digest('hex').slice(0, 32);
    const out = `${kind === 'person' ? 'p' : 's'}:${hash}`;
    if (_hashes.size > 5000) _hashes.clear();
    _hashes.set(cacheKey, out);
    return out;
}

/** The actor for a request: the signed-in person's Network subject, else their anonymous session id. */
async function actorFor(req, session) {
    const auth = String(req.get('authorization') || '');
    if (/^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(auth)) {
        const subject = await require('../auth').viewerSubject(auth.slice(7));
        if (subject) return { actor: await actorHash('person', subject), person: true };
    }
    if (session) return { actor: await actorHash('session', session), person: false };
    return null;
}

// Per-actor and per-address event budgets in memory (a sliding minute). They protect the database; the counts
// themselves are deduped by the window.
const _hits = new Map();
function overBudget(map, key, limit, now) {
    const cut = now - 60_000;
    const arr = (map.get(key) || []).filter((t) => t > cut);
    if (arr.length >= limit) { map.set(key, arr); return true; }
    arr.push(now);
    map.set(key, arr);
    if (map.size > 5000) for (const [k, v] of map) if (!v.some((t) => t > cut)) map.delete(k);
    return false;
}

async function creatorOf(ref) {
    if (ref.creator) return ref.creator;
    if (ref.service !== 'media' || !MEDIA_KINDS.has(ref.kind)) return null;
    const table = ref.kind === 'clip' ? 'clips' : 'vods';
    try {
        const row = await db.get(`SELECT o.owner_subject AS creator FROM ${table} t JOIN media_objects o ON o.id = t.object_id WHERE t.id = ?`, [ref.id]);
        return row && row.creator ? String(row.creator) : null;
    } catch { return null; }
}

async function bumpCounts(ref, { counted, engaged, preview, livePeak, creator }) {
    const site = ref.site || ref.service;
    await db.run(`INSERT INTO content_view_counts (service, kind, item_id, site, creator_subject, views, engaged, previews, live_peak)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(service, kind, item_id) DO UPDATE SET
                views = content_view_counts.views + excluded.views,
                engaged = content_view_counts.engaged + excluded.engaged,
                previews = content_view_counts.previews + excluded.previews,
                site = COALESCE(content_view_counts.site, excluded.site),
                creator_subject = COALESCE(content_view_counts.creator_subject, excluded.creator_subject),
                live_peak = CASE WHEN excluded.live_peak IS NULL THEN content_view_counts.live_peak
                                 ELSE GREATEST(COALESCE(content_view_counts.live_peak, 0), excluded.live_peak) END,
                updated_at = ov_now()`,
    [ref.service, ref.kind, ref.id, site, creator, counted ? 1 : 0, engaged ? 1 : 0, counted && preview ? 1 : 0, livePeak == null ? null : livePeak]);
}

async function bumpDay(ref, { counted, engaged, preview, livePeak, creator }, ms) {
    if (!counted && !engaged && livePeak == null) return;
    const site = ref.site || ref.service;
    await db.run(`INSERT INTO content_view_days (service, kind, item_id, day, site, creator_subject, views, engaged, previews, live_peak)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(service, kind, item_id, day) DO UPDATE SET
                views = content_view_days.views + excluded.views,
                engaged = content_view_days.engaged + excluded.engaged,
                previews = content_view_days.previews + excluded.previews,
                site = COALESCE(content_view_days.site, excluded.site),
                creator_subject = COALESCE(content_view_days.creator_subject, excluded.creator_subject),
                live_peak = CASE WHEN excluded.live_peak IS NULL THEN content_view_days.live_peak
                                 ELSE GREATEST(COALESCE(content_view_days.live_peak, 0), excluded.live_peak) END`,
    [ref.service, ref.kind, ref.id, dayOf(ms), site, creator, counted ? 1 : 0, engaged ? 1 : 0,
        counted && preview ? 1 : 0, livePeak == null ? null : livePeak]);
}

/**
 * Record one normalized event for one actor. Runs in its own transaction so the counters and the event are one
 * change. → { counted, engaged, reason? }
 */
async function recordOne(event, actor, now = Date.now()) {
    const ref = event.ref;
    const how = event.how;
    const seconds = event.seconds;
    const preview = how === 'preview';
    const creator = await creatorOf(ref);
    const day = dayOf(now);
    return await db.getDb().tx(async () => {
        const prior = await db.get(
            'SELECT last_view_ms, watched_seconds, engaged_ms, live FROM content_view_actors WHERE service = ? AND kind = ? AND item_id = ? AND actor = ?',
            [ref.service, ref.kind, ref.id, actor]);
        const counted = seconds >= 1 && !(prior && prior.last_view_ms != null && now - Number(prior.last_view_ms) < WINDOW_MS);
        let engaged = false;
        const threshold = thresholdFor(how, event.of_seconds);
        const watched = Math.max(Number(prior && prior.watched_seconds) || 0, seconds);
        if (how !== 'preview' && seconds >= 1 && !(prior && prior.engaged_ms != null) && watched >= threshold) engaged = true;

        if (!counted && !engaged) {
            // Still remember that a live viewer is watching now (peak concurrency), and the cumulative seconds.
            if (how === 'live') {
                await db.run(`INSERT INTO content_view_actors (service, kind, item_id, actor, first_ms, last_view_ms, last_seen_ms, watched_seconds, live)
                        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, true)
                        ON CONFLICT(service, kind, item_id, actor) DO UPDATE SET last_seen_ms = excluded.last_seen_ms,
                            watched_seconds = GREATEST(content_view_actors.watched_seconds, excluded.watched_seconds), live = true`,
                [ref.service, ref.kind, ref.id, actor, now, now, watched]);
            } else {
                await db.run(`INSERT INTO content_view_actors (service, kind, item_id, actor, first_ms, last_seen_ms, watched_seconds)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(service, kind, item_id, actor) DO UPDATE SET last_seen_ms = excluded.last_seen_ms,
                            watched_seconds = GREATEST(content_view_actors.watched_seconds, excluded.watched_seconds)`,
                [ref.service, ref.kind, ref.id, actor, now, now, watched]);
            }
            return { counted: false, engaged: false, reason: seconds < 1 ? 'too-short' : 'window' };
        }

        let livePeak = null;
        await db.run(`INSERT INTO content_view_actors (service, kind, item_id, actor, first_ms, last_view_ms, last_seen_ms, watched_seconds, engaged_ms, live)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(service, kind, item_id, actor) DO UPDATE SET
                    last_view_ms = CASE WHEN ? THEN excluded.last_view_ms ELSE content_view_actors.last_view_ms END,
                    last_seen_ms = excluded.last_seen_ms,
                    watched_seconds = GREATEST(content_view_actors.watched_seconds, excluded.watched_seconds),
                    engaged_ms = COALESCE(content_view_actors.engaged_ms, excluded.engaged_ms),
                    live = excluded.live`,
        [ref.service, ref.kind, ref.id, actor, now, counted ? now : null, now, watched, engaged ? now : null, how === 'live' ? true : false, counted ? 1 : 0]);

        if (how === 'live') {
            const seen = await db.get(
                'SELECT COUNT(*) AS n FROM content_view_actors WHERE service = ? AND kind = ? AND item_id = ? AND live = true AND last_seen_ms >= ?',
                [ref.service, ref.kind, ref.id, now - LIVE_WINDOW_MS]);
            livePeak = Math.max(1, n(seen && seen.n));
        }

        await bumpCounts(ref, { counted, engaged, preview, livePeak, creator });
        await bumpDay(ref, { counted, engaged, preview, livePeak, creator }, now);

        const subject = { type: ref.kind, id: ref.id };
        if (counted) {
            await events.recordView('media.viewed', subject, {
                ref: { ...ref, site: ref.site || ref.service, creator },
                how,
                occurred_at: iso(now),
                seconds,
                of_seconds: event.of_seconds || null,
                concurrent: livePeak,
            });
        }
        if (engaged) {
            await events.recordView('media.engaged', subject, {
                ref: { ...ref, site: ref.site || ref.service, creator },
                how,
                occurred_at: iso(now),
                seconds: watched,
                threshold,
                of_seconds: event.of_seconds || null,
                concurrent: livePeak,
            });
        }
        return { counted, engaged, reason: counted || engaged ? undefined : 'window' };
    });
}

/**
 * Record a batch of raw events. → { results: [{ accepted, counted, engaged, reason? }], accepted, counted }
 * Invalid events are refused one by one; a caller never learns whether an item exists.
 */
async function record(rawEvents, { req, now = Date.now() } = {}) {
    const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    if (!list.length || list.length > MAX_BATCH) return { error: 'views.batch_size' };
    const ua = String((req && req.get('user-agent')) || '');
    const ip = req ? clientIp(req) : 'unknown';
    if (BOT_UA.test(ua)) return { results: list.map((raw) => ({ accepted: false, counted: false, engaged: false, reason: 'bot' })) };
    if (overBudget(_hits, `ip:${ip}`, IP_RATE_PER_MIN, now)) return { results: list.map(() => ({ accepted: false, counted: false, engaged: false, reason: 'rate-limited' })) };

    const results = [];
    for (const raw of list) {
        const v = normalizeEvent(raw);
        if (!v.ok) { results.push({ accepted: false, counted: false, engaged: false, reason: v.error }); continue; }
        const who = await actorFor(req, v.event.session);
        if (!who) { results.push({ accepted: false, counted: false, engaged: false, reason: 'session' }); continue; }
        if (overBudget(_hits, `actor:${who.actor}`, RATE_PER_MIN, now)) {
            results.push({ accepted: false, counted: false, engaged: false, reason: 'rate-limited' });
            continue;
        }
        try {
            const out = await recordOne(v.event, who.actor, now);
            results.push({ accepted: true, ...out });
        } catch (err) {
            console.warn('[Views] record failed:', err.message);
            results.push({ accepted: true, counted: false, engaged: false, reason: 'error' });
        }
    }
    return { results };
}

// ── Counts and aggregates ────────────────────────────────────

function countsOfRow(row) {
    if (!row) return { views: 0, engaged: 0, previews: 0, preview_share: null, peak_concurrent: null };
    const views = n(row.views);
    return {
        views,
        engaged: n(row.engaged),
        previews: n(row.previews),
        preview_share: views > 0 ? Math.round((n(row.previews) / views) * 1000) / 1000 : null,
        peak_concurrent: row.live_peak == null ? null : n(row.live_peak),
    };
}

async function countsFor(ref) {
    const row = await db.get(
        'SELECT views, engaged, previews, live_peak FROM content_view_counts WHERE service = ? AND kind = ? AND item_id = ?',
        [ref.service, ref.kind, ref.id]);
    return countsOfRow(row);
}

async function countsMany(refs) {
    const out = {};
    const groups = new Map();
    for (const ref of refs) {
        const k = `${ref.service}\u0000${ref.kind}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(ref);
    }
    for (const [k, list] of groups) {
        const [service, kind] = k.split('\u0000');
        const ids = [...new Set(list.map((r) => r.id))];
        for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            const rows = await db.all(
                `SELECT item_id, views, engaged, previews, live_peak FROM content_view_counts
                 WHERE service = ? AND kind = ? AND item_id IN (${chunk.map(() => '?').join(',')})`,
                [service, kind, ...chunk]);
            const found = new Map(rows.map((r) => [String(r.item_id), r]));
            for (const id of chunk) out[`${service}:${kind}:${id}`] = countsOfRow(found.get(String(id)));
        }
    }
    return out;
}

/**
 * Report's read: per item, per creator or per site, over a window. → { scope, id, days, from, to, rows, totals }
 * A row is { id, service?, kind?, item_id?, site, creator, views, engaged, previews, preview_share, peak_concurrent }.
 */
async function aggregate({ scope = 'item', id = null, days = 30, service = null, kind = null, limit = 100 } = {}) {
    if (!['item', 'creator', 'site'].includes(scope)) return { error: 'views.scope' };
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const to = dayOf(Date.now());
    const from = dayOf(Date.now() - (d - 1) * 86_400_000);
    const where = ['day >= ?', 'day <= ?'];
    const params = [from, to];
    if (scope === 'creator') { where.push('creator_subject = ?'); params.push(String(id || '')); }
    if (scope === 'site') { where.push('site = ?'); params.push(String(id || '')); }
    if (scope === 'item') {
        where.push('service = ?', 'kind = ?', 'item_id = ?');
        params.push(String(service || ''), String(kind || ''), String(id || ''));
    }
    const group = scope === 'item' ? 'service, kind, item_id' : scope === 'creator' ? 'creator_subject' : 'site';
    const select = scope === 'item'
        ? 'service, kind, item_id, MAX(site) AS site, MAX(creator_subject) AS creator'
        : scope === 'creator' ? 'creator_subject, MAX(site) AS site, MAX(creator_subject) AS creator' : 'site, MAX(creator_subject) AS creator';
    const rows = await db.all(
        `SELECT ${select},
                SUM(views)::bigint AS views, SUM(engaged)::bigint AS engaged, SUM(previews)::bigint AS previews,
                MAX(live_peak) AS live_peak
         FROM content_view_days WHERE ${where.join(' AND ')}
         GROUP BY ${group} ORDER BY views DESC, ${group} ASC LIMIT ?`,
        [...params, Math.max(1, Math.min(500, parseInt(limit, 10) || 100))]);
    const out = rows.map((r) => {
        const views = n(r.views);
        const base = {
            id: scope === 'item' ? `${r.service}:${r.kind}:${r.item_id}` : scope === 'creator' ? (r.creator_subject || null) : r.site,
            site: r.site || null,
            creator: r.creator || null,
            views,
            engaged: n(r.engaged),
            previews: n(r.previews),
            preview_share: views > 0 ? Math.round((n(r.previews) / views) * 1000) / 1000 : null,
            peak_concurrent: r.live_peak == null ? null : n(r.live_peak),
        };
        if (scope === 'item') { base.service = r.service; base.kind = r.kind; base.item_id = r.item_id; }
        return base;
    });
    const totals = {
        views: out.reduce((a, r) => a + r.views, 0),
        engaged: out.reduce((a, r) => a + r.engaged, 0),
        previews: out.reduce((a, r) => a + r.previews, 0),
        peak_concurrent: out.reduce((a, r) => (r.peak_concurrent != null ? Math.max(a, r.peak_concurrent) : a), 0) || null,
    };
    totals.preview_share = totals.views > 0 ? Math.round((totals.previews / totals.views) * 1000) / 1000 : null;
    return { scope, id: id || null, days: d, from, to, rows: out, totals };
}

/** The legacy /v /c visit counter adds to the same total, so a page's number never splits in two. */
async function addLegacyView(type, id) {
    const kind = type === 'clip' ? 'clip' : type === 'file' ? 'file' : 'vod';
    const ref = { service: 'media', kind, id: String(id) };
    const now = Date.now();
    try {
        const creator = await creatorOf(ref);
        await bumpCounts(ref, { counted: true, engaged: false, preview: false, livePeak: null, creator });
        await bumpDay(ref, { counted: true, engaged: false, preview: false, livePeak: null, creator }, now);
    } catch { /* a page view that is not stored is not an error */ }
}

/** Forget the 30-minute windows (kept small; the totals and the engagement stay). */
async function prune(days = 30) {
    try {
        return (await db.run('DELETE FROM content_view_actors WHERE first_ms < ?', [Date.now() - days * 86_400_000])).changes;
    } catch { return 0; }
}

module.exports = {
    record, normalizeEvent, normalizeRef, countsFor, countsMany, countsOfRow, aggregate, addLegacyView, prune,
    thresholdFor, keyOf, MAX_BATCH, WINDOW_MS, LIVE_WINDOW_MS,
    _internals: { actorHash, overBudget, _hits },
};
