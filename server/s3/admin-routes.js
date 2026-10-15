'use strict';
/**
 * The two control doors of the S3 surface, both loopback-only and Network-service-token-only (server/service-guard.js):
 *
 * OpenVibe.Zone → Media (capability media.zone.provision), mounted at /internal/zones:
 *   PUT /:id     body zone.object-zone@1 → { applied, ...report }   a zone change, applied when its revision is higher
 *   GET /:id     → report: { zone_id, revision, state, usage, deletion }   what Zone shows and polls while deleting
 *
 * OpenVibe.Services → Media (capability media.access_key.manage), mounted at /api/v1/projects/:project/access-keys,
 * always on behalf of a person who is an admin or owner of the project (asked of Network, server/registry/projects.js):
 *   POST /                  { env, name, permissions, zones, on_behalf_of } → 201 { key: media.access-key@1, secret }
 *   GET  /?on_behalf_of=    → { keys: [media.access-key@1] }
 *   DELETE /:id?on_behalf_of= → 200 media.access-key@1 (revoked; S3 refuses it at once)
 * The secret is in the 201 only; Media never shows it again.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { guard } = require('../service-guard');
const zones = require('./zones');
const keys = require('./keys');

const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail });

function internalRouter() {
    const r = express.Router();
    r.use(guard('media.zone.provision'), express.json({ limit: '64kb' }));
    r.put('/:id', async (req, res, next) => {
        try {
            res.set('Cache-Control', 'no-store');
            if (!req.body || req.body.id !== req.params.id) return problem(res, 400, 'media.zone.invalid', 'the body is the zone named in the path');
            const out = await zones.provision(req.body);
            res.json({ applied: out.applied, ...await zones.report(out.zone) });
        } catch (err) {
            if (err instanceof zones.ZoneError) return problem(res, err.status, err.code, err.message);
            next(err);
        }
    });
    r.get('/:id', async (req, res, next) => {
        try {
            res.set('Cache-Control', 'no-store');
            const zone = await zones.byId(req.params.id);
            if (!zone) return problem(res, 404, 'media.zone.unknown', 'Media has no such zone');
            res.json(await zones.report(zone));
        } catch (err) { next(err); }
    });
    return r;
}

function keysRouter({ projects = require('../registry/projects').createProjects() } = {}) {
    const r = express.Router({ mergeParams: true });
    r.use(guard('media.access_key.manage'), express.json({ limit: '16kb' }));

    // A first-party service acts, and only for a person who administers the project.
    r.use(async (req, res, next) => {
        try {
            res.set('Cache-Control', 'no-store');
            if (!String(req.principal.sub || '').startsWith('svc:')) return problem(res, 403, 'capability.denied', 'media.access_key.manage requires a service token');
            if (!PROJECT_RE.test(req.params.project)) return problem(res, 404, 'media.project.unknown', 'no such project');
            const person = String((req.body && req.body.on_behalf_of) || req.query.on_behalf_of || '');
            if (!SUBJECT_RE.test(person)) return problem(res, 400, 'media.access_key.no_person', 'on_behalf_of names the person acting (usr_…)');
            let admin;
            try { admin = await projects.isAdmin(req.params.project, person); } catch (err) {
                return problem(res, 503, 'media.network.unavailable', `project roles cannot be read: ${err.message}`);
            }
            if (!admin) return problem(res, 403, 'media.access_key.not_admin', 'only an admin or owner of the project manages its access keys');
            req.person = person;
            next();
        } catch (err) { next(err); }
    });

    r.post('/', async (req, res, next) => {
        try {
            const b = req.body || {};
            const out = await keys.issue({ projectId: req.params.project, env: b.env, name: b.name, permissions: b.permissions || 'read-write', zones: b.zones || [], createdBy: req.person });
            res.status(201).json(out);
        } catch (err) {
            if (err instanceof keys.KeyError) return problem(res, err.status, err.code, err.message);
            next(err);
        }
    });
    r.get('/', async (req, res, next) => {
        try { res.json({ keys: await keys.list(req.params.project) }); } catch (err) { next(err); }
    });
    r.delete('/:id', async (req, res, next) => {
        try {
            const out = await keys.revoke(req.params.project, req.params.id, req.person);
            if (!out) return problem(res, 404, 'media.access_key.unknown', 'no such key in this project');
            res.json(out);
        } catch (err) { next(err); }
    });
    return r;
}

module.exports = { internalRouter, keysRouter };
