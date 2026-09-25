'use strict';
/**
 * Sign-out everywhere reaches openvibe.media (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after).
 *
 * POST /internal/events is the endpoint of Media's Events subscription to that topic, signed with
 * MEDIA_INBOUND_EVENTS_SECRET (signature v2 only) and refused when it came through the proxy. A
 * delivery moves the person's cutoff (openvibe-sdk createRevocationStore: only ever forward, source
 * network only); user-auth.js then refuses their older tokens, so openvibe.media's navbar shows them
 * signed out at once. The subscription is created at boot when EVENTS_URL, the service secret and
 * MEDIA_INBOUND_EVENTS_SECRET are set (grant media events.subscription.manage).
 */
const express = require('express');

const TOPIC = 'network.user.token_valid_after';
let store = null;
function cutoffs() {
    if (!store) store = require('openvibe-sdk/auth').createRevocationStore(require('./db/database').getDb(), { table: 'token_revocations' });
    return store;
}
const secrets = () => String(process.env.MEDIA_INBOUND_EVENTS_SECRET || '').split(',').map((s) => s.trim()).filter((s) => s.length >= 32);
const stats = { received: 0, revoked: 0, refused: 0 };

function isRevoked(claims) { try { return cutoffs().isRevoked(claims); } catch { return false; } }

function handler() {
    const { parseDelivery } = require('openvibe-sdk/events');
    return [express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return res.status(404).json({ error: 'Not found' });
        const keys = secrets();
        if (!keys.length) return res.status(503).json({ error: 'MEDIA_INBOUND_EVENTS_SECRET is not set' });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let d = null;
        for (const k of keys) { d = parseDelivery(raw, req.headers, k, { requireV2: true }); if (d) break; }
        if (!d || !d.event) { stats.refused++; return res.status(401).json({ error: 'bad signature' }); }
        stats.received++;
        const outcome = cutoffs().apply(d.event);
        if (outcome === 'revoked') stats.revoked++;
        res.json({ event_id: d.event.event_id || null, outcome });
    }];
}

/** Create Media's subscription to TOPIC if missing (idempotent; an operator-disabled one is left alone). */
async function ensureSubscription({ fetchImpl = globalThis.fetch, log = console } = {}) {
    const eventsUrl = String(process.env.EVENTS_URL || '').replace(/\/+$/, '');
    const secret = secrets()[0];
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!eventsUrl || !secret || !clientSecret) return 'off';
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const tokens = createServiceTokenClient({
        tokenUrl: `${String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '')}/oauth/token`,
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'media', clientSecret, fetch: fetchImpl,
    });
    const endpoint = process.env.MEDIA_EVENTS_ENDPOINT || `http://127.0.0.1:${require('./config').port}/internal/events`;
    const token = await tokens.getToken({ audience: 'openvibe.events', scope: 'events.subscription.manage' });
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const list = await fetchImpl(`${eventsUrl}/api/v1/subscriptions`, { headers });
    if (!list.ok) throw new Error(`Events answered ${list.status} listing subscriptions`);
    const subs = ((await list.json()).subscriptions || []);
    if (subs.some((s) => s.topic_pattern === TOPIC && s.endpoint === endpoint)) return 'exists';
    const r = await fetchImpl(`${eventsUrl}/api/v1/subscriptions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ topic_pattern: TOPIC, endpoint, secret }) });
    if (r.status === 409) return 'exists';
    if (!r.ok) throw new Error(`Events answered ${r.status} creating the ${TOPIC} subscription`);
    log.log && log.log(`[Events] subscription created: ${TOPIC} → ${endpoint}`);
    return 'created';
}

module.exports = { handler, ensureSubscription, isRevoked, stats, TOPIC, _cutoffs: cutoffs };
