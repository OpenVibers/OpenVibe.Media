/**
 * OpenVibe.Media — signed object URLs and upload tokens
 *
 * HMAC-SHA256 over (purpose, object id, expiry) with MEDIA_SIGNING_SECRET.
 * Purposes are separate so a download signature can never be replayed as an
 * upload token or the other way round.
 *
 * Upload tokens (presigned PUT URLs) are scoped to the tenant, the object and its size:
 * "v2.<exp>.<size>.<mac>" over (put2, tenant, object id, size, exp); size 0 = "up to the
 * single-part limit" (the object was created without a declared size). Tokens of the earlier
 * form "<exp>.<mac>" (object only) are still accepted until they expire. Multipart sessions
 * get one token for all their parts: "mp1.<exp>.<mac>" over (mpart, tenant, object id,
 * upload id, total size, exp). Without the env secret a random
 * per-process secret is used (and a warning logged): links then stop working
 * at the next restart, which is safe but not what production wants.
 */
'use strict';

const crypto = require('crypto');
const config = require('../config');

let _ephemeral = null;
function secret() {
    if (config.objects.signingSecret) return config.objects.signingSecret;
    if (!_ephemeral) {
        _ephemeral = crypto.randomBytes(32).toString('hex');
        console.warn('[Objects] MEDIA_SIGNING_SECRET is not set — signed URLs and upload tokens die with this process');
    }
    return _ephemeral;
}

function mac(purpose, objectId, exp) {
    return crypto.createHmac('sha256', secret()).update(`${purpose}\n${objectId}\n${exp}`).digest('base64url');
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function nowS() { return Math.floor(Date.now() / 1000); }

/** Short-lived GET URL for /o/:id. ttl is clamped to [30 s, 1 h]. */
function signedDownloadUrl(objectId, ttlS = config.objects.signedUrlTtlS) {
    const exp = nowS() + Math.min(3600, Math.max(30, Number(ttlS) || config.objects.signedUrlTtlS));
    return {
        url: `${config.publicUrl}/o/${encodeURIComponent(objectId)}?exp=${exp}&sig=${mac('get', objectId, exp)}`,
        expires_at: new Date(exp * 1000).toISOString(),
    };
}

function verifyDownload(objectId, exp, sig) {
    const e = Number(exp);
    if (!Number.isInteger(e) || e < nowS()) return false;
    return safeEqual(sig, mac('get', objectId, e));
}

/**
 * Short-lived GET URL for a v1 file (/f/:key). Its own purpose ('getf') and id space (file:<key>), so
 * a file signature is never valid for an object or the other way round. Used for developer-project
 * sandbox files, which are never served without one.
 */
function signedFileUrl(key, ttlS = config.objects.signedUrlTtlS) {
    const exp = nowS() + Math.min(3600, Math.max(30, Number(ttlS) || config.objects.signedUrlTtlS));
    return {
        url: `${config.publicUrl}/f/${encodeURIComponent(key)}?exp=${exp}&sig=${mac('getf', `file:${key}`, exp)}`,
        expires_at: new Date(exp * 1000).toISOString(),
    };
}

function verifyFile(key, exp, sig) {
    const e = Number(exp);
    if (!Number.isInteger(e) || e < nowS()) return false;
    return safeEqual(sig, mac('getf', `file:${key}`, e));
}

function macOf(parts) {
    return crypto.createHmac('sha256', secret()).update(parts.map(String).join('\n')).digest('base64url');
}

/** Upload token lifetime: 60 s to 24 h (default MEDIA_UPLOAD_TOKEN_TTL_S). */
function uploadTtl(ttlS) {
    return Math.min(86400, Math.max(60, Number(ttlS) || config.objects.uploadTokenTtlS || 3600));
}

/**
 * Token for PUT /api/v2/:app/objects/:id/content (a presigned single-PUT URL carries it as ?token=):
 * "v2.<exp>.<size>.<mac>" scoped to tenant + object + size.
 */
function uploadToken(objectId, ttlS = config.objects.uploadTokenTtlS, { tenant = '', size = 0 } = {}) {
    const exp = nowS() + uploadTtl(ttlS);
    const n = Math.max(0, Math.floor(Number(size) || 0));
    return { token: `v2.${exp}.${n}.${macOf(['put2', tenant, objectId, n, exp])}`, expires_at: new Date(exp * 1000).toISOString(), size: n };
}

/**
 * Check an upload token's signature for this object and tenant. Returns { ok, size } where size is
 * the byte count the token is scoped to (signed, so it cannot be altered): 0 = up to the single-part
 * limit, null = an earlier-form token (object only).
 */
function checkUploadToken(objectId, token, { tenant = '' } = {}) {
    const t = String(token || '');
    const v2 = /^v2\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(t);
    if (v2) {
        const exp = Number(v2[1]), n = Number(v2[2]);
        if (exp < nowS()) return { ok: false };
        return { ok: safeEqual(v2[3], macOf(['put2', tenant, objectId, n, exp])), size: n };
    }
    const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(t);
    if (!m) return { ok: false };
    const exp = Number(m[1]);
    if (exp < nowS()) return { ok: false };
    return { ok: safeEqual(m[2], mac('put', objectId, exp)), size: null };
}

/**
 * Valid for this object, in this tenant, for an object of `size` bytes: a token scoped to a size
 * is valid only while the object declares exactly that size (a size-0 token: any size up to the limit).
 */
function verifyUploadToken(objectId, token, { tenant = '', size } = {}) {
    const r = checkUploadToken(objectId, token, { tenant });
    if (!r.ok) return false;
    return size === undefined || r.size === null || r.size === 0 || r.size === Number(size);
}

/** One token for every part (and the status, complete and abort calls) of a multipart session. */
function multipartToken({ tenant, objectId, uploadId, totalSize, expiresAt }) {
    const exp = Math.floor(new Date(expiresAt).getTime() / 1000);
    return { token: `mp1.${exp}.${macOf(['mpart', tenant, objectId, uploadId, totalSize, exp])}`, expires_at: new Date(exp * 1000).toISOString() };
}

function verifyMultipartToken(token, { tenant, objectId, uploadId, totalSize }) {
    const m = /^mp1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
    if (!m) return false;
    const exp = Number(m[1]);
    if (exp < nowS()) return false;
    return safeEqual(m[2], macOf(['mpart', tenant, objectId, uploadId, totalSize, exp]));
}

module.exports = {
    signedDownloadUrl, verifyDownload, signedFileUrl, verifyFile,
    uploadToken, uploadTtl, checkUploadToken, verifyUploadToken, multipartToken, verifyMultipartToken,
};
