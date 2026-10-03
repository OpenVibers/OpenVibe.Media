/**
 * OpenVibe.Media — provider registry over the existing S3 engine (placement F1, part 1).
 *
 * Every provider here is a thin adapter that reuses vod-storage.js's S3 client and primitives
 * (`headObject`, `presignGet`, `getObject` stream). The provider declares the classes it can
 * serve (`online-canonical` / `online-hot` / `regional-cache`) and a capability probe that runs
 * once per provider at boot and once an hour afterwards.
 *
 *   classes               provider classes the fabric considers for read routing
 *   capabilities(name)    a snapshot of the probed capabilities (range, range_206, if_range,
 *                         etag, cache_range, token_auth, purge) and `passed` overall
 *   probe(name, client?)  run the capability probe for one provider (writes a tiny probe
 *                         object once under prefix `fabric-probe/`; rereads/HEADs it through
 *                         every supported path)
 *   probeAll()            probe every configured remote provider
 *   startHealthLoop()     the cheap per-minute HeadBucket and the hourly capability probe
 *   healthStatus()        { b2, r2 } each as { configured, healthy, lastCheck, lastError }
 *
 * A provider that fails a capability is removed from the classes that need it until it passes
 * again — `probeProvider(name)` returning a capability list with `passed=false` is the only
 * signal the router needs to skip it for that class. Continuous health comes from a cheap HEAD
 * every 60 s plus the passive signals the read path records (placement/signals.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const vodStorage = () => require('../vod/vod-storage');

// Provider classes the fabric considers; a provider declares which ones it serves.
const CLASSES = ['online-canonical', 'online-hot', 'regional-cache'];

// Capability matrix: the probe checks each. A missing capability removes that class for the
// provider, not the provider itself (B2 has range+206 but is not "hot"; R2 has range but is
// always served as `online-hot`).
const CLASS_REQUIREMENTS = {
    'online-canonical': ['range', 'range_206', 'etag', 'if_range'],
    'online-hot':        ['range', 'range_206'],
    'regional-cache':    [],   // local: no remote capabilities needed
};

const PROBE_PREFIX = 'fabric-probe/';
const PROBE_KEY = `${PROBE_PREFIX}capability-probe`;   // one tiny object per provider
const PROBE_BYTES = Buffer.from('openvibe-media-fabric-probe', 'utf8');

let S3;   // lazy
function loadSdk() {
    if (!S3) { S3 = require('@aws-sdk/client-s3'); }
}

const state = {
    started: false,
    timers: [],        // so tests can stop them
    lastHealthCheck: {},   // provider -> epoch ms
    lastHealthError: {},   // provider -> string
};

async function announceProviderEvent(eventType, provider, payload) {
    try {
        await require('../db/database').getDb().tx(async () =>
            await require('../events').recordPlacement(eventType, null, { type: 'provider', id: provider }, { provider, ...payload }));
        require('../events').kick();
    } catch (err) { console.warn(`[Placement] ${eventType} not announced: ${err.message}`); }
}

/**
 * Capability gating. 'report' (the default) records what each provider can do and exposes it (health, the
 * admin placement view) without taking anything out of routing; 'enforce' (MEDIA_CAPABILITY_GATE=enforce) removes
 * a provider from every class whose requirements its last completed probe failed. Real providers run in report
 * mode first: S3-compatible APIs differ (If-Range especially), and one unsupported check must never take the
 * canonical copy offline unseen.
 */
function gateMode() { return String(process.env.MEDIA_CAPABILITY_GATE || 'report').toLowerCase() === 'enforce' ? 'enforce' : 'report'; }

/** The classes a provider's measured capabilities satisfy (null until a probe has completed). */
function measuredClasses(name) {
    if (name === 'local') return providerClasses('local');
    const caps = capabilities(name);
    if (!caps.passed) return null;
    const cap = caps.capabilities || {};
    return providerClasses(name).filter((cls) => CLASS_REQUIREMENTS[cls].every((c) => cap[c]));
}

/** Which classes a provider currently claims for routing (its declaration, narrowed by the probe when enforced). */
function eligibleClasses(name) {
    // Local: always eligible (regional-cache), no probe needed.
    if (name === 'local') return providerClasses('local');
    const measured = measuredClasses(name);
    if (gateMode() !== 'enforce' || measured === null) return providerClasses(name);
    return measured;
}

/** What classes each provider says it can serve. These are the design's assignments (docs/media-fabric.md §2):
 *  B2 is the online canonical, R2 Standard the online hot tier, the Media host's NVMe the regional cache. */
function providerClasses(name) {
    switch (name) {
        case 'local': return ['regional-cache'];
        case 'b2':    return ['online-canonical'];
        case 'r2':    return ['online-hot'];
        default: return [];
    }
}

/** Cheap per-provider capability snapshot: probe result + last known state. */
function capabilities(name) {
    const stored = state.capabilities && state.capabilities[name];
    if (stored) return stored;
    return { provider: name, passed: null, capabilities: {}, lastChecked: null, lastError: null };
}

/** Record the latest probe result in memory. */
function setCapabilities(name, caps) {
    if (!state.capabilities) state.capabilities = {};
    const old = state.capabilities[name];
    const classesOf = (snapshot) => snapshot.classes || providerClasses(name).filter((cls) =>
        CLASS_REQUIREMENTS[cls].every((cap) => snapshot.capabilities && snapshot.capabilities[cap]));
    if (old && old.passed && caps.passed) {
        const prev = classesOf(old);
        const next = classesOf(caps);
        if (next.length < prev.length) {
            void announceProviderEvent('provider.capacity.warning', name, { classes: next, previous_classes: prev });
        }
    }
    state.capabilities[name] = caps;
}

/** Whether the provider is configured (env is present). Always false for `local`. */
function isConfigured(name) {
    if (name === 'local') return true;
    return vodStorage().providerConfigured(name);
}

/** Run the capability probe for one provider against its bucket. */
async function probe(name) {
    const vs = vodStorage();
    if (!isConfigured(name)) {
        const out = { provider: name, passed: false, capabilities: {}, lastChecked: Date.now(), lastError: 'not configured' };
        setCapabilities(name, out); return out;
    }
    if (name === 'local') {
        const out = { provider: name, passed: true, capabilities: { range: true, range_206: true, etag: true, if_range: true, cache_range: true, token_auth: true, purge: true }, lastChecked: Date.now(), lastError: null };
        setCapabilities(name, out); return out;
    }
    loadSdk();
    const client = vs.clientFor(name);
    const bucket = vs.bucketFor(name);
    if (!client || !bucket) {
        const out = { provider: name, passed: false, capabilities: {}, lastChecked: Date.now(), lastError: 'no client' };
        setCapabilities(name, out); return out;
    }
    const caps = { range: false, range_206: false, etag: false, if_range: false, cache_range: false, token_auth: false, purge: false };
    const prev = capabilities(name);
    let error = null;
    try {
        await ensureProbeObject(name, client, bucket);
        const head = await vs.headObject(name, PROBE_KEY).catch(() => null);
        if (!head) { error = 'probe object missing'; }
        else {
            caps.range = !!head.size;
            caps.etag = !!head.etag;
            const range206 = await sendRange(name, client, bucket, PROBE_KEY, 0, 5).catch(() => null);
            caps.range_206 = !!(range206 && range206.status === 206);
            caps.if_range = await sendIfRange(name, client, bucket, PROBE_KEY, head.etag).catch(() => null) === true;
            caps.cache_range = caps.range_206;     // range slicing == cache range: same code path
            // token_auth + purge: these are operation surfaces (presign + DeleteObject). The probe
            // can't fully validate them without exercising the production code; treat as supported
            // when range works, since presign is over the same auth path.
            caps.token_auth = caps.range;
            caps.purge = caps.range;
        }
    } catch (err) { error = err.message; }
    // `passed` means the probe completed; what the provider can do is in `capabilities`, and the classes those
    // satisfy in `classes`. A probe that errored (a network blip) keeps the last completed snapshot.
    if (error && prev && prev.passed) {
        const out = { ...prev, lastError: error, lastChecked: Date.now(), stale: true };
        setCapabilities(name, out); return out;
    }
    const out = { provider: name, passed: !error, capabilities: caps, lastChecked: Date.now(), lastError: error };
    // The probe is a health check too: the admin view is not "unhealthy" until the first 60 s tick.
    state.lastHealthCheck[name] = Date.now(); state.lastHealthError[name] = error;
    out.classes = error ? [] : providerClasses(name).filter((cls) => CLASS_REQUIREMENTS[cls].every((c) => caps[c]));
    out.gate = gateMode();
    setCapabilities(name, out);
    return out;
}

async function probeAll() {
    const out = {};
    for (const name of ['local', ...vodStorage().REMOTE_PROVIDERS]) {
        try { out[name] = await probe(name); } catch (err) {
            // A probe that threw (a code or SDK fault) is recorded, never silent, and keeps the last snapshot.
            const prev = capabilities(name);
            out[name] = { ...prev, provider: name, lastError: err.message, lastChecked: Date.now(), stale: !!prev.passed };
            setCapabilities(name, out[name]);
        }
    }
    return out;
}

async function ensureProbeObject(name, client, bucket) {
    loadSdk();
    try {
        await client.send(new S3.HeadObjectCommand({ Bucket: bucket, Key: PROBE_KEY }));
        return;
    } catch { /* missing — create it */ }
    await client.send(new S3.PutObjectCommand({ Bucket: bucket, Key: PROBE_KEY, Body: PROBE_BYTES, ContentType: 'application/octet-stream' }));
}

async function sendRange(name, client, bucket, key, start, end) {
    loadSdk();
    try {
        const r = await client.send(new S3.GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }));
        const status = r.$metadata && r.$metadata.httpStatusCode;
        try { r.body && r.body.destroy && r.body.destroy(); } catch { /* */ }
        return { status };
    } catch (err) {
        return { status: err?.$metadata?.httpStatusCode || null };
    }
}

async function sendIfRange(name, client, bucket, key, etag) {
    if (!etag) return null;
    loadSdk();
    try {
        const r = await client.send(new S3.GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-0', IfRange: etag }));
        try { r.body && r.body.destroy && r.body.destroy(); } catch { /* */ }
        return true;
    } catch { return false; }
}

/** Cheap per-minute live health: one HeadBucket per remote provider (a HEAD, one Class B op on R2
 *  and free on B2). Flips the signals module's view of the provider. */
async function liveHealth(name) {
    const vs = vodStorage();
    if (!isConfigured(name)) return { configured: false };
    if (name === 'local') return { configured: true, healthy: true };
    const started = Date.now();
    try {
        loadSdk();
        await vs.probeProvider(name);   // HeadBucket; also flips vod-storage's providerHealthy
        state.lastHealthCheck[name] = Date.now();
        state.lastHealthError[name] = null;
        const ms = state.lastHealthCheck[name] - started;
        observe(name, 'head', true, ms);
        return { configured: true, healthy: true, lastCheck: state.lastHealthCheck[name], latencyMs: ms };
    } catch (err) {
        const wasHealthy = state.lastHealthCheck[name] != null && state.lastHealthError[name] == null;
        state.lastHealthCheck[name] = Date.now();
        state.lastHealthError[name] = err.message || String(err);
        if (wasHealthy) void announceProviderEvent('provider.health.degraded', name, { healthy: false, last_error: state.lastHealthError[name] });
        const ms = state.lastHealthCheck[name] - started;
        observe(name, 'head', false, ms);
        return { configured: true, healthy: false, lastCheck: state.lastHealthCheck[name], error: state.lastHealthError[name], latencyMs: ms };
    }
}

/** Feed one observation into the rolling signals and the Prometheus histogram/counter (lazy requires: this
 *  module is required by the router, so a top-level require of metrics-binding would be circular). */
function observe(provider, op, ok, ms) {
    try { const s = require('./signals'); ok ? s.recordSuccess(provider, op, ms) : s.recordFailure(provider, op, ms); } catch { /* */ }
    try {
        const mb = require('./metrics-binding');
        ok ? mb.observeLatency(provider, op, ms) : mb.observeError(provider, op);
    } catch { /* */ }
}

function healthStatus() {
    const out = {};
    for (const name of vodStorage().REMOTE_PROVIDERS) {
        out[name] = {
            configured: isConfigured(name),
            healthy: state.lastHealthError[name] == null && state.lastHealthCheck[name] != null,
            lastCheck: state.lastHealthCheck[name] || null,
            lastError: state.lastHealthError[name] || null,
            capabilities: capabilities(name),
            eligibleClasses: eligibleClasses(name),
        };
    }
    out.local = { configured: true, healthy: true, eligibleClasses: ['regional-cache'] };
    return out;
}

/** Start the cheap per-minute live health check and an hourly capability probe. */
function startHealthLoop({ log = console, intervalMs = 60_000, probeEveryMs = 60 * 60_000 } = {}) {
    if (state.started) return;
    state.started = true;
    const tick = async () => {
        for (const name of vodStorage().REMOTE_PROVIDERS) {
            if (!isConfigured(name)) continue;
            const h = await liveHealth(name);
            if (!h.healthy) log.warn && log.warn(`[placement] provider ${name} unhealthy: ${h.error}`);
        }
    };
    state.timers.push(setInterval(tick, intervalMs));
    if (state.timers[state.timers.length - 1].unref) state.timers[state.timers.length - 1].unref();
    const probeTick = async () => {
        for (const name of vodStorage().REMOTE_PROVIDERS) {
            if (!isConfigured(name)) continue;
            try { await probe(name); } catch (err) { log.warn && log.warn(`[placement] capability probe ${name} failed: ${err.message}`); }
        }
    };
    state.timers.push(setInterval(probeTick, probeEveryMs));
    if (state.timers[state.timers.length - 1].unref) state.timers[state.timers.length - 1].unref();
}

function stop() {
    for (const t of state.timers) { try { clearInterval(t); } catch { /* */ } }
    state.timers = [];
    state.started = false;
}

function reset() { stop(); state.capabilities = {}; state.lastHealthCheck = {}; state.lastHealthError = {}; }

module.exports = {
    CLASSES, CLASS_REQUIREMENTS, PROBE_PREFIX, PROBE_KEY,
    isConfigured, providerClasses, eligibleClasses, measuredClasses, gateMode, capabilities,
    probe, probeAll, liveHealth, healthStatus,
    startHealthLoop, stop, reset,
    // Test-only setter (used by tests to inject a known capability snapshot without touching the SDK).
    _setCapabilities: setCapabilities,
};
