/**
 * OpenVibe.Media — Object API v2 (mounted at /api/v2/:app/objects; docs/object-model.md)
 *
 * POST   /                    init upload → { id, object, upload: { method, url, token, expires_at, max_bytes, … } }
 *                              (objects over MEDIA_OBJECT_MAX_MB, or { multipart: true }: a multipart session)
 * POST   /:id/upload-url      a fresh presigned single-PUT URL (scoped to tenant, object and size; ?ttl)
 * PUT    /:id/content         the bytes (single part; sha256 computed; size + quota + content type checked)
 * POST   /:id/complete        verify (expected hash, invariant, quota, content bytes) → lifecycle ready
 * POST   /:id/multipart                         start a multipart session { part_size } → upload_id, token
 * GET    /:id/multipart/:uploadId               session: parts received (sha256), `missing` (resume)
 * PUT    /:id/multipart/:uploadId/parts/:n      one part (exact size; X-Content-SHA256 optional)
 * POST   /:id/multipart/:uploadId/complete      assemble + the same checks as complete → ready
 * DELETE /:id/multipart/:uploadId               abort (parts deleted; the object stays uploading)
 * GET    /:id                 metadata (id = med_… or legacy:<app>:<kind>:<id>)
 * GET    /                    cursor list (?kind&visibility&status&owner&user_id&include_deleted&limit&cursor)
 * DELETE /:id                 soft delete (bytes kept MEDIA_DELETE_RETENTION_DAYS); 409 when held
 * POST   /:id/restore         undo a soft delete inside the retention period
 * GET    /:id/download        302 to the public location, or a signed short-lived URL for private objects
 * GET    /:id/holds           retention holds (?all=1 includes released)
 * POST   /:id/holds           place a hold  { kind, reason, created_by }     (app key only)
 * DELETE /:id/holds/:holdId   release it                                      (app key only)
 *
 * Auth: the app's API key, or a Network service token granting media.object.upload
 * (writes) / media.object.read (reads) for namespace = :app. Developer-project tenants
 * (:app = prj_<ULID>) take their project's app tokens only (server/auth.js); their sandbox
 * objects are served only through signed URLs, whatever their visibility. X-OV-Subject names the
 * owner (usr_…); X-OV-User-Id (app key only) acts as one of the app's users. The
 * content PUT and complete also accept the upload token handed out at init (a presigned
 * URL), and the multipart routes the session token, so a browser can send the bytes directly.
 *
 * Public bytes: GET /o/:id (publicRouter) — public/unlisted objects openly,
 * private ones only with a valid ?exp&sig from /download.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ids, http } = require('openvibe-contracts');
const db = require('../db/database');
const config = require('../config');
const model = require('./model');
const invariant = require('./invariant');
const signing = require('./signing');
const ctypes = require('./content-type');
const multipart = require('./multipart');
const { tenantAuth, tenantCors, tenantPath } = require('../auth');
const { announce } = require('../webhooks');

const MB = 1024 * 1024;
const upload = tenantAuth({ capability: 'media.object.upload' });
const read = tenantAuth({ capability: 'media.object.read' });
const appOnly = tenantAuth();

function problem(res, status, code, detail, extra) {
    return http.sendProblem(res, status, code, { detail, extra });
}

/** Owner subject from X-OV-Subject: 'usr_…' or 'user:usr_…'. undefined = malformed. */
function subjectFrom(req) {
    const raw = req.headers['x-ov-subject'];
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    const parsed = ids.parseSubject(s);
    if (parsed && parsed.type === 'user') return parsed.id;
    return ids.isSubjectId('user', s) ? s : undefined;
}

// An app acting for one of its users (X-OV-User-Id) sees public/unlisted objects
// plus that user's own; the app itself and service principals see the namespace.
function canSee(req, obj) {
    return req.authType !== 'user' || obj.visibility !== 'private' || (obj.owner_user_id != null && obj.owner_user_id === req.userId);
}
function canWrite(req, obj) {
    return req.authType !== 'user' || (obj.owner_user_id != null && obj.owner_user_id === req.userId);
}

function load(req, res) {
    const obj = model.resolveObject(String(req.params.id || ''), req.appId);
    if (!obj || !canSee(req, obj)) { problem(res, 404, 'media.object.not_found', 'No such object in this namespace'); return null; }
    return obj;
}

/** The token-bearing request's object and tenant; the URL must address that tenant. */
function tokenTenant(req, res, obj) {
    // A developer-project tenant is addressed by its project id, whichever of its production/sandbox rows holds the object.
    const app = obj ? db.getApp(obj.app_id) : null;
    if (!app || tenantPath(app) !== String(req.params.app || '')) { res.status(404).json({ error: 'Unknown app' }); return false; }
    req.appId = app.app_id;
    req.appPath = tenantPath(app);
    req.appRow = app;
    req.authType = 'upload_token';
    return true;
}

/** Upload token (a presigned URL from init or /upload-url) or the usual tenant credential with media.object.upload. */
function contentAuth(req, res, next) {
    const token = req.query.token || req.headers['x-upload-token'];
    if (!token) return upload(req, res, next);
    const id = String(req.params.id || '');
    const obj = model.getObject(id);
    // Scoped to tenant + object + size: a token for another object, tenant or size never verifies.
    const size = obj && Number(obj.size_bytes) > 0 ? Number(obj.size_bytes) : 0;
    if (!obj || !signing.verifyUploadToken(id, token, { tenant: obj.app_id, size })) return problem(res, 401, 'media.upload_token.invalid', 'Upload token is invalid or expired');
    if (tokenTenant(req, res, obj)) next();
}

/** Multipart session token (from POST /:id/multipart) or the usual tenant credential with `capability`. */
function multipartAuth(capability) {
    const fallback = tenantAuth({ capability });
    return (req, res, next) => {
        const token = req.query.token || req.headers['x-upload-token'];
        if (!token) return fallback(req, res, next);
        const obj = model.getObject(String(req.params.id || ''));
        const session = multipart.getSession(String(req.params.uploadId || ''));
        const ok = obj && session && session.object_id === obj.id && signing.verifyMultipartToken(token, {
            tenant: obj.app_id, objectId: obj.id, uploadId: session.id, totalSize: session.total_size,
        });
        if (!ok) return problem(res, 401, 'media.upload_token.invalid', 'Upload token is invalid or expired');
        if (tokenTenant(req, res, obj)) next();
    };
}

function apiBase(req) {
    return `${config.publicUrl}/api/v2/${encodeURIComponent(req.appPath || req.appId)}/objects`;
}

/** A presigned single-PUT URL for this object: { method, url, token, expires_at, max_bytes, content_type }. */
function presignedPut(req, obj, ttlS) {
    const size = Number(obj.size_bytes) > 0 ? Number(obj.size_bytes) : 0;
    const tok = signing.uploadToken(obj.id, ttlS, { tenant: obj.app_id, size });
    return {
        method: 'PUT',
        url: `${apiBase(req)}/${obj.id}/content?token=${encodeURIComponent(tok.token)}`,
        token: tok.token,
        expires_at: tok.expires_at,
        max_bytes: size || config.objects.maxUploadMb * MB,
        content_type: obj.mime_type || null,
    };
}

/** Public shape of a multipart session plus what a client needs to send it (URLs carry the session token). */
function multipartPublic(req, obj, session, { parts = true } = {}) {
    const tok = signing.multipartToken({ tenant: obj.app_id, objectId: obj.id, uploadId: session.id, totalSize: session.total_size, expiresAt: Date.parse(String(session.expires_at).replace(' ', 'T') + 'Z') });
    const u = `${apiBase(req)}/${obj.id}/multipart/${session.id}`;
    const q = `token=${encodeURIComponent(tok.token)}`;
    return {
        ...multipart.sessionPublic(session, { parts }),
        token: tok.token,
        part_url_template: `${u}/parts/{part_number}?${q}`,
        status_url: `${u}?${q}`,
        complete_url: `${u}/complete?${q}`,
        abort_url: `${u}?${q}`,
    };
}

function sanitizeFilename(name) {
    if (name == null || name === '') return null;
    return path.basename(String(name)).replace(/[^\w.\- ]/g, '_').slice(0, 200) || null;
}

function quotaCheck(req, res, addBytes, excludeId = null) {
    const quota = Number(req.appRow.quota_bytes) || 0;
    if (!quota) return true;
    const used = model.usedBytes(req.appId, excludeId);
    if (used + addBytes <= quota) return true;
    problem(res, 413, 'media.quota.exceeded', 'App storage quota exceeded', { quota_bytes: quota, used_bytes: used });
    return false;
}

// ── Content upload (mounted ahead of the JSON body parser — see index.js) ──

/** Stream the request body to `tmp`, hashing as it goes; stop past `cap` bytes. */
function receive(req, tmp, cap) {
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(tmp);
        let n = 0, done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        // Failures settle once the file handle is closed, so the caller's unlink cannot race the open.
        const fail = (r) => { if (done) return; if (out.closed) return finish(r); out.once('close', () => finish(r)); out.destroy(); };
        req.on('data', (chunk) => {
            if (done) return;
            n += chunk.length;
            if (n > cap) { req.unpipe(out); req.resume(); return fail({ error: 'too_large' }); }
            hash.update(chunk);
        });
        req.on('aborted', () => fail({ error: 'aborted' }));
        req.on('error', () => fail({ error: 'aborted' }));
        out.on('error', (e) => fail({ error: 'write', message: e.message }));
        out.on('finish', () => finish({ bytes: n, sha256: hash.digest('hex') }));
        req.pipe(out);
    });
}

async function putContent(req, res) {
    const obj = load(req, res);
    if (!obj) { req.resume(); return; }
    if (!canWrite(req, obj)) { req.resume(); return problem(res, 403, 'media.object.forbidden', 'Not your object'); }
    if (obj.legacy_ref) { req.resume(); return problem(res, 409, 'media.object.legacy_managed', 'This object is written through the v1 API'); }
    if (obj.lifecycle_status !== 'uploading') { req.resume(); return problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`); }

    const declared = Number(obj.size_bytes) > 0 ? Number(obj.size_bytes) : null;
    const single = config.objects.maxUploadMb * MB;
    if (declared && declared > single) {
        res.set('Connection', 'close'); req.resume();
        return problem(res, 413, 'media.object.too_large', `Objects over ${single} bytes are uploaded in parts: POST /${obj.id}/multipart`);
    }
    if (multipart.activeFor(obj.id)) { req.resume(); return problem(res, 409, 'media.upload.multipart_active', 'A multipart upload is open for this object: complete or abort it first'); }
    const cap = declared || single;
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > cap) {
        res.set('Connection', 'close'); req.resume();
        return problem(res, 413, 'media.object.too_large', `At most ${cap} bytes`);
    }
    // No type declared at init: the request's Content-Type becomes it, and must suit the kind.
    const headerType = ctypes.normalize(req.headers['content-type']);
    const effectiveType = obj.mime_type || headerType || 'application/octet-stream';
    const typeProblem = ctypes.kindProblem(obj.kind, obj.mime_type || headerType);
    if (typeProblem) { req.resume(); return problem(res, 415, 'media.object.unsupported_type', typeProblem); }

    const tmpDir = path.join(config.objects.path, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${obj.id}-${crypto.randomBytes(4).toString('hex')}`);
    const got = await receive(req, tmp, cap);
    const drop = () => { try { fs.unlinkSync(tmp); } catch { /* not written */ } };
    if (got.error) {
        drop();
        if (got.error === 'too_large') { res.set('Connection', 'close'); return problem(res, 413, 'media.object.too_large', `At most ${cap} bytes`); }
        return problem(res, 400, 'media.object.upload_interrupted', got.message || 'Upload did not complete');
    }
    if (declared && got.bytes !== declared) { drop(); return problem(res, 400, 'media.object.size_mismatch', `Declared ${declared} bytes, received ${got.bytes}`); }
    if (!got.bytes) { drop(); return problem(res, 400, 'media.object.empty', 'No bytes received'); }
    if (!quotaCheck(req, res, got.bytes, obj.id)) { drop(); return; }

    try {
        const dest = model.objectFilePath(obj);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(tmp, dest);
        db.getDb().transaction(() => {
            model.updateObject(obj.id, {
                size_bytes: got.bytes, content_hash: got.sha256, mime_type: effectiveType,
                canonical_provider: 'local', canonical_key: dest,
            });
            model.upsertLocation(obj.id, { provider: 'local', key: dest, state: 'present', size_bytes: got.bytes, checksum: got.sha256, verified: true });
        })();
        res.json({ id: obj.id, size_bytes: got.bytes, content_hash: got.sha256 });
    } catch (err) {
        drop();
        console.error('[Objects] content store error:', err.message);
        problem(res, 500, 'media.object.store_failed', 'Failed to store content');
    }
}

// ── API router ───────────────────────────────────────────────

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

router.post('/', upload, (req, res) => {
    try {
        const b = req.body || {};
        const kind = String(b.kind || 'file');
        if (!model.KINDS.includes(kind)) return problem(res, 400, 'media.object.invalid', `kind must be one of ${model.KINDS.join(', ')}`);
        const visibility = String(b.visibility || 'private');
        if (!model.VISIBILITIES.includes(visibility)) return problem(res, 400, 'media.object.invalid', 'visibility must be public, unlisted or private');
        let size = 0;
        if (b.size_bytes != null) {
            size = Number(b.size_bytes);
            if (!Number.isInteger(size) || size < 1) return problem(res, 400, 'media.object.invalid', 'size_bytes must be a positive integer');
        }
        const max = config.objects.maxUploadMb * MB;
        const wantParts = b.multipart === true || b.multipart === 'true';
        if (wantParts && !size) return problem(res, 400, 'media.object.invalid', 'A multipart upload needs size_bytes');
        if (!wantParts && size > max) return problem(res, 413, 'media.object.too_large', `Single-part uploads are limited to ${max} bytes; send multipart: true for larger objects`);
        if (wantParts && size > config.objects.multipartMaxMb * MB) return problem(res, 413, 'media.object.too_large', `Objects are limited to ${config.objects.multipartMaxMb * MB} bytes`);
        if (size && invariant.wouldViolate({ kind, visibility, size_bytes: size })) {
            return problem(res, 422, 'media.invariant.public_object_too_large', `Public playback objects are limited to ${config.objects.publicMaxMb} MB`);
        }
        if (b.content_hash != null && !/^[a-f0-9]{64}$/i.test(String(b.content_hash))) return problem(res, 400, 'media.object.invalid', 'content_hash must be a sha256 hex digest');
        if (b.metadata != null && (typeof b.metadata !== 'object' || Array.isArray(b.metadata) || JSON.stringify(b.metadata).length > 16384)) {
            return problem(res, 400, 'media.object.invalid', 'metadata must be an object of at most 16 KB');
        }
        const subject = subjectFrom(req);
        if (subject === undefined) return problem(res, 400, 'media.object.invalid', 'X-OV-Subject must be a user subject (usr_…)');
        if (!quotaCheck(req, res, size)) return;

        const mime = b.mime_type && /^[\w.+-]+\/[\w.+-]+$/.test(String(b.mime_type)) ? String(b.mime_type).toLowerCase() : null;
        if (mime) {
            const why = ctypes.kindProblem(kind, mime);
            if (why) return problem(res, 415, 'media.object.unsupported_type', why);
        }
        if (b.upload_ttl != null && !(Number(b.upload_ttl) >= 60 && Number(b.upload_ttl) <= 86400)) return problem(res, 400, 'media.object.invalid', 'upload_ttl must be 60-86400 seconds');
        const userId = req.authType === 'user' ? req.userId : (Number.isInteger(Number(b.user_id)) && Number(b.user_id) > 0 ? Number(b.user_id) : null);
        const metadata = { ...(b.metadata || {}) };
        const filename = sanitizeFilename(b.filename);
        if (filename) metadata.filename = filename;
        if (b.content_hash) metadata.expected_sha256 = String(b.content_hash).toLowerCase();
        if (req.principal) metadata.created_by = req.principal.sub;

        const id = model.createObject({
            app_id: req.appId, namespace: req.appId, kind, owner_subject: subject, owner_app: req.appId, owner_user_id: userId,
            visibility, lifecycle_status: 'uploading', mime_type: mime, size_bytes: size, metadata,
        });
        const obj = model.getObject(id);
        let session = null;
        if (wantParts) {
            session = multipart.initiate(obj, { partSize: b.part_size });
            if (session.error) {
                db.run('DELETE FROM media_objects WHERE id = ?', [id]);         // nothing was stored for it
                return problem(res, session.status, session.code, session.error);
            }
        }
        const single = !wantParts ? presignedPut(req, obj, b.upload_ttl) : null;
        res.status(201).json({
            id,
            object: model.objectPublic(obj),
            upload: {
                ...(single || { method: 'multipart', url: null, token: null, expires_at: null, max_bytes: size, content_type: mime }),
                complete_url: `${apiBase(req)}/${id}/complete`,
                multipart_url: `${apiBase(req)}/${id}/multipart`,
                ...(session ? { multipart: multipartPublic(req, obj, session, { parts: false }) } : {}),
            },
        });
    } catch (err) {
        console.error('[Objects] init error:', err.message);
        problem(res, 500, 'media.object.init_failed', 'Failed to create object');
    }
});

/**
 * The checks every upload ends with (single PUT and multipart): expected sha256, the public-size
 * invariant, the quota, and whether the bytes are what their type says; then the ready transition,
 * its invariant row and the media.object.uploaded event commit together (the webhook follows).
 */
function completeUpload(req, res, obj, { expectedHash = null } = {}) {
    const loc = model.listLocations(obj.id).find(l => l.provider === 'local' && l.state === 'present');
    if (!loc || !fs.existsSync(loc.key)) return problem(res, 409, 'media.object.no_content', 'PUT the content first');
    const md = model.parseJson(obj.metadata, {});
    const expected = String(expectedHash || md.expected_sha256 || '').toLowerCase();
    if (expected && expected !== obj.content_hash) {
        return problem(res, 422, 'media.object.hash_mismatch', 'Content hash does not match', { expected, actual: obj.content_hash });
    }
    if (invariant.wouldViolate(obj)) {
        return problem(res, 422, 'media.invariant.public_object_too_large', `Public playback objects are limited to ${config.objects.publicMaxMb} MB`);
    }
    if (!quotaCheck(req, res, Number(obj.size_bytes) || 0, obj.id)) return;
    const typeWhy = ctypes.kindProblem(obj.kind, obj.mime_type) || ctypes.contentProblem(obj.kind, obj.mime_type, ctypes.readHead(loc.key));
    if (typeWhy) return problem(res, 415, 'media.object.content_mismatch', typeWhy);
    const { data: body } = announce(req.appId, 'media.object.uploaded', {
        change: () => {
            model.updateObject(obj.id, { lifecycle_status: 'ready' });
            invariant.record(model.getObject(obj.id));
        },
        payload: () => model.objectPublic(model.getObject(obj.id)),
    });
    return res.json(body);
}

/** The object named in the URL, writable by this caller, native and still uploading (else answered). */
function loadUploading(req, res) {
    const obj = load(req, res);
    if (!obj) return null;
    if (!canWrite(req, obj)) { problem(res, 403, 'media.object.forbidden', 'Not your object'); return null; }
    if (obj.legacy_ref) { problem(res, 409, 'media.object.legacy_managed', 'This object is written through the v1 API'); return null; }
    if (obj.lifecycle_status !== 'uploading') { problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`); return null; }
    return obj;
}

router.post('/:id/complete', contentAuth, tenantCors, (req, res) => {
    try {
        const obj = load(req, res);
        if (!obj) return;
        if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
        if (obj.lifecycle_status === 'ready' && !obj.legacy_ref) return res.json(model.objectPublic(obj));
        if (obj.legacy_ref || obj.lifecycle_status !== 'uploading') return problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`);
        completeUpload(req, res, obj, { expectedHash: req.body && req.body.content_hash });
    } catch (err) {
        console.error('[Objects] complete error:', err.message);
        problem(res, 500, 'media.object.complete_failed', 'Failed to complete upload');
    }
});

// ── Presigned single-PUT URL ─────────────────────────────────

router.post('/:id/upload-url', upload, (req, res) => {
    const obj = loadUploading(req, res);
    if (!obj) return;
    const ttl = req.body && req.body.ttl != null ? Number(req.body.ttl) : (req.query.ttl != null ? Number(req.query.ttl) : undefined);
    if (ttl !== undefined && !(ttl >= 60 && ttl <= 86400)) return problem(res, 400, 'media.object.invalid', 'ttl must be 60-86400 seconds');
    if (Number(obj.size_bytes) > config.objects.maxUploadMb * MB) return problem(res, 413, 'media.object.too_large', 'This object is uploaded in parts: POST /multipart');
    res.json(presignedPut(req, obj, ttl));
});

// ── Multipart uploads ────────────────────────────────────────

const mpRead = multipartAuth('media.object.read');
const mpWrite = multipartAuth('media.object.upload');

/** The session named in the URL, belonging to the object, still open (else answered). */
function loadSession(req, res, obj, { open = true } = {}) {
    const session = multipart.getSession(String(req.params.uploadId || ''));
    if (!session || session.object_id !== obj.id) { problem(res, 404, 'media.upload.not_found', 'No such upload for this object'); return null; }
    if (open && session.status === 'active' && multipart.isExpired(session)) multipart.abort(session.id, 'expired');
    const now = multipart.getSession(session.id);
    if (open && now.status !== 'active') { problem(res, 409, 'media.upload.not_active', `The upload is ${now.status}`); return null; }
    return now;
}

router.post('/:id/multipart', upload, (req, res) => {
    try {
        const obj = loadUploading(req, res);
        if (!obj) return;
        const b = req.body || {};
        let current = obj;
        if (!(Number(obj.size_bytes) > 0)) {
            // Created without a size: declare it now (the same checks init makes).
            const size = Number(b.size_bytes);
            if (!Number.isInteger(size) || size < 1) return problem(res, 400, 'media.object.invalid', 'size_bytes (a positive integer) is required');
            if (size > config.objects.multipartMaxMb * MB) return problem(res, 413, 'media.object.too_large', `Objects are limited to ${config.objects.multipartMaxMb * MB} bytes`);
            if (invariant.wouldViolate({ kind: obj.kind, visibility: obj.visibility, size_bytes: size })) {
                return problem(res, 422, 'media.invariant.public_object_too_large', `Public playback objects are limited to ${config.objects.publicMaxMb} MB`);
            }
            if (!quotaCheck(req, res, size, obj.id)) return;
            model.updateObject(obj.id, { size_bytes: size });
            current = model.getObject(obj.id);
        } else if (b.size_bytes != null && Number(b.size_bytes) !== Number(obj.size_bytes)) {
            return problem(res, 400, 'media.object.size_mismatch', `The object declares ${obj.size_bytes} bytes`);
        }
        const session = multipart.initiate(current, { partSize: b.part_size });
        if (session.error) return problem(res, session.status, session.code, session.error);
        res.status(201).json(multipartPublic(req, current, session, { parts: false }));
    } catch (err) {
        console.error('[Objects] multipart init error:', err.message);
        problem(res, 500, 'media.upload.init_failed', 'Failed to start the upload');
    }
});

router.get('/:id/multipart/:uploadId', mpRead, (req, res) => {
    const obj = load(req, res);
    if (!obj) return;
    const session = loadSession(req, res, obj, { open: false });
    if (!session) return;
    if (session.status === 'active' && multipart.isExpired(session)) multipart.abort(session.id, 'expired');
    res.json(multipart.sessionPublic(multipart.getSession(session.id)));
});

router.post('/:id/multipart/:uploadId/complete', mpWrite, tenantCors, async (req, res) => {
    let session = null;
    try {
        const obj = loadUploading(req, res);
        if (!obj) return;
        session = loadSession(req, res, obj);
        if (!session) return;
        if (!multipart.beginComplete(session)) return problem(res, 409, 'media.upload.not_active', 'The upload is being completed already');
        const b = req.body || {};
        const dest = model.objectFilePath(obj);
        const got = await multipart.assemble(session, dest, Array.isArray(b.parts) ? b.parts : null);
        if (got.error) {
            multipart.reopen(session);
            return problem(res, got.status, got.code, got.error, got.missing ? { missing: got.missing } : undefined);
        }
        db.getDb().transaction(() => {
            model.updateObject(obj.id, {
                size_bytes: got.bytes, content_hash: got.sha256, mime_type: obj.mime_type || 'application/octet-stream',
                canonical_provider: 'local', canonical_key: dest,
            });
            model.upsertLocation(obj.id, { provider: 'local', key: dest, state: 'present', size_bytes: got.bytes, checksum: got.sha256, verified: true });
        })();
        multipart.finish(session);
        completeUpload(req, res, model.getObject(obj.id), { expectedHash: b.content_hash });
    } catch (err) {
        if (session) multipart.reopen(session);
        console.error('[Objects] multipart complete error:', err.message);
        if (!res.headersSent) problem(res, 500, 'media.object.complete_failed', 'Failed to complete upload');
    }
});

router.delete('/:id/multipart/:uploadId', mpWrite, (req, res) => {
    const obj = load(req, res);
    if (!obj) return;
    if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
    const session = loadSession(req, res, obj, { open: false });
    if (!session) return;
    if (session.status === 'completed') return problem(res, 409, 'media.upload.not_active', 'The upload is completed');
    multipart.abort(session.id);
    res.json(multipart.sessionPublic(multipart.getSession(session.id), { parts: false }));
});

router.get('/', read, (req, res) => {
    try {
        const q = req.query;
        const limit = Math.min(Math.max(parseInt(q.limit || '50', 10) || 50, 1), 200);
        const conds = ['app_id = ?'], params = [req.appId];
        if (q.cursor) {
            if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(q.cursor))) return problem(res, 400, 'media.object.invalid', 'Bad cursor');
            conds.push('id < ?'); params.push(String(q.cursor));
        }
        if (q.kind) { conds.push('kind = ?'); params.push(String(q.kind)); }
        if (q.visibility) { conds.push('visibility = ?'); params.push(String(q.visibility)); }
        if (q.status) { conds.push('lifecycle_status = ?'); params.push(String(q.status)); }
        else if (!['1', 'true'].includes(String(q.include_deleted || ''))) conds.push("lifecycle_status != 'deleted'");
        if (q.owner) { conds.push('owner_subject = ?'); params.push(String(q.owner).replace(/^user:/, '')); }
        if (q.user_id != null) { conds.push('owner_user_id = ?'); params.push(Number(q.user_id)); }
        if (req.authType === 'user') { conds.push("(visibility != 'private' OR owner_user_id = ?)"); params.push(req.userId); }
        const rows = db.all(`SELECT * FROM media_objects WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, limit + 1]);
        const page = rows.slice(0, limit);
        res.json({ objects: page.map(o => model.objectPublic(o, { locations: false })), next_cursor: rows.length > limit ? page[page.length - 1].id : null, limit });
    } catch (err) {
        console.error('[Objects] list error:', err.message);
        problem(res, 500, 'media.object.list_failed', 'Failed to list objects');
    }
});

router.get('/:id', read, (req, res) => {
    const obj = load(req, res);
    if (obj) res.json(model.objectPublic(obj));
});

router.delete('/:id', upload, (req, res) => {
    try {
        const obj = load(req, res);
        if (!obj) return;
        if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
        if (obj.legacy_ref) return problem(res, 409, 'media.object.legacy_managed', 'Delete this object through its v1 route (vods, clips, files, pastes)');
        if (model.isHeld(obj.id)) return problem(res, 409, 'media.object.held', 'Object is under a retention hold');
        if (obj.lifecycle_status === 'deleted') return res.json(model.objectPublic(obj));
        res.json(model.objectPublic(model.softDelete(obj, { by: req.principal ? req.principal.sub : `app:${req.appId}` })));
    } catch (err) {
        if (err.code === 'media.object.held' || /retention hold/.test(err.message)) return problem(res, 409, 'media.object.held', 'Object is under a retention hold');
        console.error('[Objects] delete error:', err.message);
        problem(res, 500, 'media.object.delete_failed', 'Failed to delete object');
    }
});

router.post('/:id/restore', upload, (req, res) => {
    const obj = load(req, res);
    if (!obj) return;
    if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
    if (obj.lifecycle_status !== 'deleted' || obj.legacy_ref) return problem(res, 409, 'media.object.not_deleted', 'Only soft-deleted native objects can be restored');
    const back = model.restore(obj);
    if (!back) return problem(res, 410, 'media.object.purged', 'The retention period has passed and the bytes are gone');
    res.json(model.objectPublic(back));
});

router.get('/:id/download', read, (req, res) => {
    const obj = load(req, res);
    if (!obj) return;
    if (obj.lifecycle_status === 'deleted') return problem(res, 410, 'media.object.deleted', 'Object was deleted');
    if (obj.lifecycle_status !== 'ready') return problem(res, 409, 'media.object.not_ready', `Object is ${obj.lifecycle_status}`);
    const json = req.query.format === 'json';
    res.set('Cache-Control', 'private, no-store');
    // Developer-project sandbox objects are never public, whatever their visibility: always signed.
    if (obj.visibility !== 'private' && !db.isSandboxTenant(obj.app_id)) {
        const url = model.legacyPublicUrl(obj) || `${config.publicUrl}/o/${obj.id}`;
        return json ? res.json({ url, expires_at: null, public: true }) : res.redirect(302, url);
    }
    const signed = signing.signedDownloadUrl(obj.id, req.query.ttl);
    if (['1', 'true'].includes(String(req.query.redirect || ''))) return res.redirect(302, signed.url);
    res.json({ url: signed.url, expires_at: signed.expires_at, public: false });
});

// ── Retention holds ──────────────────────────────────────────

router.get('/:id/holds', read, (req, res) => {
    const obj = load(req, res);
    if (!obj) return;
    res.json({ object_id: obj.id, holds: model.listHolds(obj.id, { includeReleased: ['1', 'true'].includes(String(req.query.all || '')) }) });
});

router.post('/:id/holds', appOnly, (req, res) => {
    const obj = load(req, res);
    if (!obj) return;
    const b = req.body || {};
    if (!model.HOLD_KINDS.includes(b.kind)) return problem(res, 400, 'media.hold.invalid', `kind must be one of ${model.HOLD_KINDS.join(', ')}`);
    const by = b.created_by ? String(b.created_by).slice(0, 200) : `app:${req.appId}${req.userId != null ? `:user:${req.userId}` : ''}`;
    res.status(201).json(model.placeHold({ object_id: obj.id, kind: b.kind, reason: b.reason || '', created_by: by }));
});

router.delete('/:id/holds/:holdId', appOnly, (req, res) => {
    const obj = load(req, res);
    if (!obj) return;
    const hold = db.get('SELECT * FROM media_holds WHERE id = ? AND object_id = ?', [parseInt(req.params.holdId, 10), obj.id]);
    if (!hold) return problem(res, 404, 'media.hold.not_found', 'No such hold on this object');
    const by = (req.body && req.body.released_by) ? String(req.body.released_by).slice(0, 200) : `app:${req.appId}`;
    res.json(model.releaseHold(hold.id, by));
});

// ── Public bytes: GET /o/:id ─────────────────────────────────

const INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$|text\/plain$)/;

const publicRouter = express.Router();
publicRouter.get('/:id', async (req, res) => {
    try {
        const obj = model.getObject(String(req.params.id || ''));
        if (!obj) return res.status(404).json({ error: 'Not found' });
        const signed = !!req.query.sig && signing.verifyDownload(obj.id, req.query.exp, req.query.sig);
        // Private objects (and every developer-project sandbox object) are indistinguishable from
        // missing ones without a valid signature — checked before the lifecycle answers, or a 410
        // for a deleted private object would still say it existed.
        const sandbox = db.isSandboxTenant(obj.app_id);
        if ((obj.visibility === 'private' || sandbox) && !signed) return res.status(404).json({ error: 'Not found' });
        if (obj.lifecycle_status === 'deleted') return res.status(410).json({ error: 'Gone' });
        if (obj.lifecycle_status !== 'ready') return res.status(404).json({ error: 'Not found' });

        const mime = obj.mime_type || 'application/octet-stream';
        const md = model.parseJson(obj.metadata, {});
        const name = String(md.filename || obj.id).replace(/["\\\r\n]/g, '_');
        const headers = {
            'Content-Type': mime,
            'X-Content-Type-Options': 'nosniff',
            'X-Robots-Tag': 'noindex',
            'Cache-Control': obj.visibility === 'private' || sandbox ? 'private, no-store' : 'public, max-age=3600',
            'Content-Disposition': `${INLINE.test(mime) ? 'inline' : 'attachment'}; filename="${name}"`,
        };
        const locs = model.listLocations(obj.id);
        const local = locs.find(l => l.provider === 'local' && l.state !== 'missing' && fs.existsSync(l.key));
        if (local) return require('../public/routes').streamFileWithRange(req, res, local.key, headers);
        const vodStorage = require('../vod/vod-storage');
        for (const p of ['r2', 'b2']) {
            const l = locs.find(x => x.provider === p && x.state !== 'missing' && x.state !== 'corrupt');
            if (!l || !vodStorage.providerConfigured(p)) continue;
            const url = await vodStorage.presignGet(p, l.key, 300).catch(() => null);
            if (url) { res.set('Cache-Control', 'private, max-age=0'); res.set('X-Robots-Tag', 'noindex'); return res.redirect(302, url); }
        }
        res.status(404).json({ error: 'Object bytes unavailable' });
    } catch (err) {
        console.error('[Objects] /o error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve object' });
    }
});

/** PUT /:id/multipart/:uploadId/parts/:n (raw body; mounted ahead of the JSON body parser). */
async function putPart(req, res) {
    const obj = load(req, res);
    if (!obj) { req.resume(); return; }
    if (!canWrite(req, obj)) { req.resume(); return problem(res, 403, 'media.object.forbidden', 'Not your object'); }
    if (obj.lifecycle_status !== 'uploading') { req.resume(); return problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`); }
    const session = loadSession(req, res, obj);
    if (!session) { req.resume(); return; }
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1 || n > session.parts_expected) {
        req.resume();
        return problem(res, 400, 'media.upload.invalid_part', `part_number must be 1-${session.parts_expected}`);
    }
    const want = multipart.partSize(session, n);
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len !== want) {
        res.set('Connection', 'close'); req.resume();
        return problem(res, len > want ? 413 : 400, len > want ? 'media.upload.part_too_large' : 'media.upload.part_size_mismatch', `Part ${n} must be ${want} bytes`);
    }
    const expect = req.headers['x-content-sha256'];
    if (expect != null && !/^[a-f0-9]{64}$/i.test(String(expect))) { req.resume(); return problem(res, 400, 'media.upload.invalid_part', 'X-Content-SHA256 must be a sha256 hex digest'); }
    const got = await multipart.receivePart(req, session, n, { expectSha256: expect || null });
    if (got.error) {
        if (got.status === 413) res.set('Connection', 'close');
        return problem(res, got.status, got.code, got.error);
    }
    res.json(got);
}

module.exports = router;
module.exports.contentHandlers = [contentAuth, tenantCors, putContent];
module.exports.partHandlers = [mpWrite, tenantCors, putPart];
module.exports.publicRouter = publicRouter;
module.exports.INLINE = INLINE;
