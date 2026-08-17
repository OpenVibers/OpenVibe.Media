/**
 * OpenVibe.Media — Universal Thumbnail Service
 *
 * Handles thumbnail generation, storage, and serving for:
 *   • Live streams  — JPEG frames POSTed by the owning app's broadcaster
 *                     (stable per-app/id filename, refreshed in place)
 *   • VODs          — extracted via ffmpeg at ~10% into the video
 *   • Clips         — extracted via ffmpeg near the first frames
 *
 * Thumbnails are stored as JPEGs in THUMBNAILS_PATH and served publicly at
 * GET /t/:id (id = filename). The vods/clips `thumbnail_url` column holds the
 * public path (e.g. "/t/vod-3-1672531200.jpg").
 *
 * The predecessor's server-side live grabbers (RTMP-FLV / JSMPEG-WS / SFU
 * PlainRTP) are dropped — live sources belong to the apps now; apps push
 * frames via POST /api/v1/:app/thumbnails/live/:id instead.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('../config');
const db = require('../db/database');

// ── Constants ────────────────────────────────────────────────
const THUMB_DIR = path.resolve(config.thumbnails.path);
const THUMB_WIDTH = 640;
const THUMB_QUALITY = 6; // ffmpeg qscale:v  (2=best, 31=worst, 6 is good balance)
const CLIENT_THUMB_WRITE_MIN_INTERVAL_MS = 15000;

if (!fs.existsSync(THUMB_DIR)) {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
}

// ── Generate Thumbnail from Video File (VODs & Clips) ────────
const _activeThumbJobs = new Set(); // Dedup concurrent VOD/clip thumbnail generation

/**
 * Extract a thumbnail frame from a video file using ffmpeg.
 * @param {string} videoPath  – Absolute path (or presigned URL) of the video
 * @param {string} prefix     – Filename prefix ('vod' or 'clip')
 * @param {number} entityId   – DB id (vod or clip id)
 * @param {object} opts       – { seekPercent?, seekSeconds? }
 * @returns {Promise<string|null>} public thumbnail URL (/t/<file>), or null
 */
function generateFromVideo(videoPath, prefix, entityId, opts = {}) {
    const jobKey = `${prefix}-${entityId}`;
    if (_activeThumbJobs.has(jobKey)) {
        return Promise.resolve(null); // Already generating for this entity
    }
    _activeThumbJobs.add(jobKey);

    return new Promise((resolve) => {
        const isUrl = /^https?:\/\//i.test(String(videoPath || ''));
        if (!videoPath || (!isUrl && !fs.existsSync(videoPath))) {
            _activeThumbJobs.delete(jobKey);
            return resolve(null);
        }

        const outFilename = `${prefix}-${entityId}-${Date.now()}.jpg`;
        const outPath = path.join(THUMB_DIR, outFilename);

        // First, probe the duration
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json', '-show_format', videoPath,
        ]);
        let probeData = '';
        probe.stdout.on('data', (d) => (probeData += d));

        probe.on('close', (probeCode) => {
            let seekTime = opts.seekSeconds || 1;

            if (probeCode === 0 && !opts.seekSeconds) {
                try {
                    const info = JSON.parse(probeData);
                    const duration = parseFloat(info.format?.duration || '0');
                    if (duration > 2) {
                        seekTime = Math.min(
                            duration * ((opts.seekPercent || 10) / 100),
                            duration - 0.5
                        );
                    }
                } catch {}
            }

            // Extract frame
            const args = [
                '-y',
                '-ss', String(Math.max(0, seekTime)),
                '-i', videoPath,
                '-vframes', '1',
                '-vf', `scale=${THUMB_WIDTH}:-1`,
                '-q:v', String(THUMB_QUALITY),
                outPath,
            ];

            const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
            const killTimer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, isUrl ? 35000 : 20000);
            ff.on('close', (code) => {
                clearTimeout(killTimer);
                if (code === 0 && fs.existsSync(outPath)) {
                    resolve(`/t/${outFilename}`);
                } else {
                    resolve(null);
                }
            });
            ff.on('error', () => { clearTimeout(killTimer); resolve(null); });
        });

        probe.on('error', () => resolve(null));
    }).finally(() => _activeThumbJobs.delete(jobKey));
}

// ── Generate VOD Thumbnail (~10% in) ─────────────────────────
async function generateVodThumbnail(vodId, filePath) {
    const thumbUrl = await generateFromVideo(filePath, 'vod', vodId, { seekPercent: 10 });
    if (thumbUrl) {
        // Clean up the previous thumbnail for this VOD
        _removeOldThumb(db.get('SELECT thumbnail_url FROM vods WHERE id = ?', [vodId])?.thumbnail_url, thumbUrl);
        db.run('UPDATE vods SET thumbnail_url = ? WHERE id = ?', [thumbUrl, vodId]);
    }
    return thumbUrl;
}

// ── Generate Clip Thumbnail (first frames) ───────────────────
async function generateClipThumbnail(clipId, filePath) {
    const thumbUrl = await generateFromVideo(filePath, 'clip', clipId, { seekSeconds: 0.5 });
    if (thumbUrl) {
        _removeOldThumb(db.get('SELECT thumbnail_url FROM clips WHERE id = ?', [clipId])?.thumbnail_url, thumbUrl);
        db.run('UPDATE clips SET thumbnail_url = ? WHERE id = ?', [thumbUrl, clipId]);
    }
    return thumbUrl;
}

function _removeOldThumb(oldUrl, newUrl) {
    if (!oldUrl || oldUrl === newUrl) return;
    const oldFile = path.join(THUMB_DIR, path.basename(oldUrl));
    try { if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile); } catch { /* */ }
}

// ── Save Live Stream Thumbnail (POSTed by the owning app) ────
/**
 * Save a live-stream thumbnail for an app's stream. Accepts a Buffer of
 * JPEG/PNG data or a base64 string (with or without data: prefix). Stored
 * under a STABLE filename (stream-<app>-<id>.jpg) refreshed in place so the
 * URL is stable and files never accumulate.
 * @returns {string|null} public thumbnail URL, or null on failure
 */
function saveLiveThumbnail(appId, streamId, imageData) {
    try {
        const filename = `stream-${appId}-${streamId}.jpg`;
        const outPath = path.join(THUMB_DIR, filename);

        // Rate-limit rewrites (the predecessor's client-write cooldown)
        try {
            const stat = fs.statSync(outPath);
            if (Date.now() - stat.mtimeMs < CLIENT_THUMB_WRITE_MIN_INTERVAL_MS) {
                return `/t/${filename}`;
            }
        } catch { /* no existing file */ }

        let buffer;
        if (Buffer.isBuffer(imageData)) {
            buffer = imageData;
        } else if (typeof imageData === 'string') {
            const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
            buffer = Buffer.from(base64, 'base64');
        } else {
            return null;
        }

        // Validate it's a JPEG (FF D8) or PNG (89 50)
        if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
            if (buffer.length < 4 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
                console.warn('[Thumbnails] Invalid image data for stream', streamId);
                return null;
            }
        }

        fs.writeFileSync(outPath, buffer);
        return `/t/${filename}`;
    } catch (err) {
        console.error('[Thumbnails] Save live thumbnail error:', err.message);
        return null;
    }
}

// ── Serve Thumbnail File (public /t/:id) ─────────────────────
function serveThumbnail(req, res) {
    try {
        const filename = path.basename(req.params.id || req.params.filename || ''); // prevent traversal
        const filePath = path.join(THUMB_DIR, filename);

        if (!filename || !fs.existsSync(filePath)) {
            // Return a 1x1 transparent pixel JPEG as fallback
            const pixel = Buffer.from(
                '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA=',
                'base64'
            );
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': pixel.length,
                'Cache-Control': 'no-cache',
                'X-Robots-Tag': 'noindex',
            });
            return res.end(pixel);
        }

        const stat = fs.statSync(filePath);
        const ext = path.extname(filename).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

        // Cache briefly for live thumbnails, longer for VOD/clip
        const isLive = filename.startsWith('stream-');
        const maxAge = isLive ? 30 : 86400;

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Cache-Control': `public, max-age=${maxAge}`,
            'X-Robots-Tag': 'noindex',
        });
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: 'Failed to serve thumbnail' });
    }
}

// ── Cleanup Old Live Thumbnails ──────────────────────────────
/**
 * Remove live-stream thumbnails not refreshed within `maxAgeMs` (default 24h —
 * filenames are stable per stream, so this only reaps dead streams).
 */
function cleanupOldThumbnails(maxAgeMs = 24 * 3600000) {
    try {
        const files = fs.readdirSync(THUMB_DIR);
        const now = Date.now();
        let cleaned = 0;

        for (const file of files) {
            // Only auto-clean live stream thumbs (vod/clip thumbs are permanent)
            if (!file.startsWith('stream-')) continue;

            const filePath = path.join(THUMB_DIR, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
                fs.unlinkSync(filePath);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[Thumbnails] Cleaned up ${cleaned} old live thumbnails`);
        }
    } catch (err) {
        console.error('[Thumbnails] Cleanup error:', err.message);
    }
}

/**
 * Extract one frame to an arbitrary file. `source` may be a local path OR an
 * http(s) URL (e.g. a presigned B2/R2 URL) — with `-ss` before `-i`, ffmpeg
 * seeks via HTTP range requests and only pulls the bytes around that
 * timestamp, so remote/cold VODs work without downloading. Resolves boolean.
 */
function extractFrameToFile(source, seekSeconds, outAbsPath) {
    return new Promise((resolve) => {
        const isUrl = /^https?:\/\//i.test(String(source || ''));
        if (!source || (!isUrl && !fs.existsSync(source))) return resolve(false);
        try { fs.mkdirSync(path.dirname(outAbsPath), { recursive: true }); } catch { /* */ }
        const args = ['-y', '-ss', String(Math.max(0.5, Number(seekSeconds) || 1)), '-i', source,
            '-vframes', '1', '-vf', `scale=${THUMB_WIDTH}:-1`, '-q:v', String(THUMB_QUALITY), outAbsPath];
        const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
        const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } resolve(false); }, isUrl ? 35000 : 15000);
        ff.on('close', (code) => { clearTimeout(to); resolve(code === 0 && fs.existsSync(outAbsPath)); });
        ff.on('error', () => { clearTimeout(to); resolve(false); });
    });
}

module.exports = {
    generateFromVideo,
    generateVodThumbnail,
    generateClipThumbnail,
    saveLiveThumbnail,
    serveThumbnail,
    cleanupOldThumbnails,
    extractFrameToFile,
    THUMB_DIR,
};
