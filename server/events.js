'use strict';
/**
 * Media → OpenVibe.Events (roadmap Wave 3, ADR-004): the outcomes Media already announces by
 * per-app webhook are also written as durable events to Media's own `event_outbox` table and
 * relayed to OpenVibe.Events with Media's service token (audience openvibe.events, capability
 * events.event.publish). The webhooks stay as they are until every consumer reads events.
 *
 *   vod.ready | vod.failed           → media.vod.ready | media.vod.failed      (subject vod <id>)
 *   clip.ready | clip.failed         → media.clip.ready | media.clip.failed    (subject clip <id>)
 *   media.object.uploaded            → media.object.uploaded                   (subject object <id>)
 *   storage.alert | storage.recovered → media.storage.alert | media.storage.recovered
 *   job state changes (server/jobs/queue.js) → media.job.proposed | queued | started | retrying |
 *                                             succeeded | failed | cancelled   (subject job <id>; Events only, no webhook;
 *                                             payload queue.jobEvent, not the tenant's params/result/error)
 *
 * The outbox row is written INSIDE the SQLite transaction that makes the state change it describes
 * (record(), called from webhooks.announce()): the event exists if and only if the change committed,
 * so a crash can neither lose an outcome nor announce one that rolled back. The webhook for the same
 * outcome is sent after the commit and carries the envelope's event_id, so a consumer receiving it by
 * both paths (Live during its webhook → Events transition) handles it once. Delivery from the outbox
 * on is at least once. Every event is `internal` visibility: a VOD's own visibility decides who may
 * see it, and consumers (Live, Search) apply it. Lifecycle outcomes are `important` (roadmap §6.3);
 * only storage.recovered is `low`.
 *
 * Off unless EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set (EVENTS_PUBLISH=off disables it).
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');
const db = require('./db/database');

const TYPES = {
    'vod.ready': ['media.vod.ready', 'vod'],
    'vod.failed': ['media.vod.failed', 'vod'],
    'clip.ready': ['media.clip.ready', 'clip'],
    'clip.failed': ['media.clip.failed', 'clip'],
    'media.object.uploaded': ['media.object.uploaded', 'object'],
    'storage.alert': ['media.storage.alert', 'storage'],
    'storage.recovered': ['media.storage.recovered', 'storage'],
};

// media.job.<transition>: progress is low priority, the outcome (and a proposal waiting for its owner) important.
const JOB_TRANSITIONS = {
    proposed: 'important', queued: 'low', started: 'low', retrying: 'low',
    succeeded: 'important', failed: 'important', cancelled: 'important',
};

let outbox = null;
const stats = { queued: 0, lastError: null };

function init({
    eventsUrl = (process.env.EVENTS_URL || '').replace(/\/+$/, ''),
    clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '',
    clientId = process.env.OV_OAUTH_CLIENT_ID || 'media',
    networkUrl = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, ''),
    fetchImpl, intervalMs = 2000,
} = {}) {
    if (outbox) return outbox;
    // A restore drill (MEDIA_DRILL) relays nothing: its outbox rows describe a restored copy.
    if (require('./drill').enabled) return null;
    if (process.env.EVENTS_PUBLISH === 'off' || !eventsUrl || !clientSecret) return null;
    const tokens = createServiceTokenClient({ tokenUrl: `${networkUrl}/oauth/token`, clientId, clientSecret, fetch: fetchImpl });
    const client = createClient({ baseUrls: { events: eventsUrl }, tokenProvider: tokens, fetch: fetchImpl, retries: 0 });
    outbox = createOutbox(db.getDb(), {
        events: createEventsClient(client, { source: 'media' }),
        intervalMs,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== stats.lastError) console.warn('[Events] publish failed (will retry):', msg);
            stats.lastError = msg;
        },
    });
    outbox.ensureSchema();
    outbox.start();
    const prune = setInterval(() => { try { outbox.prune(); } catch { /* next time */ } }, 6 * 60 * 60 * 1000);
    if (prune.unref) prune.unref();
    console.log(`[Events] media outcomes → ${eventsUrl} (${outbox.pending()} pending)`);
    return outbox;
}

// Events caps payloads (64 KB by default): the free-text fields stay behind the Media API.
function slim(appId, data) {
    const { meta, ai_overview, ...rest } = data || {};
    return { app_id: appId || null, ...rest };
}

/**
 * Queue the durable event for an outcome. MUST run inside the transaction that makes the change
 * (the SDK outbox refuses otherwise), and throws if the insert fails, so the change rolls back with
 * it. Returns the envelope (with event_id), or null when the outbox is off, the tenant is a sandbox
 * or the webhook event has no durable twin.
 */
function record(webhookEvent, appId, data) {
    const map = TYPES[webhookEvent];
    if (!map) return null;
    const [eventType, subjectType] = map;
    const id = data && (data.object_id || data.id);
    const subject = subjectType === 'storage'
        ? { type: 'storage', id: String((data && data.kind) || 'storage') }
        : { type: subjectType, id: String(id == null ? 'unknown' : id) };
    return enqueue(eventType, appId, subject, data, eventType === 'media.storage.recovered' ? 'low' : 'important');
}

/**
 * Queue media.job.<transition> for a job (queue.jobEvent: ids, state, counters, ISO times and
 * has_result; never params, result, error text, idempotency key or who created/decided it; the
 * tenant-scoped GET /api/v2/:app/jobs/:id has those). Same rule as record(): call it inside the
 * transaction that changes the job's state; it throws when the insert fails.
 */
function recordJob(transition, job) {
    const priority = JOB_TRANSITIONS[transition];
    if (!priority) throw new Error(`unknown job transition ${transition}`);
    return enqueue(`media.job.${transition}`, job.app_id, { type: 'job', id: String(job.id) }, job, priority);
}

function enqueue(eventType, appId, subject, data, priority) {
    if (!outbox) return null;
    // Developer-project sandbox tenants (ADR-014) produce no platform events: sandbox activity must
    // never reach production consumers.
    if (appId && db.isSandboxTenant(appId)) return null;
    const env = outbox.enqueue({
        event_type: eventType,
        actor: { type: 'service', id: 'media' },
        subject,
        visibility: 'internal',
        priority,
        payload: slim(appId, data),
    });
    stats.queued++;
    return env;
}

/**
 * Operator scripts (scripts/media-jobs.js) change job state in the same database as the running
 * service. When the service's outbox table exists (the outbox is on there), the script writes its
 * events into it too, and the service's relay publishes them. No relay runs in the script.
 */
function initWriter() {
    if (outbox) return outbox;
    const raw = db.getDb();
    if (!raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_outbox'").get()) return null;
    const client = createClient({ baseUrls: { events: 'http://127.0.0.1:9' }, retries: 0 });
    outbox = createOutbox(raw, { events: createEventsClient(client, { source: 'media' }) });
    outbox.ensureSchema();
    return outbox;
}

/** Wake the relay once the transaction that queued events has committed. */
function kick() {
    if (outbox) setImmediate(() => outbox && outbox.kick());
}

function status() {
    if (!outbox) return { enabled: false };
    return { enabled: true, pending: outbox.pending(), rejected: outbox.rejected(), queued_since_boot: stats.queued, last_error: stats.lastError };
}

function _reset() { if (outbox) outbox.stop(); outbox = null; stats.queued = 0; stats.lastError = null; }

module.exports = { init, initWriter, record, recordJob, kick, status, TYPES, JOB_TRANSITIONS, _reset };
