'use strict';
/**
 * POST /internal/community/legacy-paste-screenshots/:id/retire   (OpenVibe.Community only)
 *
 * The narrow door for the two inherited screenshot objects that Community's move script cannot
 * delete through its own tenant (docs/object-model.md, "Ids and legacy refs"):
 *
 *   - a screenshot paste imported from Live has its object in the `live` tenant with
 *     `legacy_ref = legacy:live:paste:<slug>`. DELETE /api/v2/community/objects/<id> answers 404
 *     for it (another tenant).
 *   - an older paste stored its bytes through Community's v1 file store: the object is in the
 *     `community` tenant, kind `file`, with `legacy_ref = legacy:community:file:<key>`. DELETE finds
 *     it but the direct v2 delete refuses every legacy object with 409 media.object.legacy_managed.
 *
 * Community re-hosted those pastes privately in the 2026-11-06 pilot and needs to retire the old
 * public bytes without widening the v2 delete for every legacy row.
 *
 * Exactly those two shapes are retirable. VODs, clips, thumbnails, avatars, other legacy file
 * references and native objects (no legacy_ref) keep their own routes and are refused here. Only
 * the Community service principal (`svc:community`) may call it, with media.object.delete, on
 * loopback, through the same service-token guard as Media's other internal routes; another service
 * holding the capability is refused.
 *
 * The delete is the ordinary soft delete (model.softDelete): /o/:id answers 410 at once, the bytes
 * stay for MEDIA_DELETE_RETENTION_DAYS (metadata.retention_until), the media_objects trigger queues
 * the same media.object.deleted event as any other delete, and a retention hold refuses it. Calling
 * it again is a no-op: the object is already deleted, so the answer is changed:false and no second
 * event is queued. It is rate-limited like DELETE /:id.
 */
const { http } = require('openvibe-contracts');
const model = require('./model');
const { limits } = require('../actor-limits');

const PATH = '/internal/community/legacy-paste-screenshots/:id/retire';
const CAPABILITY = 'media.object.delete';
const PRINCIPAL = 'svc:community';

function problem(res, status, code, detail) {
    return http.sendProblem(res, status, code, { detail });
}

/**
 * The two shapes this route may retire: an imported Live screenshot paste, or a Community-era v1
 * file that held a screenshot paste's bytes (never an avatar, VOD or clip).
 */
function isRetirable(obj) {
    if (!obj) return false;
    const ref = model.parseLegacyRef(obj.legacy_ref);
    if (!ref || !ref.id) return false;
    if (obj.app_id === 'live' && obj.kind === 'screenshot') return ref.app === 'live' && ref.kind === 'paste';
    if (obj.app_id === 'community' && obj.kind === 'file') return ref.app === 'community' && ref.kind === 'file';
    return false;
}

async function retire(req, res) {
    if (!req.principal || req.principal.sub !== PRINCIPAL) {
        return problem(res, 403, 'capability.denied', `${PATH} is for OpenVibe.Community only`);
    }
    const raw = String(req.params.id || '').trim();
    if (!raw) return problem(res, 404, 'media.object.not_found', 'No such object');
    const obj = raw.startsWith('legacy:') ? await model.getObjectByLegacyRef(raw) : await model.getObject(raw);
    if (!obj) return problem(res, 404, 'media.object.not_found', 'No such object');
    if (!isRetirable(obj)) {
        return problem(res, 409, 'media.object.legacy_managed',
            'Only a legacy Live paste screenshot or a legacy Community file is retired here; VODs, clips, thumbnails, avatars and native objects keep their own routes');
    }
    if (obj.lifecycle_status === 'deleted') {
        const md = model.parseJson(obj.metadata, {});
        return res.json({ id: obj.id, lifecycle_status: 'deleted', changed: false, ...(md.retention_until ? { retention_until: md.retention_until } : {}) });
    }
    if (await model.isHeld(obj.id)) return problem(res, 409, 'media.object.held', 'Object is under a retention hold');
    try {
        const gone = await model.softDelete(obj, { by: PRINCIPAL });
        const md = model.parseJson(gone && gone.metadata, {});
        res.json({ id: obj.id, lifecycle_status: 'deleted', changed: true, ...(md.retention_until ? { retention_until: md.retention_until } : {}) });
    } catch (err) {
        if (err && (err.code === 'media.object.held' || /retention hold/.test(err.message))) {
            return problem(res, 409, 'media.object.held', 'Object is under a retention hold');
        }
        console.error('[Objects] legacy paste retire error:', err.message);
        problem(res, 500, 'media.object.delete_failed', 'Failed to retire object');
    }
}

// Deletes change lifecycle, quota and events: the same tighter budget the v2 DELETE uses.
const limit = limits('media.object.legacy_paste.retire', { minute: 60, hour: 1200 });

function handlers() {
    return [limit, retire];
}

module.exports = { PATH, CAPABILITY, PRINCIPAL, isRetirable, limit, handlers };
