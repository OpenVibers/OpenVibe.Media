/**
 * OpenVibe.Media — a tenant's namespaces (mounted at /api/v2/:app/namespaces;
 * docs/object-model.md#namespaces-grants-and-quotas)
 *
 * GET /              the namespaces the caller may list: owner, policy, quota and usage
 * GET /:namespace    one (its full name, or a name relative to the tenant's root)
 *
 * The owner's read. The app key sees every namespace of its tenant; a Network token (a first-party
 * service's, or a developer project's app token on /<project_id>/) sees those it holds list
 * (GET /: media.object.list, or media.object.read) or read (GET /:namespace: media.object.read) for.
 * Usage is counted from the rows when read, and the snapshot columns are refreshed with it. Quotas and
 * policies are set by the operator (scripts/namespaces.js).
 */
'use strict';

const express = require('express');
const { http } = require('openvibe-contracts');
const namespaces = require('./namespaces');
const { tenantAuth, tenantCors, namespaceGrant } = require('../auth');

const router = express.Router({ mergeParams: true });
router.use(tenantCors);

function problem(res, status, code, detail) {
    return http.sendProblem(res, status, code, { detail });
}

function shape(req, row) {
    return namespaces.publicShape(req.appRow, row, namespaces.reconcile(req.appRow, row.namespace));
}

router.get('/', tenantAuth({ verb: 'list', namespaced: true }), (req, res) => {
    try {
        const rows = namespaces.listForTenant(req.appId).filter(r => namespaceGrant(req, 'list', r.namespace).allowed);
        res.json({ namespaces: rows.map(r => shape(req, r)) });
    } catch (err) {
        console.error('[Namespaces] list error:', err.message);
        problem(res, 500, 'media.namespace.list_failed', 'Failed to list namespaces');
    }
});

router.get('/:namespace', tenantAuth({ verb: 'read', namespaced: true }), (req, res) => {
    try {
        const named = namespaces.resolveName(req.appRow, req.params.namespace);
        if (named.error) return problem(res, 400, 'media.namespace.invalid', named.error);
        const g = namespaceGrant(req, 'read', named.namespace);
        if (!g.allowed) return problem(res, 403, g.code, g.reason);
        const row = namespaces.get(named.namespace);
        if (!row || row.app_id !== req.appId) return problem(res, 404, 'media.namespace.not_found', 'No such namespace in this tenant');
        res.json(shape(req, row));
    } catch (err) {
        console.error('[Namespaces] read error:', err.message);
        problem(res, 500, 'media.namespace.read_failed', 'Failed to read the namespace');
    }
});

module.exports = router;
