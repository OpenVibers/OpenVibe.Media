'use strict';
/**
 * OpenVibe.Media as a receiver of Network service tokens (plan T2, X-Internal-Key retirement).
 *
 * guard(capability) protects an internal route: loopback only (nothing that came through nginx) and a
 * Network service token holding `capability` for audience openvibe.media, verified with the same key
 * Media verifies user JWTs with (server/auth.js verifyServiceTokenResult; sandbox refused). The token
 * is judged on its own: a Bearer is never downgraded to another credential, and nothing else opens the
 * route (the X-Internal-Key path is retired).
 */
const { capabilities, http } = require('openvibe-contracts');
const auth = require('./auth');

// Loopback only: the local reverse proxy marks what it forwarded with one of these headers.
const viaProxy = (req) => !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']);
const isLocal = (req) => /^(::1|::ffff:127\.|127\.)/.test(String(req.socket.remoteAddress || ''));

function guard(capability) {
    return function mediaServiceGuard(req, res, next) {
        if (viaProxy(req) || !isLocal(req)) return res.status(404).json({ error: 'Not found' });
        const bearer = String(req.headers.authorization || '');
        if (!bearer.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required' });
        const r = auth.verifyServiceTokenResult(bearer.slice(7).trim());
        if (!r.ok) return http.sendProblem(res, 401, r.code, { detail: r.reason });
        const c = capabilities.check(r.claims, capability);
        if (!c.allowed) return http.sendProblem(res, 403, c.code || 'capability.denied', { detail: c.reason });
        req.principal = { sub: r.claims.sub, cap: r.claims.cap, jti: r.claims.jti };
        next();
    };
}

module.exports = { guard };
