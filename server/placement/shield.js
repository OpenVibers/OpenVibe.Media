/**
 * OpenVibe.Media — the origin shield (Media Fabric F1b, docs/media-fabric.md "origin shield").
 *
 * Node still authorizes every read and picks the copy (the placement router); for a public copy on a shielded provider
 * it no longer redirects the viewer to a presigned URL. It answers with `X-Accel-Redirect` into nginx's internal
 * `/_media_shield/<provider>/…` location, which proxies the presigned request through a slice cache (10 MB slices,
 * `proxy_cache_lock`): N viewers of the same object range cost one provider GET, the bytes come from the Media host's
 * prepaid bandwidth, and the provider URL never reaches the viewer. The cache key is the object path and the slice,
 * never the signature (deploy/nginx/openvibe.media.conf).
 *
 *   MEDIA_SHIELD=b2         providers whose reads go through the shield (comma-separated; empty = off). Set it only
 *                           once nginx has the locations: a Node that emits X-Accel to an nginx without them 404s.
 *   MEDIA_SHIELD_HOST=edge.openvibe.media   the ONLY host the shield answers on: a DNS-only (grey-cloud) edge name.
 *                           openvibe.media is behind Cloudflare's proxy, whose terms for video are not verified (plan
 *                           T4): bytes that went viewer → B2 must not start flowing through Cloudflare. Unset = off.
 *   MEDIA_SHIELD_REFRESH_URL  the loopback-only purge listener (default http://127.0.0.1:8479).
 *
 * Rules: private and sandbox bytes never enter the shared cache; B2 only for now (path-style URLs, one signed host; R2
 * waits for F2's port-utilization guard); the shield's presign lives an hour (it stays inside nginx, and a long response
 * fetches later slices with it), the viewer-facing 302 keeps its short TTL.
 *
 *   target({ provider, url, visibility, sandbox })  → '/_media_shield/b2/<bucket>/<key>?<signed query>' | null
 *   send(res, target, headers)                      → the 200 + X-Accel-Redirect answer
 *   await purge({ provider, key, size, presign })   → refreshes every cached slice of a deleted or replaced object
 */
'use strict';

const SLICE_BYTES = 10 * 1024 * 1024;           // nginx `slice 10m`
const SHIELD_TTL_SECONDS = 3600;

function providers() {
    return String(process.env.MEDIA_SHIELD || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function enabled(provider) { return providers().includes(String(provider || '').toLowerCase()); }

/** The internal location for one presigned URL, or null when this read must not go through the shield. `host` is the
 *  request's host: the shield answers only on MEDIA_SHIELD_HOST (a DNS-only edge name), never through Cloudflare. */
function target({ provider, url, visibility = 'public', sandbox = false, host = null }) {
    if (!url || !enabled(provider)) return null;
    const edge = String(process.env.MEDIA_SHIELD_HOST || '').toLowerCase();
    if (!edge || String(host || '').toLowerCase() !== edge) return null;
    if (visibility === 'private' || sandbox) return null;           // never into a shared cache
    let u; try { u = new URL(url); } catch { return null; }
    // Path-style URLs only: the pathname is /<bucket>/<key>, the host is the provider's one signed endpoint.
    if (!u.pathname || u.pathname === '/') return null;
    return `/_media_shield/${String(provider).toLowerCase()}${u.pathname}${u.search}`;
}

/** Hand the read to nginx. Headers the route computed (type, disposition, cache policy) go with it. */
function send(res, targetPath, headers = {}) {
    for (const [k, v] of Object.entries(headers)) if (v != null) res.set(k, v);
    res.set('X-Accel-Redirect', targetPath);
    res.set('X-Media-Source', 'shield');
    return res.status(200).end();
}

/**
 * Refresh every cached slice of an object after it was deleted or replaced on a shielded provider: one request per
 * 10 MB slice to nginx's loopback-only refresh location, which bypasses the cache and stores the provider's answer
 * (a 404 for a deleted object: cached for a minute, then gone). Never throws; returns what it did.
 */
async function purge({ provider, key, size, presign, fetchImpl = globalThis.fetch, base = process.env.MEDIA_SHIELD_REFRESH_URL || 'http://127.0.0.1:8479', host = process.env.MEDIA_SHIELD_HOST || 'localhost' }) {
    if (!enabled(provider) || !key) return { purged: 0, skipped: true };
    let url; try { url = await presign(provider, key, 300); } catch (err) { return { purged: 0, error: err.message }; }
    const t = target({ provider, url, host: process.env.MEDIA_SHIELD_HOST });
    if (!t) return { purged: 0, skipped: true };
    const refresh = t.replace('/_media_shield/', '/_media_shield_refresh/');
    const slices = Math.max(1, Math.ceil((Number(size) || SLICE_BYTES) / SLICE_BYTES));
    let purged = 0, failed = 0;
    for (let i = 0; i < slices; i++) {
        const range = `bytes=${i * SLICE_BYTES}-${(i + 1) * SLICE_BYTES - 1}`;
        try {
            const r = await fetchImpl(base + refresh, { headers: { Host: host, Range: range }, signal: AbortSignal.timeout(15000) });
            try { await r.arrayBuffer(); } catch { /* drained */ }
            purged++;
        } catch { failed++; }
    }
    return { purged, failed, slices };
}

module.exports = { target, send, purge, enabled, providers, SLICE_BYTES, SHIELD_TTL_SECONDS };
