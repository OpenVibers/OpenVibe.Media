/**
 * OpenVibe.Media — Pastes API, read-only (mounted at /api/v1/:app/pastes)
 *
 * OpenVibe.Community owns pastes since the 2026-09-22 cutover (PASTES_MOVED_TO).
 * Media keeps the rows and answers reads for anything still pointed here; public
 * pages live at /p/:slug (HTML) and /p/:slug/raw.
 *
 * GET    /                    list (?limit&offset&type&search&user_id&include_unlisted&sort)
 * GET    /config              paste limits (+ the caller's count today)
 * GET    /:slug               paste meta/content
 * GET    /:slug/comments      list comments (+replies)
 *
 * Every other method answers 410 { code: 'pastes.moved' }.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const db = require('../db/database');
const { tenantAuth, tenantCors } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);
// Pastes moved to OpenVibe.Community: no writes here, for any app. The caller is
// authenticated first, so an anonymous write still answers 401 like the reads.
const writeAuth = tenantAuth({ allowUser: true });
router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    writeAuth(req, res, () => res.status(410).json({ error: 'Pastes moved to OpenVibe.Community', code: 'pastes.moved' }));
});

// Screenshot directory, shared with the avatar ingest (server/pastes/storage.js).
const { SCREENSHOTS_DIR, generateSlug } = require('./storage');

// ── Helpers ─────────────────────────────────────────────────

async function getPasteConfig() {
    return {
        maxSizeKb: Number(await db.getSetting('paste_max_size_kb')) || 512,
        screenshotMaxSizeMb: Number(await db.getSetting('paste_screenshot_max_size_mb')) || 8,
        cooldownSeconds: Number(await db.getSetting('paste_cooldown_seconds')) || 30,
        maxPerUserPerDay: Number(await db.getSetting('paste_max_per_user_per_day')) || 0,
    };
}

function screenshotUrl(paste) {
    return paste.screenshot_path ? `/p/${paste.slug}/screenshot` : null;
}

function pastePublic(paste) {
    if (!paste) return null;
    return {
        unique_views: paste.unique_views || 0,

        id: paste.id,
        app_id: paste.app_id,
        slug: paste.slug,
        user_id: paste.user_id,
        type: paste.type,
        title: paste.title,
        content: paste.content,
        language: paste.language,
        visibility: paste.visibility,
        stream_id: paste.stream_id,
        screenshot_url: screenshotUrl(paste),
        metadata: paste.metadata,
        burn_after_read: !!paste.burn_after_read,
        forked_from: paste.forked_from,
        pinned: !!paste.pinned,
        views: paste.views || 0,
        copies: paste.copies || 0,
        likes: paste.likes || 0,
        is_nsfw: !!paste.is_nsfw,
        ai_summary: paste.ai_summary || null,
        ai_tags: paste.ai_tags || null,
        ai_analyzed_at: paste.ai_analyzed_at || null,
        url: `/p/${paste.slug}`,
        raw_url: `/p/${paste.slug}/raw`,
        created_at: paste.created_at,
        updated_at: paste.updated_at,
    };
}

// Effective actor for the daily count in GET /config: user-JWT callers are
// counted by their token; app-key callers name the user in the request.
function _actor(req) {
    if (req.authType === 'user') return { userId: req.userId, ip: req.ip };
    return { userId: (req.body && req.body.user_id) || null, ip: req.ip };
}

async function _getPasteScoped(req, res) {
    const slug = String(req.params.slug);
    const paste = await db.getPasteBySlug(slug, req.appId);
    if (!paste) {
        // "Paste not found" was being reported for pastes that demonstrably exist, and the
        // 404 was silent — so there was no way to tell whether the slug was wrong, the
        // tenant scope was wrong, or the row was genuinely missing. Log all three.
        let existsElsewhere = null;
        try {
            const any = await db.get('SELECT app_id FROM pastes WHERE slug = ?', [slug]);
            existsElsewhere = any ? any.app_id : null;
        } catch { /* */ }
        console.warn(`[Pastes] 404 slug="${slug}" appId="${req.appId}" auth=${req.authType || 'none'}` +
            (existsElsewhere ? ` — EXISTS under app_id="${existsElsewhere}" (tenant mismatch)` : ' — no row with that slug'));
        res.status(404).json({ error: 'Paste not found' });
        return null;
    }
    return paste;
}

// Fully remove a paste's screenshot from local disk AND any legacy B2 object.
async function removePasteScreenshot(paste) {
    if (!paste) return;
    // A held screenshot keeps its bytes (the row delete that follows is refused by the hold trigger).
    const objects = require('../objects/model');
    if (await objects.isHeldRow(paste.object_id !== undefined ? paste : await db.get('SELECT object_id FROM pastes WHERE id = ?', [paste.id]))) return;
    if (paste.screenshot_path) {
        try { fs.unlinkSync(paste.screenshot_path); } catch { /* ignore */ }
    }
    try { require('../vod/vod-storage').deleteLegacyPasteScreenshot(paste.id).catch(() => {}); } catch { /* ignore */ }
}

// ── List pastes ─────────────────────────────────────────────
router.get('/', tenantAuth({ allowUser: true }), async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const type = req.query.type; // 'paste', 'screenshot', or undefined for all
        const search = req.query.search ? `%${req.query.search}%` : null;
        const userId = req.query.user_id != null ? req.query.user_id : null;

        // Unlisted/private pastes are hidden from PUBLIC listings, but their owner must
        // still see them in their own list — otherwise creating an unlisted paste looks
        // exactly like it was never created at all. Only honoured for a caller that can be
        // trusted to be the owner: either an app key (the app gates who may ask) or a user
        // token whose subject matches the user_id being listed.
        const wantMine = req.query.include_unlisted === '1' || req.query.include_unlisted === 'true';
        const ownerView = wantMine && userId != null && (
            req.authType === 'app' || (req.authType === 'user' && String(req.userId) === String(userId))
        );
        const visClause = ownerView
            ? `AND visibility IN ('public', 'unlisted', 'private')`
            : `AND visibility = 'public'`;

        let sql = `SELECT * FROM pastes WHERE app_id = ? ${visClause}`;
        const params = [req.appId];

        if (type === 'paste' || type === 'screenshot') { sql += ` AND type = ?`; params.push(type); }
        if (userId != null) { sql += ` AND user_id = ?`; params.push(userId); }
        // Work queue for the owning app's AI pass. Media holds the pastes but has no LLM;
        // the app polls this, analyses, and posts results back to /:slug/ai. App-key only —
        // this deliberately spans visibility, so it must never be reachable by a user token.
        if (req.authType === 'app' && (req.query.needs_ai === '1' || req.query.needs_ai === 'true')) {
            sql = sql.replace(visClause, `AND COALESCE(ai_summary, '') = ''`);
        }
        if (search) { sql += ` AND (title ILIKE ? OR content ILIKE ?)`; params.push(search, search); }

        const dir = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
        sql += ` ORDER BY pinned DESC, created_at ${dir} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const pastes = (await db.all(sql, params)).map(p => ({
            ...pastePublic(p),
            content: p.type === 'paste' ? (p.content || '').slice(0, 300) : null, // Preview only in list
        }));

        let countSql = `SELECT COUNT(*) as total FROM pastes WHERE app_id = ? ${visClause}`;
        const countParams = [req.appId];
        if (type === 'paste' || type === 'screenshot') { countSql += ` AND type = ?`; countParams.push(type); }
        if (userId != null) { countSql += ` AND user_id = ?`; countParams.push(userId); }
        if (search) { countSql += ` AND (title ILIKE ? OR content ILIKE ?)`; countParams.push(search, search); }
        const { total } = await db.get(countSql, countParams);

        res.json({ pastes, total, limit, offset });
    } catch (err) {
        console.error('[Pastes] List error:', err.message);
        res.status(500).json({ error: 'Failed to list pastes' });
    }
});

// ── Paste config / limits (inherited SPA reads this before posting) ──
// Registered before /:slug so the literal path wins.
router.get('/config', tenantAuth({ allowUser: true }), async (req, res) => {
    try {
        const cfg = await getPasteConfig();
        const actor = _actor(req);
        res.json({
            maxSizeKb: cfg.maxSizeKb,
            screenshotMaxSizeMb: cfg.screenshotMaxSizeMb,
            cooldownSeconds: cfg.cooldownSeconds,
            maxPerUserPerDay: cfg.maxPerUserPerDay,
            todayCount: await db.countUserPastesToday(req.appId, actor.userId, actor.ip),
        });
    } catch (err) {
        console.error('[Pastes] Config error:', err.message);
        res.status(500).json({ error: 'Failed to load paste config' });
    }
});


// ── Get single paste by slug ────────────────────────────────
router.get('/:slug', tenantAuth({ allowUser: true }), async (req, res) => {
    try {
        const paste = await _getPasteScoped(req, res);
        if (!paste) return;
        // Private pastes: owner (or the app itself) only — decided before anything is counted.
        if (paste.visibility === 'private') {
            const allowed = req.authType === 'app' || (req.userId != null && paste.user_id === req.userId);
            if (!allowed) return res.status(404).json({ error: 'Paste not found' });
        }
        // The owning app renders the paste page itself — count the view here (real client
        // IP via X-Forwarded-For, viewer via the "user" JWT / X-OV-User-Id) unless it says
        // this fetch is not a page view (?no_view=1 for edit forms, embeds, bots).
        if (String(req.query.no_view || '') !== '1' && !paste.burn_after_read) {
            try { const r = await require('../views/service').recordView('paste', paste.id, { req, ownerUserId: paste.user_id }); if (r.view_count != null) { paste.views = r.view_count; paste.unique_views = r.unique_views; } } catch { /* */ }
        }


        paste.liked = req.userId != null ? await db.hasUserLikedPaste(paste.id, req.userId) : false;
        res.json({ paste: { ...pastePublic(paste), liked: paste.liked } });
    } catch (err) {
        console.error('[Pastes] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get paste' });
    }
});

// ═════════════════════════════════════════════════════════════
// ── Paste Comments (supports anonymous via app callers) ─────
// ═════════════════════════════════════════════════════════════

router.get('/:slug/comments', tenantAuth({ allowUser: true }), async (req, res) => {
    try {
        const paste = await _getPasteScoped(req, res);
        if (!paste) return;

        const limit = Math.min(parseInt(req.query.limit || '50'), 100);
        const offset = parseInt(req.query.offset || '0');

        const comments = await db.getPasteComments(paste.id, limit, offset);
        const total = await db.getPasteCommentCount(paste.id);

        for (const c of comments) {
            c.replies = await db.getPasteCommentReplies(c.id);
            c.reply_count = c.replies.length;
        }

        res.json({ comments, total });
    } catch (err) {
        console.error('[PasteComments] List error:', err.message);
        res.status(500).json({ error: 'Failed to load comments' });
    }
});

module.exports = router;
module.exports.generateSlug = generateSlug;
module.exports.SCREENSHOTS_DIR = SCREENSHOTS_DIR;
module.exports.removePasteScreenshot = removePasteScreenshot;
