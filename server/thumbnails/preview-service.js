/**
 * OpenVibe.Media — hover previews (6 s, muted, 320 px wide)
 *
 * A finished recording or clip gets a short preview beside its thumbnail, for the hover/centred player the design
 * puts on cards (plan 355): `vod-<id>-<time>.mp4` (H.264) and `.webm` (VP9, VP8 when this ffmpeg has no VP9), both
 * in THUMB_DIR, both served at GET /t/<name> (the thumbnail origin; /p/ belongs to Community's paste URLs). The row's
 * preview_url is the MP4 (every browser plays it) and
 * preview_webm_url the WebM of the same moment. Files are made by the preview.make job (server/jobs/preview.js)
 * and only for public/unlisted, non-audio-only items.
 *
 * The name follows the thumbnail convention, so the file can be found from the item and the item from the name.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');

const PREVIEW_DIR = path.resolve(config.thumbnails.path);
const PREVIEW_WIDTH = 320;
const PREVIEW_SECONDS = 6;
const MAX_BYTES = 400 * 1024;
const NAME_RE = /^(vod|clip)-(\d{1,15})-\d{10,}\.(mp4|webm)$/;
const CONTENT_TYPE = { mp4: 'video/mp4', webm: 'video/webm' };

// A deleted item's preview must stop answering (as a deleted item's thumbnail does). Asked per item, remembered a minute.
const ITEM_TTL_MS = 60 * 1000;
const _items = new Map();   // 'vod:12' → { at, ok }
async function itemServable(kind, id) {
    const key = `${kind}:${id}`;
    const hit = _items.get(key);
    if (hit && Date.now() - hit.at < ITEM_TTL_MS) return hit.ok;
    let ok = false;
    try {
        const row = await db.get(`SELECT visibility, is_public FROM ${kind === 'vod' ? 'vods' : 'clips'} WHERE id = ?`, [id]);
        ok = !!row && (row.visibility || (Number(row.is_public) ? 'public' : 'private')) !== 'private';
    } catch { ok = true; }   // no database to ask (a test, a drill): serve as before
    if (_items.size > 5000) _items.clear();
    _items.set(key, { at: Date.now(), ok });
    return ok;
}

/** The public URL of a written preview file. */
const previewUrl = (name) => `/t/${name}`;

/** The file name of a new preview for `kind`/`id` at `stamp` (the same stamp for both formats). */
function previewNames(kind, id, stamp = Date.now()) {
    return { mp4: `${kind}-${id}-${stamp}.mp4`, webm: `${kind}-${id}-${stamp}.webm` };
}

/** Remove the preview files a row used before (the old pair follows a regeneration). */
function removePreviewFiles(...urls) {
    for (const url of urls) {
        if (!url) continue;
        const name = path.basename(String(url));
        if (!NAME_RE.test(name)) continue;
        try { fs.unlinkSync(path.join(PREVIEW_DIR, name)); } catch { /* gone */ }
    }
}

/** Parse a Range header against a size: { start, end } or null (invalid / not a range). */
function parseRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!m || (!m[1] && !m[2])) return null;
    let start, end;
    if (!m[1]) {                       // bytes=-500: the last 500 bytes
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
    return { start, end: Math.min(end, size - 1) };
}

/** GET /p/:id — one stored preview. Range requests are answered (a <video> seeking asks for one). */
async function servePreview(req, res) {
    if (require('../drill').refuseBytes(res)) return;
    const name = path.basename(String(req.params.id || ''));
    const m = NAME_RE.exec(name);
    if (!m) return res.status(404).end();
    if (!await itemServable(m[1], Number(m[2]))) return res.status(404).end();
    const file = path.join(PREVIEW_DIR, name);
    let stat;
    try { stat = fs.statSync(file); if (!stat.isFile()) throw new Error('not a file'); } catch { return res.status(404).end(); }
    const type = CONTENT_TYPE[m[3]];
    res.set({
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex',
    });
    const range = parseRange(req.headers.range, stat.size);
    if (req.headers.range && !range) {
        res.status(416).set('Content-Range', `bytes */${stat.size}`);
        return res.end();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;
    res.status(range ? 206 : 200);
    res.set('Content-Length', String(end - start + 1));
    if (range) res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    const stream = fs.createReadStream(file, { start, end });
    const done = () => { try { stream.destroy(); } catch { /* */ } };
    res.on('close', done); res.on('finish', done); res.on('error', done);
    stream.on('error', () => { try { res.destroy(); } catch { /* */ } });
    stream.pipe(res);
}

module.exports = {
    PREVIEW_DIR, PREVIEW_WIDTH, PREVIEW_SECONDS, MAX_BYTES, NAME_RE,
    previewUrl, previewNames, removePreviewFiles, parseRange, servePreview, itemServable,
};
