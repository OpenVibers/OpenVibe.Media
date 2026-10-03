'use strict';
/**
 * Demand rollups (F2.4, docs/media-fabric.md §6, §8): reads per object × region × 5-minute bucket, folded into
 * Valkey counters plus one hot sorted set per region and bucket, with an in-process fallback when Valkey is off.
 * Valkey is never authoritative (ADR-007): a lost counter only delays a promotion, never loses bytes, and a slow
 * or absent Valkey never delays or fails a read (record() is fire-and-forget).
 *
 * Keys (inside the service prefix, VALKEY_PREFIX=ov:media:):
 *   demand:<region>:<bucket>:<object_id>   counter, one per served read                     TTL KEY_TTL_S
 *   hot:<region>:<bucket>                  sorted set, object_id -> reads in that bucket    TTL KEY_TTL_S
 *   hot-announced:<region>:<object_id>     media.object.hot staged within the hour (NX)     TTL ANNOUNCE_S
 * <bucket> = floor(epoch_ms / BUCKET_MS). The region is one per deployment (MEDIA_DEMAND_REGION, default 'local');
 * a per-viewer region needs an edge-provided header that does not exist yet.
 *
 * Not yet read by the sweep's eligibility (that stays on the daily PostgreSQL counts, objects/popularity.js, until
 * F2.5): the sweep only calls rollup(), which stages media.object.hot for objects over HOT_READS in the window.
 */
const config = require('../config');

const BUCKET_MS = 5 * 60 * 1000;    // the design's video bucket
const WINDOW_BUCKETS = 12;          // one hour of buckets hotness() and rollup() read
const KEY_TTL_S = 2 * 3600;         // longer than the window, so a slow sweep still reads a full hour
const TOP_N = 500;                  // in-process sorted set cap per bucket; most objects one rollup announces
const HOT_READS = 100;              // reads in the window that make an object hot
const ANNOUNCE_S = 3600;            // media.object.hot at most once per object per hour
const READ_TIMEOUT_MS = 2000;       // a rollup read never waits on a stuck Valkey longer than this
const FALLBACK_MAX = 50000;         // in-process counters before expired ones are pruned on write

let vk = null;                      // openvibe-sdk/valkey handle, or null: count in this process
const counters = new Map();         // fallback: counter key -> { n, expiresAt }
const sets = new Map();             // fallback: hot key -> { members: Map(object_id -> n), expiresAt }
const announced = new Map();        // fallback: announce key -> expiresAt

function useValkey(handle) { vk = handle && handle.client ? handle : null; }
function region() { return String((config.demand && config.demand.region) || 'local').replace(/[^A-Za-z0-9_.-]/g, '_') || 'local'; }
function bucketOf(now = Date.now()) { return Math.floor(now / BUCKET_MS); }
const name = (...parts) => (vk ? vk.key(...parts) : parts.join(':'));
function counterKey(r, b, id) { return name('demand', r, String(b), String(id)); }
function hotKey(r, b) { return name('hot', r, String(b)); }
function announceKey(r, id) { return name('hot-announced', r, String(id)); }
const windowOf = (now, buckets) => Array.from({ length: buckets }, (_, i) => bucketOf(now) - i);
const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); return p; };
const timed = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('valkey read timeout')), READ_TIMEOUT_MS).unref())]);

function pruneFallback(now = Date.now()) {
    for (const [k, c] of counters) if (c.expiresAt <= now) counters.delete(k);
    for (const [k, s] of sets) if (s.expiresAt <= now) sets.delete(k);
    for (const [k, at] of announced) if (at <= now) announced.delete(k);
}

/** One served read of an object. Best-effort: never throws, never awaits Valkey. */
function record({ objectId, region: r = region(), now = Date.now() } = {}) {
    if (objectId == null || objectId === '') return;
    const id = String(objectId), b = bucketOf(now);
    try {
        if (vk) {
            const ck = counterKey(r, b, id), hk = hotKey(r, b);
            quiet(vk.client.incr(ck).then((n) => (n === 1 ? vk.client.expire(ck, KEY_TTL_S) : null)));
            quiet(vk.client.zincrby(hk, 1, id).then((n) => (Number(n) === 1 ? vk.client.expire(hk, KEY_TTL_S) : null)));
            return;
        }
        const expiresAt = now + KEY_TTL_S * 1000;
        if (counters.size >= FALLBACK_MAX) pruneFallback(now);
        const ck = counterKey(r, b, id);
        const c = counters.get(ck) || { n: 0, expiresAt };
        c.n++;
        counters.set(ck, c);
        const hk = hotKey(r, b);
        const s = sets.get(hk) || { members: new Map(), expiresAt };
        s.members.set(id, (s.members.get(id) || 0) + 1);
        if (s.members.size > TOP_N) {
            let lo = null;
            for (const e of s.members) if (e[0] !== id && (!lo || e[1] < lo[1])) lo = e;
            if (lo) s.members.delete(lo[0]);
        }
        sets.set(hk, s);
    } catch { /* demand is a hint */ }
}

/**
 * Reads per object over the last `buckets` buckets (summed), newest bucket included. With `objectIds`, the counters
 * of those objects (all of them, zero when unread); without, every object in the region's hot sets.
 * A Valkey error answers an empty map: demand is a hint. → Map(object_id -> reads)
 */
async function hotness({ region: r = region(), now = Date.now(), buckets = WINDOW_BUCKETS, objectIds = null } = {}) {
    const out = new Map();
    const window = windowOf(now, buckets);
    const ids = objectIds ? [...new Set(objectIds.filter((x) => x != null).map(String))] : null;
    if (ids) for (const id of ids) out.set(id, 0);
    try {
        if (vk) {
            if (ids) {
                if (!ids.length) return out;
                const keys = ids.flatMap((id) => window.map((b) => counterKey(r, b, id)));
                const vals = await timed(vk.client.mget(...keys));
                ids.forEach((id, i) => {
                    let n = 0;
                    for (let j = 0; j < window.length; j++) n += Number(vals[i * window.length + j]) || 0;
                    out.set(id, n);
                });
                return out;
            }
            const all = await timed(Promise.all(window.map((b) => vk.client.zrange(hotKey(r, b), 0, -1, 'WITHSCORES'))));
            for (const flat of all) {
                for (let i = 0; i + 1 < flat.length; i += 2) out.set(flat[i], (out.get(flat[i]) || 0) + Number(flat[i + 1]));
            }
            return out;
        }
        pruneFallback(now);
        if (ids) {
            for (const id of ids) {
                let n = 0;
                for (const b of window) { const c = counters.get(counterKey(r, b, id)); if (c) n += c.n; }
                out.set(id, n);
            }
            return out;
        }
        for (const b of window) {
            const s = sets.get(hotKey(r, b));
            if (s) for (const [id, n] of s.members) out.set(id, (out.get(id) || 0) + n);
        }
        return out;
    } catch (err) {
        console.warn('[Demand] hotness not read:', err.message);
        return ids ? new Map(ids.map((id) => [id, 0])) : new Map();
    }
}

/** The hottest objects of a region over the last `buckets` buckets, hottest first. → [{ object_id, reads }] */
async function top({ region: r = region(), now = Date.now(), buckets = 1, limit = 100 } = {}) {
    return [...(await hotness({ region: r, now, buckets }))]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit)
        .map(([object_id, reads]) => ({ object_id, reads }));
}

/** Claim this hour's media.object.hot for an object: true once per ANNOUNCE_S (across processes on Valkey). */
async function claimAnnounce(r, id, now) {
    const k = announceKey(r, id);
    if (vk) return (await timed(vk.client.set(k, String(now), 'EX', ANNOUNCE_S, 'NX'))) === 'OK';
    const at = announced.get(k);
    if (at && at > now) return false;
    announced.set(k, now + ANNOUNCE_S * 1000);
    return true;
}

async function releaseAnnounce(r, id) {
    const k = announceKey(r, id);
    try { if (vk) await timed(vk.client.del(k)); else announced.delete(k); } catch { /* the claim lapses with its TTL */ }
}

/**
 * The sweep's demand pass: stage media.object.hot (through the placement outbox, one transaction per object) for
 * every object with at least `threshold` reads in the window, at most once per object per hour. Objects no
 * longer in media_objects are skipped; a sandbox tenant's event is dropped by the outbox. Never throws.
 * → { region, window_s, threshold, objects, hot, announced }
 */
async function rollup({ region: r = region(), now = Date.now(), threshold = HOT_READS, buckets = WINDOW_BUCKETS } = {}) {
    const out = { region: r, window_s: (buckets * BUCKET_MS) / 1000, threshold, objects: 0, hot: 0, announced: 0 };
    try {
        const heat = await hotness({ region: r, now, buckets });
        out.objects = heat.size;
        const over = [...heat].filter(([, n]) => n >= threshold).sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
        out.hot = over.length;
        if (!over.length) return out;
        const db = require('../db/database');
        const events = require('../events');
        const rows = await db.all(`SELECT id, app_id FROM media_objects WHERE id IN (${over.map(() => '?').join(', ')})`, over.map(([id]) => id));
        const appOf = new Map(rows.map((row) => [String(row.id), row.app_id]));
        for (const [id, reads] of over) {
            if (!appOf.has(id)) continue;
            try {
                if (!(await claimAnnounce(r, id, now))) continue;
            } catch (err) { console.warn('[Demand] hot claim failed:', err.message); continue; }
            const appId = appOf.get(id) || null;
            try {
                let env = null;
                await db.getDb().tx(async () => {
                    env = await events.recordPlacement('media.object.hot', appId, { type: 'object', id }, {
                        object_id: id, app_id: appId, region: r, reads, window_s: out.window_s, threshold,
                        bucket: bucketOf(now), since: new Date(now - out.window_s * 1000).toISOString(),
                    });
                });
                if (env) out.announced++;
            } catch (err) {
                console.warn(`[Demand] media.object.hot for ${id} not staged: ${err.message}`);
                await releaseAnnounce(r, id);
            }
        }
        if (out.announced) events.kick();
    } catch (err) {
        console.warn('[Demand] rollup failed:', err.message);
        out.error = err.message;
    }
    return out;
}

/** Forget everything in this process (tests). */
function _reset() { counters.clear(); sets.clear(); announced.clear(); }

module.exports = {
    BUCKET_MS, WINDOW_BUCKETS, KEY_TTL_S, TOP_N, HOT_READS, ANNOUNCE_S,
    useValkey, region, bucketOf, counterKey, hotKey, announceKey, record, hotness, top, rollup, _reset,
};
