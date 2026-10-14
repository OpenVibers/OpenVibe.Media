'use strict';
/**
 * Project delegation (ADR-003 amendment 2026-10-12): whether a person is an admin or owner of an unarchived project,
 * asked of Network (GET /internal/projects/:project/members/:subject, capability network.project.member.read) with
 * Media's own client-credentials token. The control API (server/registry/resource-control.js) uses it so a project's
 * admins can delete the objects its apps stored.
 *
 *   await createProjects().isAdmin(projectId, subjectId)   → true | false; throws when Network cannot answer
 */
const { serviceAuth } = require('openvibe-contracts');
const config = require('../config');

const ADMIN_ROLES = new Set(['admin', 'owner']);

function createProjects({
    networkUrl = config.network.internalUrl,
    clientId = process.env.OV_OAUTH_CLIENT_ID || 'media',
    clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '',
    fetchImpl = globalThis.fetch,
} = {}) {
    const base = String(networkUrl || '').replace(/\/+$/, '');
    const tokens = clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId, clientSecret, audience: 'openvibe.network', scope: 'network.project.member.read', fetchImpl,
    }) : null;

    async function isAdmin(projectId, subjectId) {
        if (!tokens) throw new Error('set OV_OAUTH_CLIENT_SECRET so Media can read project roles from Network');
        const res = await fetchImpl(`${base}/internal/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(subjectId)}`, {
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404) return false;
        if (!res.ok) throw new Error(`Network answered ${res.status} for a project membership`);
        const out = await res.json().catch(() => null);
        return !!out && out.project_id === projectId && out.subject === subjectId && ADMIN_ROLES.has(out.role) && out.archived === false;
    }

    return { isAdmin };
}

module.exports = { createProjects, ADMIN_ROLES };
