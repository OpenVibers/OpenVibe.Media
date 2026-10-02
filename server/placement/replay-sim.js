'use strict';
/**
 * Placement replay simulator (F1b, docs/media-fabric.md §10): replays recorded tier decisions
 * (rows of media_object_tier_decisions) against a candidate policy and reports what it would have done.
 * Pure: no database, providers or bytes; the input rows are never modified.
 *
 * policy is {maxPromotionsPerSweep, maxDemotionsPerSweep, minResidencyMs} (a missing or non-finite limit
 * means unlimited / none), either flat for every class or keyed by class: {video: {...}, default: {...}}.
 * A row's class is row.class, else inputs.class, else inputs.kind, else 'default'.
 *
 * Only 'done' and 'dry_run' rows are proposals; refused, failed and already rows moved nothing and are
 * counted in `ignored`. Proposals replay in time order (decided_at, then id). A sweep is row.sweep when
 * given, else the sweepMs-wide time bucket (default one hour). For each proposal:
 *   1. hysteresis: an object that moved less than minResidencyMs ago stays put (suppressedByHysteresis);
 *   2. budget: a sweep spends at most maxPromotionsPerSweep / maxDemotionsPerSweep per class and
 *      the rest is suppressedByBudget (a suppressed proposal spends nothing and starts no residency).
 * A flap is an applied move that reverses the object's previous applied move within flapWindowMs (24 h).
 *
 * → {moves, suppressedByBudget, suppressedByHysteresis, flaps, ignored}
 */

const DEFAULT_SWEEP_MS = 3600 * 1000;
const DEFAULT_FLAP_WINDOW_MS = 24 * 3600 * 1000;
const LIMIT_KEYS = ['maxPromotionsPerSweep', 'maxDemotionsPerSweep', 'minResidencyMs'];

function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    return Date.parse(v);
}

function parseInputs(v) {
    if (v && typeof v === 'object') return v;
    try { return JSON.parse(v || '{}') || {}; } catch (_) { return {}; }
}

function limit(v) {
    return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : Infinity;
}

function policyFor(policy, cls) {
    const p = policy || {};
    const flat = LIMIT_KEYS.some((k) => k in p);
    const src = flat ? p : (p[cls] || p.default || {});
    return {
        promotions: limit(src.maxPromotionsPerSweep),
        demotions: limit(src.maxDemotionsPerSweep),
        residencyMs: Number.isFinite(Number(src.minResidencyMs)) ? Math.max(0, Number(src.minResidencyMs)) : 0,
    };
}

function simulate({ decisions = [], policy = {}, sweepMs = DEFAULT_SWEEP_MS, flapWindowMs = DEFAULT_FLAP_WINDOW_MS } = {}) {
    const out = { moves: [], suppressedByBudget: 0, suppressedByHysteresis: 0, flaps: 0, ignored: 0 };
    const proposals = [];
    for (const row of decisions) {
        const at = toMs(row && row.decided_at);
        if (!row || !Number.isFinite(at) || (row.action !== 'promote' && row.action !== 'demote')
            || (row.outcome !== 'done' && row.outcome !== 'dry_run')) { out.ignored++; continue; }
        const inputs = parseInputs(row.inputs);
        proposals.push({ row, at, cls: row.class || inputs.class || inputs.kind || 'default' });
    }
    proposals.sort((a, b) => a.at - b.at || (Number(a.row.id) || 0) - (Number(b.row.id) || 0));

    const last = new Map();   // object_id → {action, at} of its last applied move
    const spent = new Map();  // `${sweep}|${cls}|${action}` → moves applied
    for (const { row, at, cls } of proposals) {
        const p = policyFor(policy, cls);
        const prev = last.get(row.object_id);
        if (prev && at - prev.at < p.residencyMs) { out.suppressedByHysteresis++; continue; }
        const sweep = row.sweep != null ? String(row.sweep) : String(Math.floor(at / sweepMs));
        const key = `${sweep}|${cls}|${row.action}`;
        const n = spent.get(key) || 0;
        if (n >= (row.action === 'promote' ? p.promotions : p.demotions)) { out.suppressedByBudget++; continue; }
        spent.set(key, n + 1);
        if (prev && prev.action !== row.action && at - prev.at < flapWindowMs) out.flaps++;
        last.set(row.object_id, { action: row.action, at });
        out.moves.push({ object_id: row.object_id, action: row.action, class: cls, sweep,
            at: new Date(at).toISOString(), from: row.from_provider || null, to: row.to_provider || null });
    }
    return out;
}

module.exports = { simulate };
