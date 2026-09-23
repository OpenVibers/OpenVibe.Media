/**
 * OpenVibe.Media — Outbound webhooks
 *
 * POSTs { event, app_id, data } to the app's configured webhook_url with
 * `X-OVMedia-Signature: sha256=<hmac>` — HMAC-SHA256 of the raw body using the
 * app's webhook_secret (per CONTRACTS.md). Fire-and-forget with small retries.
 *
 * Events: vod.ready | vod.failed | clip.ready | clip.failed | media.object.uploaded |
 *         storage.alert | storage.recovered
 *
 * Outcomes go through announce(): the state change and its durable OpenVibe.Events outbox row
 * commit in one SQLite transaction, then the webhook is sent with `event_id` = that event's id
 * (absent when the outbox is off), so a consumer that also reads Events dedupes the pair.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db/database');

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 3000;
const TIMEOUT_MS = 10000;

function sign(secret, rawBody) {
    return 'sha256=' + crypto.createHmac('sha256', String(secret || '')).update(rawBody).digest('hex');
}

async function _post(url, rawBody, signature) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OVMedia-Signature': signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Send an event to an app's webhook. Silently no-ops when the app has no
 * webhook_url. Never throws. Queues nothing: the durable event is written by
 * announce() (or the caller) inside the state change's transaction.
 * @param {string|object} appOrId  app_id or apps row
 * @param {string} event           e.g. 'vod.ready'
 * @param {object} data            event payload
 * @param {object} [opts]
 * @param {string} [opts.eventId]  the OpenVibe.Events event_id of the same outcome
 */
async function sendWebhook(appOrId, event, data, { eventId = null } = {}) {
    // A restore drill (MEDIA_DRILL) never calls an app: the URLs in its apps table are production's.
    if (require('./drill').enabled) return false;
    let app = appOrId;
    if (typeof appOrId === 'string') {
        try { app = db.getApp(appOrId); } catch { app = null; }
    }
    if (!app || !app.webhook_url) return false;

    const body = { event, app_id: app.app_id, data };
    if (eventId) body.event_id = eventId;
    const rawBody = JSON.stringify(body);
    const signature = sign(app.webhook_secret, rawBody);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await _post(app.webhook_url, rawBody, signature);
            return true;
        } catch (err) {
            if (attempt === MAX_ATTEMPTS) {
                console.warn(`[Webhooks] ${event} → ${app.app_id} failed after ${MAX_ATTEMPTS} attempts: ${err.message}`);
                return false;
            }
            await new Promise(r => setTimeout(r, RETRY_BASE_MS * attempt));
        }
    }
    return false;
}

/**
 * Commit an outcome and announce it. `change()` (synchronous DB writes, optional) and the outbox
 * row for `event` run in ONE SQLite transaction, so the durable event exists if and only if the
 * change committed: never lost after a commit, never announced for a rollback. `payload()` is read
 * inside that transaction (the row as committed). After the commit the relay is woken and the
 * app's webhook is sent with the same event_id. Returns { data, eventId }; throws (nothing changed,
 * nothing queued, no webhook) when the transaction fails.
 */
function announce(appId, event, { change = null, payload }) {
    const events = require('./events');
    let data = null;
    let env = null;
    db.getDb().transaction(() => {
        if (change) change();
        data = typeof payload === 'function' ? payload() : payload;
        env = events.record(event, appId, data);
    })();
    events.kick();
    const eventId = env ? env.event_id : null;
    sendWebhook(appId, event, data, { eventId }).catch(() => {});
    return { data, eventId };
}

module.exports = { sendWebhook, announce, sign };
