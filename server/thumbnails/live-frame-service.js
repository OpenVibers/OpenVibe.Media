/**
 * OpenVibe.Media — live frame service
 *
 * Serves a near-realtime JPEG frame of any actively-live stream slot,
 * extracted from the slot's in-progress recording (fragmented mp4 / webm —
 * both readable while still growing). Public dev-facing feature: external
 * APIs, bots, and dashboards can poll a plain URL for "what does this stream
 * look like right now".
 *
 * Rate limiting IS the cache: one extraction per slot per CACHE_TTL_MS window
 * (successes and failures both cached), with concurrent requests for the same
 * slot sharing a single in-flight extraction.
 */
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const db = require('../db/database');

const CACHE_TTL_MS = 5000;
const EXTRACT_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 6000;

// How far behind the tail to seek. The recorder is still writing the last
// fragment, so back off a little to stay inside flushed data.
const LIVE_EDGE_BACKOFF_SEC = 3;

// ── Abuse limits ─────────────────────────────────────────────
// This endpoint spawns ffprobe/ffmpeg per miss, so every knob a caller can turn
// is bounded. The 5s cache is only a rate limit if the CACHE KEY is bounded too:
// `w` used to accept any value in 64..1920, i.e. ~1857 distinct keys per slot,
// so a caller walking `?w=` bypassed the cache entirely and span up two
// processes per request. Widths are therefore quantized to a short ladder.
const WIDTH_LADDER = [160, 320, 480, 640, 960, 1280, 1920];
const MAX_CACHE_ENTRIES = 400;      // hard cap on cached frames/placeholders
const MAX_CONCURRENT_EXTRACTS = 3;  // global ffmpeg ceiling for this endpoint
const RATE_BURST = 30;              // per-IP token bucket
const RATE_REFILL_PER_SEC = 3;
const MAX_RATE_BUCKETS = 5000;

const _cache = new Map();     // key → { at, out }
const _inFlight = new Map();  // key → Promise<out>
let _activeExtracts = 0;

/** Snap a requested width to the nearest allowed rung (null = native size). */
function quantizeWidth(w) {
    const n = parseInt(w, 10);
    if (!Number.isFinite(n)) return null;
    return WIDTH_LADDER.reduce((best, cur) =>
        Math.abs(cur - n) < Math.abs(best - n) ? cur : best, WIDTH_LADDER[0]);
}

// Per-IP token bucket. In-memory and O(1); the map is swept when it grows past
// MAX_RATE_BUCKETS so a spoofed-IP flood cannot grow it without bound.
const _rateBuckets = new Map(); // ip → { tokens, at }
function rateLimitOk(ip) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    let b = _rateBuckets.get(key);
    if (!b) {
        if (_rateBuckets.size >= MAX_RATE_BUCKETS) {
            const cutoff = now - (RATE_BURST / RATE_REFILL_PER_SEC) * 1000;
            for (const [k, v] of _rateBuckets) { if (v.at < cutoff) _rateBuckets.delete(k); }
            // Still full of active talkers → drop the oldest few.
            while (_rateBuckets.size >= MAX_RATE_BUCKETS) {
                const k = _rateBuckets.keys().next().value;
                if (k === undefined) break;
                _rateBuckets.delete(k);
            }
        }
        b = { tokens: RATE_BURST, at: now };
        _rateBuckets.set(key, b);
    }
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_REFILL_PER_SEC);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}

/**
 * Position of the newest written frame, in seconds.
 *
 * A still-recording file has NO duration in its container header (it is written
 * when the muxer finalizes), so `format=duration` reports "N/A" for exactly the
 * files this service exists to read. Reading the LAST video packet's timestamp
 * gives the real tail instead; `-read_intervals 999999%+#1` seeks to the end and
 * reads a single packet, so it costs ~0.1s even on a multi-GB growing file.
 * Falls back to the header duration for finalized files.
 *
 * @returns {Promise<number>} seconds, or 0 if it cannot be determined
 */
function _probeTailSeconds(file) {
    const run = (args) => new Promise((resolve) => {
        let out = '';
        let p;
        try { p = spawn('ffprobe', args); } catch { return resolve(0); }
        const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(0); }, PROBE_TIMEOUT_MS);
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', () => {
            clearTimeout(to);
            const last = String(out).trim().split(/\s+/).filter(Boolean).pop();
            const v = parseFloat(last);
            resolve(Number.isFinite(v) && v > 0 ? v : 0);
        });
        p.on('error', () => { clearTimeout(to); resolve(0); });
    });

    return run(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
        '-of', 'csv=p=0', '-read_intervals', '999999%+#1', file])
        .then((pts) => pts > 0 ? pts : run(['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', file]));
}

function _extractFrame(file, seekSeconds, width) {
    return new Promise((resolve) => {
        const args = ['-v', 'error', '-ss', String(Math.max(0, seekSeconds)), '-i', file, '-vframes', '1'];
        if (width) args.push('-vf', `scale=${width}:-2`);
        args.push('-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1');
        let ff;
        try { ff = spawn('ffmpeg', args); } catch { return resolve(null); }
        const chunks = [];
        const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, EXTRACT_TIMEOUT_MS);
        ff.stdout.on('data', (d) => chunks.push(d));
        ff.on('close', (code) => {
            clearTimeout(to);
            const buf = Buffer.concat(chunks);
            resolve(code === 0 && buf.length > 100 ? buf : null);
        });
        ff.on('error', () => { clearTimeout(to); resolve(null); });
    });
}

async function _grab(appId, managedStreamId, width) {
    const vod = db.get(
        `SELECT file_path FROM vods
         WHERE app_id = ? AND managed_stream_id = ? AND is_recording = 1
         ORDER BY id DESC LIMIT 1`,
        [appId, managedStreamId]
    );
    if (!vod || !vod.file_path || !fs.existsSync(vod.file_path)) {
        return { ok: false, reason: 'not_live' };
    }
    // Global ceiling on concurrent transcodes. Shed load immediately rather than
    // queueing — a queue under attack just turns into unbounded memory + CPU.
    // 'busy' is deliberately NOT cached, so a legitimate caller retries cheaply.
    if (_activeExtracts >= MAX_CONCURRENT_EXTRACTS) return { ok: false, reason: 'busy' };
    _activeExtracts++;
    try {
        // Seek near the live edge; a short back-off keeps us inside written
        // fragments. Previously the tail probe returned 0 for a growing WebM, so
        // this seeked to 0 and served the FIRST frame of the broadcast forever.
        const tail = await _probeTailSeconds(vod.file_path);
        let buf = null;
        if (tail > 0) buf = await _extractFrame(vod.file_path, Math.max(0, tail - LIVE_EDGE_BACKOFF_SEC), width);
        // One fallback only (was three): if the tail is unreadable, take whatever
        // the head has. Each extra attempt is another ffmpeg process per request.
        if (!buf) buf = await _extractFrame(vod.file_path, 0, width);
        return buf ? { ok: true, buf } : { ok: false, reason: 'unavailable' };
    } finally {
        _activeExtracts--;
    }
}

// ── Selector resolution (slot id / slot slug / @username) ────
// Slugs, usernames, and viewer counts are app-side data; the app's public
// /api/streams listing has all three, fetched over loopback and cached 5s.
const APP_INTERNAL_URLS = (() => {
    try { const m = JSON.parse(process.env.APP_INTERNAL_URLS || ''); if (m && typeof m === 'object') return m; } catch { /* */ }
    return { live: process.env.LIVE_APP_INTERNAL_URL || 'http://127.0.0.1:3000' };
})();

const _liveListCache = new Map();   // appId → { at, streams }
async function _appLiveStreams(appId) {
    const hit = _liveListCache.get(appId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.streams;
    const base = APP_INTERNAL_URLS[appId];
    if (!base) return hit?.streams || [];
    try {
        const res = await fetch(`${String(base).replace(/\/+$/, '')}/api/streams`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`streams list ${res.status}`);
        const streams = (await res.json())?.streams || [];
        _liveListCache.set(appId, { at: Date.now(), streams });
        return streams;
    } catch (err) {
        console.warn('[LiveFrame] app streams lookup failed:', err.message);
        return hit?.streams || [];
    }
}

/**
 * Resolve a URL selector to a managed stream slot:
 *   "12"       → slot id 12
 *   "whip"     → the live slot whose slug is "whip"
 *   "@Goosely" → that streamer's top-viewed currently-live slot
 * @returns {Promise<{msid:number, label:string} | {msid:null, label:string}>}
 */
async function resolveSelector(appId, selector) {
    const sel = String(selector || '').trim();
    if (/^\d+$/.test(sel)) return { msid: parseInt(sel, 10), label: `Slot ${sel}` };
    const streams = await _appLiveStreams(appId);
    if (sel.startsWith('@')) {
        const name = sel.slice(1).toLowerCase();
        const mine = streams.filter(s => String(s.username || '').toLowerCase() === name && s.managed_stream_id);
        mine.sort((a, b) => (b.total_viewer_count ?? b.viewer_count ?? 0) - (a.total_viewer_count ?? a.viewer_count ?? 0));
        if (mine.length) return { msid: mine[0].managed_stream_id, label: `@${mine[0].username}` };
        return { msid: null, label: sel };
    }
    const slug = sel.toLowerCase();
    const match = streams.find(s => String(s.managed_stream_slug || '').toLowerCase() === slug && s.managed_stream_id);
    if (match) return { msid: match.managed_stream_id, label: match.managed_stream_slug };
    return { msid: null, label: sel };
}

// ── Offline / unavailable placeholder card (SVG, 640×360) ────
function _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function offlineCardSvg(label, subtitle = 'is offline right now') {
    const name = _esc(String(label || 'stream').slice(0, 40));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f1420"/><stop offset="1" stop-color="#1a2035"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.55">
      <stop offset="0" stop-color="#8b5cf6" stop-opacity="0.22"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="640" height="360" fill="url(#bg)"/>
  <rect width="640" height="360" fill="url(#glow)"/>
  <g transform="translate(320,128)" stroke="#8b5cf6" stroke-width="5" fill="none" opacity="0.9">
    <circle cx="-34" cy="22" r="13"/><circle cx="34" cy="22" r="13"/><circle cx="0" cy="-30" r="13"/>
    <line x1="-24" y1="14" x2="-8" y2="-20"/><line x1="24" y1="14" x2="8" y2="-20"/><line x1="-21" y1="22" x2="21" y2="22"/>
  </g>
  <text x="320" y="216" text-anchor="middle" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="34" font-weight="700" fill="#e6e9f2" letter-spacing="6">OFFLINE</text>
  <text x="320" y="252" text-anchor="middle" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="17" fill="#9aa3b8">${name} ${_esc(subtitle)}</text>
  <text x="320" y="330" text-anchor="middle" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="13" fill="#5b6478" letter-spacing="2">OPENVIBE.LIVE</text>
</svg>`;
}

/**
 * Get a current frame for an actively-live slot.
 * @returns {Promise<{ok:true, buf:Buffer} | {ok:false, reason:'not_live'|'unavailable'}>}
 */
function getLiveFrame(appId, managedStreamId, width = null) {
    const key = `${appId}:${managedStreamId}:${width || 0}`;
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.out);
    if (_inFlight.has(key)) return _inFlight.get(key);

    const p = _grab(appId, managedStreamId, width)
        .catch((err) => {
            console.warn('[LiveFrame] grab failed:', err.message);
            return { ok: false, reason: 'unavailable' };
        })
        .then((out) => {
            // Don't cache load-shedding — it is about server state, not this slot.
            if (out.reason !== 'busy') _cacheSet(key, out);
            _inFlight.delete(key);
            return out;
        });
    _inFlight.set(key, p);
    return p;
}

// Bounded cache write: expire first, then evict oldest-inserted, so the map can
// never grow without limit no matter how many distinct keys are requested.
function _cacheSet(key, out) {
    if (_cache.size >= MAX_CACHE_ENTRIES) {
        const cutoff = Date.now() - CACHE_TTL_MS;
        for (const [k, v] of _cache) { if (v.at < cutoff) _cache.delete(k); }
        while (_cache.size >= MAX_CACHE_ENTRIES) {
            const k = _cache.keys().next().value;
            if (k === undefined) break;
            _cache.delete(k);
        }
    }
    _cache.set(key, { at: Date.now(), out });
}

// The endpoint is frame.jpg — dev pipelines feed the bytes straight into image
// decoders, so the placeholder must be a real JPEG too. Rasterize the SVG card
// via sharp, cached per label (the card for a given name rarely changes).
const _cardCache = new Map();   // `${label}|${subtitle}` → { at, buf }
const CARD_CACHE_TTL_MS = 60_000;
async function offlineCardJpeg(label, subtitle) {
    // The label is caller-controlled (any /live/:sel), so it is both truncated
    // (offlineCardSvg slices to 40) and used in a bounded, expiring cache —
    // otherwise a walk of random names would rasterize unbounded sharp jobs.
    const key = `${label}|${subtitle}`;
    const hit = _cardCache.get(key);
    if (hit && Date.now() - hit.at < CARD_CACHE_TTL_MS) return hit.buf;
    const buf = await require('sharp')(Buffer.from(offlineCardSvg(label, subtitle)))
        .jpeg({ quality: 88 }).toBuffer();
    if (_cardCache.size >= 200) {
        const cutoff = Date.now() - CARD_CACHE_TTL_MS;
        for (const [k, v] of _cardCache) { if (v.at < cutoff) _cardCache.delete(k); }
        while (_cardCache.size >= 200) {
            const k = _cardCache.keys().next().value;
            if (k === undefined) break;
            _cardCache.delete(k);
        }
    }
    _cardCache.set(key, { at: Date.now(), buf });
    return buf;
}

module.exports = {
    getLiveFrame, resolveSelector, offlineCardSvg, offlineCardJpeg, CACHE_TTL_MS,
    quantizeWidth, rateLimitOk,
    // shared with the dev-data API (transcripts / chat insight)
    APP_INTERNAL_URLS, appLiveStreams: _appLiveStreams,
};
