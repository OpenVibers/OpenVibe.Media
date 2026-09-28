'use strict';
/**
 * Per-actor rate limits at Media's capability boundaries (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * nginx limits by address. These limit by WHO calls: the Network token's principal (svc:community,
 * app:app_… of a developer project), the person signed in to the object explorer (user:usr_…), or an
 * app acting for one of its users (live:user:<id>, X-OV-User-Id). An app's own API key is not counted:
 * it is a first-party server speaking for every visitor of its site, so one budget for it would refuse
 * the whole site; that server limits its own visitors. A browser holding only an upload token (a
 * presigned PUT) is counted by address. Past a limit the route answers 429 problem+json `rate_limited`
 * with Retry-After before doing any work. Reads get MEDIA_LIMITS_MINUTE / MEDIA_LIMITS_HOUR (120 and
 * 3000); uploads, deletes and jobs set their own, tighter numbers where they are mounted.
 *
 * Counters live in this process: a restart forgets them. Never on /healthz, /api/ready, /release.json,
 * /metrics or the signed /internal/events deliveries (Events pushes at its own pace; a 429 there only
 * makes it retry and fall behind).
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');
const config = require('./config');

let clock = () => Date.now();
let refused = null;      // media_rate_limited_total, once index.js has a metrics registry

/** Who is counted: see above. null = not counted (an app's own API key). */
function actor(req) {
    if (req.principal && req.principal.sub) return req.principal.sub;
    if (req.person && req.person.subject) return `user:${req.person.subject}`;
    if (req.authType === 'user' && req.userId != null) return `${req.appId}:user:${req.userId}`;
    if (req.authType === 'app') return null;
    return defaultActor(req);
}

function onLimited(e) {
    // The actor is a principal, a subject id or an address, never a credential.
    console.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
    if (refused) refused.inc({ limit: e.name, window: e.window });
}

// The counters: in this process, or shared across processes on Valkey once server/index.js calls useValkey() at boot
// (ADR-035). Routes built before that pick the shared limiter up on their next request.
let store = null;
let valkeyHandle = null;
let limiter = null;
let generation = 0;
function current() {
    if (!limiter) {
        limiter = createActorLimiter({
            limits: { minute: config.limits.minute, hour: config.limits.hour },
            actor,
            now: () => clock(),
            onLimited,
            ...(store ? { store } : {}),
        });
    }
    return limiter;
}
/** Count on Valkey (an openvibe-sdk/valkey handle), from now on. */
function useValkey(valkey) {
    valkeyHandle = valkey || null;
    store = valkey ? createValkeyLimitStore(valkey) : null;
    limiter = null;
    generation++;
}

/** Every named limit with its numbers, as the routes declare them (published in /limits.json). */
const registered = new Map();
function limits(name, own = {}) {
    registered.set(name, { minute: own.minute != null ? own.minute : config.limits.minute, hour: own.hour != null ? own.hour : config.limits.hour });
    let mw = null;
    let built = -1;
    return (req, res, next) => {
        if (built !== generation || !mw) { mw = current()(name, own); built = generation; }
        return mw(req, res, next);
    };
}
limits.stats = () => current().stats();
limits.reset = () => current().reset();

/** Count refusals in /metrics (server/index.js, after observability.instrument). */
function bindMetrics(registry) {
    if (refused || !registry) return;
    refused = registry.counter({ name: 'media_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] });
}

module.exports = {
    useValkey,
    valkey: () => valkeyHandle,
    limits,
    /** [{ id, minute, hour }] for every limit the routes have declared, sorted by id. */
    registered: () => [...registered].map(([id, n]) => ({ id, ...n })).sort((x, y) => x.id.localeCompare(y.id)),
    actor,
    bindMetrics,
    _setClockForTests(fn) { clock = fn || (() => Date.now()); },
};
