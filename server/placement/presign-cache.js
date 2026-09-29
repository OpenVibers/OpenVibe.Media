/**
 * OpenVibe.Media — presigned-URL LRU in front of vod-storage.presignGet (placement F1, part 4).
 *
 * Each presign is one Class B op on R2 ($0.36/M); a popular URL is signed many times in a row.
 * Keyed by (provider, key, contentType, contentDisposition, ttl) the LRU caches the URL
 * itself. An entry is valid until 60 s before its TTL expires — close enough to the edge that
 * nobody is ever served an expired URL, but enough head-room that a cached URL was never used
 * within the unsafe last minute.
 *
 *   get(key) -> { url, expiresAt } | null
 *   put(key, url, ttlSeconds)
 *   metrics: bindMetric(fn) to count hits/misses
 *
 * Bounded: at most MAX_ENTRIES entries. Eviction is LRU on put.
 */
'use strict';

const MAX_ENTRIES = 5000;
const SAFETY_MARGIN_MS = 60_000;   // drop an entry this long before its expiry

const cache = new Map();   // key -> { url, expiresAt }
let _inc = () => {};
function bindMetric(fn) { _inc = fn || (() => {}); }

function bucketise(ttlSeconds) {
    if (ttlSeconds <= 60) return '60s';
    if (ttlSeconds <= 300) return '5m';
    if (ttlSeconds <= 900) return '15m';
    if (ttlSeconds <= 3600) return '1h';
    return '>1h';
}

// The exact TTL, not a bucket: a 2-hour URL must never answer a 6-hour request (derive's ffmpeg
// source reads for hours) and expire under it.
function keyOf(provider, key, contentType, contentDisposition, ttlSeconds) {
    return `${provider}|${key}|${contentType || ''}|${contentDisposition || ''}|${Math.round(ttlSeconds)}`;
}

function get(provider, key, contentType, contentDisposition, ttlSeconds) {
    const k = keyOf(provider, key, contentType, contentDisposition, ttlSeconds);
    const e = cache.get(k);
    if (!e) { _inc('media_presign_cache_total', { result: 'miss' }); return null; }
    if (e.expiresAt - Date.now() <= SAFETY_MARGIN_MS) { cache.delete(k); _inc('media_presign_cache_total', { result: 'miss' }); return null; }
    // LRU touch
    cache.delete(k); cache.set(k, e);
    _inc('media_presign_cache_total', { result: 'hit' });
    return e;
}

function put(provider, key, contentType, contentDisposition, ttlSeconds, url) {
    const k = keyOf(provider, key, contentType, contentDisposition, ttlSeconds);
    cache.set(k, { url, expiresAt: Date.now() + ttlSeconds * 1000 });
    if (cache.size > MAX_ENTRIES) {
        // Drop the oldest entry (Map preserves insertion order; re-insert on get keeps things hot).
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
    }
}

function clear() { cache.clear(); }
function size() { return cache.size; }

module.exports = { get, put, clear, size, MAX_ENTRIES, bindMetric };