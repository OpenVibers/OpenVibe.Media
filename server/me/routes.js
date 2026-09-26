/**
 * OpenVibe.Media — the object explorer (roadmap WS-G task 12; docs/object-model.md#object-explorer).
 *
 * The person signed in to openvibe.media (the Network access token: the ov_token cookie, or a bearer
 * token) sees the media objects whose owner_subject is their Network subject (usr_…), in every tenant:
 *
 *   GET  /api/v2/me/objects       ?cursor&limit (≤100)&status (a lifecycle, or all)&kind&q&app → { objects, next_cursor, limit }
 *   GET  /api/v2/me/objects/:id   one of them: copies, derivatives, recent jobs (404 when it is not theirs)
 *   GET  /api/v2/me/usage         their objects and bytes per tenant and namespace (no tenant's quota)
 *   GET  /me, /me/objects/:id     the same as pages (complete without JavaScript; /me/app.js enhances /me)
 *
 * Read-only: visibility, delete and restore stay with the apps. The object API takes them only from a
 * tenant credential (tenantAuth answers a user JWT 403), so the explorer does not act for a person.
 *
 * Operator views, for Network staff (contracts staff map, ADR-022): staff.site.view reads,
 * staff.site.configure recomputes (POST, same-origin only when the credential is the cookie):
 *
 *   GET  /api/v2/me/ops[?app]            failed jobs, missing media, backfill, tiering, namespaces (me/ops.js)
 *   POST /api/v2/me/ops/recompute[?app]  refresh the namespaces' usage snapshot
 *   GET  /me/ops, POST /me/ops/recompute the page and its form
 *
 * The app-key twin of the operator report is GET/POST /api/v1/:app/admin/storage/ops (admin/routes.js).
 * Tokens that are not a person's access token for this site are refused: service and app principals,
 * FedCM assertions, and tokens whose audience does not include openvibe.media. Every answer is private,
 * no-store and noindex. A restore drill (MEDIA_DRILL) signs nobody in: the API answers 503.
 */
'use strict';

const express = require('express');
const { http, ids, staff } = require('openvibe-contracts');
const config = require('../config');
const drill = require('../drill');
const { extractToken } = require('../user-auth');
const explorer = require('./explorer');
const pages = require('./pages');

const PRINCIPAL_SUB = /^(svc|app|mod):/;
const SITE_ORIGIN = (() => { try { return new URL(config.publicUrl).origin; } catch { return null; } })();

function problem(res, status, code, detail) {
    return http.sendProblem(res, status, code, { detail });
}

function privateHeaders(_req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
}

/**
 * The person a verified token names, or { error }: a Network access token for this site (audience
 * openvibe.media), a person (not a service or app principal, not a FedCM assertion), with a subject.
 */
function personFromClaims(claims) {
    if (!claims) return { error: 'invalid' };
    if (PRINCIPAL_SUB.test(String(claims.sub || '')) || claims.actor_type === 'service' || claims.actor_type === 'app') return { error: 'invalid' };
    if (claims.typ === 'fedcm') return { error: 'invalid' };
    const aud = Array.isArray(claims.aud) ? claims.aud : (claims.aud ? [claims.aud] : []);
    if (!aud.includes('openvibe.media')) return { error: 'invalid' };
    if (!ids.isSubjectId('user', claims.subject_id)) return { error: 'no_subject' };
    return {
        person: {
            subject: claims.subject_id,
            username: typeof claims.username === 'string' ? claims.username : null,
            display_name: typeof claims.display_name === 'string' ? claims.display_name : null,
            claims,
        },
    };
}

/** req.person (or req.personError: none | invalid | no_subject | drill) and req.viaCookie. Never blocks. */
function identify(auth) {
    return async (req, _res, next) => {
        req.person = null;
        if (drill.enabled) { req.personError = 'drill'; return next(); }
        const token = extractToken(req);
        if (!token) { req.personError = 'none'; return next(); }
        req.viaCookie = !(req.headers.authorization && req.headers.authorization.startsWith('Bearer '));
        let claims = null;
        try { claims = await auth.verify(token); } catch { claims = null; }
        const r = personFromClaims(claims);
        if (r.person) req.person = r.person; else req.personError = r.error;
        next();
    };
}

/** A cookie-borne write must come from this site's own pages (the cookie is SameSite=Lax as well). */
function sameOrigin(req) {
    if (!req.viaCookie) return true;
    const site = String(req.headers['sec-fetch-site'] || '');
    if (site) return site === 'same-origin';
    const origin = String(req.headers.origin || '');
    return !!origin && origin === SITE_ORIGIN;
}

const can = (person, capability) => {
    try { return !!person && staff.can(person.claims, capability); } catch { return false; }
};

/** 401/503 problems for an API caller who is not a signed-in person. */
function needPerson(req, res) {
    if (req.person) return true;
    if (req.personError === 'drill') problem(res, 503, 'media.drill_no_sign_in', 'This is a restore-drill instance (MEDIA_DRILL): no sign-in');
    else if (req.personError === 'no_subject') problem(res, 401, 'auth.no_subject', 'Your sign-in carries no network subject: sign in again');
    else if (req.personError === 'invalid') problem(res, 401, 'auth.invalid', 'Invalid or expired token');
    else problem(res, 401, 'auth.required', 'Sign in to see your media');
    return false;
}

function opsScope(req) {
    const app = req.query.app;
    if (app == null || app === '') return { appId: null };
    return /^[A-Za-z0-9_.-]{1,80}$/.test(String(app)) ? { appId: String(app) } : { error: 'Bad app' };
}

/**
 * { api, pages }: `api` is mounted at /api/v2/me (ahead of /api/v2/:app/…, so "me" is never a tenant
 * there), `pages` at /me. `auth` is user-auth.createAuthClient's (verify(token) → claims | null).
 */
function createMeRoutes({ auth }) {
    const api = express.Router();
    api.use(privateHeaders, identify(auth));

    api.get('/objects', (req, res) => {
        if (!needPerson(req, res)) return;
        const f = explorer.parseFilters(req.query);
        if (f.error) return problem(res, 400, 'media.me.invalid', f.error);
        try {
            res.json(explorer.list(req.person.subject, f.filters));
        } catch (err) {
            console.error('[Me] list error:', err.message);
            problem(res, 500, 'media.me.list_failed', 'Failed to list your objects');
        }
    });

    api.get('/objects/:id', (req, res) => {
        if (!needPerson(req, res)) return;
        const obj = explorer.detail(req.person.subject, req.params.id);
        if (!obj) return problem(res, 404, 'media.object.not_found', 'No such object of yours');
        res.json(obj);
    });

    api.get('/usage', (req, res) => {
        if (!needPerson(req, res)) return;
        try {
            res.json(explorer.usage(req.person.subject));
        } catch (err) {
            console.error('[Me] usage error:', err.message);
            problem(res, 500, 'media.me.usage_failed', 'Failed to count your usage');
        }
    });

    api.get('/ops', (req, res) => {
        if (!needPerson(req, res)) return;
        if (!can(req.person, 'staff.site.view')) return problem(res, 403, 'capability.denied', 'staff.site.view not granted');
        const s = opsScope(req);
        if (s.error) return problem(res, 400, 'media.me.invalid', s.error);
        try {
            res.json(require('./ops').report({ appId: s.appId, limit: req.query.limit }));
        } catch (err) {
            console.error('[Me] ops report error:', err.message);
            problem(res, 500, 'media.ops.report_failed', 'Failed to build the operator report');
        }
    });

    api.post('/ops/recompute', (req, res) => {
        if (!needPerson(req, res)) return;
        if (!can(req.person, 'staff.site.configure')) return problem(res, 403, 'capability.denied', 'staff.site.configure not granted');
        if (!sameOrigin(req)) return problem(res, 403, 'media.request.cross_origin', 'Only this site\'s own pages may ask for this');
        const s = opsScope(req);
        if (s.error) return problem(res, 400, 'media.me.invalid', s.error);
        const out = require('./ops').recompute({ appId: s.appId });
        console.log(`[Me] Namespace usage recomputed by ${req.person.subject} (${out.scope}): ${out.namespaces} namespace(s)`);
        res.json(out);
    });

    api.use((req, res) => problem(res, 404, 'media.not_found', 'No such route'));

    // ── Pages ────────────────────────────────────────────────
    const site = express.Router();
    site.use(privateHeaders);

    // The enhancement script (client.js). Versioned by content: a matching ?v= is cached for a year.
    site.get('/app.js', (req, res) => {
        res.set('Cache-Control', req.query.v === pages.CLIENT_VERSION ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        res.set('X-Content-Type-Options', 'nosniff');
        res.type('application/javascript').send(pages.CLIENT_SOURCE);
    });

    site.use(identify(auth));
    const html = (res, status, body) => res.status(status).type('html').send(body);

    /** The page for someone who is not (validly) signed in: the sign-in prompt, or the drill notice. */
    function signedOut(req, res, heading, next) {
        if (req.personError === 'drill') return html(res, 503, pages.renderDrill(heading));
        const reason = req.personError === 'no_subject' ? 'Your sign-in carries no network subject yet: sign in again.'
            : req.personError === 'invalid' ? 'Your sign-in has expired.' : null;
        return html(res, 200, pages.renderSignIn({ next, heading, reason }));
    }

    site.get('/', (req, res) => {
        if (!req.person) return signedOut(req, res, 'Your media', '/me');
        const f = explorer.parseFilters(req.query);
        const filters = f.error ? explorer.parseFilters({}).filters : f.filters;
        try {
            html(res, f.error ? 400 : 200, pages.renderExplorer({
                person: req.person, filters, list: explorer.list(req.person.subject, filters), usage: explorer.usage(req.person.subject),
                canOps: can(req.person, 'staff.site.view'),
            }));
        } catch (err) {
            console.error('[Me] page error:', err.message);
            html(res, 500, pages.renderSignIn({ heading: 'Your media', reason: 'Something went wrong loading your media.' }));
        }
    });

    site.get('/objects/:id', (req, res, next) => {
        if (!req.person) return signedOut(req, res, 'Your media', `/me/objects/${encodeURIComponent(req.params.id)}`);
        const obj = explorer.detail(req.person.subject, req.params.id);
        if (!obj) return next();   // the site's own not-found, exactly as for an id that does not exist
        html(res, 200, pages.renderDetail({ person: req.person, obj }));
    });

    site.get('/ops', (req, res) => {
        if (!req.person) return signedOut(req, res, 'Media operations', '/me/ops');
        if (!can(req.person, 'staff.site.view')) return html(res, 403, pages.renderForbidden({ person: req.person, need: 'staff.site.view' }));
        const s = opsScope(req);
        html(res, s.error ? 400 : 200, pages.renderOps({
            person: req.person, report: require('./ops').report({ appId: s.error ? null : s.appId }), canRecompute: can(req.person, 'staff.site.configure'),
            recomputed: /^\d+$/.test(String(req.query.recomputed || '')) ? String(req.query.recomputed) : null,
        }));
    });

    site.post('/ops/recompute', (req, res) => {
        if (!req.person) return signedOut(req, res, 'Media operations', '/me/ops');
        if (!can(req.person, 'staff.site.configure')) return html(res, 403, pages.renderForbidden({ person: req.person, need: 'staff.site.configure' }));
        if (!sameOrigin(req)) return problem(res, 403, 'media.request.cross_origin', 'Only this site\'s own pages may ask for this');
        const s = opsScope(req);
        const out = require('./ops').recompute({ appId: s.error ? null : s.appId });
        console.log(`[Me] Namespace usage recomputed by ${req.person.subject} (${out.scope}): ${out.namespaces} namespace(s)`);
        const qs = new URLSearchParams({ ...(s.appId ? { app: s.appId } : {}), recomputed: String(out.namespaces) });
        res.redirect(303, `/me/ops?${qs}`);
    });

    return { api, pages: site };
}

module.exports = { createMeRoutes, personFromClaims, sameOrigin };
