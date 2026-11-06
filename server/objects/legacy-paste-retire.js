'use strict';
/**
 * POST /internal/community/legacy-paste-screenshots/:id/retire   (OpenVibe.Community only)
 *
 * The narrow door for one inherited object that Community's move script cannot reach through its own
 * tenant: a screenshot paste imported from Live has its object in the `live` tenant with
 * `legacy_ref = legacy:live:paste:<slug>` (docs/object-model.md, "Ids and legacy refs"). DELETE
 * /api/v2/community/objects/<id> answers 404 for it (another tenant), and Media's direct v2 delete
 * refuses every legacy object with 409 media.object.legacy_managed. Community re-hosted three such
 * pastes privately in the 2026-11-06 pilot before that was known, so their old public objects need a
 * way to be retired without widening the v2 delete for every legacy row.
 *
 * Exactly that shape is retirable: app `live`, kind `screenshot`, legacy ref `legacy:live:paste:<slug>`.
 * VODs, clips, files, thumbnails and avatars keep their own routes and are refused here, as is a
 * native object (no legacy_ref). Only the Community service principal (`svc:community`) may call it,
 * with media.object.delete, on loopback, through the same service-token guard as Media's other
 * internal routes; another service holding the capability is refused.
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

/** The one shape this route may retire (an imported Live screenshot paste, never an avatar or a VOD). */
function isRetirable(obj) {
    if (!obj || obj.app_id !== 'live' || obj.kind !== 'screenshot') return false;
    const ref = model.parseLegacyRef(obj.legacy_ref);
    return !!ref && ref.app === 'live' && ref.kind === 'paste' && !!ref.id;
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
            'Only a legacy Live paste screenshot is retired here; VODs, clips, files, thumbnails and avatars keep their own routes');
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
