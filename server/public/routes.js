/**
 * OpenVibe.Media — Public serving routes (no auth unless the item is private)
 *
 * GET /v/:id             VOD playback: local stream w/ Range, or 302 presigned
 *                        B2/R2 (inherited logic). Live recordings serve the
 *                        fully-indexed .seekable sidecar for DVR. A browser
 *                        NAVIGATING here gets a watch page instead (see
 *                        pages.js — ?raw=1 always yields the bytes).
 * GET /c/:id             clip playback (same tiering/range logic + watch page)
 * GET /p/:slug           paste viewer — canonical on OpenVibe.Community
 * GET /p/:slug/raw       paste raw text
 * GET /p/:slug/screenshot paste screenshot image
 * GET /t/:id             thumbnails (id = filename)
 * GET /f/:key            files with correct Content-Type + Range
 * GET /og-image.png      the site's share card
 * GET /robots.txt, /sitemap.xml, /llms.txt   crawler files (crawl.js): the sitemap lists only
 *                        the watch pages Media is canonical for (public, not Live's, not AI clips)
 *
 * /v /c /t /f bytes carry X-Robots-Tag: noindex — the owning app has the
 * canonical page (the watch page says so with rel=canonical). The paste
 * viewer is noindex too: Community owns that URL now.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const tools = require('../vod/media-tools');
const { optionalIdentity } = require('../auth');
const pages = require('./pages');
// A restore drill (MEDIA_DRILL) serves no stored bytes: every byte route answers 503 before it looks
// at a file path (the database's paths are production's files). Watch pages still render.
const drill = require('../drill');

const router = express.Router();
// /robots.txt, /sitemap.xml, /llms.txt (server/public/crawl.js).
router.use(require('./crawl'));

const MIME_TYPES = {
    '.webm': 'video/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

const views = require('../views/service');
// Views + unique views live in ../views/service (visit-based with a cooldown, hashed
// visitors, owner/bot/rate-limit exclusions). A playback session counts once: only the
// request for the first bytes, not every seek/range request.
function trackUniqueView(kind, id, req, ownerUserId = null) {
    try { if (views.isInitialPlaybackRequest(req)) views.recordView(kind, id, { req, ownerUserId }); } catch { /* non-critical */ }
}

/** public | unlisted | private. Rows without a visibility fall back to is_public (0 = private). */
function recordVisibility(record) {
    return record.visibility || (record.is_public ? 'public' : 'private');
}

/** The single "no such thing" answer for every id-addressed route, used for private items too. */
function notFound(res) {
    return res.status(404).json({ error: 'Not found' });
}

function canAccessPrivate(record, req) {
    // Private items: the owning app (its API key) or the owning user's JWT.
    if (req.authType === 'app' && req.appId === record.app_id) return true;
    if (req.authType === 'user' && req.userId != null && record.user_id === req.userId) return true;
    return false;
}

/**
 * Pipe a file (or a byte range of it) to the response WITHOUT leaking the descriptor.
 * `createReadStream(...).pipe(res)` alone never closes the file when the client goes away
 * mid-transfer — and video players do that thousands of times per session (every seek
 * aborts a range request). Deleted-but-open VOD files once held 80 GB of disk that way.
 */
function sendFileStream(res, filePath, opts) {
    if (drill.enabled) { try { res.destroy(); } catch { /* */ } return null; }   // unreachable: every caller refuses first
    const stream = fs.createReadStream(filePath, opts);
    const done = () => { try { stream.destroy(); } catch { /* */ } };
    res.on('close', done); res.on('error', done); res.on('finish', done);
    stream.on('error', () => { try { res.destroy(); } catch { /* */ } });
    stream.pipe(res);
    return stream;
}

function streamFileWithRange(req, res, filePath, extraHeaders = {}) {
    if (drill.refuseBytes(res)) return;
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
        sendFileStream(res, filePath, { start, end: Math.min(end, stat.size - 1) });
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            ...extraHeaders,
        });
        sendFileStream(res, filePath);
    }
}

/**
 * Serve a vods/clips row: local file (Range + live-DVR sidecar) or 302
 * presigned B2/R2 — the inherited playback logic.
 */
async function serveMediaRecord(kind, record, req, res) {
    const vodStorage = require('../vod/vod-storage');
    const noindex = { 'X-Robots-Tag': 'noindex' };

    const visibility = recordVisibility(record);
    // Exactly the answer a missing id gets: a 403 here told anyone probing ids which private
    // recordings exist (and, through the basename form of /v, which file names are real).
    if (visibility === 'private' && !canAccessPrivate(record, req)) return notFound(res);

    // A person (or a link-preview crawler) landing on the URL gets the watch
    // page; its <video> comes back here with ?raw=1 for the bytes.
    if (pages.wantsHtmlPage(req)) {
        res.set('Cache-Control', visibility === 'public' ? 'public, max-age=60' : 'private, no-store');
        return res.type('html').send(pages.renderWatchPage(kind, record));
    }
    if (drill.refuseBytes(res)) return;

    trackUniqueView(kind, record.id, req, record.user_id);

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
            if (!vod || vod.clips_only) return notFound(res);
            return await serveMediaRecord('vod', vod, req, res);
        }
        const vod = db.getVodByFileBasename(req.params.id);
        if (vod && !vod.clips_only) return await serveMediaRecord('vod', vod, req, res);
        const clip = db.getClipByFileBasename(req.params.id);
        if (clip) return await serveMediaRecord('clip', clip, req, res);
        notFound(res);
    } catch (err) {
        console.error('[Public] /v error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve media' });
    }
});

// ── Clip playback ────────────────────────────────────────────
router.get('/c/:id', optionalIdentity, async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return notFound(res);
        const clip = db.getClipById(parseInt(req.params.id, 10));
        if (!clip || !clip.file_path) return notFound(res);
        await serveMediaRecord('clip', clip, req, res);
    } catch (err) {
        console.error('[Public] /c error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve media' });
    }
});

// ── Share card (og:image default) ────────────────────────────
router.get('/og-image.png', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, '..', 'static', 'og-image.png'));
});

// ── Thumbnails ───────────────────────────────────────────────
router.get('/t/:id', (req, res) => {
    if (drill.refuseBytes(res)) return;
    require('../thumbnails/thumbnail-service').serveThumbnail(req, res);
});

// ── Live frame API (public, dev-facing) ──────────────────────
// GET /live/:sel/frame.jpg[?w=640][&app=live][&format=json]
// :sel = slot id ("1"), slot slug ("whip"), or "@username" (that streamer's
// top-viewed live slot). Returns a near-realtime JPEG frame extracted from the
// slot's in-progress recording; when the target isn't live, a styled OFFLINE
// card (SVG) is served with a 404 so <img> embeds still look good while API
// consumers can key off the status code (or pass ?format=json).
// Cached 5s per slot (that cache IS the rate limit); CORS-open.
router.get('/live/:sel/frame.jpg', async (req, res) => {
    if (drill.refuseBytes(res)) return;   // ffprobe + ffmpeg on the live recording
    const frames = require('../thumbnails/live-frame-service');
    const wantJson = String(req.query.format || '') === 'json';
    const sendCard = async (status, label, subtitle) => {
        if (wantJson) return res.status(status).json({ error: subtitle ? `${label} ${subtitle}` : `${label} is offline` });
        // Always JPEG bytes — the URL says .jpg and dev pipelines decode accordingly.
        let buf = null, type = 'image/jpeg';
        try { buf = await frames.offlineCardJpeg(label, subtitle); }
        catch (err) {
            console.warn('[Public] offline card render failed:', err.message);
            buf = Buffer.from(frames.offlineCardSvg(label, subtitle));
            type = 'image/svg+xml; charset=utf-8';
        }
        res.status(status).set({
            'Content-Type': type,
            'Content-Length': buf.length,
            'Cache-Control': 'public, max-age=5',
            'X-Robots-Tag': 'noindex',
        });
        res.end(buf);
    };
    try {
        res.set('Access-Control-Allow-Origin', '*');
        // Each cache miss spawns ffprobe+ffmpeg, so the endpoint is guarded by a
        // per-IP token bucket before any work is done.
        if (!frames.rateLimitOk(req.ip)) {
            res.set('Retry-After', '2');
            if (wantJson) return res.status(429).json({ error: 'Too many requests' });
            return res.status(429).end();
        }
        const appId = String(req.query.app || 'live');
        // Snap to a fixed width ladder — an unbounded `w` would give every request
        // its own cache key and defeat the cache that IS the rate limit.
        const w = frames.quantizeWidth(req.query.w);

        const resolved = await frames.resolveSelector(appId, req.params.sel);
        if (!resolved.msid) return sendCard(404, resolved.label, 'is offline right now');

        const out = await frames.getLiveFrame(appId, resolved.msid, w);
        if (!out.ok) {
            if (out.reason === 'not_live') return sendCard(404, resolved.label, 'is offline right now');
            if (out.reason === 'busy') {
                res.set('Retry-After', '2');
                return sendCard(503, resolved.label, 'is live — server busy, retry shortly');
            }
            return sendCard(503, resolved.label, 'is live — frame unavailable, retry shortly');
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

// ── App assets (emotes / sounds) by id ───────────────────────
router.get('/a/:id', (req, res) => {
    if (drill.refuseBytes(res)) return;
    try {
        const a = db.getAssetById(parseInt(req.params.id, 10));
        if (!a || !a.file_path || !fs.existsSync(a.file_path)) return res.status(404).json({ error: 'Not found' });
        // Content is replaced under the same URL on re-upload — cache a day, not immutable.
        streamFileWithRange(req, res, a.file_path, {
            'Content-Type': a.mime || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
            'X-Robots-Tag': 'noindex',
        });
    } catch (err) {
        console.error('[Public] /a error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve asset' });
    }
});

// ── Media index home page ────────────────────────────────────
// GET / — server-rendered mass index of all public media (tabs: All / Videos /
// Clips / Images / Text / Thumbnails / Files), each card linking back to its
// source page in the owning app. See public/browse.js.
router.get('/', (req, res) => require('./browse').handle(req, res));
router.get('/browse', (req, res) => require('./browse').handle(req, res));

// ── Dev data APIs: transcripts / AI timelines / chat insight ─
// JSON companions to the frame API — same selector grammar, 30s cache as the
// rate limit, CORS-open. See README "Public serving".
function _devDataRoute(handler) {
    return async (req, res) => {
        try {
            res.set('Access-Control-Allow-Origin', '*');
            const { status, body } = await handler(req);
            res.status(status).set('Cache-Control', 'public, max-age=15').json(body);
        } catch (err) {
            console.error('[Public] dev-data error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to load data' });
        }
    };
}

// Full transcript log + AI overview timeline for a slot (id/slug) or streamer (@username).
router.get('/live/:sel/transcript.json', _devDataRoute((req) =>
    require('./dev-data').getTranscriptTimeline(String(req.query.app || 'live'), req.params.sel, req.query.limit)));

// A user's chat-related AI insight + timeline (@username or numeric user id).
router.get('/live/:sel/chat-insight.json', _devDataRoute((req) =>
    require('./dev-data').getChatInsight(String(req.query.app || 'live'), req.params.sel)));

// Transcript + AI overview for one existing VOD id.
router.get('/v/:id/transcript.json', _devDataRoute((req) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return { status: 400, body: { error: 'Bad VOD id' } };
    return require('./dev-data').getVodTranscript(id);
}));

// ── Legacy thumbnail URLs ────────────────────────────────────
// Old-stack thumbnails lived at /api/thumbnails/<basename>, and migrated Live
// rows still carry those absolute URLs. Basenames change when a thumbnail is
// regenerated, so resolve the vod/clip id from the name and redirect to the
// current canonical URL; serve the exact file when it still exists.
router.get('/api/thumbnails/:name', (req, res) => {
    if (drill.refuseBytes(res)) return;
    const name = path.basename(String(req.params.name || ''));
    const m = /^(vod|clip)-(\d+)-\d+\.(?:jpg|jpeg|png)$/i.exec(name);
    if (m) {
        const row = m[1].toLowerCase() === 'vod'
            ? db.getVodById(parseInt(m[2], 10), 'live')
            : db.getClipById(parseInt(m[2], 10), 'live');
        // Never for a private row: the redirect would hand out the current thumbnail URL of any
        // private recording to whoever guesses vod-<id>-0.jpg. The exact file name still serves.
        if (row && row.thumbnail_url && recordVisibility(row) !== 'private' && !row.thumbnail_url.endsWith(`/${name}`)) {
            res.set('Cache-Control', 'public, max-age=3600');
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
    if (drill.refuseBytes(res)) return;
    try {
        const name = path.basename(String(req.params.name || ''));
        const dir = path.join(require('../config').pastes.path, 'screenshots');
        const filePath = path.join(dir, name);
        if (!name || !filePath.startsWith(dir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return res.status(404).json({ error: 'Not found' });
        }
        streamFileWithRange(req, res, filePath, { 'Cache-Control': 'public, max-age=604800, immutable', 'X-Robots-Tag': 'noindex' });
    } catch (err) {
        console.error('[Public] /f/screenshots error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve file' });
    }
});

// ── Files ────────────────────────────────────────────────────
router.get('/f/:key', (req, res) => {
    if (drill.refuseBytes(res)) return;
    try {
        const row = db.getFileByKey(String(req.params.key));
        if (!row) return res.status(404).json({ error: 'Not found' });
        // Developer-project sandbox files are never public: only a valid signed URL (from the
        // Files API) serves them, and a missing signature looks exactly like a missing file.
        const sandbox = db.isSandboxTenant(row.app_id);
        if (sandbox && !require('../objects/signing').verifyFile(row.key, req.query.exp, req.query.sig)) return res.status(404).json({ error: 'Not found' });
        const filesRoutes = require('../files/routes');
        const filePath = filesRoutes.filePathForKey(row);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        const contentType = row.mime || 'application/octet-stream';
        const inline = /^[\w.+-]+\/[\w.+-]+$/.test(contentType) && require('../objects/routes').INLINE.test(contentType.toLowerCase());
        // Uploaders (developer apps included) choose the Content-Type: only inert types render here,
        // everything else (HTML, SVG, XML…) downloads, so it never runs on this origin.
        const headers = {
            'X-Robots-Tag': 'noindex',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${row.key}"`,
            'Cache-Control': sandbox ? 'private, no-store' : 'public, max-age=86400',
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
            sendFileStream(res, filePath, { start, end });
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                ...headers,
            });
            sendFileStream(res, filePath);
        }
    } catch (err) {
        console.error('[Public] /f error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve file' });
    }
});

// ── Pastes ───────────────────────────────────────────────────

// The page itself is rendered in pages.js (thin viewer; canonical on Community).
// Pastes moved to OpenVibe.Community (roadmap Wave 5, PASTES_MOVED_TO): the page and its text are
// Community's now, so send people there. Screenshot bytes keep being served from here.
const movedTo = () => String(process.env.PASTES_MOVED_TO || '').replace(/\/$/, '');

router.get('/p/:slug', optionalIdentity, (req, res) => {
    if (movedTo()) return res.redirect(301, `${movedTo()}/p/${encodeURIComponent(req.params.slug)}`);
    try {
        const paste = db.getPasteBySlug(String(req.params.slug));
        if (!paste) return res.status(404).send('Paste not found');

        // Unlisted pastes stay reachable by direct link (that's the point).
        // Private pastes: owning app/user only.
        if (paste.visibility === 'private' && !canAccessPrivate(paste, req)) {
            return res.status(404).send('Paste not found');
        }

        // Count the view (visit-based, cooldown, owner excluded). Burn-after-read pastes
        // keep the literal every-read counter — one read is the whole point of them.
        const isOwner = req.userId != null && paste.user_id === req.userId;
        if (!isOwner) {
            if (paste.burn_after_read) { db.run('UPDATE pastes SET views = views + 1 WHERE id = ?', [paste.id]); paste.views += 1; }
            else { const r = views.recordView('paste', paste.id, { req, ownerUserId: paste.user_id }); if (r.view_count != null) { paste.views = r.view_count; paste.unique_views = r.unique_views; } }
        }

        // Burn-after-read: allow one non-owner read, then delete.
        if (paste.burn_after_read && !isOwner && paste.views > 1) {
            require('../pastes/routes').removePasteScreenshot(paste);
            db.run('DELETE FROM pastes WHERE id = ?', [paste.id]);
            return res.status(410).send('This paste has been burned after reading.');
        }

        res.set('Cache-Control', 'private, no-store');
        res.type('html').send(pages.renderPastePage(paste));
    } catch (err) {
        console.error('[Public] /p error:', err.message);
        res.status(500).send('Error');
    }
});

router.get('/p/:slug/raw', (req, res) => {
    try {
        const found = db.getPasteBySlug(String(req.params.slug));
        // A private paste answers exactly like a missing slug (no redirect that proves it exists).
        const paste = found && found.visibility !== 'private' ? found : null;
        // Image pastes have no raw text — bounce to the screenshot (stale
        // consumers stored /raw URLs for hero-moment images).
        if (paste && paste.type === 'screenshot') {
            res.set('Cache-Control', 'public, max-age=3600');
            return res.redirect(302, `/p/${encodeURIComponent(paste.slug)}/screenshot`);
        }
        // Moved: every slug goes to Community, found or not, like /p/:slug.
        if (movedTo()) return res.redirect(301, `${movedTo()}/p/${encodeURIComponent(String(req.params.slug))}/raw`);
        if (!paste || paste.type !== 'paste') return res.status(404).send('Not found');

        // Burn after read
        if (paste.burn_after_read && paste.views > 0) {
            db.run('DELETE FROM pastes WHERE id = ?', [paste.id]);
            return res.status(410).send('This paste has been burned after reading.');
        }

        if (paste.burn_after_read) db.run('UPDATE pastes SET views = views + 1 WHERE id = ?', [paste.id]);
        else views.recordView('paste', paste.id, { req, ownerUserId: paste.user_id });
        res.type('text/plain').send(paste.content);
    } catch {
        res.status(500).send('Error');
    }
});

router.get('/p/:slug/screenshot', (req, res) => {
    if (drill.refuseBytes(res)) return;
    try {
        const paste = db.getPasteBySlug(String(req.params.slug));
        // Pastes made since the move live in Community only: send an unknown slug there, like
        // /p/:slug and /p/:slug/raw (Community answers with the image, or its own 404). Stored
        // hero-moment thumbnails pointed here and showed broken images.
        if ((!paste || paste.visibility === 'private') && movedTo()) {   // private answers like missing
            res.set('Cache-Control', 'public, max-age=3600');
            return res.redirect(301, `${movedTo()}/p/${encodeURIComponent(String(req.params.slug))}/screenshot`);
        }
        if (!paste || !paste.screenshot_path) return res.status(404).send('Not found');
        if (paste.visibility === 'private') return res.status(404).send('Not found');
        if (!fs.existsSync(paste.screenshot_path)) return res.status(404).send('Not found');
        streamFileWithRange(req, res, paste.screenshot_path, { 'Cache-Control': 'public, max-age=86400' });
    } catch {
        res.status(500).send('Error');
    }
});

module.exports = router;
module.exports.streamFileWithRange = streamFileWithRange;
module.exports.recordVisibility = recordVisibility;
