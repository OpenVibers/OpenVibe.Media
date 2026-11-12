'use strict';
/**
 * The model that says which way is up (pictures, 2026-11-11 part 3).
 *
 * Media makes a 256 px copy of a stored picture and asks OpenVibe.AI's `pics.orientation` detector, which answers
 * 0, 90, 180 or 270 degrees with a confidence, under the owner's method, cap, budget and confidence threshold. It runs
 * only on a picture whose EXIF did not settle the orientation (no orientation value, or details already removed) and
 * only when the owner has turned the detector on: when it is off, the answer is "off" and nothing changes.
 *
 * Above the owner's confidence the picture is turned with the same code as a hand turn, and the answer, the model, the
 * confidence and the run's receipt are kept in its metadata. Below it, nothing is turned; the picture stays marked
 * "orientation unknown" so a later run may look again.
 */
const fs = require('fs');
const model = require('../objects/model');
const { rotateObject } = require('./rotate');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const THUMB = 256;
const OFF_TTL_MS = 60_000;

let tokenClient = null;
let lastOffAt = 0;

/** The local copy of the picture, or null: a remote-only object is left to the owner's next repair. */
async function localFile(obj) {
    const locations = await model.listLocations(obj.id);
    const local = locations.find((l) => l.provider === 'local' && l.state === 'present' && l.key && fs.existsSync(l.key));
    return local ? local.key : null;
}

/** A 256 px JPEG copy for the model: the pixels as stored, no EXIF turn (the detector's question is the pixels). */
async function thumbnail(file, { sharp = null } = {}) {
    const lib = sharp || require('sharp');
    const bytes = await lib(file, { limitInputPixels: 40_000_000, failOn: 'error', animated: false })
        .resize({ width: THUMB, height: THUMB, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    return { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, bytes };
}

function createDetector({ config, db, log = console, fetchImpl = globalThis.fetch, sharp = null, clock = { now: () => Date.now() } }) {
    const ai = config.ai || {};
    const enabled = Boolean(ai.internalUrl && ai.clientSecret) && config.orientation.enabled !== false;

    function tokensFor() {
        if (!enabled) return null;
        if (!tokenClient) {
            const { createServiceTokenClient } = require('openvibe-sdk/auth');
            tokenClient = createServiceTokenClient({
                tokenUrl: `${config.network.internalUrl}/oauth/token`,
                clientId: ai.clientId || 'media', clientSecret: ai.clientSecret,
                audience: ai.audience || 'openvibe.ai', scope: 'ai.run.create', fetch: fetchImpl,
            });
        }
        return tokenClient;
    }

    async function ask(dataUrl) {
        const tokens = tokensFor();
        const token = await tokens.getToken();
        const res = await fetchImpl(`${ai.internalUrl}/api/v1/vision/orientation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ image: { data_url: dataUrl } }),
            signal: AbortSignal.timeout(ai.timeoutMs || 60000),
        });
        const body = await res.json().catch(() => null);
        return { status: res.status, body };
    }

    /**
     * Look at one object and, above the owner's confidence, turn it. `apply` false is a dry look (the try page and the
     * batch's first pass): it answers what the model said and changes nothing.
     * → { scanned: true, status, rotation, confidence, turned } | { scanned: false, reason }
     */
    async function detect(obj, { apply = true } = {}) {
        if (!obj || obj.lifecycle_status !== 'ready' || !IMAGE_TYPES.includes(String(obj.mime_type || '').toLowerCase())) return { scanned: false, reason: 'not_image' };
        const md = model.parseJson(obj.metadata, {});
        if (md.orientation_status && md.orientation_status !== 'orientation unknown') return { scanned: false, reason: 'already_settled' };
        const file = await localFile(obj);
        if (!file) return { scanned: false, reason: 'no_local_copy' };
        // EXIF did settle it: the pixels are the source of truth and the detector is not asked.
        const meta = await (sharp || require('sharp'))(file, { limitInputPixels: 40_000_000, failOn: 'error', animated: false }).metadata();
        if (meta.orientation && Number(meta.orientation) >= 2 && Number(meta.orientation) <= 8) {
            if (apply && md.orientation_status !== 'orientation applied') {
                await model.updateObject(obj.id, { metadata: { ...md, orientation_status: 'orientation applied', orientation_source: 'exif' } });
            }
            return { scanned: false, reason: 'exif' };
        }
        // A no-EXIF picture is "orientation unknown" from the moment it is seen: a later batch can find it even when
        // the detector is off now or the answer is below the threshold.
        if (apply && md.orientation_status !== 'orientation unknown') {
            await model.updateObject(obj.id, { metadata: { ...md, orientation_status: 'orientation unknown', orientation_source: 'none' } });
        }
        // Marked before the detector is even configured: a picture seen while the feature is off or unconfigured is
        // still found by the batch on the day the owner turns it on.
        if (!enabled) return { scanned: false, reason: 'disabled' };
        if (!apply) return { scanned: true, rotation: null, confidence: null, turned: false };
        // A detector that just answered "off" is not asked again for a minute: one uploader's picture does not need
        // an AI request while the owner has the feature off.
        if (clock.now() - lastOffAt < OFF_TTL_MS) return { scanned: false, reason: 'off' };
        let answer;
        try {
            const thumb = await thumbnail(file, { sharp });
            answer = await ask(thumb.dataUrl);
        } catch (err) {
            log.warn(`[Orientation] ${obj.id}: OpenVibe.AI did not answer (${String((err && err.message) || err).slice(0, 160)})`);
            return { scanned: true, status: 'unavailable', turned: false };
        }
        if (answer.status === 429) return { scanned: false, reason: 'budget' };
        if (!answer.body || answer.body.method === 'off') { lastOffAt = clock.now(); return { scanned: false, reason: 'off' }; }
        if (!answer.body.answered) return { scanned: true, status: 'unavailable', turned: false };
        const rotation = Number(answer.body.rotation);
        const confidence = Number(answer.body.confidence);
        const threshold = Number(answer.body.setting && answer.body.setting.confidence);
        const ranAt = new Date(clock.now()).toISOString();
        const attempted = {
            orientation_checked_at: ranAt,
            orientation_model_rotation: rotation,
            orientation_model_confidence: confidence,
            orientation_model: answer.body.model || null,
            orientation_receipt: answer.body.receipt_id || null,
            orientation_cost_usd: answer.body.cost_usd == null ? null : Number(answer.body.cost_usd),
        };
        if (![0, 90, 180, 270].includes(rotation) || !Number.isFinite(confidence)) {
            await model.updateObject(obj.id, { metadata: { ...md, ...attempted, orientation_status: 'orientation unknown', orientation_reason: 'model answer unusable' } });
            return { scanned: true, status: 'unreadable', rotation: null, confidence: null, turned: false };
        }
        if (rotation !== 0 && Number.isFinite(threshold) && confidence >= threshold) {
            const turned = await rotateObject(obj, rotation, {
                by: 'svc:media:orientation',
                extraMetadata: { ...attempted, orientation_source: 'model' },
            });
            try {
                const app = await db.getApp(obj.app_id);
                if (app) await require('../objects/namespaces').reconcileChain(app, obj.namespace);
            } catch { /* the hourly reconcile catches it */ }
            return { scanned: true, status: 'turned', rotation, confidence, turned: true, object: turned };
        }
        await model.updateObject(obj.id, {
            metadata: {
                ...md, ...attempted,
                orientation_status: rotation === 0 ? 'orientation checked' : 'orientation unknown',
                orientation_source: rotation === 0 ? 'model' : 'below_confidence',
            },
        });
        return { scanned: true, status: rotation === 0 ? 'upright' : 'below_confidence', rotation, confidence, turned: false };
    }

    return { enabled, detect };
}

module.exports = { createDetector, thumbnail };
