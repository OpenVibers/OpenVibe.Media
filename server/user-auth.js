'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.media — sign-in with OpenVibe.Network, through
// openvibe-sdk/sso (createSsoClient).
//
// The identity provider is OpenVibe.Network (https://openvibe.network).
// This site is registered there as OAuth client `media`, redirect
// https://openvibe.media/auth/callback.
//
//   GET  /auth/login     → redirect to Network /oauth/authorize with state and PKCE (S256)
//                          ?silent=1 adds prompt=none (one quiet round trip; a
//                          signed-out browser comes straight back with
//                          error=login_required and lands on next + ?sso=none)
//                          ?next=…  same-site path or an https://openvibe.network/…
//                          URL (sign-in-everywhere chains)
//                          A silent login whose ov_token already verifies skips the
//                          Network round trip and 302s straight to next.
//   GET  /auth/callback  → server-side code exchange with the PKCE verifier, set cookies
//   POST /auth/fedcm     → browser-native FedCM: the navbar posts the Network's
//                          assertion JWT + the nonce it minted; we check the nonce,
//                          swap the assertion for tokens (jwt-bearer grant), set the
//                          same cookies as the callback
//   GET  /auth/logout    → clear cookies (+ best-effort refresh revoke), hint=guest
//   GET  /auth/me        → offline-verify ov_token, return profile ({ user: null } for a guest)
//   POST /auth/refresh   → rotate tokens via refresh_token grant
//   GET  /auth/health    → does the Network accept this site's OAuth client? (503 when it refuses it)
//
// The routes, the state comparison (constant time), the PKCE verifier and the
// failure pages are openvibe-sdk/sso's; this module supplies the site's OAuth
// client, cookies and /auth/me (this site's own contract: a credential that is
// present but invalid answers 401, and revocations are checked with the rest of
// the app). Moving here keeps everyone signed in: the cookie names are the ones
// this site already used.
//
// Cookies (all host-only — openvibe.media has no subdomains):
//   ov_token     — access JWT, SameSite=Lax, Secure, JS-readable (navbar.js reads it)
//   ov_refresh   — opaque refresh token, httpOnly, Path=/auth
//   ov_sso_hint  — 'account' after a sign-in, 'guest' after a sign-out; 1 year,
//                  JS-readable. navbar.js only attempts a silent login when it says
//                  'account', so signed-out visitors never get bounced.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');
const { verifyUserToken } = require('openvibe-sdk/auth');
const {
    createSsoClient, claimsToUser, decodeJwtPayload, fedcmNonceMatches, sanitizeNext, withParam,
} = require('openvibe-sdk/sso');
const cache = require('openvibe-shared/cache-policy');

/**
 * Create the auth client shared by the whole app: OAuth through OpenVibeAuthClient, and OFFLINE session verification
 * with openvibe-sdk/auth verifyUserToken against the Network keys server/auth.js holds (loaded at boot, never in a
 * drill). A typed token (a FedCM assertion, a realtime ticket, an export token) or a service principal is never a
 * session here.
 */
function createAuthClient(config) {
    const client = new OpenVibeAuthClient({
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        publicKey: null, // sessions are verified below, never by this client
        authBase: config.networkUrl,
        internalBase: config.networkInternalUrl,
    });

    /** Offline JWT verification. Returns decoded claims or null. */
    async function verify(token) {
        if (!token) return null;
        let claims;
        try {
            claims = await verifyUserToken(String(token), { ...require('./auth').networkKeys().verifyOptions, issuer: config.networkUrl });
        } catch {
            return null;
        }
        // Signed out everywhere / password changed / banned since this token was issued (WS-B task 4).
        if (require('./revocations').isRevoked(claims)) return null;
        return claims;
    }

    return { client, verify };
}

/** Token from Authorization header or the ov_token cookie. */
function extractToken(req) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    return req.cookies?.['ov_token'] || null;
}

function createAuthRoutes(config, auth) {
    const sso = createSsoClient({
        site: 'media',
        siteName: 'OpenVibe.Media',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        networkUrl: config.networkUrl,
        networkInternalUrl: config.networkInternalUrl,
        issuer: config.networkUrl,
        redirectUri: config.oauth.redirectUri,
        scope: 'profile theme',
        secureCookies: config.cookies.secure,
        log: console,
    });

    const router = express.Router();

    // GET /auth/me — the shared navbar asks this on every page view. No credential at all (a guest) is
    // signed out, not an error (a 401 logged a console error on each); a credential that is present but
    // invalid or expired still answers 401. Verified offline with the same keys client as the rest of the app.
    router.get('/me', async (req, res) => {
        const token = extractToken(req);
        if (!token) return res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ user: null });
        const claims = await auth.verify(token);
        if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
        res.json({ user: claimsToUser(claims), expires_at: claims.exp ? claims.exp * 1000 : null });
    });

    // /login /callback /logout /fedcm /refresh /health, and the routes this module does not override above.
    router.use(sso.router(express));
    return router;
}

module.exports = {
    createAuthClient, createAuthRoutes,
    extractToken, claimsToUser, decodeJwtPayload, fedcmNonceMatches, sanitizeNext, withParam,
};
