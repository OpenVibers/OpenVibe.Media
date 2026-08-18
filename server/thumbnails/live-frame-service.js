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

const _cache = new Map();     // key → { at, out }
const _inFlight = new Map();  // key → Promise<out>

function _probeDuration(file) {
    return new Promise((resolve) => {
        let out = '';
        let p;
        try {
            p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', file]);
        } catch { return resolve(0); }
        const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(0); }, PROBE_TIMEOUT_MS);
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', () => { clearTimeout(to); resolve(parseFloat(out) || 0); });
        p.on('error', () => { clearTimeout(to); resolve(0); });
    });
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
    // Seek near the live edge; a short back-off keeps us inside written fragments.
    const duration = await _probeDuration(vod.file_path);
    let buf = await _extractFrame(vod.file_path, Math.max(0, duration - 2), width);
    if (!buf && duration > 4) buf = await _extractFrame(vod.file_path, Math.max(0, duration / 2), width);
    if (!buf) buf = await _extractFrame(vod.file_path, 0, width);
    return buf ? { ok: true, buf } : { ok: false, reason: 'unavailable' };
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
            _cache.set(key, { at: Date.now(), out });
            _inFlight.delete(key);
            // Opportunistic sweep so dead slots don't accumulate.
            if (_cache.size > 500) {
                const cutoff = Date.now() - CACHE_TTL_MS;
                for (const [k, v] of _cache) { if (v.at < cutoff) _cache.delete(k); }
            }
            return out;
        });
    _inFlight.set(key, p);
    return p;
}

// The endpoint is frame.jpg — dev pipelines feed the bytes straight into image
// decoders, so the placeholder must be a real JPEG too. Rasterize the SVG card
// via sharp, cached per label (the card for a given name rarely changes).
const _cardCache = new Map();   // `${label}|${subtitle}` → { at, buf }
const CARD_CACHE_TTL_MS = 60_000;
async function offlineCardJpeg(label, subtitle) {
    const key = `${label}|${subtitle}`;
    const hit = _cardCache.get(key);
    if (hit && Date.now() - hit.at < CARD_CACHE_TTL_MS) return hit.buf;
    const buf = await require('sharp')(Buffer.from(offlineCardSvg(label, subtitle)))
        .jpeg({ quality: 88 }).toBuffer();
    if (_cardCache.size > 200) _cardCache.clear();
    _cardCache.set(key, { at: Date.now(), buf });
    return buf;
}

module.exports = {
    getLiveFrame, resolveSelector, offlineCardSvg, offlineCardJpeg, CACHE_TTL_MS,
    // shared with the dev-data API (transcripts / chat insight)
    APP_INTERNAL_URLS, appLiveStreams: _appLiveStreams,
};
