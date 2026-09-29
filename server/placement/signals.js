/**
 * OpenVibe.Media — per-provider rolling signals and a circuit breaker (placement F1, part 2).
 *
 *   latencyEWMA(provider, op)        current EWMA (ms) over the recent samples
 *   errorRate(provider, window)      failures / total over a window ('10s'|'1m'|'5m'|'1h')
 *   p95(provider, window)            observed p95 over a window (ms)
 *   recordSuccess(provider, op, ms)  push one success sample (and a low-latency signal)
 *   recordFailure(provider, op, ms)  push one failure sample
 *   breakerOpen(provider)            true when the breaker is open (skip the provider)
 *   snapshot()                       a plain object for /metrics and the admin view
 *   reset()                          clear in-memory state (tests)
 *
 * The breaker opens when the 1-minute error rate exceeds 50% over at least 5 samples,
 * or the 5-minute p95 exceeds 5 s. Half-open after 60 s: one trial; on success it
 * closes, on failure it re-opens. `providerHealthy` in vod-storage.js reads this so a
 * dead provider is skipped without waiting for the next boot probe.
 *
 * In-memory only: signals are observed on the actual read path and the next boot
 * re-initialises them from the cheap periodic HEAD probe (placement/providers.js).
 */
'use strict';

const WINDOWS = ['10s', '1m', '5m', '1h'];
const WINDOW_MS = { '10s': 10_000, '1m': 60_000, '5m': 5 * 60_000, '1h': 60 * 60_000 };
const EWMA_ALPHA = 0.3;          // ~few samples to converge, not so fast it whipsaws on noise
const SAMPLE_LIMIT = 2000;       // per provider × op ring buffer (memory bound)
const BREAKER_OPEN_THRESHOLD = { errorRate1m: 0.5, minSamples1m: 5, p95Ms5m: 5000 };
const BREAKER_HALF_OPEN_AFTER_MS = 60_000;

// The clock is virtual only for tests (`_advance`), so the 60-second half-open window can be
// exercised without sleeping: everything else reads Date.now().
let clockSkewMs = 0;
function nowMs() { return Date.now() + clockSkewMs; }

/** Per-(provider, op): an EWMA of latency and a ring of recent (ok, ms) samples for error rate / p95. */
function makeSignal() {
    return { ewmaMs: 0, samples: [] };   // samples = [{ t, ok, ms }]
}

const state = new Map();        // key 'provider:op' -> signal
const breakers = new Map();     // provider -> { openAt, halfOpenAt?, halfOpenInFlight? }
const listeners = new Set();    // (provider) => void  — fired when a breaker flips

function key(provider, op) { return `${provider}:${op || 'op'}`; }

function getSignal(provider, op) {
    const k = key(provider, op);
    let s = state.get(k);
    if (!s) { s = makeSignal(); state.set(k, s); }
    return s;
}

/** All samples for one provider, regardless of op. Used by the breaker stats so it sees every signal. */
function allSamplesFor(provider) {
    const out = [];
    for (const [k, s] of state) {
        if (!k.startsWith(provider + ':')) continue;
        for (const sample of s.samples) out.push(sample);
    }
    return out;
}

/** EWMA averaged across all ops for the provider. */
function ewmaFor(provider) {
    let count = 0, weighted = 0;
    for (const [k, s] of state) {
        if (!k.startsWith(provider + ':')) continue;
        if (s.ewmaMs > 0) { weighted += s.ewmaMs; count++; }
    }
    return count ? weighted / count : 0;
}

/** Push one (ok, ms) observation into the ring; trim by window + size. */
function push(provider, op, ok, ms) {
    const s = getSignal(provider, op);
    if (ok && ms > 0) s.ewmaMs = s.ewmaMs ? (EWMA_ALPHA * ms + (1 - EWMA_ALPHA) * s.ewmaMs) : ms;
    s.samples.push({ t: nowMs(), ok: !!ok, ms: Number(ms) || 0 });
    if (s.samples.length > SAMPLE_LIMIT) s.samples.splice(0, s.samples.length - SAMPLE_LIMIT);
    if (ok) onSuccess(provider); else onFailure(provider);
    // Slow success (high p95) is itself a degradation signal: check every push.
    const stats5m = statsFor(provider, null, '5m');
    if (breakerState(provider) === 'closed' && stats5m.p95Ms >= BREAKER_OPEN_THRESHOLD.p95Ms5m) openBreaker(provider);
}

function recordSuccess(provider, op, ms) { push(provider, op, true, ms); }
function recordFailure(provider, op, ms) { push(provider, op, false, ms || 0); }

/** Stats over a window: total, errors, error rate, observed p95 (ms). Aggregates across all ops
 *  for the provider — the breaker cares about the provider as a whole, not per-op. */
function statsFor(provider, _opUnused, windowKey) {
    const windowMs = WINDOW_MS[windowKey] || WINDOW_MS['1m'];
    const cutoff = nowMs() - windowMs;
    let total = 0, errors = 0, latencies = [];
    for (const sample of allSamplesFor(provider)) {
        if (sample.t < cutoff) continue;
        total++;
        if (!sample.ok) errors++; else latencies.push(sample.ms);
    }
    latencies.sort((a, b) => a - b);
    const percentile = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] : 0);
    const p50 = percentile(0.5), p95 = percentile(0.95);
    return { total, errors, errorRate: total ? errors / total : 0, p50Ms: p50, p95Ms: p95 };
}

function latencyEWMA(provider, op) { return op ? getSignal(provider, op).ewmaMs : ewmaFor(provider); }
function errorRate(provider, windowKey = '1m', _op) { return statsFor(provider, null, windowKey).errorRate; }
function p50(provider, windowKey = '5m', _op) { return statsFor(provider, null, windowKey).p50Ms; }
function p95(provider, windowKey = '5m', _op) { return statsFor(provider, null, windowKey).p95Ms; }
/** Whether the provider is worth routing to at all: breaker closed. `providerHealthy` in vod-storage.js reads this. */
function providerHealthy(name) { return !breakerOpen(name); }

/** Breaker: closed (healthy), open (skipped), half-open (one trial allowed). */
function breakerState(provider) {
    const b = breakers.get(provider);
    if (!b) return 'closed';
    if (b.halfOpenInFlight) return 'half-open';
    if (b.halfOpenAt && nowMs() >= b.halfOpenAt) return 'half-open';
    if (b.openAt && nowMs() - b.openAt < BREAKER_HALF_OPEN_AFTER_MS) return 'open';
    if (b.openAt) { b.halfOpenAt = nowMs(); return 'half-open'; }
    return 'closed';
}

function breakerOpen(provider) { return breakerState(provider) === 'open'; }

function openBreaker(provider) {
    const b = breakers.get(provider) || {};
    b.openAt = nowMs();
    b.halfOpenAt = null;
    b.halfOpenInFlight = false;   // a failed trial is no longer in flight: the breaker is open again
    breakers.set(provider, b);
    fire(provider);
}

function closeBreaker(provider) {
    if (!breakers.has(provider)) return;
    breakers.delete(provider);
    fire(provider);
}

function fire(provider) { for (const fn of listeners) { try { fn(provider); } catch { /* */ } } }
function onBreakerChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function onSuccess(provider) {
    const b = breakers.get(provider);
    if (!b) return;
    if (b.halfOpenInFlight) { closeBreaker(provider); }
    else if (b.openAt && nowMs() - b.openAt >= BREAKER_HALF_OPEN_AFTER_MS) { closeBreaker(provider); }
}

function onFailure(provider) {
    if (breakerState(provider) === 'half-open') { openBreaker(provider); return; }
    if (breakerState(provider) === 'open') return;
    const stats1m = statsFor(provider, null, '1m');
    if (stats1m.total >= BREAKER_OPEN_THRESHOLD.minSamples1m && stats1m.errorRate >= BREAKER_OPEN_THRESHOLD.errorRate1m) { openBreaker(provider); }
}

/** Mark a half-open trial as in-flight so a concurrent call cannot also use the provider. */
function halfOpenClaim(provider) {
    const b = breakers.get(provider);
    if (!b) return false;
    if (breakerState(provider) !== 'half-open') return false;
    if (b.halfOpenInFlight) return false;
    b.halfOpenInFlight = true;
    breakers.set(provider, b);
    return true;
}

function snapshot() {
    const providers = new Set();
    for (const k of state.keys()) providers.add(k.split(':', 1)[0]);
    const out = { breakers: {}, providers: {} };
    for (const p of providers) {
        out.breakers[p] = breakerState(p);
        const w = {};
        for (const win of WINDOWS) {
            const st = statsFor(p, null, win);
            w[win] = { total: st.total, errors: st.errors, errorRate: Number(st.errorRate.toFixed(4)), p50Ms: st.p50Ms, p95Ms: st.p95Ms };
        }
        out.providers[p] = { ewmaMs: Math.round(ewmaFor(p)), windows: w };
    }
    return out;
}

function reset() {
    state.clear();
    breakers.clear();
    listeners.clear();
    clockSkewMs = 0;
}

/** Test-only: move the virtual clock forward so the half-open window needs no real sleep. */
function _advance(ms) { clockSkewMs += Number(ms) || 0; }

module.exports = {
    WINDOWS, BREAKER_OPEN_THRESHOLD, BREAKER_HALF_OPEN_AFTER_MS,
    recordSuccess, recordFailure,
    latencyEWMA, errorRate, p50, p95,
    providerHealthy,
    breakerState, breakerOpen,
    halfOpenClaim, openBreaker, closeBreaker,
    onBreakerChange, snapshot, reset,
    _advance,
};