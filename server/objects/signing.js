/**
 * OpenVibe.Media — signed object URLs and upload tokens
 *
 * HMAC-SHA256 over (purpose, object id, expiry) with MEDIA_SIGNING_SECRET.
 * Purposes are separate so a download signature can never be replayed as an
 * upload token or the other way round. Without the env secret a random
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

/** Token for PUT /api/v2/:app/objects/:id/content: "<exp>.<mac>". */
function uploadToken(objectId, ttlS = config.objects.uploadTokenTtlS) {
    const exp = nowS() + Math.max(60, Number(ttlS) || 3600);
    return { token: `${exp}.${mac('put', objectId, exp)}`, expires_at: new Date(exp * 1000).toISOString() };
}

function verifyUploadToken(objectId, token) {
    const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
    if (!m) return false;
    const exp = Number(m[1]);
    if (exp < nowS()) return false;
    return safeEqual(m[2], mac('put', objectId, exp));
}

module.exports = { signedDownloadUrl, verifyDownload, signedFileUrl, verifyFile, uploadToken, verifyUploadToken };
