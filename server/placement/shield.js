/**
 * OpenVibe.Media — the origin shield (Media Fabric F1b, docs/media-fabric.md "origin shield").
 *
 * Node still authorizes every read and picks the copy (the placement router); for a public copy on a shielded provider
 * it no longer redirects the viewer to a presigned URL. It answers with `X-Accel-Redirect` into nginx's internal
 * `/_media_shield/<provider>/…` location, which proxies the presigned request through a slice cache (10 MB slices,
 * `proxy_cache_lock`): N viewers of the same object range cost one provider GET, the bytes come from the Media host's
 * prepaid bandwidth, and the provider URL never reaches the viewer. The cache key is the object path and the slice,
 * never the signature (deploy/nginx/media-shield.http.conf, edge.openvibe.media.conf, media-shield-b2-upstream.conf).
 *
 *   MEDIA_SHIELD=b2         providers whose reads go through the shield (comma-separated; empty = off). Set it only
 *                           once nginx has the locations: a Node that emits X-Accel to an nginx without them 404s.
 *   MEDIA_SHIELD_HOST=edge.openvibe.media   the ONLY host the shield answers on: a DNS-only (grey-cloud) edge name.
 *                           openvibe.media is behind Cloudflare's proxy, whose terms for video are not verified (plan
 *                           T4): bytes that went viewer → B2 must not start flowing through Cloudflare. Unset = off.
 *   MEDIA_SHIELD_REFRESH_URL  the loopback-only purge listener (default http://127.0.0.1:8479).
 *
 * The edge is known from `X-Media-Shield-Host`, which only the edge server block sets (from its own $host) and every
 * other Media server block clears: never from Host or X-Forwarded-Host, which a client can choose (Express's
 * req.hostname honours X-Forwarded-Host under `trust proxy`). nginx proxies to ONE B2 host (B2_UPSTREAM_HOST, equal to
 * deploy/nginx/media-shield-b2-upstream.conf, a test pins it) and SigV4 signs the Host header, so a URL signed for any
 * other host (MEDIA_B2_ENDPOINT changed) is never shielded: it keeps its 302 instead of failing every slice with a 403.
 *
 * Rules: private and sandbox bytes never enter the shared cache; B2 only for now (path-style URLs, one signed host; R2
 * waits for F2's port-utilization guard); the shield's presign lives six hours (it stays inside nginx, and a long
 * response fetches later slices with it), the viewer-facing 302 keeps its short TTL.
 *
 *   onEdge(req)                                     → true on the edge host (check it before presigning anything)
 *   toEdge(req, provider)                           → 'https://<edge><same path>' for a shield-eligible read that came in
 *                                                     on openvibe.media, else null: viewers keep requesting the one
 *                                                     public URL and a tiny 302 through Cloudflare moves them to the
 *                                                     edge, where the bytes come from the shield
 *   target({ provider, url, visibility, sandbox, edge })  → '/_media_shield/b2/<bucket>/<key>?<signed query>' | null
 *   send(res, target, headers)                      → the 200 + X-Accel-Redirect answer
 *   await purge({ provider, key, size, presign })   → refreshes every cached slice of a deleted or replaced object
 */
'use strict';

const SLICE_BYTES = 10 * 1024 * 1024;           // nginx `slice 10m`
const SHIELD_TTL_SECONDS = 6 * 3600;            // inside nginx only; covers a long response's later slices
const B2_UPSTREAM_HOST = 's3.us-west-004.backblazeb2.com';   // = deploy/nginx/media-shield-b2-upstream.conf
const UPSTREAM_HOSTS = { b2: B2_UPSTREAM_HOST };
const EDGE_HEADER = 'x-media-shield-host';      // set by the edge server block only (nginx)
const PURGE_CONCURRENCY = 4;

function providers() {
    return String(process.env.MEDIA_SHIELD || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function enabled(provider) { return providers().includes(String(provider || '').toLowerCase()); }

function edgeHost() { return String(process.env.MEDIA_SHIELD_HOST || '').trim().toLowerCase(); }
/** The edge name nginx vouched for on this request (X-Media-Shield-Host), or null. */
function edgeOf(req) { const v = req && typeof req.get === 'function' ? req.get(EDGE_HEADER) : null; return v ? String(v).trim().toLowerCase() : null; }
/** True when this request came in on the edge host: routes check it before presigning anything for the shield. */
function onEdge(req) { const want = edgeHost(); return !!want && edgeOf(req) === want; }

/** Where to send a shield-eligible read that arrived on the proxied host (callers check visibility and sandbox). */
function toEdge(req, provider) {
    const edge = edgeHost();
    if (!edge || !enabled(provider) || onEdge(req)) return null;
    const p = String((req && (req.originalUrl || req.url)) || '');
    return p.startsWith('/') && !p.startsWith('//') ? `https://${edge}${p}` : null;
}

/** The internal location for one presigned URL, or null when this read must not go through the shield. `edge` is
 *  edgeOf(req): the shield answers only on MEDIA_SHIELD_HOST (a DNS-only edge name), never through Cloudflare. */
function target({ provider, url, visibility = 'public', sandbox = false, edge = null }) {
    if (!url || !enabled(provider)) return null;
    const want = edgeHost();
    if (!want || String(edge || '').toLowerCase() !== want) return null;
    if (visibility === 'private' || sandbox) return null;           // never into a shared cache
    let u; try { u = new URL(url); } catch { return null; }
    // Path-style URLs for the one host nginx proxies to (the signature covers Host): /<bucket>/<key>.
    if (u.host.toLowerCase() !== UPSTREAM_HOSTS[String(provider).toLowerCase()]) return null;
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
 * 10 MB slice to nginx's loopback-only refresh listener (a few at a time), which bypasses the cache and stores the
 * provider's answer (new bytes for a replaced object; a 404 for a deleted one, cached for a minute). Never throws;
 * returns what it did. The listener is the only server on its port, so no Host header is needed (fetch drops it).
 */
async function purge({ provider, key, size, presign, fetchImpl = globalThis.fetch, base = process.env.MEDIA_SHIELD_REFRESH_URL || 'http://127.0.0.1:8479', concurrency = PURGE_CONCURRENCY }) {
    if (!enabled(provider) || !key || !edgeHost()) return { purged: 0, skipped: true };
    let url; try { url = await presign(provider, key, 300); } catch (err) { return { purged: 0, error: err.message }; }
    const t = target({ provider, url, edge: edgeHost() });
    if (!t) return { purged: 0, skipped: true };
    const refresh = t.replace('/_media_shield/', '/_media_shield_refresh/');
    const slices = Math.max(1, Math.ceil((Number(size) || SLICE_BYTES) / SLICE_BYTES));
    let purged = 0, failed = 0, next = 0;
    async function worker() {
        while (next < slices) {
            const i = next++;
            const range = `bytes=${i * SLICE_BYTES}-${(i + 1) * SLICE_BYTES - 1}`;
            try {
                const r = await fetchImpl(base + refresh, { headers: { Range: range }, signal: AbortSignal.timeout(15000) });
                try { await r.arrayBuffer(); } catch { /* drained */ }
                purged++;
            } catch { failed++; }
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, slices)) }, worker));
    return { purged, failed, slices };
}

module.exports = { target, send, purge, enabled, providers, onEdge, edgeOf, toEdge, SLICE_BYTES, SHIELD_TTL_SECONDS, B2_UPSTREAM_HOST, EDGE_HEADER };
