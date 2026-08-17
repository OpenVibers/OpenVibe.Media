/**
 * OpenVibe.Media — Pastes API (mounted at /api/v1/:app/pastes)
 *
 * Pastebin-style sharing ported from the predecessor: text pastes, code
 * snippets, and screenshots (EXIF-stripped via sharp). Public pages live at
 * /p/:slug (HTML) and /p/:slug/raw.
 *
 * POST   /                    { title?, content?, language?, user_id?, visibility?,
 *                               burn_after_read?, is_nsfw?, screenshot (multipart)? }
 *                             → { id, slug, url }
 * GET    /                    list (?limit&offset&type&search&user_id)
 * GET    /:slug               paste meta/content
 * PUT    /:slug               update
 * DELETE /:slug               delete (+ screenshot local & legacy B2)
 * POST   /:slug/fork          fork a text paste
 * POST   /:slug/like          toggle-like (user identity required)
 * POST   /:slug/copy          track a copy event
 * GET    /:slug/comments      list comments (+replies)
 * POST   /:slug/comments      add comment
 * DELETE /:slug/comments/:id  delete comment
 *
 * Rate limits (cooldown/daily) apply to user-JWT callers; app-key callers are
 * trusted server-to-server. AI summary/tags hooks are dropped (Live owns AI)
 * but the columns remain for imported rows.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const db = require('../db/database');
const config = require('../config');
const { tenantAuth, tenantCors } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

// ── Screenshot upload storage ───────────────────────────────
const SCREENSHOTS_DIR = path.join(config.pastes.path, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const screenshotStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SCREENSHOTS_DIR),
    filename: (_req, file, cb) => {
        const ext = MIME_TO_EXT[file.mimetype] || '.png';
        cb(null, `ss-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
});
const screenshotUpload = multer({
    storage: screenshotStorage,
    limits: { fileSize: 16 * 1024 * 1024 }, // hard cap; per-app setting enforced below
    fileFilter: (_req, file, cb) => {
        if (/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only PNG, JPEG, WebP, or GIF images allowed'));
    },
});

// ── Helpers ─────────────────────────────────────────────────

// Word pools for readable paste slugs (adj-noun-number)
const SLUG_ADJECTIVES = [
    'amber', 'blue', 'bold', 'brave', 'bright', 'calm', 'clean', 'clever',
    'cold', 'cool', 'coral', 'crisp', 'dark', 'dawn', 'deep', 'dry',
    'dusk', 'dusty', 'fair', 'fast', 'fierce', 'fine', 'foggy', 'free',
    'fresh', 'frost', 'glad', 'gold', 'grand', 'gray', 'green', 'grim',
    'hazy', 'heavy', 'hidden', 'hollow', 'honey', 'hot', 'icy', 'iron',
    'jade', 'keen', 'kind', 'late', 'lazy', 'light', 'lime', 'lit',
    'lone', 'lost', 'loud', 'lucky', 'lush', 'mild', 'misty', 'mossy',
    'muddy', 'neon', 'new', 'noble', 'odd', 'old', 'opal', 'open',
    'pale', 'pink', 'plain', 'plum', 'prime', 'proud', 'pure', 'quick',
    'quiet', 'rare', 'raw', 'red', 'rich', 'rocky', 'rosy', 'rough',
    'ruby', 'rusty', 'safe', 'sage', 'sandy', 'sharp', 'shy', 'silver',
    'slim', 'slow', 'smoky', 'snowy', 'soft', 'sour', 'steep', 'still',
    'stone', 'sunny', 'sweet', 'swift', 'tall', 'tame', 'teal', 'thin',
    'tidy', 'tiny', 'torn', 'vast', 'vivid', 'warm', 'wavy', 'west',
    'wet', 'white', 'wide', 'wild', 'windy', 'wise', 'worn', 'young',
];
const SLUG_NOUNS = [
    'acorn', 'arch', 'arrow', 'aspen', 'badger', 'basil', 'bay', 'bear',
    'birch', 'blade', 'bloom', 'bolt', 'brook', 'brush', 'cairn', 'cave',
    'cedar', 'cliff', 'cloud', 'clover', 'coast', 'coral', 'crane', 'creek',
    'crow', 'dale', 'deer', 'delta', 'dew', 'dock', 'dove', 'drift',
    'drum', 'dune', 'eagle', 'echo', 'edge', 'elm', 'ember', 'fawn',
    'fern', 'field', 'finch', 'flame', 'flare', 'flint', 'fog', 'ford',
    'forge', 'fox', 'frost', 'gale', 'gate', 'gem', 'glen', 'goat',
    'grove', 'gull', 'hawk', 'haze', 'heath', 'hedge', 'heron', 'hill',
    'holly', 'horse', 'hound', 'isle', 'ivy', 'jade', 'jay', 'kelp',
    'lake', 'lark', 'leaf', 'ledge', 'lily', 'lion', 'lodge', 'lynx',
    'maple', 'marsh', 'mesa', 'mill', 'mint', 'mist', 'moon', 'moss',
    'moth', 'mule', 'nest', 'oak', 'orca', 'otter', 'owl', 'palm',
    'path', 'peak', 'pearl', 'petal', 'pike', 'pine', 'plum', 'pond',
    'quail', 'rain', 'raven', 'reed', 'reef', 'ridge', 'river', 'robin',
    'root', 'rose', 'sage', 'seal', 'shade', 'shell', 'shore', 'slate',
    'snail', 'spark', 'stone', 'storm', 'stork', 'thorn', 'tide', 'trail',
    'trout', 'tulip', 'vale', 'vine', 'viper', 'wave', 'wren', 'wolf',
];

function generateSlug(attempts = 0) {
    if (attempts >= 10) throw new Error('Could not generate a unique paste slug after 10 attempts');
    const adj = SLUG_ADJECTIVES[crypto.randomInt(SLUG_ADJECTIVES.length)];
    const noun = SLUG_NOUNS[crypto.randomInt(SLUG_NOUNS.length)];
    const num = crypto.randomInt(10, 100); // 10–99
    const slug = `${adj}-${noun}-${num}`;
    const existing = db.get('SELECT 1 FROM pastes WHERE slug = ?', [slug]);
    if (existing) return generateSlug(attempts + 1);
    return slug;
}

function sanitizeTitle(title) {
    return String(title || '').trim().slice(0, 200) || 'Untitled';
}

function detectLanguage(content, hint) {
    if (hint && hint !== 'auto') return hint;
    const first = String(content || '').slice(0, 500);
    if (/^<(!DOCTYPE|html|div|span|head|body)/im.test(first)) return 'html';
    if (/^(import |from |const |let |var |function |=>|class )/m.test(first)) return 'javascript';
    if (/^(def |class |import |from |print\(|if __name__)/m.test(first)) return 'python';
    if (/^(package |func |import \(|fmt\.)/m.test(first)) return 'go';
    if (/^\{[\s\n]*"/.test(first)) return 'json';
    if (/^---\n|^[a-z_]+:\s/m.test(first)) return 'yaml';
    if (/^#!\/(bin|usr)/m.test(first)) return 'bash';
    if (/```|^#{1,6} |^\* |\*\*|^\[.*\]\(.*\)/m.test(first)) return 'markdown';
    if (/^(SELECT|INSERT|CREATE|ALTER|DROP|UPDATE|DELETE)\s/im.test(first)) return 'sql';
    if (/^<\?php/m.test(first)) return 'php';
    if (/^(use |fn |let mut |pub |impl |struct )/m.test(first)) return 'rust';
    return 'text';
}

function getPasteConfig() {
    return {
        maxSizeKb: Number(db.getSetting('paste_max_size_kb')) || 512,
        screenshotMaxSizeMb: Number(db.getSetting('paste_screenshot_max_size_mb')) || 8,
        cooldownSeconds: Number(db.getSetting('paste_cooldown_seconds')) || 30,
        maxPerUserPerDay: Number(db.getSetting('paste_max_per_user_per_day')) || 0,
    };
}

function screenshotUrl(paste) {
    return paste.screenshot_path ? `/p/${paste.slug}/screenshot` : null;
}

function pastePublic(paste) {
    if (!paste) return null;
    return {
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
        url: `/p/${paste.slug}`,
        raw_url: `/p/${paste.slug}/raw`,
        created_at: paste.created_at,
        updated_at: paste.updated_at,
    };
}

// Effective actor for rate limits: user-JWT callers get cooldowns; app-key
// callers are trusted server-to-server (their platform enforces its own).
function _actor(req) {
    if (req.authType === 'user') return { userId: req.userId, ip: req.ip, limited: true };
    return { userId: (req.body && req.body.user_id) || null, ip: req.ip, limited: false };
}

function _rateLimitCheck(req, res) {
    const actor = _actor(req);
    if (!actor.limited) return true;
    const cfg = getPasteConfig();
    if (cfg.cooldownSeconds > 0) {
        const lastTime = db.getLastPasteTime(req.appId, actor.userId, actor.ip);
        const elapsed = (Date.now() - lastTime) / 1000;
        if (elapsed < cfg.cooldownSeconds) {
            const wait = Math.ceil(cfg.cooldownSeconds - elapsed);
            res.status(429).json({ error: `Please wait ${wait}s before creating another paste`, cooldown: wait });
            return false;
        }
    }
    if (cfg.maxPerUserPerDay > 0) {
        const todayCount = db.countUserPastesToday(req.appId, actor.userId, actor.ip);
        if (todayCount >= cfg.maxPerUserPerDay) {
            res.status(429).json({ error: `Daily paste limit reached (${cfg.maxPerUserPerDay}/day)` });
            return false;
        }
    }
    return true;
}

function _getPasteScoped(req, res) {
    const paste = db.getPasteBySlug(String(req.params.slug), req.appId);
    if (!paste) { res.status(404).json({ error: 'Paste not found' }); return null; }
    return paste;
}

// Fully remove a paste's screenshot from local disk AND any legacy B2 object.
function removePasteScreenshot(paste) {
    if (!paste) return;
    if (paste.screenshot_path) {
        try { fs.unlinkSync(paste.screenshot_path); } catch { /* ignore */ }
    }
    try { require('../vod/vod-storage').deleteLegacyPasteScreenshot(paste.id).catch(() => {}); } catch { /* ignore */ }
}

// ── List pastes ─────────────────────────────────────────────
router.get('/', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const type = req.query.type; // 'paste', 'screenshot', or undefined for all
        const search = req.query.search ? `%${req.query.search}%` : null;
        const userId = req.query.user_id != null ? req.query.user_id : null;

        let sql = `SELECT * FROM pastes WHERE app_id = ? AND visibility = 'public'`;
        const params = [req.appId];

        if (type === 'paste' || type === 'screenshot') { sql += ` AND type = ?`; params.push(type); }
        if (userId != null) { sql += ` AND user_id = ?`; params.push(userId); }
        if (search) { sql += ` AND (title LIKE ? OR content LIKE ?)`; params.push(search, search); }

        const dir = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
        sql += ` ORDER BY pinned DESC, created_at ${dir} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const pastes = db.all(sql, params).map(p => ({
            ...pastePublic(p),
            content: p.type === 'paste' ? (p.content || '').slice(0, 300) : null, // Preview only in list
        }));

        let countSql = `SELECT COUNT(*) as total FROM pastes WHERE app_id = ? AND visibility = 'public'`;
        const countParams = [req.appId];
        if (type === 'paste' || type === 'screenshot') { countSql += ` AND type = ?`; countParams.push(type); }
        if (userId != null) { countSql += ` AND user_id = ?`; countParams.push(userId); }
        if (search) { countSql += ` AND (title LIKE ? OR content LIKE ?)`; countParams.push(search, search); }
        const { total } = db.get(countSql, countParams);

        res.json({ pastes, total, limit, offset });
    } catch (err) {
        console.error('[Pastes] List error:', err.message);
        res.status(500).json({ error: 'Failed to list pastes' });
    }
});

// ── Paste config / limits (inherited SPA reads this before posting) ──
// Registered before /:slug so the literal path wins.
router.get('/config', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const cfg = getPasteConfig();
        const actor = _actor(req);
        res.json({
            maxSizeKb: cfg.maxSizeKb,
            screenshotMaxSizeMb: cfg.screenshotMaxSizeMb,
            cooldownSeconds: cfg.cooldownSeconds,
            maxPerUserPerDay: cfg.maxPerUserPerDay,
            todayCount: db.countUserPastesToday(req.appId, actor.userId, actor.ip),
        });
    } catch (err) {
        console.error('[Pastes] Config error:', err.message);
        res.status(500).json({ error: 'Failed to load paste config' });
    }
});

// ── Get single paste by slug ────────────────────────────────
router.get('/:slug', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;

        // Private pastes: owner (or the app itself) only.
        if (paste.visibility === 'private') {
            const allowed = req.authType === 'app' || (req.userId != null && paste.user_id === req.userId);
            if (!allowed) return res.status(404).json({ error: 'Paste not found' });
        }

        paste.liked = req.userId != null ? db.hasUserLikedPaste(paste.id, req.userId) : false;
        res.json({ paste: { ...pastePublic(paste), liked: paste.liked } });
    } catch (err) {
        console.error('[Pastes] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get paste' });
    }
});

// ── Create paste (text, or screenshot via multipart) ────────
router.post('/', tenantAuth({ allowUser: true }), screenshotUpload.single('screenshot'), async (req, res) => {
    try {
        const body = req.body || {};
        const cfg = getPasteConfig();

        if (!_rateLimitCheck(req, res)) {
            if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* */ } }
            return;
        }

        const actor = _actor(req);
        const userId = req.authType === 'user' ? req.userId : (body.user_id != null ? body.user_id : null);
        const vis = ['unlisted', 'private'].includes(body.visibility) ? body.visibility : 'public';
        const burn = body.burn_after_read ? 1 : 0;
        const nsfw = body.is_nsfw ? 1 : 0;
        const slug = generateSlug();

        // ── Screenshot paste ────────────────────────────────
        if (req.file) {
            if (req.file.size > cfg.screenshotMaxSizeMb * 1024 * 1024) {
                try { fs.unlinkSync(req.file.path); } catch { /* */ }
                return res.status(400).json({ error: `File too large (max ${cfg.screenshotMaxSizeMb} MB)` });
            }

            // Strip EXIF/GPS metadata by re-encoding with sharp (GIFs kept as-is
            // so animations survive).
            const mime = req.file.mimetype;
            if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') {
                try {
                    const img = sharp(req.file.path);
                    let buf;
                    if (mime === 'image/png')       buf = await img.png().toBuffer();
                    else if (mime === 'image/jpeg') buf = await img.jpeg({ quality: 90 }).toBuffer();
                    else                            buf = await img.webp({ quality: 90 }).toBuffer();
                    fs.writeFileSync(req.file.path, buf);
                    req.file.size = buf.length;
                } catch (stripErr) {
                    console.warn('[Pastes] Metadata strip warning:', stripErr.message);
                    // Continue with original file if re-encoding fails
                }
            }

            const metadata = JSON.stringify({
                page_url: body.page_url || null,
                user_agent: body.user_agent || req.get('user-agent') || null,
                original_name: req.file.originalname,
                size_bytes: req.file.size,
                mime_type: req.file.mimetype,
            });

            db.run(
                `INSERT INTO pastes (app_id, slug, user_id, type, title, content, language, visibility, stream_id, screenshot_path, metadata, burn_after_read, is_nsfw, ip_address)
                 VALUES (?, ?, ?, 'screenshot', ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?)`,
                [req.appId, slug, userId, sanitizeTitle(body.title || 'Screenshot'),
                 body.description || body.content || '', vis, body.stream_id || null, req.file.path, metadata, burn, nsfw, actor.ip]
            );

            const paste = db.getPasteBySlug(slug, req.appId);
            return res.status(201).json({ id: paste.id, slug, url: `/p/${slug}`, paste: pastePublic(paste) });
        }

        // ── Text paste ──────────────────────────────────────
        const content = body.content;
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ error: 'Content is required' });
        }
        const maxBytes = cfg.maxSizeKb * 1024;
        if (content.length > maxBytes) {
            return res.status(400).json({ error: `Paste too large (max ${cfg.maxSizeKb} KB)` });
        }

        const lang = detectLanguage(content, body.language);
        db.run(
            `INSERT INTO pastes (app_id, slug, user_id, type, title, content, language, visibility, stream_id, burn_after_read, is_nsfw, ip_address)
             VALUES (?, ?, ?, 'paste', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.appId, slug, userId, sanitizeTitle(body.title), content.trim(), lang, vis,
             body.stream_id || null, burn, nsfw, actor.ip]
        );

        const paste = db.getPasteBySlug(slug, req.appId);
        res.status(201).json({ id: paste.id, slug, url: `/p/${slug}`, paste: pastePublic(paste) });
    } catch (err) {
        console.error('[Pastes] Create error:', err.message);
        if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* */ } }
        res.status(500).json({ error: 'Failed to create paste' });
    }
});

// ── Update paste ────────────────────────────────────────────
router.put('/:slug', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;
        if (req.authType === 'user' && !(req.userId != null && paste.user_id === req.userId)) {
            return res.status(403).json({ error: 'Not authorized for this paste' });
        }

        const { title, content, language, visibility, pinned, is_nsfw } = req.body || {};
        const updates = [];
        const params = [];

        if (title !== undefined) { updates.push('title = ?'); params.push(sanitizeTitle(title)); }
        if (content !== undefined && paste.type === 'paste') {
            const cfg = getPasteConfig();
            if (content.length > cfg.maxSizeKb * 1024) return res.status(400).json({ error: 'Too large' });
            updates.push('content = ?'); params.push(content);
            updates.push('language = ?'); params.push(detectLanguage(content, language));
        }
        if (visibility !== undefined) { updates.push('visibility = ?'); params.push(['unlisted', 'private'].includes(visibility) ? visibility : 'public'); }
        if (is_nsfw !== undefined) { updates.push('is_nsfw = ?'); params.push(is_nsfw ? 1 : 0); }
        if (pinned !== undefined && req.authType === 'app') {
            updates.push('pinned = ?'); params.push(pinned ? 1 : 0);
        }

        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(paste.id);
        db.run(`UPDATE pastes SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ paste: pastePublic(db.getPasteBySlug(paste.slug, req.appId)) });
    } catch (err) {
        console.error('[Pastes] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update paste' });
    }
});

// ── Delete paste ────────────────────────────────────────────
router.delete('/:slug', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;
        if (req.authType === 'user' && !(req.userId != null && paste.user_id === req.userId)) {
            return res.status(403).json({ error: 'Not authorized for this paste' });
        }

        removePasteScreenshot(paste);
        db.run('DELETE FROM pastes WHERE id = ?', [paste.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('[Pastes] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete paste' });
    }
});

// ── Fork (copy) a paste ─────────────────────────────────────
router.post('/:slug/fork', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const original = _getPasteScoped(req, res);
        if (!original) return;
        if (original.type !== 'paste') return res.status(400).json({ error: 'Only text pastes can be forked' });
        if (!_rateLimitCheck(req, res)) return;

        const actor = _actor(req);
        const userId = req.authType === 'user' ? req.userId : (req.body?.user_id ?? null);
        const slug = generateSlug();
        db.run(
            `INSERT INTO pastes (app_id, slug, user_id, type, title, content, language, visibility, forked_from, ip_address)
             VALUES (?, ?, ?, 'paste', ?, ?, ?, 'public', ?, ?)`,
            [req.appId, slug, userId, `Fork of ${original.title}`,
             original.content, original.language, original.id, actor.ip]
        );

        const paste = db.getPasteBySlug(slug, req.appId);
        res.status(201).json({ id: paste.id, slug, url: `/p/${slug}`, paste: pastePublic(paste) });
    } catch (err) {
        console.error('[Pastes] Fork error:', err.message);
        res.status(500).json({ error: 'Failed to fork paste' });
    }
});

// ── Like / Unlike a paste ───────────────────────────────────
router.post('/:slug/like', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;
        const userId = req.authType === 'user' ? req.userId : (req.body?.user_id ?? null);
        if (userId == null) return res.status(400).json({ error: 'user_id required to like' });

        const alreadyLiked = db.hasUserLikedPaste(paste.id, userId);
        const result = alreadyLiked ? db.unlikePaste(paste.id, userId) : db.likePaste(paste.id, userId);
        res.json({ liked: !alreadyLiked, likes: result?.likes || 0 });
    } catch (err) {
        console.error('[Pastes] Like error:', err.message);
        res.status(500).json({ error: 'Failed to toggle like' });
    }
});

// ── Track a copy event ──────────────────────────────────────
router.post('/:slug/copy', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;
        db.incrementPasteCopies(paste.slug);
        res.json({ copies: (paste.copies || 0) + 1 });
    } catch (err) {
        res.status(500).json({ error: 'Failed to track copy' });
    }
});

// ═════════════════════════════════════════════════════════════
// ── Paste Comments (supports anonymous via app callers) ─────
// ═════════════════════════════════════════════════════════════

// Rate-limit state: IP → timestamp of last comment
const commentCooldowns = new Map();
const _cooldownSweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, ts] of commentCooldowns) {
        if (now - ts > 120_000) commentCooldowns.delete(ip);
    }
}, 600_000);
if (_cooldownSweep.unref) _cooldownSweep.unref();

router.get('/:slug/comments', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;

        const limit = Math.min(parseInt(req.query.limit || '50'), 100);
        const offset = parseInt(req.query.offset || '0');

        const comments = db.getPasteComments(paste.id, limit, offset);
        const total = db.getPasteCommentCount(paste.id);

        for (const c of comments) {
            c.replies = db.getPasteCommentReplies(c.id);
            c.reply_count = c.replies.length;
        }

        res.json({ comments, total });
    } catch (err) {
        console.error('[PasteComments] List error:', err.message);
        res.status(500).json({ error: 'Failed to load comments' });
    }
});

router.post('/:slug/comments', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;

        const ip = req.ip || 'unknown';
        const userId = req.authType === 'user' ? req.userId : (req.body?.user_id ?? null);

        // ── Anon check ──────────────────────────────────────
        if (userId == null && db.getSetting('paste_comment_anon_allowed') === false) {
            return res.status(401).json({ error: 'You must be logged in to comment' });
        }

        // ── Message validation ──────────────────────────────
        const message = (req.body?.message || '').trim();
        const maxLen = Number(db.getSetting('paste_comment_max_length')) || 2000;
        if (!message) return res.status(400).json({ error: 'Comment cannot be empty' });
        if (message.length > maxLen) {
            return res.status(400).json({ error: `Comment must be under ${maxLen} characters` });
        }

        // ── Anon name validation ────────────────────────────
        let anonName = null;
        if (userId == null) {
            anonName = (req.body?.anon_name || '').trim().substring(0, 32) || 'Anonymous';
            anonName = anonName.replace(/[^a-zA-Z0-9 _\-]/g, '').trim() || 'Anonymous';
        }

        // ── Rate limits (user-JWT/browser callers) ──────────
        if (req.authType === 'user') {
            const cooldownSec = Number(db.getSetting('paste_comment_cooldown_seconds')) || 10;
            const lastComment = commentCooldowns.get(ip);
            if (lastComment && (Date.now() - lastComment) < cooldownSec * 1000) {
                const wait = Math.ceil((cooldownSec * 1000 - (Date.now() - lastComment)) / 1000);
                return res.status(429).json({ error: `Please wait ${wait}s before commenting again` });
            }
            const recentFromIp = db.getRecentPasteCommentsByIp(ip, 60);
            if (recentFromIp.length >= 5) {
                return res.status(429).json({ error: 'Too many comments. Please slow down.' });
            }
            if (recentFromIp.length > 0 && recentFromIp[0].message === message) {
                return res.status(400).json({ error: 'Duplicate comment' });
            }
        }

        // ── Parent comment validation ───────────────────────
        const parentId = req.body?.parent_id ? parseInt(req.body.parent_id) : null;
        let parent = null;
        if (parentId) {
            parent = db.getPasteCommentById(parentId);
            if (!parent || parent.paste_id !== paste.id) {
                return res.status(400).json({ error: 'Invalid parent comment' });
            }
            // Prevent deeply nested replies — only allow replies to top-level
            if (parent.parent_id) {
                return res.status(400).json({ error: 'Cannot reply to a reply — reply to the original comment instead' });
            }
        }

        const result = db.createPasteComment({
            paste_id: paste.id,
            user_id: userId,
            parent_id: parentId,
            anon_name: anonName,
            message,
            ip_address: ip,
        });

        commentCooldowns.set(ip, Date.now());

        const comment = db.getPasteCommentById(result.lastInsertRowid);
        res.status(201).json({ comment });
    } catch (err) {
        console.error('[PasteComments] Create error:', err.message);
        res.status(500).json({ error: 'Failed to post comment' });
    }
});

router.delete('/:slug/comments/:commentId', tenantAuth({ allowUser: true }), (req, res) => {
    try {
        const paste = _getPasteScoped(req, res);
        if (!paste) return;

        const comment = db.getPasteCommentById(parseInt(req.params.commentId));
        if (!comment || comment.paste_id !== paste.id) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        // App callers moderate freely; user callers must be the comment author
        // or the paste owner.
        if (req.authType === 'user') {
            const isAuthor = comment.user_id != null && comment.user_id === req.userId;
            const isPasteOwner = paste.user_id != null && paste.user_id === req.userId;
            if (!isAuthor && !isPasteOwner) {
                return res.status(403).json({ error: 'Not authorized to delete this comment' });
            }
        }

        db.deletePasteComment(comment.id);
        res.json({ message: 'Comment deleted' });
    } catch (err) {
        console.error('[PasteComments] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;
module.exports.pastePublic = pastePublic;
module.exports.screenshotUrl = screenshotUrl;
module.exports.removePasteScreenshot = removePasteScreenshot;
module.exports.SCREENSHOTS_DIR = SCREENSHOTS_DIR;
