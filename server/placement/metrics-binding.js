/**
 * OpenVibe.Media — single point that registers every placement metric (F1 part A, §6) and wires the
 * `inc(name, labels)` callbacks the other placement modules call. Keeps the registry as the only
 * source of truth (one HELP/TYPE per metric name).
 *
 *   bind(registry)            create the metrics, wire the counters/histograms/gauge, and rebind
 *                             the router / presign-cache / signals to inc() through them
 *   inc(name, labels)         the hook other modules use (router.route, presignCache.get, etc.)
 *   setBreaker(provider, ...)  signals module hook to flip the breaker-open gauge
 *
 * Metrics:
 *   media_provider_latency_seconds_bucket{provider,op}    histogram (default + latency buckets)
 *   media_provider_errors_total{provider,op}             counter
 *   media_provider_breaker_open{provider}                gauge (0/1)
 *   media_router_decisions_total{provider,purpose,reason} counter
 *   media_presign_cache_total{result}                    counter
 *   media_storage_alerts_total{kind}                     counter
 *   media_sweep_demand_source_total{source}              counter (valkey | pg: the object sweep's demand signal)
 */
'use strict';

const signals = require('./signals');
const router = require('./router');
const presignCache = require('./presign-cache');

let latency = null;     // histogram
let errors = null;      // counter
let breakerGauge = null; // gauge (collect)
let decisions = null;   // counter
let presign = null;     // counter
let alerts = null;      // counter
let demandSource = null; // counter

function bind(registry) {
    if (latency) return;   // idempotent

    latency = registry.histogram({
        name: 'media_provider_latency_seconds',
        help: 'Provider op latency in seconds (placement F1; presign = the cost the player pays to be served)',
        labelNames: ['provider', 'op'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
    errors = registry.counter({
        name: 'media_provider_errors_total',
        help: 'Provider op errors (placement F1)',
        labelNames: ['provider', 'op'],
    });
    breakerGauge = registry.gauge({
        name: 'media_provider_breaker_open',
        help: '1 when the placement breaker is open for a provider (the router skips it)',
        labelNames: ['provider'],
        collect: () => {
            const out = [];
            for (const p of require('../vod/vod-storage').REMOTE_PROVIDERS) out.push({ labels: { provider: p }, value: signals.breakerOpen(p) ? 1 : 0 });
            return out;
        },
    });
    decisions = registry.counter({
        name: 'media_router_decisions_total',
        help: 'Read-router decisions per provider, purpose and reason (placement F1)',
        labelNames: ['provider', 'purpose', 'reason'],
    });
    presign = registry.counter({
        name: 'media_presign_cache_total',
        help: 'Presigned-URL LRU cache lookups, by hit/miss',
        labelNames: ['result'],
    });
    alerts = registry.counter({
        name: 'media_storage_alerts_total',
        help: 'Storage alerts emitted to /metrics, mirroring the storage.alert webhook kinds',
        labelNames: ['kind'],
    });

    demandSource = registry.counter({
        name: 'media_sweep_demand_source_total',
        help: 'Object tiering sweeps by the demand signal their eligibility read: valkey (hourly reads) or pg (daily view counts, the fallback)',
        labelNames: ['source'],
    });
    for (const source of ['valkey', 'pg']) demandSource.inc({ source }, 0);

    // Bind every hook the placement modules use.
    router.bindMetric((name, labels) => inc(name, labels));
    presignCache.bindMetric((name, labels) => inc(name, labels));
    signals.onBreakerChange(() => { /* gauge collects lazily on next /metrics scrape */ });
}

function inc(name, labels) {
    if (name === 'media_router_decisions_total') decisions && decisions.inc(labels || {}, 1);
    else if (name === 'media_presign_cache_total') presign && presign.inc(labels || {}, 1);
    else if (name === 'media_storage_alerts_total') alerts && alerts.inc(labels || {}, 1);
    else if (name === 'media_provider_errors_total') errors && errors.inc(labels || {}, 1);
    else if (name === 'media_sweep_demand_source_total') demandSource && demandSource.inc(labels || {}, 1);
}

/** Hook the signals module's recordSuccess/recordFailure to fill the histogram/counter. */
function observeLatency(provider, op, ms) { if (latency && ms > 0) latency.observe({ provider, op }, ms / 1000); }
function observeError(provider, op) { errors && errors.inc({ provider, op }, 1); }
function alert(kind) { alerts && alerts.inc({ kind }, 1); }

module.exports = { bind, inc, observeLatency, observeError, alert, _reset: () => { latency = errors = breakerGauge = decisions = presign = alerts = demandSource = null; } };