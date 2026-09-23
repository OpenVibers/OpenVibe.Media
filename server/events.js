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
 *
 * The event is enqueued right after the state change commits (its own SQLite transaction, a local
 * insert): the loss window is a process crash between those two statements. Delivery from the
 * outbox on is at least once. Every event is `internal` visibility: a VOD's own visibility decides
 * who may see it, and consumers (Live, Search) apply it.
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

/** Queue the durable twin of a webhook event. Never throws; returns the envelope or null. */
function emit(webhookEvent, appId, data) {
    if (!outbox) return null;
    const map = TYPES[webhookEvent];
    if (!map) return null;
    const [eventType, subjectType] = map;
    const id = data && (data.object_id || data.id);
    const subject = subjectType === 'storage'
        ? { type: 'storage', id: String((data && data.kind) || 'storage') }
        : { type: subjectType, id: String(id == null ? 'unknown' : id) };
    try {
        let env = null;
        db.getDb().transaction(() => {
            env = outbox.enqueue({
                event_type: eventType,
                actor: { type: 'service', id: 'media' },
                subject,
                visibility: 'internal',
                priority: /failed|alert/.test(eventType) ? 'important' : 'low',
                payload: slim(appId, data),
            });
        })();
        stats.queued++;
        setImmediate(() => outbox && outbox.kick());
        return env;
    } catch (err) {
        console.warn(`[Events] ${eventType} not queued:`, err.message);
        return null;
    }
}

function status() {
    if (!outbox) return { enabled: false };
    return { enabled: true, pending: outbox.pending(), rejected: outbox.rejected(), queued_since_boot: stats.queued, last_error: stats.lastError };
}

function _reset() { if (outbox) outbox.stop(); outbox = null; stats.queued = 0; stats.lastError = null; }

module.exports = { init, emit, status, TYPES, _reset };
