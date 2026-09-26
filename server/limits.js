'use strict';
/**
 * GET /limits.json (roadmap WS-N task 7): the limits a developer project meets here, read from the
 * running configuration, so OpenVibe.Codes' limits page (openvibe.codes/docs/limits) shows what is
 * enforced and never restates it. Public: these are the defaults a project's tenant starts with; an
 * operator's per-namespace quota (scripts/namespaces.js) is not here.
 *
 *   limits[]  id, label, capability (the grant it bounds), unit (count | bytes | hours | days),
 *             production and sandbox (the project's environment), exceeded (what the caller gets past it)
 */
const MB = 1024 * 1024;

function limitsOf(config) {
    const o = config.objects;
    const t = config.apps;
    const both = (v) => ({ production: v, sandbox: v });
    return {
        service: 'media',
        scope: 'per project tenant and environment; namespaces app.<project_id> and app.<project_id>.sandbox (WS-G task 2)',
        limits: [
            { id: 'storage_bytes', label: 'Stored bytes (every namespace of the tenant)', capability: 'media.object.upload', unit: 'bytes',
                production: t.projectQuotaMb * MB, sandbox: t.sandboxQuotaMb * MB, exceeded: '413 media.quota.exceeded' },
            { id: 'child_namespaces', label: 'Namespaces below the root', capability: 'media.object.upload', unit: 'count',
                ...both(o.maxChildNamespaces), exceeded: '413 media.quota.namespaces_exceeded' },
            { id: 'single_upload_bytes', label: 'Size of a single-part upload', capability: 'media.object.upload', unit: 'bytes',
                ...both(o.maxUploadMb * MB), exceeded: '413 media.object.too_large' },
            { id: 'multipart_bytes', label: 'Size of a multipart upload', capability: 'media.object.upload', unit: 'bytes',
                ...both(o.multipartMaxMb * MB), exceeded: '413 media.object.too_large' },
            { id: 'part_bytes', label: 'Size of one multipart part', capability: 'media.object.upload', unit: 'bytes',
                ...both(o.multipartMaxPartMb * MB), exceeded: '413 media.object.too_large' },
            { id: 'public_object_bytes', label: 'Size of an object played publicly', capability: 'media.object.upload', unit: 'bytes',
                ...both(o.publicMaxMb * MB), exceeded: '422 media.invariant.public_object_too_large' },
            { id: 'unfinished_upload_hours', label: 'Hours an unfinished upload holds its quota', capability: 'media.object.upload', unit: 'hours',
                ...both(o.reservationHours), exceeded: 'failed, bytes freed' },
            { id: 'deleted_retention_days', label: 'Days a deleted object can be restored', capability: 'media.object.delete', unit: 'days',
                ...both(o.retentionDays), exceeded: 'purged' },
        ],
    };
}

function mountLimits(app, config) {
    const body = limitsOf(config);
    app.get('/limits.json', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300').set('Access-Control-Allow-Origin', '*').json(body);
    });
}

module.exports = { limitsOf, mountLimits };
