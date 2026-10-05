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
 * GET    /                    cursor list (?namespace&kind&visibility&status&owner&user_id&include_deleted&limit&cursor)
 * DELETE /:id                 soft delete (bytes kept MEDIA_DELETE_RETENTION_DAYS); 409 when held
 * POST   /:id/restore         undo a soft delete inside the retention period
 * GET    /:id/download        302 to the public location, or a signed short-lived URL for private objects
 * GET    /:id/holds           retention holds (?all=1 includes released), and the holds a clip inherits from its VOD
 * POST   /:id/holds           place a hold  { kind, reason, note, placed_by | created_by }   (app key only)
 * DELETE /:id/holds/:holdId   release it                                                      (app key only)
 *                              Staff place and release holds by vod/clip id at /api/v1/:app/admin/storage/holds.
 *
 * Auth: the app's API key, or a Network token holding the route's verb for the object's namespace
 * (server/auth.js VERBS): write (init, content, complete, multipart) media.object.upload; read
 * (metadata, download, holds) media.object.read; list media.object.list; delete and restore
 * media.object.delete. The older ids keep granting the newer verbs (read lists, upload deletes).
 * Init takes `namespace` (the tenant's root by default, or a name below it; objects/namespaces.js),
 * reserves its declared size against every quota from there up to the tenant, and complete settles
 * the reservation against the bytes received. Developer-project tenants
 * (:app = prj_<ULID>) take their project's app tokens only (server/auth.js); their sandbox
 * objects are served only through signed URLs, whatever their visibility. X-OV-Subject names the
 * owner (usr_…); X-OV-User-Id (app key only) acts as one of the app's users. The
 * content PUT and complete also accept the upload token handed out at init (a presigned
 * URL), and the multipart routes the session token, so a browser can send the bytes directly.
 *
 * Public bytes: GET /o/:id (publicRouter) — public/unlisted objects openly,
 * private ones only with a valid ?exp&sig from /download. With MEDIA_HLS_ENABLED, the object's timeline as HLS
 * under the same check: /o/:id/master.m3u8, /o/:id/source/index.m3u8, /o/:id/source/{init.mp4,NNNNNN.m4s}.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ids, http } = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');
const db = require('../db/database');
const config = require('../config');
const model = require('./model');
const invariant = require('./invariant');
const signing = require('./signing');
const hls = require('./hls');
const ctypes = require('./content-type');
const multipart = require('./multipart');
const namespaces = require('./namespaces');
const { tenantAuth, tenantCors, tenantPath, namespaceGrant } = require('../auth');
const { announce } = require('../webhooks');
const { limits } = require('../actor-limits');

const MB = 1024 * 1024;
// Each route checks its verb for the namespace it works in (the object's, or the one init names).
const upload = tenantAuth({ verb: 'write', namespaced: true, project: true });
const read = tenantAuth({ verb: 'read', namespaced: true, project: true });
const list = tenantAuth({ verb: 'list', namespaced: true, project: true });
const remove = tenantAuth({ verb: 'delete', namespaced: true, project: true });
const appOnly = tenantAuth();
// Per-actor limits (server/actor-limits.js), after the credential and before the work. Reads take the
// defaults (MEDIA_LIMITS_MINUTE / _HOUR). An init reserves quota and makes a row, and each upload step
// writes or hashes bytes, so the upload routes allow a steady app a new object every two seconds at most.
const UPLOAD = { minute: 30, hour: 600 };

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

/** The object named in the URL, in this tenant and visible to the caller, if the caller may `verb` in its namespace (else answered). */
async function load(req, res, verb = 'read') {
    const obj = await model.resolveObject(String(req.params.id || ''), req.appId);
    if (!obj || !canSee(req, obj)) { problem(res, 404, 'media.object.not_found', 'No such object in this namespace'); return null; }
    const g = await namespaceGrant(req, verb, obj.namespace);
    if (!g.allowed) { problem(res, 403, g.code, g.reason); return null; }
    return obj;
}

/** The token-bearing request's object and tenant; the URL must address that tenant. */
async function tokenTenant(req, res, obj) {
    // A developer-project tenant is addressed by its project id, whichever of its production/sandbox rows holds the object.
    const app = obj ? await db.getApp(obj.app_id) : null;
    if (!app || tenantPath(app) !== String(req.params.app || '')) { res.status(404).json({ error: 'Unknown app' }); return false; }
    req.appId = app.app_id;
    req.appPath = tenantPath(app);
    req.appRow = app;
    req.authType = 'upload_token';
    return true;
}

/** Upload token (a presigned URL from init or /upload-url) or the usual tenant credential with media.object.upload. */
async function contentAuth(req, res, next) {
    const token = req.query.token || req.headers['x-upload-token'];
    if (!token) return upload(req, res, next);
    const id = String(req.params.id || '');
    const obj = await model.getObject(id);
    // Scoped to tenant + object + size: a token for another object, tenant or size never verifies.
    const size = obj && Number(obj.size_bytes) > 0 ? Number(obj.size_bytes) : 0;
    if (!obj || !signing.verifyUploadToken(id, token, { tenant: obj.app_id, size })) return problem(res, 401, 'media.upload_token.invalid', 'Upload token is invalid or expired');
    if (await tokenTenant(req, res, obj)) next();
}

/** Multipart session token (from POST /:id/multipart) or the usual tenant credential with `verb`. */
function multipartAuth(verb) {
    const fallback = tenantAuth({ verb, namespaced: true, project: true });
    return async (req, res, next) => {
        const token = req.query.token || req.headers['x-upload-token'];
        if (!token) return fallback(req, res, next);
        const obj = await model.getObject(String(req.params.id || ''));
        const session = await multipart.getSession(String(req.params.uploadId || ''));
        const ok = obj && session && session.object_id === obj.id && signing.verifyMultipartToken(token, {
            tenant: obj.app_id, objectId: obj.id, uploadId: session.id, totalSize: session.total_size,
        });
        if (!ok) return problem(res, 401, 'media.upload_token.invalid', 'Upload token is invalid or expired');
        if (await tokenTenant(req, res, obj)) next();
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
async function multipartPublic(req, obj, session, { parts = true } = {}) {
    const tok = signing.multipartToken({ tenant: obj.app_id, objectId: obj.id, uploadId: session.id, totalSize: session.total_size, expiresAt: Date.parse(String(session.expires_at).replace(' ', 'T') + 'Z') });
    const u = `${apiBase(req)}/${obj.id}/multipart/${session.id}`;
    const q = `token=${encodeURIComponent(tok.token)}`;
    return {
        ...await multipart.sessionPublic(session, { parts }),
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

/**
 * Room for `bytes` (and `objects` new objects) in `namespace`: every quota from there up to the
 * tenant, and the policy's max_object_bytes (objects/namespaces.checkQuota). Answers 413 when not.
 */
async function quotaCheck(req, res, namespace, opts) {
    return await withQuota(req, res, namespace, opts) !== undefined;
}

/**
 * The quota check and the write it admits in one transaction, under the tenant's quota lock (namespaces.checkQuota):
 * a racing upload or restore of the same tenant checks after this one commits. `opts` may be an async function, read
 * inside the transaction. Answers 413 and returns undefined when there is no room; else what `write` returned.
 */
async function withQuota(req, res, namespace, opts, write = async () => true) {
    const out = await db.getDb().tx(async () => {
        const q = await namespaces.checkQuota(req.appRow, namespace, typeof opts === 'function' ? await opts() : opts);
        return q ? { q } : { value: await write() };
    });
    if (out.q) { problem(res, out.q.status, out.q.code, out.q.detail, out.q.extra); return undefined; }
    return out.value;
}

/** An upload step that has no reservation (it was released at abort) takes one again, checked like init. */
async function reserveAgain(req, res, obj, bytes) {
    return await withQuota(req, res, obj.namespace, async () => ({ bytes, objects: await namespaces.reservation(obj.id) ? 0 : 1, excludeId: obj.id }),
        async () => { await namespaces.reserve(obj, bytes); return true; }) === true;
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
    const obj = await load(req, res, 'write');
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
    if (await multipart.activeFor(obj.id)) { req.resume(); return problem(res, 409, 'media.upload.multipart_active', 'A multipart upload is open for this object: complete or abort it first'); }
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
    await namespaces.touch(obj.id);   // the upload is active: its reservation does not expire under it
    const got = await receive(req, tmp, cap);
    const drop = () => { try { fs.unlinkSync(tmp); } catch { /* not written */ } };
    if (got.error) {
        drop();
        if (got.error === 'too_large') { res.set('Connection', 'close'); return problem(res, 413, 'media.object.too_large', `At most ${cap} bytes`); }
        return problem(res, 400, 'media.object.upload_interrupted', got.message || 'Upload did not complete');
    }
    if (declared && got.bytes !== declared) { drop(); return problem(res, 400, 'media.object.size_mismatch', `Declared ${declared} bytes, received ${got.bytes}`); }
    if (!got.bytes) { drop(); return problem(res, 400, 'media.object.empty', 'No bytes received'); }
    // The object may have been completed, deleted or expired while the bytes streamed in.
    const current = await model.getObject(obj.id);
    if (!current || current.lifecycle_status !== 'uploading') { drop(); return problem(res, 409, 'media.object.not_uploading', `Object is ${current ? current.lifecycle_status : 'gone'}`); }
    // The real size replaces the declared one in this upload's reservation.
    try {
        const dest = model.objectFilePath(obj);
        const stored = await withQuota(req, res, obj.namespace, async () => ({ bytes: got.bytes, objects: await namespaces.reservation(obj.id) ? 0 : 1, excludeId: obj.id }), async () => {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.renameSync(tmp, dest);
            await model.updateObject(obj.id, {
                size_bytes: got.bytes, content_hash: got.sha256, mime_type: effectiveType,
                canonical_provider: 'local', canonical_key: dest,
            });
            await model.upsertLocation(obj.id, { provider: 'local', key: dest, state: 'present', size_bytes: got.bytes, checksum: got.sha256, verified: true });
            await namespaces.reserve(current, got.bytes);
            return true;
        });
        if (!stored) { drop(); return; }
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

router.post('/', upload, limits('media.object.upload', UPLOAD), async (req, res) => {
    try {
        const b = req.body || {};
        const kind = String(b.kind || 'file');
        if (!model.KINDS.includes(kind)) return problem(res, 400, 'media.object.invalid', `kind must be one of ${model.KINDS.join(', ')}`);
        const visibility = String(b.visibility || 'private');
        if (!model.VISIBILITIES.includes(visibility)) return problem(res, 400, 'media.object.invalid', 'visibility must be public, unlisted or private');
        // The namespace: the tenant's root unless the body names one below it; the caller must hold write there.
        const named = namespaces.resolveName(req.appRow, b.namespace);
        if (named.error) return problem(res, 400, 'media.namespace.invalid', named.error);
        const namespace = named.namespace;
        const g = await namespaceGrant(req, 'write', namespace);
        if (!g.allowed) return problem(res, 403, g.code, g.reason);
        const policy = await namespaces.effectivePolicy(req.appId, namespace);
        if (Array.isArray(policy.kinds) && !policy.kinds.includes(kind)) return problem(res, 422, 'media.namespace.policy_denied', `${namespace} takes kinds ${policy.kinds.join(', ') || '(none)'}`);
        if (Array.isArray(policy.visibilities) && !policy.visibilities.includes(visibility)) return problem(res, 422, 'media.namespace.policy_denied', `${namespace} takes visibilities ${policy.visibilities.join(', ') || '(none)'}`);
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

        // The namespace row, the quota check, the object and its reservation commit together, so two
        // inits racing for the last of a quota cannot both get it.
        const made = await db.getDb().tx(async () => {
            const row = await namespaces.ensure(req.appRow, namespace);
            if (row.error) return { problem: { status: row.status, code: row.code, detail: row.error } };
            const q = await namespaces.checkQuota(req.appRow, namespace, { bytes: size, objects: 1 });
            if (q) return { problem: q };
            const newId = await model.createObject({
                app_id: req.appId, namespace, kind, owner_subject: subject, owner_app: req.appId, owner_user_id: userId,
                visibility, lifecycle_status: 'uploading', mime_type: mime, size_bytes: size, metadata,
            });
            await namespaces.reserve(await model.getObject(newId), size);
            return { id: newId };
        });
        if (made.problem) return problem(res, made.problem.status, made.problem.code, made.problem.detail, made.problem.extra);
        const id = made.id;
        const obj = await model.getObject(id);
        let session = null;
        if (wantParts) {
            session = await multipart.initiate(obj, { partSize: b.part_size });
            if (session.error) {
                await namespaces.settle(id);
                await db.run('DELETE FROM media_objects WHERE id = ?', [id]);         // nothing was stored for it
                return problem(res, session.status, session.code, session.error);
            }
        }
        const single = !wantParts ? presignedPut(req, obj, b.upload_ttl) : null;
        res.status(201).json({
            id,
            object: await model.objectPublic(obj),
            upload: {
                ...(single || { method: 'multipart', url: null, token: null, expires_at: null, max_bytes: size, content_type: mime }),
                complete_url: `${apiBase(req)}/${id}/complete`,
                multipart_url: `${apiBase(req)}/${id}/multipart`,
                ...(session ? { multipart: await multipartPublic(req, obj, session, { parts: false }) } : {}),
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
async function completeUpload(req, res, obj, { expectedHash = null } = {}) {
    const loc = (await model.listLocations(obj.id)).find(l => l.provider === 'local' && l.state === 'present');
    if (!loc || !fs.existsSync(loc.key)) return problem(res, 409, 'media.object.no_content', 'PUT the content first');
    const md = model.parseJson(obj.metadata, {});
    const expected = String(expectedHash || md.expected_sha256 || '').toLowerCase();
    if (expected && expected !== obj.content_hash) {
        return problem(res, 422, 'media.object.hash_mismatch', 'Content hash does not match', { expected, actual: obj.content_hash });
    }
    if (invariant.wouldViolate(obj)) {
        return problem(res, 422, 'media.invariant.public_object_too_large', `Public playback objects are limited to ${config.objects.publicMaxMb} MB`);
    }
    // Reconciled against the bytes actually stored: the object's real size, everything else as it is now.
    if (!await quotaCheck(req, res, obj.namespace, { bytes: Number(obj.size_bytes) || 0, objects: await namespaces.reservation(obj.id) ? 0 : 1, excludeId: obj.id })) return;
    const typeWhy = ctypes.kindProblem(obj.kind, obj.mime_type) || ctypes.contentProblem(obj.kind, obj.mime_type, ctypes.readHead(loc.key));
    if (typeWhy) return problem(res, 415, 'media.object.content_mismatch', typeWhy);
    const { data: body } = await announce(req.appId, 'media.object.uploaded', {
        change: async () => {
            await model.updateObject(obj.id, { lifecycle_status: 'ready' });
            await namespaces.settle(obj.id);          // the ready object counts from now on
            await invariant.record(await model.getObject(obj.id));
        },
        payload: async () => await model.objectPublic(await model.getObject(obj.id)),
    });
    await namespaces.reconcileChain(req.appRow, obj.namespace);
    return res.json(body);
}

/** The object named in the URL, writable by this caller, native and still uploading (else answered). */
async function loadUploading(req, res) {
    const obj = await load(req, res, 'write');
    if (!obj) return null;
    if (!canWrite(req, obj)) { problem(res, 403, 'media.object.forbidden', 'Not your object'); return null; }
    if (obj.legacy_ref) { problem(res, 409, 'media.object.legacy_managed', 'This object is written through the v1 API'); return null; }
    if (obj.lifecycle_status !== 'uploading') { problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`); return null; }
    return obj;
}

// Complete re-reads the stored bytes (type sniff, hash); twice the init rate leaves room for retries.
router.post('/:id/complete', contentAuth, tenantCors, limits('media.object.complete', { minute: 60, hour: 1200 }), async (req, res) => {
    try {
        const obj = await load(req, res, 'write');
        if (!obj) return;
        if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
        if (obj.lifecycle_status === 'ready' && !obj.legacy_ref) return res.json(await model.objectPublic(obj));
        if (obj.legacy_ref || obj.lifecycle_status !== 'uploading') return problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`);
        await completeUpload(req, res, obj, { expectedHash: req.body && req.body.content_hash });
    } catch (err) {
        console.error('[Objects] complete error:', err.message);
        problem(res, 500, 'media.object.complete_failed', 'Failed to complete upload');
    }
});

// ── Presigned single-PUT URL ─────────────────────────────────

router.post('/:id/upload-url', upload, limits('media.object.upload_url', UPLOAD), async (req, res) => {
    const obj = await loadUploading(req, res);
    if (!obj) return;
    const ttl = req.body && req.body.ttl != null ? Number(req.body.ttl) : (req.query.ttl != null ? Number(req.query.ttl) : undefined);
    if (ttl !== undefined && !(ttl >= 60 && ttl <= 86400)) return problem(res, 400, 'media.object.invalid', 'ttl must be 60-86400 seconds');
    if (Number(obj.size_bytes) > config.objects.maxUploadMb * MB) return problem(res, 413, 'media.object.too_large', 'This object is uploaded in parts: POST /multipart');
    // A fresh URL is a fresh attempt: the upload holds its declared size again (after an abort released it).
    const stored = Number((await db.get("SELECT size_bytes FROM media_locations WHERE object_id = ? AND provider = 'local' AND state = 'present'", [obj.id]) || {}).size_bytes) || 0;
    if (!await reserveAgain(req, res, obj, Math.max(Number(obj.size_bytes) || 0, stored))) return;
    res.json(presignedPut(req, obj, ttl));
});

// ── Multipart uploads ────────────────────────────────────────

const mpRead = multipartAuth('read');
const mpWrite = multipartAuth('write');

/** The session named in the URL, belonging to the object, still open (else answered). */
async function loadSession(req, res, obj, { open = true } = {}) {
    const session = await multipart.getSession(String(req.params.uploadId || ''));
    if (!session || session.object_id !== obj.id) { problem(res, 404, 'media.upload.not_found', 'No such upload for this object'); return null; }
    if (open && session.status === 'active' && multipart.isExpired(session)) await multipart.abort(session.id, 'expired');   // releases its reservation
    const now = await multipart.getSession(session.id);
    if (open && now.status !== 'active') { problem(res, 409, 'media.upload.not_active', `The upload is ${now.status}`); return null; }
    return now;
}

router.post('/:id/multipart', upload, limits('media.object.multipart', UPLOAD), async (req, res) => {
    try {
        const obj = await loadUploading(req, res);
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
            if (!await reserveAgain(req, res, obj, size)) return;
            await model.updateObject(obj.id, { size_bytes: size });
            current = await model.getObject(obj.id);
        } else if (b.size_bytes != null && Number(b.size_bytes) !== Number(obj.size_bytes)) {
            return problem(res, 400, 'media.object.size_mismatch', `The object declares ${obj.size_bytes} bytes`);
        } else if (!await reserveAgain(req, res, obj, Number(obj.size_bytes))) {
            return;       // a session after an abort holds the declared size again
        }
        const session = await multipart.initiate(current, { partSize: b.part_size });
        if (session.error) return problem(res, session.status, session.code, session.error);
        res.status(201).json(await multipartPublic(req, current, session, { parts: false }));
    } catch (err) {
        console.error('[Objects] multipart init error:', err.message);
        problem(res, 500, 'media.upload.init_failed', 'Failed to start the upload');
    }
});

router.get('/:id/multipart/:uploadId', mpRead, limits('media.object.multipart_read'), async (req, res) => {
    const obj = await load(req, res, 'read');
    if (!obj) return;
    const session = await loadSession(req, res, obj, { open: false });
    if (!session) return;
    if (session.status === 'active' && multipart.isExpired(session)) await multipart.abort(session.id, 'expired');
    res.json(await multipart.sessionPublic(await multipart.getSession(session.id)));
});

// Assembling concatenates and hashes every part of an object up to MEDIA_MULTIPART_MAX_MB.
router.post('/:id/multipart/:uploadId/complete', mpWrite, tenantCors, limits('media.object.multipart_complete', UPLOAD), async (req, res) => {
    let session = null;
    try {
        // A repeat of a complete that already succeeded (its answer was lost on the way): the object as it is.
        const already = await model.resolveObject(String(req.params.id || ''), req.appId);
        const prior = already && await multipart.getSession(String(req.params.uploadId || ''));
        if (prior && prior.object_id === already.id && prior.status === 'completed' && already.lifecycle_status === 'ready' && canSee(req, already)) {
            return res.json(await model.objectPublic(already));
        }
        const obj = await loadUploading(req, res);
        if (!obj) return;
        session = await loadSession(req, res, obj);
        if (!session) return;
        if (!await multipart.beginComplete(session)) return problem(res, 409, 'media.upload.not_active', 'The upload is being completed already');
        const b = req.body || {};
        const dest = model.objectFilePath(obj);
        const got = await multipart.assemble(session, dest, Array.isArray(b.parts) ? b.parts : null);
        if (got.error) {
            await multipart.reopen(session);
            return problem(res, got.status, got.code, got.error, got.missing ? { missing: got.missing } : undefined);
        }
        await db.getDb().tx(async () => {
            await model.updateObject(obj.id, {
                size_bytes: got.bytes, content_hash: got.sha256, mime_type: obj.mime_type || 'application/octet-stream',
                canonical_provider: 'local', canonical_key: dest,
            });
            await model.upsertLocation(obj.id, { provider: 'local', key: dest, state: 'present', size_bytes: got.bytes, checksum: got.sha256, verified: true });
        });
        await multipart.finish(session);
        await completeUpload(req, res, await model.getObject(obj.id), { expectedHash: b.content_hash });
    } catch (err) {
        if (session) await multipart.reopen(session);
        console.error('[Objects] multipart complete error:', err.message);
        if (!res.headersSent) problem(res, 500, 'media.object.complete_failed', 'Failed to complete upload');
    }
});

// An abort deletes the parts and frees the reservation: a write, cheaper than an upload.
router.delete('/:id/multipart/:uploadId', mpWrite, limits('media.object.multipart_abort', { minute: 60, hour: 1200 }), async (req, res) => {
    const obj = await load(req, res, 'write');
    if (!obj) return;
    if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
    const session = await loadSession(req, res, obj, { open: false });
    if (!session) return;
    if (session.status === 'completed') return problem(res, 409, 'media.upload.not_active', 'The upload is completed');
    await multipart.abort(session.id);          // parts deleted; the quota it held is released
    res.json(await multipart.sessionPublic(await multipart.getSession(session.id), { parts: false }));
});

router.get('/', list, limits('media.object.list'), async (req, res) => {
    try {
        const q = req.query;
        const limit = Math.min(Math.max(parseInt(q.limit || '50', 10) || 50, 1), 200);
        const conds = ['app_id = ?'], params = [req.appId];
        // ?namespace= narrows the list to one namespace and those below it.
        if (q.namespace != null && q.namespace !== '') {
            const named = namespaces.resolveName(req.appRow, q.namespace);
            if (named.error) return problem(res, 400, 'media.namespace.invalid', named.error);
            const g = await namespaceGrant(req, 'list', named.namespace);
            if (!g.allowed) return problem(res, 403, g.code, g.reason);
            conds.push('(namespace = ? OR substr(namespace, 1, ?) = ?)');
            params.push(named.namespace, named.namespace.length + 1, `${named.namespace}.`);
        }
        // A Network token lists only the namespaces it may list here.
        if (req.grant) {
            const rows = await namespaces.listForTenant(req.appId);
            const listable = [];
            for (const r of rows) if ((await namespaceGrant(req, 'list', r.namespace)).allowed) listable.push(r.namespace);
            if (!listable.length) {
                // Nothing listable: refused when the verb itself is (a strict namespace), else an empty page.
                const g = await namespaceGrant(req, 'list', db.rootNamespace(req.appRow));
                if (!g.allowed && g.code === 'capability.denied') return problem(res, 403, g.code, g.reason);
                conds.push('FALSE');
            } else if (listable.length < rows.length) {
                conds.push(`namespace IN (${listable.map(() => '?').join(', ')})`);
                params.push(...listable);
            }
        }
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
        const rows = await db.all(`SELECT * FROM media_objects WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, limit + 1]);
        const page = rows.slice(0, limit);
        res.json({ objects: (await Promise.all(page.map(async o => await model.objectPublic(o, { locations: false })))), next_cursor: rows.length > limit ? page[page.length - 1].id : null, limit });
    } catch (err) {
        console.error('[Objects] list error:', err.message);
        problem(res, 500, 'media.object.list_failed', 'Failed to list objects');
    }
});

router.get('/:id', read, limits('media.object.read'), async (req, res) => {
    const obj = await load(req, res, 'read');
    if (obj) res.json(await model.objectPublic(obj));
});

// Deletes and restores change lifecycle, quota usage and events: writes, tighter than reads.
router.delete('/:id', remove, limits('media.object.delete', { minute: 60, hour: 1200 }), async (req, res) => {
    try {
        const obj = await load(req, res, 'delete');
        if (!obj) return;
        if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
        if (obj.legacy_ref) return problem(res, 409, 'media.object.legacy_managed', 'Delete this object through its v1 route (vods, clips, files); paste screenshots and avatars are frozen since pastes moved to OpenVibe.Community');
        if (await model.isHeld(obj.id)) return problem(res, 409, 'media.object.held', 'Object is under a retention hold');
        if (obj.lifecycle_status === 'deleted') return res.json(await model.objectPublic(obj));
        const gone = await model.softDelete(obj, { by: req.principal ? req.principal.sub : `app:${req.appId}` });
        await namespaces.reconcileChain(req.appRow, obj.namespace);
        res.json(await model.objectPublic(gone));
    } catch (err) {
        if (err.code === 'media.object.held' || /retention hold/.test(err.message)) return problem(res, 409, 'media.object.held', 'Object is under a retention hold');
        console.error('[Objects] delete error:', err.message);
        problem(res, 500, 'media.object.delete_failed', 'Failed to delete object');
    }
});

router.post('/:id/restore', remove, limits('media.object.restore', { minute: 60, hour: 1200 }), async (req, res) => {
    const obj = await load(req, res, 'delete');
    if (!obj) return;
    if (!canWrite(req, obj)) return problem(res, 403, 'media.object.forbidden', 'Not your object');
    if (obj.lifecycle_status !== 'deleted' || obj.legacy_ref) return problem(res, 409, 'media.object.not_deleted', 'Only soft-deleted native objects can be restored');
    // A restored object counts again: it needs the room (in a developer project it never stopped counting).
    const md = model.parseJson(obj.metadata, {});
    const back = md.pre_delete_status !== 'uploading' && !md.purged_at
        ? await withQuota(req, res, obj.namespace, { bytes: Number(obj.size_bytes) || 0, objects: 1, excludeId: obj.id }, async () => await model.restore(obj))
        : await model.restore(obj);
    if (back === undefined) return;
    if (!back) return problem(res, 410, 'media.object.purged', 'The retention period has passed and the bytes are gone');
    await namespaces.reconcileChain(req.appRow, obj.namespace);
    res.json(await model.objectPublic(back));
});

router.get('/:id/download', read, limits('media.object.download'), async (req, res) => {
    const obj = await load(req, res, 'read');
    if (!obj) return;
    if (obj.lifecycle_status === 'deleted') return problem(res, 410, 'media.object.deleted', 'Object was deleted');
    if (obj.lifecycle_status !== 'ready') return problem(res, 409, 'media.object.not_ready', `Object is ${obj.lifecycle_status}`);
    res.set('Cache-Control', cache.htmlHeaders({ private: true }));
    if (req.query.format === 'mp4') return await downloadMp4(req, res, obj);
    const json = req.query.format === 'json';
    // Developer-project sandbox objects are never public, whatever their visibility: always signed.
    // With segment-native video on (MEDIA_HLS_ENABLED) and a timeline made, the JSON answer also names the HLS master
    // playlist: open for a public object, signed as a playlist (purpose 'hls', MEDIA_HLS_PLAYLIST_TTL_S) for a private
    // one. A media object without a timeline yet (a VOD older than F3.1) gets object.cmaf queued, and hls_url once it ran.
    // A clip without its own timeline plays its window of the source's (F3.5) and is never cut a CMAF timeline here.
    // The same answer shapes the v1 VOD and clip (objects/hls.js discovery; vodPublic/clipPublic).
    const hlsInfo = json ? await hls.discoveryForObject(obj) : null;
    if (obj.visibility !== 'private' && !await db.isSandboxTenant(obj.app_id)) {
        const url = model.legacyPublicUrl(obj) || `${config.publicUrl}/o/${obj.id}`;
        return json ? res.json({ url, expires_at: null, public: true, ...(hlsInfo || {}) }) : res.redirect(302, url);
    }
    const signed = signing.signedDownloadUrl(obj.id, req.query.ttl);
    if (['1', 'true'].includes(String(req.query.redirect || ''))) return res.redirect(302, signed.url);
    res.json({ url: signed.url, expires_at: signed.expires_at, public: false, ...(hlsInfo || {}) });
});

/**
 * GET …/download?format=mp4: the object's faststart MP4 (its `remux` variant, object.remux) as a signed URL (JSON, or a
 * 302 with ?redirect=1). Without the variant yet: object.remux is queued (joining one already queued or running) and
 * the answer is 202 { job_id }; ask again once the job succeeded.
 */
async function downloadMp4(req, res, obj) {
    if (!require('../jobs/derive').isMediaObject(obj)) return problem(res, 400, 'media.object.not_media', 'Only video and audio objects have an MP4 download');
    const variant = await model.getVariant(obj.id, 'remux');
    const mp4 = variant && await model.getObject(variant.derived_object_id);
    if (mp4 && mp4.lifecycle_status === 'ready') {
        const signed = signing.signedDownloadUrl(mp4.id, req.query.ttl);
        if (['1', 'true'].includes(String(req.query.redirect || ''))) return res.redirect(302, signed.url);
        return res.json({ url: signed.url, expires_at: signed.expires_at, public: false, object_id: mp4.id });
    }
    const queue = require('../jobs/queue');
    try {
        const r = await queue.enqueue({
            appId: obj.app_id, type: 'object.remux', objectId: obj.id, params: {}, dedupeActive: true,
            createdBy: 'system:download', ownerUserId: req.authType === 'user' ? req.userId : null,
        });
        if (r.created) require('../jobs/worker').kick();
        res.status(202).json({ job_id: r.job.id });
    } catch (err) {
        if (!(err instanceof queue.JobError)) {
            console.error('[Objects] MP4 remux queue error:', err.message);
            return problem(res, 500, 'media.job.failed_request', 'Could not queue the MP4');
        }
        if (err.retryAfterS) res.set('Retry-After', String(err.retryAfterS));
        problem(res, err.status || 400, err.code, err.message);
    }
}

// ── Retention holds ──────────────────────────────────────────

router.get('/:id/holds', read, limits('media.object.holds'), async (req, res) => {
    const obj = await load(req, res, 'read');
    if (!obj) return;
    res.json({
        object_id: obj.id,
        holds: (await model.listHolds(obj.id, { includeReleased: ['1', 'true'].includes(String(req.query.all || '')) })).map(model.holdPublic),
        // A clip is held while its source VOD is (released holds are the VOD's to list).
        inherited_holds: (await model.inheritedHolds(obj.id)).map(model.holdPublic),
        held: await model.isHeld(obj.id),
    });
});

/** Placing and releasing holds is the app's own staff action (docs: app key only), never a call acting for one of its users. */
function holdsByApp(req, res) {
    if (req.authType === 'app') return true;
    problem(res, 403, 'media.hold.forbidden', 'Retention holds are staff actions: call with the app key, not on behalf of a user');
    return false;
}

router.post('/:id/holds', appOnly, async (req, res) => {
    if (!holdsByApp(req, res)) return;
    const obj = await load(req, res);
    if (!obj) return;
    const b = req.body || {};
    if (!model.HOLD_KINDS.includes(b.kind)) return problem(res, 400, 'media.hold.invalid', `kind must be one of ${model.HOLD_KINDS.join(', ')}`);
    const named = b.placed_by || b.created_by;
    const by = named ? String(named).slice(0, 200) : `app:${req.appId}${req.userId != null ? `:user:${req.userId}` : ''}`;
    const hold = await model.placeHold({ object_id: obj.id, kind: b.kind, reason: b.reason || '', created_by: by, note: b.note });
    console.log(`[Objects] Retention hold ${hold.id} placed on ${obj.id} (${obj.legacy_ref || obj.kind}) by ${by} (${req.appId}): ${hold.kind}`);
    res.status(201).json(model.holdPublic(hold));
});

router.delete('/:id/holds/:holdId', appOnly, async (req, res) => {
    if (!holdsByApp(req, res)) return;
    const obj = await load(req, res);
    if (!obj) return;
    const hold = await db.get('SELECT * FROM media_holds WHERE id = ? AND object_id = ?', [parseInt(req.params.holdId, 10), obj.id]);
    if (!hold) return problem(res, 404, 'media.hold.not_found', 'No such hold on this object');
    const by = (req.body && req.body.released_by) ? String(req.body.released_by).slice(0, 200) : `app:${req.appId}`;
    const out = await model.releaseHold(hold.id, by);
    if (!hold.released_at) console.log(`[Objects] Retention hold ${hold.id} on ${obj.id} released by ${by} (${req.appId})`);
    res.json(model.holdPublic(out));
});

// ── Public bytes: GET /o/:id ─────────────────────────────────

const INLINE = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$|text\/plain$)/;

const publicRouter = express.Router();

// ── Segment-native video (docs/media-fabric.md §3, F3.1; MEDIA_HLS_ENABLED) ──
// GET /o/:id/master.m3u8, /o/:id/source/index.m3u8 and /o/:id/source/{init.mp4,NNNNNN.m4s}: the playlists are written
// from the object's media_timeline rows (objects/timeline.js), never read from files. Every one passes the same check
// as GET /o/:id: public and unlisted objects openly, private and sandbox ones only with the object's valid ?exp&sig
// (a playlist token from /download's hls_url, or a download signature), which a signed playlist carries onto each URI;
// deleted 410, not ready 404. Off, these paths 404.
// Like GET /o/:id, a private or sandbox answer carries no Access-Control-Allow-Origin; a public one may be read cross-origin.
// A segment's copy is the placement router's choice; a packed one (F3.3) is a ranged read of its ~60 s chunk.
const HLS_TYPE = 'application/vnd.apple.mpegurl';
const SEGMENT_NAME = /^(init\.mp4|\d{6,}\.m4s)$/;
const SLICE_FETCH_MS = 15000;   // a ranged read of one packed segment from B2/R2
// clipWindow/timelineOf (a clip's window over its source, and the rows its playlists are written from) live in
// objects/hls.js, shared with the v1 VOD/clip discovery.

/** The object of an HLS request, or null when answered (or passed on to the 404 while the flag is off). */
async function hlsObject(req, res, next) {
    if (!config.hls.enabled) { next(); return null; }
    if (require('../drill').refuseBytes(res)) return null;
    const obj = await model.getObject(String(req.params.id || ''));
    if (!obj) { res.status(404).json({ error: 'Not found' }); return null; }
    // A playlist token (purpose 'hls', from /download's hls_url) or, as before, the object's download signature.
    const signed = !!req.query.sig && (signing.verifyPlaylist(obj.id, req.query.exp, req.query.sig) || signing.verifyDownload(obj.id, req.query.exp, req.query.sig));
    const closed = obj.visibility === 'private' || await db.isSandboxTenant(obj.app_id);
    if (closed && !signed) { res.status(404).json({ error: 'Not found' }); return null; }
    if (obj.lifecycle_status === 'deleted') { res.status(410).json({ error: 'Gone' }); return null; }
    if (obj.lifecycle_status !== 'ready') { res.status(404).json({ error: 'Not found' }); return null; }
    res.set({
        'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex',
        'Cache-Control': closed ? 'private, no-store' : 'public, max-age=300',
        ...(!closed && { 'Access-Control-Allow-Origin': '*' }),
    });
    return { obj, closed, query: signed ? `exp=${encodeURIComponent(req.query.exp)}&sig=${encodeURIComponent(req.query.sig)}` : '' };
}

const hlsRoute = (fn) => async (req, res, next) => {
    try {
        const h = await hlsObject(req, res, next);
        if (h) await fn(req, res, h);
    } catch (err) {
        console.error('[Objects] HLS error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve the playlist' });
    }
};

publicRouter.get('/:id/master.m3u8', hlsRoute(async (req, res, { obj, query }) => {
    const timeline = require('./timeline');
    const { rows } = await hls.timelineOf(obj);
    if (!rows.some((r) => Number(r.seq) > 0)) return res.status(404).json({ error: 'No timeline' });
    res.type(HLS_TYPE).send(timeline.masterPlaylist([{ name: timeline.SOURCE, rows }], { query }));
}));

publicRouter.get('/:id/source/index.m3u8', hlsRoute(async (req, res, { obj, query }) => {
    const timeline = require('./timeline');
    const { rows } = await hls.timelineOf(obj);
    if (!rows.some((r) => Number(r.seq) > 0)) return res.status(404).json({ error: 'No timeline' });
    res.type(HLS_TYPE).send(timeline.mediaPlaylist(rows, { query }));
}));

/** The client's Range over a `length`-byte body: { start, end } (inclusive), null for the whole, false if unsatisfiable. */
function sliceRange(header, length) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!m || (!m[1] && !m[2])) return null;
    let start = m[1] ? Number(m[1]) : Math.max(0, length - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), length - 1) : length - 1;
    if (start >= length || end < start) return false;
    return { start, end };
}

/**
 * A packed segment: bytes [offset, offset + length) of its chunk, from a local file or a ranged GET of a presigned URL,
 * answered as if the segment were its own file (Range over the segment, 206/416, Content-Length).
 */
async function sendSlice(req, res, { file, url, offset, length, headers }) {
    const r = sliceRange(req.headers.range, length);
    if (r === false) { res.writeHead(416, { 'Content-Range': `bytes */${length}`, ...headers }); return res.end(); }
    const { start, end } = r || { start: 0, end: length - 1 };
    const head = { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(r && { 'Content-Range': `bytes ${start}-${end}/${length}` }) };
    if (file) {
        res.writeHead(r ? 206 : 200, head);
        const stream = fs.createReadStream(file, { start: offset + start, end: offset + end });
        stream.on('error', () => res.destroy());
        return stream.pipe(res);
    }
    // Bounded in time and dropped when the viewer goes away; any failure, mid-body too, moves on to the next copy.
    const ac = new AbortController();
    const gone = () => ac.abort();
    req.on('close', gone);
    let body = null;
    try {
        const up = await fetch(url, { headers: { range: `bytes=${offset + start}-${offset + end}` }, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(SLICE_FETCH_MS)]) });
        body = up.status === 206 ? Buffer.from(await up.arrayBuffer()) : null;
    } catch {
        body = null;
    } finally {
        req.off('close', gone);
    }
    if (res.destroyed) return undefined;   // the viewer left: nothing more to try for them
    if (!body || body.length !== end - start + 1) return false;
    res.writeHead(r ? 206 : 200, head);
    return res.end(body);
}

publicRouter.get('/:id/source/:name', hlsRoute(async (req, res, { obj, closed }) => {
    const timeline = require('./timeline');
    const name = String(req.params.name || '');
    let row = SEGMENT_NAME.test(name) ? await timeline.byName(obj.id, timeline.SOURCE, name) : null;
    // A virtual clip serves only the source segments inside its window (timelineOf): any other name is a 404, whatever
    // the signature, so a clip's token never reaches the rest of its source.
    if (!row && SEGMENT_NAME.test(name) && obj.kind === 'clip') row = (await hls.timelineOf(obj)).rows.find((r) => r.name === name) || null;
    if (!row) return res.status(404).json({ error: 'Not found' });
    const mime = Number(row.seq) === 0 ? 'video/mp4' : 'video/iso.segment';
    const headers = { 'Content-Type': mime, 'Cache-Control': closed ? 'private, no-store' : 'public, max-age=3600' };
    const packed = !!row.packed_object_id;
    const slice = { offset: Number(row.byte_offset), length: Number(row.byte_length), headers };
    // The router ranks this node's copy and the durable one (no viewer demand counted per segment: segment-bucket demand
    // comes later). A local file is streamed; a remote unpacked segment is a redirect to a short presigned URL; a remote
    // packed one is read as a byte range of its chunk here, since a redirect cannot carry the segment's range.
    const router = require('../placement/router');
    const decision = await router.route({ locations: timeline.locationsOf(row), purpose: 'playback', session: router.sessionFor(req, `${obj.id}/source`),
        contentType: mime, expiresIn: 300, presign: !packed });
    for (const loc of decision.candidates || []) {
        if (loc.provider === 'local') {
            if (!fs.existsSync(loc.key)) continue;
            if (packed) return sendSlice(req, res, { file: loc.key, ...slice });
            return require('../public/routes').streamFileWithRange(req, res, loc.key, headers);
        }
        const url = (!packed && loc.provider === decision.provider && decision.url)
            || await require('../vod/vod-storage').presignGet(loc.provider, loc.key, 300, packed ? {} : { contentType: mime }).catch(() => null);
        if (!url) continue;
        if (packed) {
            if (await sendSlice(req, res, { url, ...slice }) !== false) return;
            continue;
        }
        res.set('Cache-Control', 'private, max-age=0');
        return res.redirect(302, url);
    }
    res.status(404).json({ error: 'Segment bytes unavailable' });
}));
publicRouter.get('/:id', async (req, res) => {
    // A restore drill (MEDIA_DRILL) serves no stored bytes, local or by a B2/R2 redirect.
    if (require('../drill').refuseBytes(res)) return;
    try {
        const obj = await model.getObject(String(req.params.id || ''));
        if (!obj) return res.status(404).json({ error: 'Not found' });
        const signed = !!req.query.sig && signing.verifyDownload(obj.id, req.query.exp, req.query.sig);
        // Private objects (and every developer-project sandbox object) are indistinguishable from
        // missing ones without a valid signature — checked before the lifecycle answers, or a 410
        // for a deleted private object would still say it existed.
        const sandbox = await db.isSandboxTenant(obj.app_id);
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
        // A viewer of a native object, counted once a day without being identified (objects/popularity.js); the
        // object tiering reads these counts. Sandbox objects are never tiered, so they are not counted.
        if (!obj.legacy_ref && !sandbox) await require('./popularity').record(obj, req);
        // Placement router (server/placement/router.js) is the only function that picks a provider.
        // The router ignores locations not in state='present', skips open breakers and unprobed
        // providers, and ranks by preference tier with the measured 5-minute EWMA latency and the
        // design's ±15 % tie band: a verified R2 copy (the hot cache) for playback, then local, R2, B2.
        const router = require('../placement/router');
        const decision = await router.route({
            object: obj, purpose: 'playback', session: router.sessionFor(req, obj.id),
            contentType: mime, contentDisposition: headers['Content-Disposition'], expiresIn: 300,
        });
        // Walk the router's ranked copies: stream a local one, redirect to a presigned remote one.
        // A stale `present` local row whose file is gone falls through to the next copy.
        // The router's candidates carry their keys: a copy it resolved without a media_locations row (the object's
        // own canonical copy) is served too.
        for (const loc of decision.candidates || []) {
            const provider = loc.provider;
            if (provider === 'local') {
                if (fs.existsSync(loc.key)) return require('../public/routes').streamFileWithRange(req, res, loc.key, headers);
                continue;
            }
            // The origin shield (placement/shield.js): a public copy on a shielded provider is served by nginx through its
            // slice cache, with a long internal presign that never reaches the viewer (only on the DNS-only edge host).
            const shield = require('../placement/shield');
            if (shield.enabled(provider) && !sandbox && obj.visibility !== 'private' && !shield.onEdge(req)) {
                const edge = shield.toEdge(req, provider);
                if (edge) { res.set('Cache-Control', 'private, max-age=0'); res.set('X-Robots-Tag', 'noindex'); return res.redirect(302, edge); }
            }
            if (shield.enabled(provider) && shield.onEdge(req) && !sandbox && obj.visibility !== 'private') {
                const inner = await require('../vod/vod-storage').presignGet(provider, loc.key, shield.SHIELD_TTL_SECONDS, { contentType: mime, contentDisposition: headers['Content-Disposition'] }).catch(() => null);
                const t = inner && shield.target({ provider, url: inner, visibility: obj.visibility, sandbox, edge: shield.edgeOf(req) });
                if (t) return shield.send(res, t, headers);
            }
            // The router already signed its first choice; a fallback copy is signed here.
            const url = (provider === decision.provider && decision.url) || await require('../vod/vod-storage').presignGet(provider, loc.key, 300, { contentType: mime, contentDisposition: headers['Content-Disposition'] }).catch(() => null);
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
    const obj = await load(req, res, 'write');
    if (!obj) { req.resume(); return; }
    if (!canWrite(req, obj)) { req.resume(); return problem(res, 403, 'media.object.forbidden', 'Not your object'); }
    if (obj.lifecycle_status !== 'uploading') { req.resume(); return problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`); }
    const session = await loadSession(req, res, obj);
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
// The bytes of one object: sent once, retried after a failure.
module.exports.contentHandlers = [contentAuth, tenantCors, limits('media.object.content', { minute: 60, hour: 1200 }), putContent];
// A multipart upload sends its parts in a row (at least MEDIA_MULTIPART_MIN_PART_MB each, 5 MB: 600 a
// minute is 50 MB/s) and its session already bounds them; this stops only a runaway loop.
module.exports.partHandlers = [mpWrite, tenantCors, limits('media.object.part', { minute: 600, hour: 20000 }), putPart];
module.exports.publicRouter = publicRouter;
module.exports.INLINE = INLINE;
