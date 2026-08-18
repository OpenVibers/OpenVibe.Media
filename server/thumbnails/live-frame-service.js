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

module.exports = { getLiveFrame, CACHE_TTL_MS };
