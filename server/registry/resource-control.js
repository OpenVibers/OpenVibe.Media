'use strict';
/**
 * Media's control API (ADR-048, plan T13 step 10; capability media.resource.control):
 *
 *   POST /api/v1/resources/control   common.resource-control-request@1 → common.resource-control-result@1
 *
 * From a first-party service (OpenVibe.Services) on loopback, acting for the person in on_behalf_of, on a media.object
 * named by its OVRN. 200 for every outcome; a malformed request is a 400 problem.
 *
 *   delete   a soft delete, exactly as DELETE /api/v1/objects/:id: the object stops being served at once and can be
 *            restored through the API until its retention period ends. An object under a retention hold, and a legacy
 *            VOD, clip or file (managed through its own routes), is refused.
 *
 * Any other action is refused `control.unsupported_action`. The object's owner may act on it, and so may an admin or
 * owner of its project (asked of Network: server/registry/projects.js), which is how a project's admins delete what
 * its apps stored. Anyone else is refused as not found, never confirmed to exist; and only inside the project the OVRN
 * names. `dry_run` decides and explains without applying. The first answer per (caller, project, idempotency_key) is
 * kept in media_control_log and returned for a repeat; the same key with another request is refused
 * `control.idempotency_conflict`.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');

const SERVICE = 'media';
const CAPABILITY = 'media.resource.control';
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const OBJECT_ID_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const digestOf = (request) => crypto.createHash('sha256')
    .update(canonical({ ...request, idempotency_key: undefined, confirmation_id: undefined, trace_id: undefined })).digest('hex');

function router({ guard, projects = require('./projects').createProjects(), db = require('../db/database'), now = () => Date.now() }) {
    const r = express.Router();
    const json = express.json({ limit: '16kb' });
    const iso = () => new Date(now()).toISOString();
    const result = (request, state, extra = {}) => ({ action: request.action, ...(request.resource ? { resource: request.resource } : {}), state, at: iso(), ...extra });
    const problem = (status, code, detail) => ({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail });

    async function decide(request, caller) {
        const parsed = contracts.resources.parse(request.resource || '');
        if (!parsed || parsed.service !== SERVICE || parsed.type !== 'object' || !OBJECT_ID_RE.test(parsed.id)) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no object named ${request.resource || request.resource_kind}`) });
        }
        if (request.action !== 'delete') {
            return result(request, 'refused', { problem: problem(422, 'control.unsupported_action', `an object takes delete, not ${request.action}`) });
        }
        const person = request.on_behalf_of;
        if (!person || person.type !== 'user' || !USER_SUBJECT_RE.test(String(person.id || ''))) {
            return result(request, 'refused', { problem: problem(403, 'control.no_person', 'on_behalf_of must name the person acting') });
        }
        const obj = await db.get('SELECT o.*, a.project_id AS project FROM media_objects o LEFT JOIN apps a ON a.app_id = o.app_id WHERE o.id = ?', [parsed.id]);
        const inProject = !!obj && obj.project === parsed.project_id && parsed.project_id === request.project_id;
        let allowed = inProject && obj.owner_subject === person.id;
        if (inProject && !allowed) {
            try { allowed = await projects.isAdmin(obj.project, person.id); } catch {
                return result(request, 'failed', { problem: problem(503, 'identity.unavailable', 'Network could not say whether this person administers the project; nothing was changed') });
            }
        }
        if (!allowed) return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no object named ${request.resource} that this person may delete`) });

        const model = require('../objects/model');
        if (obj.legacy_ref) return result(request, 'refused', { problem: problem(409, 'media.object.legacy_managed', 'a VOD, clip or file is deleted through its own routes') });
        if (obj.lifecycle_status === 'deleted') return result(request, 'done', { result: { status: 'deleted', changed: false } });
        if (await model.isHeld(obj.id)) return result(request, 'refused', { problem: problem(409, 'media.object.held', 'the object is under a retention hold') });
        if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: 'delete the object (restorable until its retention period ends)' } });
        let gone;
        try { gone = await model.softDelete(obj, { by: `user:${person.id} via ${caller}` }); } catch (err) {
            if (err && (err.code === 'media.object.held' || /retention hold/.test(err.message))) return result(request, 'refused', { problem: problem(409, 'media.object.held', 'the object is under a retention hold') });
            throw err;
        }
        const app = await db.getApp(obj.app_id);
        if (app) await require('../objects/namespaces').reconcileChain(app, obj.namespace);
        const md = model.parseJson(gone && gone.metadata, {});
        return result(request, 'done', { result: { status: 'deleted', changed: true, ...(md.retention_until ? { restorable_until: md.retention_until } : {}) } });
    }

    r.post('/control', guard, json, async (req, res, next) => {
        try {
            res.set('Cache-Control', 'no-store');
            // First-party: the capability is for OpenVibe's own services, never an app's or agent's token.
            if (!String(req.principal.sub || '').startsWith('svc:')) return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: `${CAPABILITY} requires a service token` });
            const request = req.body;
            const check = contracts.resources.checkControlRequest(request || {});
            if (!check.valid) return contracts.http.sendProblem(res, 400, 'control.bad_request', { detail: JSON.stringify(check.errors).slice(0, 500) });
            const caller = req.principal.sub;
            const digest = digestOf(request);
            const seen = await db.get('SELECT digest, response FROM media_control_log WHERE caller = ? AND project_id = ? AND idempotency_key = ?',
                [caller, request.project_id, request.idempotency_key]);
            if (seen) {
                if (seen.digest !== digest) return contracts.http.sendProblem(res, 409, 'control.idempotency_conflict', { detail: 'this idempotency_key was used for another request' });
                return res.json(typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response);
            }
            const answer = await decide(request, caller);
            await db.run(`INSERT INTO media_control_log (caller, project_id, idempotency_key, digest, response, created_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [caller, request.project_id, request.idempotency_key, digest, JSON.stringify(answer), now()]);
            return res.json(answer);
        } catch (err) { return next(err); }
    });
    return r;
}

module.exports = { router, CAPABILITY, digestOf };
