'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.media — OAuth2 CLIENT session layer
//
// The identity provider is OpenVibe.Network (https://openvibe.network).
// This site is registered there as OAuth client `media`, redirect
// https://openvibe.media/auth/callback. Same shape as the Tools gateway.
//
//   GET  /auth/login     → redirect to Network /oauth/authorize
//                          ?silent=1 adds prompt=none (one quiet round trip; a
//                          signed-out browser comes straight back with
//                          error=login_required and lands on next + ?sso=none)
//                          ?next=…  same-site path or an https://openvibe.network/…
//                          URL (sign-in-everywhere chains)
//                          A silent login whose ov_token already verifies skips the
//                          Network round trip and 302s straight to next.
//   GET  /auth/callback  → server-side code exchange, set cookies
//   POST /auth/fedcm     → browser-native FedCM: the navbar posts the Network's
//                          assertion JWT + the nonce it minted; we check the nonce,
//                          swap the assertion for tokens (jwt-bearer grant), set the
//                          same cookies as the callback
//   GET  /auth/logout    → clear cookies (+ best-effort refresh revoke), hint=guest
//   GET  /auth/me        → offline-verify ov_token, return profile
//   POST /auth/refresh   → rotate tokens via refresh_token grant
//
// Cookies (all host-only — openvibe.media has no subdomains):
//   ov_token     — access JWT, SameSite=Lax, Secure, JS-readable (navbar.js reads it)
//   ov_refresh   — opaque refresh token, httpOnly, Path=/auth
//   ov_sso_hint  — 'account' after a sign-in, 'guest' after a sign-out; 1 year,
//                  JS-readable. navbar.js only attempts a silent login when it says
//                  'account', so signed-out visitors never get bounced.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const HINT_COOKIE = 'ov_sso_hint';
const STATE_COOKIE = 'ov_oauth_state';
const NEXT_COOKIE = 'ov_oauth_next';
const SILENT_COOKIE = 'ov_oauth_silent';

/**
 * Create the auth client + JWKS fetcher shared by the whole app.
 * Verification is OFFLINE: we cache the Network's RS256 public key from
 * GET /api/.well-known/jwks and verify JWTs locally on every request.
 */
function createAuthClient(config) {
    const client = new OpenVibeAuthClient({
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        publicKey: null, // filled by ensureKey()
        authBase: config.networkUrl,
        internalBase: config.networkInternalUrl,
    });

    let lastFetch = 0;
    async function ensureKey() {
        if (client.publicKey) return client.publicKey;
        // Don't hammer the Network if it's down — retry at most every 30s
        if (Date.now() - lastFetch < 30_000) return null;
        lastFetch = Date.now();
        for (const base of [config.networkInternalUrl, config.networkUrl]) {
            if (!base) continue;
            try {
                const res = await fetch(`${base}/api/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
                if (!res.ok) continue;
                const jwks = await res.json();
                if (jwks.public_key) {
                    client.publicKey = jwks.public_key;
                    console.log(`[Auth] Network public key loaded from ${base} (${jwks.algorithm || 'RS256'})`);
                    return client.publicKey;
                }
            } catch (err) {
                console.warn(`[Auth] JWKS fetch failed from ${base}: ${err.message}`);
            }
        }
        return null;
    }

    /** Offline JWT verification. Returns decoded claims or null. */
    async function verify(token) {
        if (!token) return null;
        await ensureKey();
        return client.verifyToken(token);
    }

    // Warm the key cache at boot (non-fatal if the Network is down)
    ensureKey().catch(() => {});

    return { client, ensureKey, verify };
}

/** Token from Authorization header or the ov_token cookie. */
function extractToken(req) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    return req.cookies?.[ACCESS_COOKIE] || null;
}

/** Strip registered claims — what the site shows as "the user". */
function claimsToUser(claims) {
    if (!claims) return null;
    const { iat, exp, aud, iss, nbf, jti, ...user } = claims;
    return user;
}

/**
 * Decode a JWT's payload WITHOUT checking its signature. Only for reading claims
 * we cross-check locally (the FedCM nonce) before the Network — which does verify
 * the signature — sees the assertion. Never use it to trust an identity.
 */
function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
    } catch { return null; }
}

/** True when the assertion's `nonce` claim is exactly the nonce the page posted. */
function fedcmNonceMatches(token, nonce) {
    if (typeof nonce !== 'string' || !nonce || nonce.length > 256) return false;
    const claims = decodeJwtPayload(token);
    if (!claims || typeof claims.nonce !== 'string') return false;
    const a = Buffer.from(claims.nonce), b = Buffer.from(nonce);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Only allow same-site relative paths, this site's own https origin, or an
 * https://openvibe.network/… URL (sign-in / sign-out-everywhere chains) as post-auth targets.
 */
function sanitizeNext(next, config) {
    if (!next || typeof next !== 'string') return '/';
    if (/^\/(?!\/|\\)/.test(next)) return next; // relative path, not protocol-relative
    try {
        const u = new URL(next);
        if (u.protocol !== 'https:') return '/';
        const allowed = [config.baseUrl, config.networkUrl]
            .map((b) => { try { return new URL(b).hostname; } catch { return null; } })
            .filter(Boolean);
        if (allowed.includes(u.hostname)) return u.toString();
    } catch { /* fall through */ }
    return '/';
}

/** Append ?key=value to a same-site path or absolute URL, keeping any existing query/hash. */
function withParam(target, key, value) {
    const hashAt = target.indexOf('#');
    const hash = hashAt >= 0 ? target.slice(hashAt) : '';
    const base = hashAt >= 0 ? target.slice(0, hashAt) : target;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

/**
 * Build the Network authorize URL for a login. Exported (and pure) so tests can
 * cover the silent-login shape without a browser.
 */
function buildAuthorizeUrl(config, auth, { silent = false } = {}) {
    const { url, state } = auth.client.getAuthorizationUrl(config.oauth.scope);
    if (!silent) return { url, state };
    // ?silent=1: continue as the account openvibe.network already knows (no chooser); if the
    // network has no session either, it bounces back with error=login_required and we stay quiet.
    const u = new URL(url);
    u.searchParams.set('prompt', 'none');
    return { url: u.toString(), state };
}

function createAuthRoutes(config, auth) {
    const router = express.Router();

    const accessCookieOpts = () => ({
        sameSite: 'lax',
        secure: config.cookies.secure,
        httpOnly: false, // JS-readable by design — the shared navbar reads it client-side
        path: '/',
        maxAge: 24 * 60 * 60 * 1000, // matches the 24h access JWT
    });

    const refreshCookieOpts = () => ({
        sameSite: 'lax',
        secure: config.cookies.secure,
        httpOnly: true,
        path: '/auth', // only ever sent back to this session layer
        maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    const flowCookieOpts = () => ({
        sameSite: 'lax', secure: config.cookies.secure, httpOnly: true,
        path: '/auth', maxAge: 10 * 60 * 1000,
    });

    const hintCookieOpts = () => ({
        sameSite: 'lax',
        secure: config.cookies.secure,
        httpOnly: false, // navbar.js reads it to decide whether a silent login is worth trying
        path: '/',
        maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    function setSessionCookies(res, accessToken, refreshToken) {
        res.cookie(ACCESS_COOKIE, accessToken, accessCookieOpts());
        if (refreshToken) res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOpts());
        res.cookie(HINT_COOKIE, 'account', hintCookieOpts());
    }

    function clearSessionCookies(res) {
        res.clearCookie(ACCESS_COOKIE, { ...accessCookieOpts(), maxAge: undefined });
        res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOpts(), maxAge: undefined });
    }

    function clearFlowCookies(res) {
        for (const c of [STATE_COOKIE, NEXT_COOKIE, SILENT_COOKIE]) res.clearCookie(c, { path: '/auth' });
    }

    /** Exchange at the Network — internal URL first, public as fallback. */
    async function tokenGrant(body) {
        let lastErr = null;
        for (const base of [config.networkInternalUrl, config.networkUrl]) {
            if (!base) continue;
            try {
                const res = await fetch(`${base}/oauth/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: config.oauth.clientId,
                        client_secret: config.oauth.clientSecret,
                        ...body,
                    }),
                    signal: AbortSignal.timeout(10_000),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const err = new Error(data.error_description || data.error || `token grant failed (${res.status})`);
                    err.status = res.status;
                    err.error = data.error || 'invalid_grant';
                    err.error_description = data.error_description || null;
                    throw err;
                }
                return data;
            } catch (err) {
                lastErr = err;
                // 4xx = the grant itself is bad; retrying against another base won't help
                if (err.status && err.status < 500) throw err;
            }
        }
        throw lastErr || new Error('Network unreachable');
    }

    // ── GET /auth/login ──────────────────────────────────────
    router.get('/login', async (req, res) => {
        const silent = !!req.query.silent && req.query.silent !== '0';
        if (silent) {
            // Already signed in here? Then the silent round trip through the Network would
            // only hand back the session we have: go straight to where the caller wanted.
            const existing = req.cookies?.[ACCESS_COOKIE];
            if (existing && await auth.verify(existing)) {
                clearFlowCookies(res);
                return res.redirect(sanitizeNext(req.query.next, config));
            }
        }
        const { url, state } = buildAuthorizeUrl(config, auth, { silent });
        res.cookie(STATE_COOKIE, state, flowCookieOpts());
        const next = sanitizeNext(req.query.next, config);
        if (next !== '/') res.cookie(NEXT_COOKIE, next, flowCookieOpts());
        else res.clearCookie(NEXT_COOKIE, { path: '/auth' });
        if (silent) res.cookie(SILENT_COOKIE, '1', flowCookieOpts());
        else res.clearCookie(SILENT_COOKIE, { path: '/auth' });
        res.redirect(url);
    });

    // ── GET /auth/callback ───────────────────────────────────
    router.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        const next = sanitizeNext(req.cookies?.[NEXT_COOKIE], config);
        const silent = req.cookies?.[SILENT_COOKIE] === '1';

        if (error) {
            clearFlowCookies(res);
            // Silent sign-in found no network session — go back quietly as a guest. The
            // ?sso=none marker stops navbar.js from trying again on that page.
            if (silent || error === 'login_required') return res.redirect(withParam(next, 'sso', 'none'));
            return res.redirect(withParam('/', 'auth_error', String(error)));
        }
        if (!code) return res.status(400).send('Missing authorization code');

        const expectedState = req.cookies?.[STATE_COOKIE];
        clearFlowCookies(res);
        // The state cookie is required, not just compared when present: skipping the check when
        // the cookie is missing would let a crafted link sign a visitor into someone else's account.
        if (!expectedState || !state || !crypto.timingSafeEqual(
            Buffer.from(String(state).padEnd(64).slice(0, 64)),
            Buffer.from(String(expectedState).padEnd(64).slice(0, 64))
        )) {
            return res.status(400).send('OAuth state mismatch — please try signing in again.');
        }

        try {
            const data = await tokenGrant({
                grant_type: 'authorization_code',
                redirect_uri: config.oauth.redirectUri,
                code,
            });
            setSessionCookies(res, data.access_token, data.refresh_token);
            return res.redirect(next);
        } catch (err) {
            console.error('[Auth] Code exchange failed:', err.message);
            return res.status(502).send('Sign-in failed — could not reach OpenVibe.Network. Please try again.');
        }
    });

    // ── POST /auth/fedcm ─────────────────────────────────────
    // The shared navbar obtained a FedCM assertion from openvibe.network (the
    // browser's own account chooser) and posts it same-origin with the nonce it
    // put in the FedCM request. We only pre-check the nonce; the Network verifies
    // the assertion's signature when it swaps it for tokens.
    const fedcmBody = express.json({ limit: '16kb', type: 'application/json' });
    const fedcmBodyError = (err, _req, res, next) => (err ? res.status(400).json({ error: 'invalid_request', error_description: 'Malformed JSON body' }) : next());
    router.post('/fedcm', fedcmBody, fedcmBodyError, async (req, res) => {
        if (!req.is('application/json')) return res.status(400).json({ error: 'invalid_request', error_description: 'Expected application/json' });
        const { token, nonce } = req.body || {};
        if (typeof token !== 'string' || !token || typeof nonce !== 'string' || !nonce) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'token and nonce are required' });
        }
        if (!fedcmNonceMatches(token, nonce)) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'nonce mismatch' });
        }
        try {
            const data = await tokenGrant({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: token,
            });
            if (!data.access_token) throw Object.assign(new Error('no token'), { status: 401, error: 'invalid_grant' });
            setSessionCookies(res, data.access_token, data.refresh_token);
            const user = data.user || claimsToUser(await auth.verify(data.access_token));
            return res.json({ ok: true, user });
        } catch (err) {
            if (err.status && err.status < 500) {
                return res.status(401).json({ error: err.error || 'invalid_grant', error_description: err.error_description || err.message });
            }
            console.error('[Auth] FedCM exchange failed:', err.message);
            return res.status(502).json({ error: 'server_error', error_description: 'Could not reach OpenVibe.Network' });
        }
    });

    // ── GET /auth/logout ─────────────────────────────────────
    router.get('/logout', async (req, res) => {
        // Best-effort refresh revocation. The Network's rotating refresh tokens
        // self-invalidate, so a failure here is harmless.
        const refresh = req.cookies?.[REFRESH_COOKIE];
        if (refresh) {
            try {
                await fetch(`${config.networkInternalUrl}/oauth/revoke`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: config.oauth.clientId,
                        client_secret: config.oauth.clientSecret,
                        token: refresh,
                    }),
                    signal: AbortSignal.timeout(3000),
                });
            } catch { /* optional */ }
        }
        clearSessionCookies(res);
        res.cookie(HINT_COOKIE, 'guest', hintCookieOpts());
        res.redirect(sanitizeNext(req.query.next, config));
    });

    // ── GET /auth/me ─────────────────────────────────────────
    router.get('/me', async (req, res) => {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated' });
        const claims = await auth.verify(token);
        if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
        res.json({ user: claimsToUser(claims), expires_at: claims.exp ? claims.exp * 1000 : null });
    });

    // ── POST /auth/refresh ───────────────────────────────────
    // Small endpoint the shared navbar can call when ov_token expires.
    router.post('/refresh', async (req, res) => {
        const refresh = req.cookies?.[REFRESH_COOKIE];
        if (!refresh) return res.status(401).json({ error: 'No refresh token' });
        try {
            const data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: refresh });
            setSessionCookies(res, data.access_token, data.refresh_token);
            const claims = await auth.verify(data.access_token);
            return res.json({ token: data.access_token, user: claimsToUser(claims) });
        } catch (err) {
            if (err.status && err.status < 500) {
                clearSessionCookies(res);
                return res.status(401).json({ error: 'Refresh token rejected — please sign in again' });
            }
            console.error('[Auth] Refresh failed:', err.message);
            return res.status(502).json({ error: 'Could not reach OpenVibe.Network' });
        }
    });

    return router;
}

/** Attaches req.user (JWT claims) and req.token when a valid ov_token is presented; never blocks. */
function optionalAuth(auth) {
    return async (req, _res, next) => {
        const token = extractToken(req);
        if (token) {
            const claims = await auth.verify(token);
            if (claims) { req.user = claimsToUser(claims); req.token = token; }
        }
        next();
    };
}

module.exports = { createAuthClient, createAuthRoutes, extractToken, optionalAuth, sanitizeNext, withParam, buildAuthorizeUrl, claimsToUser, decodeJwtPayload, fedcmNonceMatches };
