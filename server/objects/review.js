'use strict';

/**
 * OpenVibe.Media's side of the unsafe-image review (VIS-6).
 *
 * Vision is the reviewer: it sorts an image into exactly three categories and, for the hard line, makes the
 * operator's report row. Media is the enforcer:
 *
 *   fine          clear: the object may be served as before.
 *   sex_acts      hidden: visibility becomes private, so every public surface (the open /o/:id route, HLS,
 *                 public_url, a listing's public link) is closed; the owner can still get a signed URL.
 *   minor_sexual  quarantined: private and blocked even with a signature; the report id is kept on the row.
 *
 * A visible upload is marked `pending` at init and stays unserved until Vision answers. If Vision cannot be
 * reached, it stays pending rather than becoming public. `reviewObject` is also exposed through
 * POST /api/v2/:app/objects/:id/review for an operator re-run and for tests.
 */
const { serviceAuth } = require('openvibe-contracts');
const db = require('../db/database');
const model = require('./model');

const ACTIONS = Object.freeze({ fine: 'allow', sex_acts: 'hide', minor_sexual: 'quarantine_and_report' });

/** The Vision client, built from the environment; null when Vision or Media's service principal is unset. */
function visionClient({ fetchImpl = globalThis.fetch } = {}) {
    const base = String(process.env.VISION_URL || process.env.OV_VISION_URL || '').replace(/\/+$/, '');
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!base || !clientSecret) return null;
    const network = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${network}/oauth/token`,
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'media',
        clientSecret,
        audience: 'openvibe.vision',
        scope: 'vision.image.review',
        fetchImpl,
    });
    async function review(obj, retried = false) {
        const res = await fetchImpl(`${base}/api/v1/review`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify({
                object_type: 'media.object',
                object_id: obj.id,
                owner_subject: obj.owner_subject || null,
                image_url: model.legacyPublicUrl(obj) || `${require('../config').publicUrl}/o/${obj.id}`,
            }),
            signal: AbortSignal.timeout(20000),
        });
        if (res.status === 401 && !retried) { try { tokens.invalidate(); } catch { /* older client */ } return await review(obj, true); }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`Vision review ${res.status}: ${(body && (body.detail || body.code)) || 'failed'}`);
        if (!body || !['fine', 'sex_acts', 'minor_sexual'].includes(body.category)) throw new Error('Vision review returned no known category');
        return body;
    }
    return { review, enabled: true };
}

let injected = null;
/** Tests: run with a stand-in Vision client, or null to restore the environment-built one. */
function setReviewClient(client) { injected = client; }
function client() { return injected !== null ? injected : visionClient(); }
/** Is a reviewer configured (or injected for a test)? */
function enabled() { return Boolean(client()); }

/** Should this object be reviewed? Only an image on a public or unlisted object, and only when Vision is configured. */
function reviewRequired(obj) {
    if (!obj || obj.visibility === 'private') return false;
    if (!/^image\//i.test(String(obj.mime_type || ''))) return false;
    return enabled();
}

/** The columns a category writes. Exported for the direct operator route and its tests. */
function columns(category, reportId = null) {
    if (!['fine', 'sex_acts', 'minor_sexual'].includes(category)) throw new Error(`unknown review category: ${category}`);
    if (category === 'fine') return { category, status: 'clear', visibility: null, reportId: null };
    if (category === 'sex_acts') return { category, status: 'hidden', visibility: 'private', reportId: null };
    return { category, status: 'quarantined', visibility: 'private', reportId };
}

async function applyCategory(obj, category, reportId = null) {
    const c = columns(category, reportId);
    const sets = ['review_category = ?', 'review_status = ?', 'review_report_id = ?', 'reviewed_at = now()'];
    const args = [c.category, c.status, c.reportId];
    if (c.visibility) { sets.push('visibility = ?'); args.push(c.visibility); }
    args.push(obj.id);
    await db.run(`UPDATE media_objects SET ${sets.join(', ')} WHERE id = ?`, args);
    return await model.getObject(obj.id);
}

/**
 * Ask Vision and apply its answer. A failure leaves the object pending (closed), never public; it does not
 * throw, so a Vision outage does not fail the uploader's already-stored upload.
 */
async function reviewObject(obj, { log = console } = {}) {
    if (!obj) return null;
    if (!reviewRequired(obj)) {
        if (obj.review_status === 'pending') await db.run("UPDATE media_objects SET review_status = 'clear', reviewed_at = now() WHERE id = ?", [obj.id]);
        return obj.review_status === 'pending' ? await model.getObject(obj.id) : obj;
    }
    const c = client();
    try {
        const out = await c.review(obj);
        const reportId = out.report && out.report.id ? out.report.id : null;
        const updated = await applyCategory(obj, out.category, reportId);
        if (out.category === 'sex_acts') log.warn(`[Objects] ${obj.id} hidden: the review found sex acts or porn`);
        if (out.category === 'minor_sexual') log.error(`[Objects] ${obj.id} quarantined: the review found sexual content involving a minor; operator report ${reportId || '(missing)'}`);
        return updated;
    } catch (err) {
        await db.run("UPDATE media_objects SET review_status = 'pending' WHERE id = ?", [obj.id]);
        log.warn(`[Objects] ${obj.id}: review failed, the object stays pending and unserved (${String((err && err.message) || err).slice(0, 200)})`);
        return await model.getObject(obj.id);
    }
}

/** True when a public reader must not be served this object (a signature does not open a quarantine). */
function publicBlocked(obj, signed = false) {
    if (!obj) return true;
    if (obj.review_status === 'pending') return true;
    if (obj.review_category === 'minor_sexual') return true;
    if (obj.review_category === 'sex_acts' && !signed) return true;
    return false;
}

module.exports = { ACTIONS, visionClient, setReviewClient, enabled, reviewRequired, columns, applyCategory, reviewObject, publicBlocked };
