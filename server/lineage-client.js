'use strict';
/**
 * Channel/owner lineage from OpenVibe.Live's canonical resolver (roadmap D20): GET
 * /internal/lineage/resolve with Media's service token (audience openvibe.live, capability
 * live.lineage.resolve). Media asks it instead of keeping a username → user mapping of its own.
 *
 *   channelBySlug(slug) -> { slug, live_user_id, owner_subject } | null (unresolved)
 *                          throws when the resolver cannot be asked (callers fall back)
 *
 * Off (channelBySlug throws) without OV_OAUTH_CLIENT_SECRET or with MEDIA_LINEAGE=off.
 */
const { serviceAuth } = require('openvibe-contracts');

const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

function createLineageClient({
    liveUrl = process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000',
    networkUrl = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    clientId = process.env.OV_OAUTH_CLIENT_ID || 'media',
    clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '',
    enabled = process.env.MEDIA_LINEAGE !== 'off',
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
} = {}) {
    const base = String(liveUrl).replace(/\/+$/, '');
    const tokens = clientSecret && enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${String(networkUrl).replace(/\/+$/, '')}/oauth/token`, clientId, clientSecret, audience: 'openvibe.live', fetchImpl, timeoutMs,
    }) : null;

    async function channelBySlug(slug) {
        if (!tokens) throw new Error('lineage resolver off');
        if (!SLUG_RE.test(String(slug || ''))) return null;
        const res = await fetchImpl(`${base}/internal/lineage/resolve?slug=${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 401) tokens.invalidate();
        const body = await res.json().catch(() => null);
        if (!res.ok || !body) throw new Error(`lineage resolver answered ${res.status}`);
        if (body.status !== 'resolved' || !body.channel) return null;
        const ch = body.channel;
        return { slug: ch.slug, live_user_id: (ch.legacy_ids && ch.legacy_ids.live_user_id) || null, owner_subject: ch.owner_subject || null };
    }

    return { enabled: Boolean(tokens), channelBySlug };
}

let _default = null;
const lineage = () => (_default || (_default = createLineageClient()));

module.exports = { createLineageClient, lineage };
