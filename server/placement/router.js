/**
 * OpenVibe.Media — the read router (placement F1, part 3).
 *
 *   route(opts) -> { provider, key, url, reason, fallbacks }
 *
 * The only function every read path goes through. Decides which provider copy to serve a
 * given object from, given the locations row(s), the per-provider signals (latency EWMA +
 * breaker) and a sticky session key.
 *
 * Decision:
 *   1. Resolve locations for the object (`locationsFor(opts)` accepts an `object`,
 *      a `vod` / `clip` row, or an explicit list).
 *   2. Filter to `state === 'present'` rows only. Non-present rows are NEVER routed to.
 *   3. Filter to providers that are configured, have passed their capability probe and are
 *      not breaker-open.
 *   4. Rank by preference tier, with the measured 5-minute EWMA latency breaking ties:
 *        playback : R2 with a verified present copy (popularity promotion put it there to move
 *                   reads off the host; promoting a VOD also frees its local copy) > local > R2 > B2
 *        else     : local > R2 > B2 (canonical); `download` (free ops) and `durable` (a job's derived bytes) put B2 before R2
 *      A VOD or clip offers every verified cloud copy its object records (media_locations), so a
 *      VOD promoted to R2 keeps B2 as its fallback when R2's breaker opens.
 *      A lower tier displaces a higher one only when both have measurements and the lower
 *      tier's EWMA is more than TIE_BAND (±15 %) faster. An unmeasured copy never claims to
 *      be faster than a preferred one — that keeps local/b2 from whipsawing a hot R2 copy.
 *   5. Sticky per session: the same `session` key gets the same provider for 30 s unless
 *      its breaker has opened, its copy is gone, or a better tier is available again.
 *   6. Presign the chosen remote copy through vod-storage (which carries the presigned-URL
 *      LRU), falling through the ranked list when a presign fails. A local copy has no URL:
 *      the caller streams it from disk.
 *
 * Every decision increments `media_router_decisions_total{provider,purpose,reason}`.
 */
'use strict';

const signals = require('./signals');
const providers = require('./providers');

const STICKY_TTL_MS = 30_000;
const TIE_BAND = 0.15;          // ±15% latency is treated as a tie
const NEUTRAL_MS = 100;         // a provider with no samples is assumed middling, never "fastest"

const stickyByKey = new Map();   // sessionKey -> { provider, expiresAt }

/** Purge expired sticky entries (called on every route to bound memory). */
function pruneSticky(now = Date.now()) {
    for (const [k, v] of stickyByKey) { if (v.expiresAt <= now) stickyByKey.delete(k); }
}

function stickyGet(session) {
    if (!session) return null;
    pruneSticky();
    return stickyByKey.get(session) || null;
}

function stickyPut(session, provider) {
    if (!session) return;
    stickyByKey.set(session, { provider, expiresAt: Date.now() + STICKY_TTL_MS });
}

/** Resolve the location rows for one object/vod/clip into a normalised list. */
async function locationsFor(opts) {
    let rows = null;
    if (Array.isArray(opts.locations)) rows = opts.locations;
    else if (opts.object && Array.isArray(opts.object.locations)) rows = opts.object.locations;
    if (rows) return rows;

    const fs = require('fs');
    if (opts.object && opts.object.id) {
        const model = require('../objects/model');
        rows = await model.listLocations(opts.object.id);
        // The object's canonical copy is a location too, when no row records it as present and none says it is
        // gone: a projected row still 'pending' verification must not hide the copy the object names.
        const canon = opts.object.canonical_provider, canonKey = opts.object.canonical_key;
        if (canon && canonKey) rows = withOwnCopy(rows, canon, canonKey, { canonical: true });
        // A stale local row whose file is gone is not really present.
        for (const r of rows) {
            if (r.provider === 'local' && r.state === 'present' && r.key && !fs.existsSync(r.key)) r.state = 'missing';
        }
        return rows;
    }
    if (opts.vod || opts.clip) {
        const vs = require('../vod/vod-storage');
        const row = opts.vod || opts.clip;
        const out = [];
        try {
            const localPath = vs.localPathForVod(row);
            if (localPath && fs.existsSync(localPath)) out.push({ provider: 'local', state: 'present', key: localPath });
        } catch { /* */ }
        // Every cloud copy the row's object records (a tier move marks each copy it verified present:
        // objects/model.js afterTierMove), not just the row's storage_provider: a VOD promoted to R2
        // (storage_provider 'r2') still has its canonical B2 copy, and that is its fallback.
        if (row.object_id) {
            try {
                const model = require('../objects/model');
                for (const l of await model.listLocations(row.object_id)) {
                    if (l.provider !== 'local' && l.key) out.push(l);
                }
            } catch (err) { console.warn('[Router] locations of object', row.object_id, err.message); }
        }
        // The row names its own copy: routable unless its object records that copy as gone. A projected row still
        // 'pending' verification (every offloaded VOD whose copy no tier move verified) does not hide it.
        if (row.storage_key && row.storage_provider && row.storage_provider !== 'local') return withOwnCopy(out, row.storage_provider, row.storage_key);
        return out;
    }
    return [];
}

/** Add the copy a row or object names itself (`provider`/`key`) unless a location already records it as present,
 *  or as missing/corrupt (then it is gone, whatever the row says). A pending location for it is replaced. */
function withOwnCopy(rows, provider, key, extra = {}) {
    const mine = rows.filter((r) => r.provider === provider);
    if (mine.some((r) => r.state === 'present' || r.state === 'missing' || r.state === 'corrupt')) return rows;
    return [...rows.filter((r) => r.provider !== provider), { provider, state: 'present', key, ...extra }];
}

/** A copy is healthy when: configured, breaker closed, and eligible for at least one provider class
 *  (a failed capability probe removes every class it needed). `passed === null` = probe not run yet. */
function isHealthy(provider, { purpose = 'playback' } = {}) {
    if (provider === 'local') return true;
    if (!providers.isConfigured(provider)) return false;
    if (signals.breakerOpen(provider)) return false;
    const caps = providers.capabilities(provider);
    if (caps.passed === null) return providers.providerClasses(provider).length > 0;
    return providers.eligibleClasses(provider).length > 0;
}

/** Measured 5-minute EWMA (ms) of a network round-trip op (head, then get), or null when the
 *  provider has no such samples. Presign is excluded: it is a local SigV4 operation, so its
 *  EWMA is host CPU noise, not a network signal, and must not rank providers. */
function measuredMs(provider) {
    const ms = signals.latencyEWMA(provider, 'head') || signals.latencyEWMA(provider, 'get');
    return ms > 0 ? ms : null;
}

function latencyOf(provider) {
    return measuredMs(provider) || NEUTRAL_MS;
}

/**
 * Preference tier (lower wins). Purpose decides only the order between the hot and canonical
 * cloud copies; local is always preferred to a cloud copy that is not the hot cache.
 */
// `download` (free B2 egress ops) and `durable` (where a job keeps bytes it derives: timeline segments and chunks)
// rank the canonical copy before the hot cache.
const CANONICAL_FIRST = new Set(['download', 'durable']);
function tierOf(candidate, purpose) {
    const p = candidate.provider;
    if (p === 'local') return 1;
    if (p === 'r2') {
        // A verified R2 copy is the hot cache: popularity promotion put it there precisely so reads leave the
        // host (the design's spill, decided by popularity until F2 measures the port).
        if (purpose === 'playback' && candidate.verified_at) return 0;
        return CANONICAL_FIRST.has(purpose) ? 3 : 2;
    }
    if (p === 'b2') return CANONICAL_FIRST.has(purpose) ? 2 : 3;
    return 2;
}

/** Rank the candidates: by tier, with a measured latency advantage (> TIE_BAND) allowed to promote. */
function rankCandidates(candidates, { purpose = 'playback' } = {}) {
    return [...candidates].sort((a, b) => {
        const ta = tierOf(a, purpose), tb = tierOf(b, purpose);
        if (ta === tb) {
            const ma = measuredMs(a.provider), mb = measuredMs(b.provider);
            if (ma != null && mb != null) return ma - mb;
            return 0;
        }
        const preferred = ta < tb ? a : b;
        const other = ta < tb ? b : a;
        const mp = measuredMs(preferred.provider), mo = measuredMs(other.provider);
        // Only a measured, clearly faster copy may jump the preference order.
        if (mp != null && mo != null && mo < mp * (1 - TIE_BAND)) return other === a ? -1 : 1;
        return preferred === a ? -1 : 1;
    });
}

/** Presign one remote candidate through vod-storage (which carries the presigned-URL LRU). */
async function presignCandidate(provider, key, opts) {
    const vs = require('../vod/vod-storage');
    const overrides = {};
    if (opts.contentType) overrides.contentType = opts.contentType;
    if (opts.contentDisposition) overrides.contentDisposition = opts.contentDisposition;
    const url = await vs.presignGet(provider, key, opts.expiresIn || 900, overrides);
    return url || null;
}

const REASONS = {
    0: 'hot-cache',
    1: 'local-cheap',
    2: 'hot-tier',
    3: 'canonical-fallback',
};

// Reads that count as demand: a viewer playing or downloading, not a job deriving from the copy.
const DEMAND_PURPOSES = new Set(['playback', 'download']);

/**
 * The only function every read path uses.
 * opts: { object | vod | clip | locations, purpose, session?, range?, presign?, expiresIn?,
 *         contentType?, contentDisposition? }
 * returns: { provider, key, url, reason, fallbacks, candidates } — `fallbacks` are provider names, ranked;
 *          `candidates` the ranked copies with their keys ({ provider, key }), the chosen one first.
 */
async function route(opts = {}) {
    const purpose = opts.purpose || 'playback';
    const session = opts.session || null;
    const locs = (await locationsFor(opts)).filter((l) => l && l.state === 'present' && l.key);

    // One candidate per provider: the first present location it has.
    const seen = new Set();
    const candidates = [];
    for (const l of locs) {
        if (seen.has(l.provider)) continue;
        if (!isHealthy(l.provider, { purpose })) continue;
        seen.add(l.provider);
        candidates.push(l);
    }
    const ranked = rankCandidates(candidates, { purpose });

    // Sticky: same session -> same provider for STICKY_TTL_MS unless its copy/breaker is gone, or a better tier
    // is available again. Stickiness stops latency flapping between copies of one tier; it never holds a viewer
    // on the canonical fallback once the hot copy is back (an R2 re-warm after an eviction).
    let ordered = ranked;
    const sticky = stickyGet(session);
    let stickyHit = false;
    if (sticky) {
        const at = ranked.findIndex((c) => c.provider === sticky.provider);
        if (at >= 0 && tierOf(ranked[at], purpose) <= tierOf(ranked[0], purpose)) { ordered = [ranked[at], ...ranked.slice(0, at), ...ranked.slice(at + 1)]; stickyHit = true; }
        else stickyByKey.delete(session);
    }

    // Materialise: keep the ranking, but let a failed presign push the decision down the list.
    let primary = ordered[0] || null;
    let url = null;
    if (primary && opts.presign !== false && primary.provider !== 'local') {
        for (const c of ordered) {
            if (c.provider === 'local') break;   // a local copy is streamed, not presigned
            const got = await presignCandidate(c.provider, c.key, opts).catch(() => null);
            if (got) { primary = c; url = got; break; }
        }
    }

    const fallbacks = ordered.filter((c) => c !== primary).map((c) => c.provider);
    const reason = primary
        ? (stickyHit && primary === ordered[0] && primary.provider === sticky.provider ? 'sticky' : REASONS[tierOf(primary, purpose)] || 'fastest-healthy')
        : 'no-healthy-copy';

    if (primary) stickyPut(session, primary.provider);

    incMetric('media_router_decisions_total', { provider: primary ? primary.provider : 'none', purpose, reason });
    // Demand (F2.4): one hit per served viewer read (not a derive job), object × region × 5-minute bucket.
    // Best-effort and fire-and-forget: a Valkey error or absence never delays or fails the read.
    if (primary && DEMAND_PURPOSES.has(purpose)) {
        try {
            const id = opts.object ? opts.object.id : (opts.vod || opts.clip || {}).object_id;
            if (id) require('./demand').record({ objectId: id });
        } catch { /* demand is a hint */ }
    }
    const chain = [primary, ...ordered.filter((c) => c !== primary)].filter(Boolean).map((c) => ({ provider: c.provider, key: c.key }));
    return primary
        ? { provider: primary.provider, key: primary.key, url, reason, fallbacks, candidates: chain }
        : { provider: null, key: null, url: null, reason, fallbacks: [], candidates: [] };
}

/**
 * A viewer's sticky-routing key for one piece of media: the same viewer (address + browser) asking for
 * the same object again within STICKY_TTL_MS gets the same provider. Hashed; never stored.
 */
function sessionFor(req, mediaId) {
    const { clientIp } = require('../client-ip');
    const h = require('crypto').createHash('sha256');
    h.update(`${clientIp(req) || ''}|${(req.headers && req.headers['user-agent']) || ''}|${mediaId}`);
    return h.digest('hex').slice(0, 24);
}

/** Optional metric hook (observability wires this up at boot). Avoids a hard require there. */
let _inc = () => {};
function bindMetric(fn) { _inc = fn || (() => {}); }
function incMetric(name, labels) { try { _inc(name, labels); } catch { /* */ } }

module.exports = {
    route,
    isHealthy,
    rankCandidates,
    tierOf,
    locationsFor,
    sessionFor,
    stickyGet, stickyPut, pruneSticky,
    bindMetric,
    reset: () => { stickyByKey.clear(); },
    STICKY_TTL_MS,
    TIE_BAND,
};
