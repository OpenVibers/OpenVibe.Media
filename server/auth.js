/**
 * OpenVibe.Media — Tenancy & Auth middleware
 *
 * Two credential types (per CONTRACTS.md, Media API v1):
 *   1. App API key — `Authorization: Bearer <app_api_key>` (server-to-server).
 *      Constant-time hash compare against the `apps` row; a key is ONLY valid
 *      for its own `:app` path segment.
 *   2. Network user JWT — RS256, verified OFFLINE against the JWKS public key
 *      fetched from OV_NETWORK_URL at boot (cached, refreshed periodically).
 *      Browser endpoints additionally check the Origin header against the
 *      app's allowed_origins list.
 *
 * App seeding: MEDIA_APPS_SEED (JSON array) and/or MEDIA_APP_KEYS ("id:key,…")
 * are upserted on boot; keys are stored as sha256 hashes.
 */
'use strict';

const crypto = require('crypto');
const db = require('./db/database');
const config = require('./config');

// ── JWKS → PEM (offline user-JWT verification) ───────────────

let _networkPublicKeyPem = null;
let _jwksTimer = null;

async function fetchNetworkPublicKey() {
    const url = `${config.network.url}/api/.well-known/jwks`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
        const body = await res.json();
        const jwk = (body.keys || []).find(k => k.kty === 'RSA') || (body.keys || [])[0];
        if (jwk) {
            const keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' });
            _networkPublicKeyPem = keyObj.export({ type: 'spki', format: 'pem' });
        } else if (typeof body.public_key === 'string' && body.public_key.includes('BEGIN')) {
            // Network's inherited endpoint shape: { public_key: <PEM>, algorithm }
            _networkPublicKeyPem = crypto.createPublicKey(body.public_key).export({ type: 'spki', format: 'pem' });
        } else {
            throw new Error('JWKS contained no keys');
        }
        console.log('[Auth] Network JWKS public key loaded');
        return _networkPublicKeyPem;
    } catch (err) {
        console.warn(`[Auth] Could not fetch JWKS from ${url}: ${err.message} — user-JWT auth unavailable until it loads`);
        return null;
    }
}

function startJwksRefresh() {
    // Until the key loads, retry every 30s — Network may still be booting
    // (user-JWT auth is down for browsers the whole time the key is missing).
    const tryLoad = () => fetchNetworkPublicKey().then((pem) => {
        if (!pem) setTimeout(tryLoad, 30 * 1000).unref?.();
    }).catch(() => { setTimeout(tryLoad, 30 * 1000).unref?.(); });
    tryLoad();
    _jwksTimer = setInterval(() => fetchNetworkPublicKey().catch(() => {}), 6 * 60 * 60 * 1000);
    if (_jwksTimer.unref) _jwksTimer.unref();
}

function stopJwksRefresh() {
    if (_jwksTimer) { clearInterval(_jwksTimer); _jwksTimer = null; }
}

/** Verify an RS256 user JWT offline. Returns the payload or null. */
function verifyUserJwt(token) {
    if (!_networkPublicKeyPem || !token) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (header.alg !== 'RS256') return null;
        const ok = crypto.verify(
            'RSA-SHA256',
            Buffer.from(`${parts[0]}.${parts[1]}`),
            _networkPublicKeyPem,
            Buffer.from(parts[2], 'base64url')
        );
        if (!ok) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload.exp && Date.now() / 1000 > payload.exp) return null;
        if (payload.iss && payload.iss !== config.network.url) return null;
        // aud must include this service when present.
        if (payload.aud) {
            const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
            if (!aud.includes('openvibe.media')) return null;
        }
        return payload;
    } catch {
        return null;
    }
}

// ── App key check (constant-time) ────────────────────────────

function checkAppKey(app, presentedKey) {
    if (!app || !presentedKey) return false;
    const presentedHash = Buffer.from(db.hashApiKey(presentedKey), 'hex');
    const storedHash = Buffer.from(String(app.api_key_hash || ''), 'hex');
    if (presentedHash.length !== storedHash.length || !storedHash.length) return false;
    return crypto.timingSafeEqual(presentedHash, storedHash);
}

function bearerToken(req) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
    return null;
}

/**
 * The user an app-key caller is acting on behalf of, from X-OV-User-Id.
 *
 * Every user_id column in this database holds an id in the CALLING APP's own user-id
 * space — that is the only space an app can resolve back to a person. A Network JWT
 * cannot supply one: its `sub` is the Network's id for that account, which collides
 * with an unrelated local account in each app (Network #57 and Live's user #57 are
 * different people). So a server that wants to act as one of its users says which one
 * explicitly, over its app key.
 *
 * Only the app key unlocks this, and an app key never reaches a browser — it lives in
 * the app's server process. A caller holding one can already write any user_id it likes
 * through the request body, so this grants no reach it did not have.
 */
function actingUserId(req) {
    const raw = req.headers['x-ov-user-id'];
    if (raw == null || raw === '') return null;
    const n = Number(String(raw).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Middleware ───────────────────────────────────────────────

/**
 * Resolve the `:app` path segment to req.appRow / req.appId, then authenticate.
 *
 * @param {object} opts
 * @param {boolean} [opts.allowUser=false]  also accept a Network user JWT
 *        (browser endpoints); Origin, when present, must be allow-listed.
 */
function tenantAuth({ allowUser = false } = {}) {
    return (req, res, next) => {
        const appId = String(req.params.app || '').trim();
        const app = appId ? db.getApp(appId) : null;
        if (!app) return res.status(404).json({ error: 'Unknown app' });
        req.appId = appId;
        req.appRow = app;

        const token = bearerToken(req);

        // 1) App API key — only valid for its own :app segment. A valid key of a
        //    DIFFERENT app must NOT fall through to anything else.
        if (token && checkAppKey(app, token)) {
            req.authType = 'app';
            // Acting on behalf of one of the app's own users: same authority as a user
            // call, so every ownership check below applies — now comparing ids that are
            // actually in the same space as the stored ones.
            const onBehalf = actingUserId(req);
            if (onBehalf != null) {
                req.authType = 'user';
                req.userId = onBehalf;
            }
            return next();
        }
        if (token && isKeyOfOtherApp(token, appId)) {
            return res.status(403).json({ error: 'API key not valid for this app' });
        }

        // 2) A Network user JWT is a real credential, but it cannot say WHICH of an app's
        //    users is calling. It names the account by the Network's id; every user_id
        //    stored here is in the app's own space. They are different numbers over the
        //    same people, so reading identity out of the JWT filed writes under an
        //    unrelated account and made the ownership checks below compare one space
        //    against the other. Both callers that used this path — openvibe.live and the
        //    openvibe.tools paste gateway — now go through their own server, which knows
        //    its users, and name the caller in X-OV-User-Id.
        //
        //    Answered specifically rather than falling through to a bare 401, so anyone
        //    who builds against the old shape is told what to do instead.
        if (allowUser && token && verifyUserJwt(token)) {
            return res.status(403).json({
                error: 'A user JWT cannot identify a user here. Call from your server with '
                    + 'your app key and set X-OV-User-Id to the caller\'s id in YOUR user space.',
            });
        }

        return res.status(401).json({ error: 'Authentication required' });
    };
}

/** Does the presented key belong to some OTHER app? (for a precise 403) */
function isKeyOfOtherApp(presentedKey, exceptAppId) {
    const hash = db.hashApiKey(presentedKey);
    const row = db.get('SELECT app_id FROM apps WHERE api_key_hash = ?', [hash]);
    return !!(row && row.app_id !== exceptAppId);
}

/**
 * Optional identity on PUBLIC serving routes (/v /c /p /t /f): attaches the owning app
 * (via any valid app key), and the user that app says it is acting for. Never rejects.
 *
 * A Network JWT is deliberately NOT an identity here — see tenantAuth for why its
 * subject cannot be used as an app-local user id.
 */
function optionalIdentity(req, _res, next) {
    const token = bearerToken(req);
    if (token) {
        const hash = db.hashApiKey(token);
        const appRow = db.get('SELECT * FROM apps WHERE api_key_hash = ?', [hash]);
        if (appRow) {
            req.authType = 'app';
            req.appRow = appRow;
            req.appId = appRow.app_id;
            const onBehalf = actingUserId(req);
            if (onBehalf != null) {
                req.authType = 'user';
                req.userId = onBehalf;
            }
        }
    }
    next();
}

/** CORS for tenant API routes — reflects allow-listed origins per app. */
function tenantCors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && req.appRow && db.appAllowedOrigins(req.appRow).includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    next();
}

// ── App seeding ──────────────────────────────────────────────

function seedApps() {
    let seeded = 0;

    if (config.apps.seedJson) {
        try {
            const list = JSON.parse(config.apps.seedJson);
            for (const entry of Array.isArray(list) ? list : []) {
                if (!entry || !entry.app_id || !entry.api_key) continue;
                db.upsertApp(entry);
                seeded++;
            }
        } catch (err) {
            console.error('[Auth] MEDIA_APPS_SEED is not valid JSON:', err.message);
        }
    }

    if (config.apps.seedKeys) {
        for (const pair of config.apps.seedKeys.split(',')) {
            const idx = pair.indexOf(':');
            if (idx < 1) continue;
            const app_id = pair.slice(0, idx).trim();
            const api_key = pair.slice(idx + 1).trim();
            if (!app_id || !api_key) continue;
            // Don't clobber a richer MEDIA_APPS_SEED entry for the same app.
            const existing = db.getApp(app_id);
            if (existing && config.apps.seedJson && config.apps.seedJson.includes(`"${app_id}"`)) continue;
            db.upsertApp({
                app_id,
                name: existing?.name || app_id,
                api_key,
                webhook_url: existing?.webhook_url || null,
                webhook_secret: existing?.webhook_secret || null,
                allowed_origins: existing ? db.appAllowedOrigins(existing) : [],
                quota_bytes: existing?.quota_bytes || 0,
            });
            seeded++;
        }
    }

    if (seeded) console.log(`[Auth] Seeded/updated ${seeded} app(s): ${db.listApps().map(a => a.app_id).join(', ')}`);
    else if (!db.listApps().length) console.warn('[Auth] No apps configured — set MEDIA_APPS_SEED (all API calls will 404)');
}

module.exports = {
    tenantAuth,
    tenantCors,
    optionalIdentity,
    // verifyUserJwt stays internal: it proves a token is a genuine Network credential,
    // but its subject is a Network id and must never be used as an app-local user id.
    seedApps,
    startJwksRefresh,
    stopJwksRefresh,
    fetchNetworkPublicKey,
};
