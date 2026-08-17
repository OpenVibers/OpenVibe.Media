/**
 * OpenVibe.Media — Outbound webhooks
 *
 * POSTs { event, app_id, data } to the app's configured webhook_url with
 * `X-OVMedia-Signature: sha256=<hmac>` — HMAC-SHA256 of the raw body using the
 * app's webhook_secret (per CONTRACTS.md). Fire-and-forget with small retries.
 *
 * Events: vod.ready | vod.failed | clip.ready | clip.failed
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
 * webhook_url. Never throws.
 * @param {string|object} appOrId  app_id or apps row
 * @param {string} event           e.g. 'vod.ready'
 * @param {object} data            event payload
 */
async function sendWebhook(appOrId, event, data) {
    let app = appOrId;
    if (typeof appOrId === 'string') {
        try { app = db.getApp(appOrId); } catch { app = null; }
    }
    if (!app || !app.webhook_url) return false;

    const rawBody = JSON.stringify({ event, app_id: app.app_id, data });
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

module.exports = { sendWebhook, sign };
