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
 *   an object deleted / its visibility changed → media.object.deleted | media.object.visibility_changed
 *                                             (subject object <id>; Events only; payload object id, tenant,
 *                                             kind, legacy_ref and the times/visibilities, nothing else)
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
let drainTimer = null;
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
    if (process.env.EVENTS_PUBLISH === 'off' || !eventsUrl || !clientSecret) {
        // No outbox: object changes staged by the triggers are not events here; drop them hourly.
        if (!drainTimer) {
            drainTimer = setInterval(() => { try { discardObjectChanges(); } catch { /* next hour */ } }, 60 * 60 * 1000);
            if (drainTimer.unref) drainTimer.unref();
        }
        return null;
    }
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
    // Object changes that no Media transaction recorded (a row deleted outside one, operator SQL).
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = setInterval(() => { try { drainObjectChanges(); } catch (err) { console.warn('[Events] object changes:', err.message); } }, intervalMs);
    if (drainTimer.unref) drainTimer.unref();
    try { drainObjectChanges(); } catch { /* the timer retries */ }
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
    // A service-wide maintenance job (queue.SYSTEM_APP) is no tenant's: nothing to announce.
    if (job.app_id === require('./jobs/queue').SYSTEM_APP) return null;
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
 * Queue a Search document or tombstone (media.index_document.*, ./public/search-documents.js) as is:
 * no tenant field, low priority. Same rule as record(): inside the transaction that records the push.
 */
function recordIndexDocument(eventType, subject, payload) {
    if (!outbox) return null;
    const env = outbox.enqueue({ event_type: eventType, actor: { type: 'service', id: 'media' }, subject, visibility: 'internal', priority: 'low', payload });
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

const isoTime = (v) => {
    if (!v) return new Date().toISOString();
    const s = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/**
 * The event for one staged object change: [event_type, payload]. Minimal on purpose: which object
 * (id, tenant, kind, the inherited row it projects) and what changed. Never its title, metadata,
 * owner, storage keys or size: consumers GET the object with a tenant-scoped token when they need more.
 */
function objectChangeEvent(change, obj) {
    const base = { object_id: obj.id, app_id: obj.app_id, kind: obj.kind, legacy_ref: obj.legacy_ref || null };
    if (change.change === 'deleted') return ['media.object.deleted', { ...base, deleted_at: isoTime(change.changed_at) }];
    return ['media.object.visibility_changed', {
        ...base, visibility: change.visibility, previous_visibility: change.previous_visibility, changed_at: isoTime(change.changed_at),
    }];
}

/**
 * media.object.deleted / media.object.visibility_changed. The media_objects triggers
 * (server/db/database.js) stage one media_object_changes row per change inside the transaction that
 * makes it, whatever path made it. This turns the staged rows into outbox envelopes and removes
 * them; it MUST run inside a transaction (throws otherwise), so each event and the removal of its
 * staged row commit together. Media calls it at the end of its own transactions (projection sync,
 * announce(), soft delete), so those events commit with their change; the relay's drain takes the
 * rest. With the outbox off it does nothing (the rows wait, or the service drops them hourly).
 * Returns how many rows it turned into events (sandbox tenants' rows are removed without one).
 */
function recordObjectChanges({ limit = 1000 } = {}) {
    if (!outbox) return 0;
    const raw = db.getDb();
    if (!raw.inTransaction) throw new Error('recordObjectChanges() must run inside the transaction that changed the objects');
    const rows = raw.prepare('SELECT * FROM media_object_changes ORDER BY id LIMIT ?').all(limit);
    let n = 0;
    for (const c of rows) {
        const obj = raw.prepare('SELECT id, app_id, kind, legacy_ref FROM media_objects WHERE id = ?').get(c.object_id);
        if (obj) {
            const [type, payload] = objectChangeEvent(c, obj);
            if (enqueue(type, obj.app_id, { type: 'object', id: obj.id }, payload, 'important')) n++;
        }
        raw.prepare('DELETE FROM media_object_changes WHERE id = ?').run(c.id);
    }
    return n;
}

/** Drain staged object changes in a transaction of their own (the relay's timer). */
function drainObjectChanges() {
    if (!outbox) return 0;
    let n = 0;
    db.getDb().transaction(() => { n = recordObjectChanges(); })();
    if (n) kick();
    return n;
}

function discardObjectChanges() {
    return db.run('DELETE FROM media_object_changes').changes;
}

/** Wake the relay once the transaction that queued events has committed. */
function kick() {
    if (outbox) setImmediate(() => outbox && outbox.kick());
}

function status() {
    if (!outbox) return { enabled: false };
    return { enabled: true, pending: outbox.pending(), rejected: outbox.rejected(), queued_since_boot: stats.queued, last_error: stats.lastError };
}

function _reset() {
    if (outbox) outbox.stop();
    outbox = null;
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    stats.queued = 0; stats.lastError = null;
}

module.exports = { init, initWriter, record, recordIndexDocument, recordJob, recordObjectChanges, drainObjectChanges, discardObjectChanges, objectChangeEvent, kick, status, TYPES, JOB_TRANSITIONS, _reset };
