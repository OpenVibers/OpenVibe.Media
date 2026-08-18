/**
 * OpenVibe.Media — Public serving routes (no auth unless the item is private)
 *
 * GET /v/:id             VOD playback: local stream w/ Range, or 302 presigned
 *                        B2/R2 (inherited logic). Live recordings serve the
 *                        fully-indexed .seekable sidecar for DVR.
 * GET /c/:id             clip playback (same tiering/range logic)
 * GET /p/:slug           paste HTML page (indexable)
 * GET /p/:slug/raw       paste raw text
 * GET /p/:slug/screenshot paste screenshot image
 * GET /t/:id             thumbnails (id = filename)
 * GET /f/:key            files with correct Content-Type + Range
 *
 * /v /c /t /f carry X-Robots-Tag: noindex — the owning app has the canonical
 * page. Pastes are Media-canonical and stay indexable.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const tools = require('../vod/media-tools');
const { optionalIdentity } = require('../auth');

const router = express.Router();

const MIME_TYPES = {
    '.webm': 'video/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

function getRequesterIp(req) {
    return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

function trackUniqueView(kind, id, req) {
    try {
        const ip = getRequesterIp(req);
        const inserted = db.run(
            'INSERT OR IGNORE INTO content_views (content_type, content_id, ip) VALUES (?, ?, ?)',
            [kind, id, ip]
        );
        if (inserted.changes > 0) {
            const count = db.get('SELECT COUNT(*) as c FROM content_views WHERE content_type = ? AND content_id = ?', [kind, id]);
            const table = kind === 'vod' ? 'vods' : 'clips';
            db.run(`UPDATE ${table} SET view_count = ? WHERE id = ?`, [count.c, id]);
        }
    } catch { /* non-critical */ }
}

function canAccessPrivate(record, req) {
    // Private items: the owning app (its API key) or the owning user's JWT.
    if (req.authType === 'app' && req.appId === record.app_id) return true;
    if (req.authType === 'user' && req.userId != null && record.user_id === req.userId) return true;
    return false;
}

function streamFileWithRange(req, res, filePath, extraHeaders = {}) {
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        if (start >= stat.size || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, ...extraHeaders });
            return res.end();
        }
        const chunkSize = Math.min(end, stat.size - 1) - start + 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${Math.min(end, stat.size - 1)}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
            ...extraHeaders,
        });
        fs.createReadStream(filePath, { start, end: Math.min(end, stat.size - 1) }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            ...extraHeaders,
        });
        fs.createReadStream(filePath).pipe(res);
    }
}

/**
 * Serve a vods/clips row: local file (Range + live-DVR sidecar) or 302
 * presigned B2/R2 — the inherited playback logic.
 */
async function serveMediaRecord(kind, record, req, res) {
    const vodStorage = require('../vod/vod-storage');
    const noindex = { 'X-Robots-Tag': 'noindex' };

    const visibility = record.visibility || (record.is_public ? 'public' : 'private');
    if (visibility === 'private' && !canAccessPrivate(record, req)) {
        return res.status(403).json({ error: 'This media is private' });
    }

    trackUniqueView(kind, record.id, req);

    // Track last access time for storage tier decisions
    if (kind === 'vod') {
        try { db.run("UPDATE vods SET last_accessed_at = datetime('now') WHERE id = ?", [record.id]); } catch {}
    }

    // Resolve the local file. Clips keep their own absolute path; VODs resolve
    // by basename under VOD_PATH (legacy rows carry old absolute paths).
    let filePath = null;
    if (record.file_path) {
        const candidates = kind === 'vod'
            ? [vodStorage.localPathForVod(record), record.file_path]
            : [record.file_path, path.join(path.resolve(require('../config').vod.clipsPath), path.basename(record.file_path))];
        for (const p of candidates) {
            if (p && fs.existsSync(p)) { filePath = p; break; }
        }
    }

    // Offloaded (B2/R2) — redirect to a presigned object-store URL. Range
    // requests are handled natively by the object store.
    if (!filePath && vodStorage.isRemote(record)) {
        const plan = await vodStorage.resolvePlayback(record);
        if (plan?.kind === 'redirect') {
            res.set('Cache-Control', 'private, max-age=0');
            res.set('X-Robots-Tag', 'noindex');
            return res.redirect(302, plan.url);
        }
        if (plan?.kind === 'file') filePath = plan.path;
    }

    if (!filePath) return res.status(404).json({ error: 'Media file unavailable' });

    // For a live recording, serve the fully-indexed seekable sidecar so DVR
    // viewers can seek anywhere.
    const seekablePath = tools.seekableSidecarPath(filePath);
    const isLiveSeekable = !!record.is_recording && !!seekablePath && seekablePath !== filePath && fs.existsSync(seekablePath);
    if (isLiveSeekable) filePath = seekablePath;
    // A still-recording MP4 grows in place — serve it no-cache so the player
    // keeps discovering new bytes (DVR to the live edge).
    const isLiveMp4 = !!record.is_recording && filePath.endsWith('.mp4');

    const cacheHeaders = (isLiveSeekable || isLiveMp4)
        ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
        : {};

    streamFileWithRange(req, res, filePath, { ...cacheHeaders, ...noindex });
}

// ── VOD playback ─────────────────────────────────────────────
// Accepts a numeric id OR a legacy file basename (old /api/vods/file/<name>
// URLs in the wild redirect here with the basename; migrated rows keep their
// original file_path basenames). The old route served CLIP files too, so a
// basename that matches a clip serves that clip.
router.get('/v/:id', optionalIdentity, async (req, res) => {
    try {
        if (/^\d+$/.test(req.params.id)) {
            const vod = db.getVodById(parseInt(req.params.id, 10));
            if (!vod || vod.clips_only) return res.status(404).json({ error: 'Not found' });
            return await serveMediaRecord('vod', vod, req, res);
        }
        const vod = db.getVodByFileBasename(req.params.id);
        if (vod && !vod.clips_only) return await serveMediaRecord('vod', vod, req, res);
        const clip = db.getClipByFileBasename(req.params.id);
        if (clip) return await serveMediaRecord('clip', clip, req, res);
        res.status(404).json({ error: 'Not found' });
    } catch (err) {
        console.error('[Public] /v error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve media' });
    }
});

// ── Clip playback ────────────────────────────────────────────
router.get('/c/:id', optionalIdentity, async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const clip = db.getClipById(parseInt(req.params.id, 10));
        if (!clip || !clip.file_path) return res.status(404).json({ error: 'Not found' });
        await serveMediaRecord('clip', clip, req, res);
    } catch (err) {
        console.error('[Public] /c error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve media' });
    }
});

// ── Thumbnails ───────────────────────────────────────────────
router.get('/t/:id', (req, res) => {
    require('../thumbnails/thumbnail-service').serveThumbnail(req, res);
});

// ── Live frame API (public, dev-facing) ──────────────────────
// GET /live/:msid/frame.jpg[?w=640][&app=live] — a near-realtime JPEG frame of
// an actively-live stream slot, extracted from its in-progress recording.
// Cached 5s per slot (that cache IS the rate limit); CORS-open so external
// APIs, bots, and dashboards can poll it directly.
router.get('/live/:msid/frame.jpg', async (req, res) => {
    try {
        const msid = parseInt(req.params.msid, 10);
        if (!Number.isFinite(msid) || msid <= 0) return res.status(400).json({ error: 'Bad slot id' });
        const appId = String(req.query.app || 'live');
        let w = parseInt(req.query.w, 10);
        w = Number.isFinite(w) ? Math.min(1920, Math.max(64, w)) : null;

        const out = await require('../thumbnails/live-frame-service').getLiveFrame(appId, msid, w);
        res.set('Access-Control-Allow-Origin', '*');
        if (!out.ok) {
            return res.status(out.reason === 'not_live' ? 404 : 503)
                .json({ error: out.reason === 'not_live' ? 'Slot is not live' : 'Frame unavailable' });
        }
        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': out.buf.length,
            'Cache-Control': 'public, max-age=5',
            'X-Robots-Tag': 'noindex',
        });
        res.end(out.buf);
    } catch (err) {
        console.error('[Public] /live frame error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to grab frame' });
    }
});

// ── Legacy thumbnail URLs ────────────────────────────────────
// Old-stack thumbnails lived at /api/thumbnails/<basename>, and migrated Live
// rows still carry those absolute URLs. Basenames change when a thumbnail is
// regenerated, so resolve the vod/clip id from the name and redirect to the
// current canonical URL; serve the exact file when it still exists.
router.get('/api/thumbnails/:name', (req, res) => {
    const name = path.basename(String(req.params.name || ''));
    const m = /^(vod|clip)-(\d+)-\d+\.(?:jpg|jpeg|png)$/i.exec(name);
    if (m) {
        const row = m[1].toLowerCase() === 'vod'
            ? db.getVodById(parseInt(m[2], 10), 'live')
            : db.getClipById(parseInt(m[2], 10), 'live');
        if (row && row.thumbnail_url && !row.thumbnail_url.endsWith(`/${name}`)) {
            return res.redirect(302, row.thumbnail_url);
        }
    }
    req.params.id = name;
    require('../thumbnails/thumbnail-service').serveThumbnail(req, res);
});

// ── Paste screenshots by filename ────────────────────────────
// Legacy /data/pastes/screenshots/<name> URLs (old avatars, hero moments,
// pre-cutover pastes) map here. Migrated screenshot files have arbitrary
// basenames on disk and NO files-table rows, so this serves straight from
// PASTES_PATH/screenshots for exactly that namespace.
router.get('/f/screenshots/:name', (req, res) => {
    try {
        const name = path.basename(String(req.params.name || ''));
        const dir = path.join(require('../config').pastes.path, 'screenshots');
        const filePath = path.join(dir, name);
        if (!name || !filePath.startsWith(dir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return res.status(404).json({ error: 'Not found' });
        }
        streamFileWithRange(req, res, filePath, { 'Cache-Control': 'public, max-age=86400', 'X-Robots-Tag': 'noindex' });
    } catch (err) {
        console.error('[Public] /f/screenshots error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve file' });
    }
});

// ── Files ────────────────────────────────────────────────────
router.get('/f/:key', (req, res) => {
    try {
        const row = db.getFileByKey(String(req.params.key));
        if (!row) return res.status(404).json({ error: 'Not found' });
        const filesRoutes = require('../files/routes');
        const filePath = filesRoutes.filePathForKey(row);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        const contentType = row.mime || 'application/octet-stream';
        const headers = {
            'X-Robots-Tag': 'noindex',
            'Cache-Control': 'public, max-age=86400',
        };
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10) || 0;
            const end = parts[1] ? Math.min(parseInt(parts[1], 10), stat.size - 1) : stat.size - 1;
            if (start >= stat.size || end < start) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, ...headers });
                return res.end();
            }
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': contentType,
                ...headers,
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                ...headers,
            });
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (err) {
        console.error('[Public] /f error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve file' });
    }
});

// ── Pastes ───────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPastePage(paste) {
    const title = escapeHtml(paste.title || 'Untitled');
    const isScreenshot = paste.type === 'screenshot' && paste.screenshot_path;
    const body = isScreenshot
        ? `<figure class="shot"><img src="/p/${escapeHtml(paste.slug)}/screenshot" alt="${title}"></figure>
           ${paste.content ? `<p class="desc">${escapeHtml(paste.content)}</p>` : ''}`
        : `<pre class="code" data-language="${escapeHtml(paste.language || 'text')}"><code>${escapeHtml(paste.content || '')}</code></pre>`;
    const created = escapeHtml(String(paste.created_at || ''));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — OpenVibe.Media</title>
<meta name="description" content="${title} — shared via OpenVibe.Media pastes">
<style>
  :root { --accent: #8b5cf6; --accent-light: #a78bfa; --bg: #131318; --panel: #1b1b22; --text: #e8e8ee; --muted: #9a9aa8; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  header { display: flex; align-items: center; gap: .6rem; padding: .8rem 1.2rem; border-bottom: 1px solid #26262f; }
  header .brand { font-weight: 700; color: var(--accent-light); text-decoration: none; font-size: 1.05rem; }
  header .brand span { color: var(--text); }
  main { max-width: 960px; margin: 0 auto; padding: 1.2rem; }
  h1 { font-size: 1.3rem; margin: .2rem 0 .3rem; }
  .meta { color: var(--muted); font-size: .85rem; margin-bottom: 1rem; }
  .meta a { color: var(--accent-light); text-decoration: none; }
  .code { background: var(--panel); border: 1px solid #26262f; border-radius: 10px; padding: 1rem 1.2rem; overflow-x: auto; white-space: pre; font: 13px/1.5 ui-monospace, 'Cascadia Code', Menlo, monospace; }
  .shot img { max-width: 100%; border-radius: 10px; border: 1px solid #26262f; }
  .desc { color: var(--muted); }
  footer { max-width: 960px; margin: 0 auto; padding: 1rem 1.2rem 2rem; color: var(--muted); font-size: .82rem; }
  footer a { color: var(--accent-light); text-decoration: none; }
</style>
</head>
<body>
<header>
  <a class="brand" href="https://openvibe.network">OpenVibe<span>.Media</span></a>
</header>
<main>
  <h1>${title}</h1>
  <p class="meta">${escapeHtml(paste.language || 'text')} · ${paste.views || 0} views · ${created}${isScreenshot ? '' : ` · <a href="/p/${escapeHtml(paste.slug)}/raw">raw</a>`}</p>
  ${body}
</main>
<footer>Shared via OpenVibe.Media — <a href="https://openvibe.network">One Account. All of OpenVibe.</a></footer>
</body>
</html>`;
}

router.get('/p/:slug', optionalIdentity, (req, res) => {
    try {
        const paste = db.getPasteBySlug(String(req.params.slug));
        if (!paste) return res.status(404).send('Paste not found');

        // Unlisted pastes stay reachable by direct link (that's the point).
        // Private pastes: owning app/user only.
        if (paste.visibility === 'private' && !canAccessPrivate(paste, req)) {
            return res.status(404).send('Paste not found');
        }

        // Increment view count (don't count the owner's views)
        const isOwner = req.userId != null && paste.user_id === req.userId;
        if (!isOwner) {
            db.run('UPDATE pastes SET views = views + 1 WHERE id = ?', [paste.id]);
            paste.views += 1;
        }

        // Burn-after-read: allow one non-owner read, then delete.
        if (paste.burn_after_read && !isOwner && paste.views > 1) {
            require('../pastes/routes').removePasteScreenshot(paste);
            db.run('DELETE FROM pastes WHERE id = ?', [paste.id]);
            return res.status(410).send('This paste has been burned after reading.');
        }

        res.type('html').send(renderPastePage(paste));
    } catch (err) {
        console.error('[Public] /p error:', err.message);
        res.status(500).send('Error');
    }
});

router.get('/p/:slug/raw', (req, res) => {
    try {
        const paste = db.getPasteBySlug(String(req.params.slug));
        if (!paste || paste.type !== 'paste') return res.status(404).send('Not found');
        if (paste.visibility === 'private') return res.status(404).send('Not found');

        // Burn after read
        if (paste.burn_after_read && paste.views > 0) {
            db.run('DELETE FROM pastes WHERE id = ?', [paste.id]);
            return res.status(410).send('This paste has been burned after reading.');
        }

        db.run('UPDATE pastes SET views = views + 1 WHERE id = ?', [paste.id]);
        res.type('text/plain').send(paste.content);
    } catch {
        res.status(500).send('Error');
    }
});

router.get('/p/:slug/screenshot', (req, res) => {
    try {
        const paste = db.getPasteBySlug(String(req.params.slug));
        if (!paste || !paste.screenshot_path) return res.status(404).send('Not found');
        if (paste.visibility === 'private') return res.status(404).send('Not found');
        if (!fs.existsSync(paste.screenshot_path)) return res.status(404).send('Not found');
        streamFileWithRange(req, res, paste.screenshot_path, { 'Cache-Control': 'public, max-age=86400' });
    } catch {
        res.status(500).send('Error');
    }
});

module.exports = router;
