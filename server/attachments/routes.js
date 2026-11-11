/**
 * OpenVibe.Media — composer attachments (composer.attachment@1)
 *
 * POST   /api/v1/attachments               multipart field `file` -> composer.attachment@1
 * POST   /api/v1/attachments/:id/keep      { message_id } -> composer.attachment@1 (kept with a message)
 * DELETE /api/v1/attachments/:id           the person who uploaded it -> 204
 * GET    /a/:id/:name                      the bytes (public, unguessable id), and /a/:id/thumb.jpg
 *
 * One person's file, stored before it is sent, so every site's composer attaches the same way. Credentials:
 * a Network user JWT (the browser), or a first-party service token holding media.object.upload with the person
 * named in X-OV-Subject (a site's server). Media sniffs the bytes and decides the kind; an executable is refused.
 * Limits: image 20 MB, video 300 MB, audio 50 MB, anything else 25 MB (code included). An unkept attachment
 * expires 24 hours after upload; a keep names the message it belongs to and moves it to the kept window.
 *
 * The CORS allow-list is every first-party origin (the service manifests' domains, server/attachments/origins.js).
 * A foreign origin gets no Access-Control-Allow-Origin and is refused by the browser; the bytes route is public.
 */
'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const sdkAuth = require('openvibe-sdk/auth');
const sharp = require('sharp');
const db = require('../db/database');
const config = require('../config');
const auth = require('../auth');
const ctypes = require('../objects/content-type');
const { limits } = require('../actor-limits');
const { openVibeOrigins } = require('./origins');

const { capabilities, http, ids } = contracts;
const MB = 1024 * 1024;
const MAX_BYTES = { image: 20 * MB, video: 300 * MB, audio: 50 * MB, file: 25 * MB, code: 25 * MB };
const UPLOAD_MAX = 300 * MB;
const ttlMs = () => (Number(config.attachments.ttlHours) || 24) * 60 * 60 * 1000;
const keepMs = () => (Number(config.attachments.keepDays) || 30) * 24 * 60 * 60 * 1000;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_MAX = 255;

const router = express.Router();
const publicRouter = express.Router();

function problem(res, status, code, detail) {
    return http.sendProblem(res, status, code, { detail });
}

// ── CORS: first-party origins only ───────────────────────────
function cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin) res.set('Vary', 'Origin');
    if (origin && openVibeOrigins().has(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-OV-Subject, X-OV-User-Id, Idempotency-Key, traceparent, X-OpenVibe-Request-Id');
        res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
}
router.use(cors);

// ── Storage ──────────────────────────────────────────────────
function root() { return path.resolve(config.attachments.path); }
function dirOf(id) { return path.join(root(), id); }
function sanitizeName(name) {
    const base = path.basename(String(name || 'file')).replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, NAME_MAX);
    return base.trim() || 'file';
}
function publicUrl(id, name) { return `${config.publicUrl}/a/${encodeURIComponent(id)}/${encodeURIComponent(name)}`; }
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('data', (d) => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function ensureDirs() {
    if (!fs.existsSync(root())) fs.mkdirSync(root(), { recursive: true });
}
function tmpDir() {
    const d = path.join(root(), '.tmp');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
}

// ── Credentials: a user JWT, or a first-party service token naming the person ──
function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
function namedSubject(req) {
    const raw = req.headers['x-ov-subject'];
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    const parsed = ids.parseSubject(s);
    if (parsed && parsed.type === 'user') return parsed.id;
    return SUBJECT_RE.test(s) ? s : null;
}
async function verifyUser(token) {
    const keys = auth.networkKeys();
    let p;
    try { p = await sdkAuth.verifyUserToken(token, { ...keys.verifyOptions, issuer: config.network.url }); } catch { return null; }
    if (p.aud) {
        const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
        if (!aud.includes('openvibe.media')) return null;
    }
    // Network's session token carries the numeric account id in `sub` and the person's subject in `subject_id`.
    const subject = String(p.subject_id || p.sub || '');
    return SUBJECT_RE.test(subject) ? { payload: p, subject } : null;
}
async function attachmentAuth(req, res, next) {
    const token = bearer(req);
    if (!token) return problem(res, 401, 'token.missing', 'a Network token is required');
    let subject = null;
    let principal = null;
    if (token.split('.').length === 3) {
        const svc = await auth.verifyServiceTokenResult(token);
        if (svc.ok) {
            if (!String(svc.claims.sub || '').startsWith('svc:')) {
                return problem(res, 403, 'capability.denied', 'only a first-party service token or a person may attach a file');
            }
            const c = capabilities.check(svc.claims, 'media.object.upload');
            if (!c.allowed) return problem(res, 403, c.code || 'capability.denied', c.reason || 'media.object.upload is not granted');
            subject = namedSubject(req);
            if (!subject) return problem(res, 403, 'attachments.subject_required', 'a service token must name the person in X-OV-Subject (usr_…)');
            principal = svc.claims.sub;
        }
    }
    if (!subject) {
        const user = await verifyUser(token);
        if (!user) return problem(res, 401, 'token.invalid', 'the token is not a valid Network person or media service token');
        subject = user.subject;
        principal = user.subject;
    }
    req.person = { subject, principal };
    next();
}

// ── Bytes sniffing ───────────────────────────────────────────
const MIME = {
    jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    avif: 'image/avif', heic: 'image/heic', heix: 'image/heic', mif1: 'image/heic', msf1: 'image/heic',
    mp4: 'video/mp4', matroska: 'video/webm', ogg: 'video/ogg', avi: 'video/x-msvideo',
    wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', mpegts: 'video/mp2t', pdf: 'application/pdf',
};
const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|cs|java|kt|swift|php|sh|bash|zsh|fish|ps1|sql|html|htm|css|scss|sass|less|json|jsonc|yaml|yml|toml|ini|xml|svg|vue|svelte|astro|md|mdx|lua|pl|r|dart|ex|exs|erl|hs|scala|clj|sol|zig|nim|graphql|gql|tf|dockerfile|make|cmake)$/i;
const CODE_MIME = /^(application\/(javascript|ecmascript|typescript|json|xml|x-sh|x-httpd-php|x-ruby|x-python|x-perl|x-shellscript|x-csh|x-c\+\+|x-java-source|x-lua|x-rust|x-go)|text\/(javascript|typescript|css|html|x-python|x-sh|x-c|x-c\+\+|x-java-source|x-markdown|x-rust|x-go))/;
const EXEC_MIME = /^(application\/(x-msdownload|x-msdos-program|x-dosexec|x-executable|x-mach-binary|x-sharedlib|x-object|x-elf|vnd\.microsoft\.portable-executable|java-archive|vnd\.android\.package-archive|x-apple-diskimage|x-msi|x-rpm|x-deb))/;
const EXEC_EXT = /\.(exe|dll|sys|so|dylib|bin|com|msi|bat|cmd|ps1|vbs|wsf|scr|jar|apk|appimage|deb|rpm|dmg|pkg|elf)$/i;

/** Is this a binary executable or an installer? (refused before it is stored) */
function isExecutable(head, declaredMime, name) {
    if (EXEC_MIME.test(String(declaredMime || '').toLowerCase())) return true;
    if (EXEC_EXT.test(String(name || ''))) return true;
    const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
    if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true;                                  // MZ / PE
    if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true;  // ELF
    if (b.length >= 4) {
        const magic = b.readUInt32BE(0);
        if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return true;  // Mach-O / fat
    }
    return false;
}

/** { kind, mime } from the bytes (never the browser's claim), with the extension only for source text. */
function classify(head, declaredMime, name) {
    const sniffed = ctypes.sniff(head);
    if (sniffed) {
        const mime = MIME[sniffed.format] || (sniffed.family === 'pdf' ? 'application/pdf' : declaredMime);
        if (sniffed.family === 'image') return { kind: 'image', mime };
        if (sniffed.family === 'video') return { kind: 'video', mime };
        if (sniffed.family === 'audio') return { kind: 'audio', mime };
        if (sniffed.family === 'av') return /^audio\//.test(String(declaredMime || '')) ? { kind: 'audio', mime } : { kind: 'video', mime };
        return { kind: 'file', mime };
    }
    const declared = ctypes.normalize(declaredMime);
    if (CODE_EXT.test(String(name || '')) || CODE_MIME.test(String(declared || ''))) return { kind: 'code', mime: declared || 'text/plain; charset=utf-8' };
    return { kind: 'file', mime: declared || 'application/octet-stream' };
}

// ── Thumbnails and size ──────────────────────────────────────
async function imageInfo(file, dir) {
    const meta = await sharp(file).metadata();
    let w = Number(meta.width) || null;
    let h = Number(meta.height) || null;
    if (meta.orientation && meta.orientation >= 5) [w, h] = [h, w];
    const thumb = path.join(dir, 'thumb.jpg');
    try {
        await sharp(file).rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(thumb);
        return { width: w, height: h, thumb_name: 'thumb.jpg' };
    } catch { return { width: w, height: h, thumb_name: null }; }
}
async function videoInfo(file, dir) {
    let width = null, height = null;
    try {
        const info = await require('../vod/media-tools').probeDuration(file);
        const v = (info.streams || []).find(s => s.codec_type === 'video' && Number(s.width) > 0);
        if (v) { width = Number(v.width); height = Number(v.height); }
    } catch { /* no ffprobe: no size */ }
    let thumbName = null;
    try {
        const ok = await require('../thumbnails/thumbnail-service').extractFrameToFile(file, 1, path.join(dir, 'thumb.jpg'));
        if (ok) thumbName = 'thumb.jpg';
    } catch { /* best effort */ }
    return { width, height, thumb_name: thumbName };
}

// ── The answer ───────────────────────────────────────────────
function shape(row) {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        size: Number(row.size_bytes),
        mime: row.mime,
        url: publicUrl(row.id, row.stored_name),
        thumb: row.thumb_name ? publicUrl(row.id, row.thumb_name) : null,
        w: row.width != null ? Number(row.width) : null,
        h: row.height != null ? Number(row.height) : null,
        expires_at: row.expires_at,
    };
}
const getRow = (id) => db.get('SELECT * FROM media_attachments WHERE id = ?', [id]);
const deleteRow = (id) => db.run('DELETE FROM media_attachments WHERE id = ?', [id]);

// ── Upload ───────────────────────────────────────────────────
// multer creates its destination when built; a restore drill takes no upload and writes nothing.
const upload = multer({
    storage: require('../drill').enabled ? multer.memoryStorage() : multer.diskStorage({ destination: (_req, _file, cb) => cb(null, tmpDir()) }),
    limits: { fileSize: UPLOAD_MAX, files: 1, fields: 10 },
});

router.post('/', attachmentAuth, limits('media.attachment.upload', { minute: 30, hour: 600 }), upload.single('file'), async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
        if (!req.file) return problem(res, 400, 'attachments.file_required', 'send one file in the multipart field `file`');
        const head = ctypes.readHead(req.file.path, 512);
        const name = sanitizeName(req.file.originalname);
        if (isExecutable(head, req.file.mimetype, name)) return problem(res, 415, 'media.attachment.executable', 'executables and installers are not accepted');
        const { kind, mime } = classify(head, req.file.mimetype, name);
        const max = MAX_BYTES[kind];
        if (req.file.size > max) {
            return problem(res, 413, 'media.attachment.too_large', `a ${kind} may be at most ${Math.round(max / MB)} MB`);
        }
        const id = `att_${ids.ulid()}`;
        const dir = dirOf(id);
        fs.mkdirSync(dir, { recursive: true });
        const stored = name;
        const dest = path.join(dir, stored);
        try { fs.renameSync(tmp, dest); } catch { fs.copyFileSync(tmp, dest); try { fs.unlinkSync(tmp); } catch { /* */ } }
        const sha256 = await sha256File(dest);
        let info = { width: null, height: null, thumb_name: null };
        if (kind === 'image') info = await imageInfo(dest, dir).catch(() => info);
        else if (kind === 'video') info = await videoInfo(dest, dir).catch(() => info);
        const expiresAt = new Date(Date.now() + ttlMs()).toISOString();
        await db.run(
            `INSERT INTO media_attachments (id, subject, principal, name, stored_name, kind, mime, size_bytes, sha256, width, height, thumb_name, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, req.person.subject, req.person.principal, req.file.originalname || name, stored, kind, mime, req.file.size, sha256, info.width, info.height, info.thumb_name, expiresAt]);
        const row = await getRow(id);
        res.status(201).json(shape(row));
    } catch (err) {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* */ } }
        if (err && err.code === 'LIMIT_FILE_SIZE') return problem(res, 413, 'media.attachment.too_large', 'the file is larger than 300 MB');
        console.error('[Attachments] Upload error:', err.message);
        if (!res.headersSent) problem(res, 500, 'media.attachment.store_failed', 'the file could not be stored');
    }
});

// ── Keep with a message ──────────────────────────────────────
router.post('/:id/keep', attachmentAuth, limits('media.attachment.keep', { minute: 120, hour: 1200 }), async (req, res) => {
    try {
        const row = await getRow(String(req.params.id || ''));
        if (!row || row.subject !== req.person.subject) return problem(res, 404, 'media.attachment.not_found', 'no such attachment for this person');
        const messageId = String((req.body && req.body.message_id) || '').trim();
        if (!messageId || messageId.length > 200) return problem(res, 422, 'attachments.message_required', 'name the message this attachment belongs to in `message_id`');
        const expiresAt = new Date(Date.now() + keepMs()).toISOString();
        await db.run('UPDATE media_attachments SET message_id = ?, kept_at = ?, expires_at = ? WHERE id = ?', [messageId, new Date().toISOString(), expiresAt, row.id]);
        res.json(shape(await getRow(row.id)));
    } catch (err) {
        console.error('[Attachments] Keep error:', err.message);
        problem(res, 500, 'media.attachment.keep_failed', 'the attachment could not be kept');
    }
});

// ── Delete (the person who uploaded it) ─────────────────────
router.delete('/:id', attachmentAuth, limits('media.attachment.delete', { minute: 60, hour: 1200 }), async (req, res) => {
    try {
        const row = await getRow(String(req.params.id || ''));
        if (!row || row.subject !== req.person.subject) return problem(res, 404, 'media.attachment.not_found', 'no such attachment for this person');
        await deleteRow(row.id);
        fs.rmSync(dirOf(row.id), { recursive: true, force: true });
        res.status(204).end();
    } catch (err) {
        console.error('[Attachments] Delete error:', err.message);
        problem(res, 500, 'media.attachment.delete_failed', 'the attachment could not be deleted');
    }
});

// ── Expiry sweep ─────────────────────────────────────────────
/** Remove the rows (and directories) whose expires_at has passed. Returns how many went. */
async function cleanupExpired({ now = new Date(), limit = 500 } = {}) {
    const rows = await db.all('SELECT id FROM media_attachments WHERE expires_at < ? ORDER BY expires_at LIMIT ?', [now.toISOString(), limit]);
    for (const r of rows) {
        try { await deleteRow(r.id); } catch { continue; }
        fs.rmSync(dirOf(r.id), { recursive: true, force: true });
    }
    return rows.length;
}
function startCleanup() {
    const timer = setInterval(() => { cleanupExpired().catch(err => console.warn('[Attachments] cleanup:', err.message)); }, 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    return timer;
}

// ── The bytes ────────────────────────────────────────────────
function sendBytes(req, res, row, filename, mime) {
    const file = path.join(dirOf(row.id), filename);
    if (!fs.existsSync(file)) return problem(res, 404, 'media.attachment.not_found', 'the bytes are gone');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    const inline = /^(image|video|audio)\//.test(mime) || mime === 'application/pdf';
    const safe = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.type(mime);
    res.sendFile(file);
}
publicRouter.get('/:id/thumb.jpg', async (req, res, next) => {
    try {
        const row = await getRow(String(req.params.id || ''));
        if (!row || !row.thumb_name) return next();
        sendBytes(req, res, row, row.thumb_name, 'image/jpeg');
    } catch (err) { next(err); }
});
publicRouter.get('/:id/:name', async (req, res, next) => {
    try {
        const row = await getRow(String(req.params.id || ''));
        if (!row) return problem(res, 404, 'media.attachment.not_found', 'no such attachment');
        sendBytes(req, res, row, row.stored_name, row.mime);
    } catch (err) { next(err); }
});

// Multer's own refusals become problem+json.
router.use((err, req, res, next) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
        const code = err.code === 'LIMIT_FILE_SIZE' ? 'media.attachment.too_large' : 'attachments.invalid_upload';
        return problem(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, code, err.message);
    }
    console.error('[Attachments] Unhandled route error:', err.message);
    if (!res.headersSent) problem(res, 500, 'media.attachment.failed', 'the request could not be handled');
});

module.exports = router;
module.exports.publicRouter = publicRouter;
module.exports.cleanupExpired = cleanupExpired;
module.exports.startCleanup = startCleanup;
module.exports.shape = shape;
module.exports.classify = classify;
module.exports.isExecutable = isExecutable;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports._ensureDirs = ensureDirs;
