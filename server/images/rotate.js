'use strict';
/**
 * Turning a stored picture by hand (pictures, 2026-11-11 part 4).
 *
 * A quarter turn is applied to the stored pixels, so every size of the picture follows: the variants are made from
 * the same file, and their cache key carries its name and modification time, so the next request makes new ones.
 * The file the uploader gave us is never destroyed: before the first turn it is copied beside the stored copy as
 * `<file>.original`, and every later turn rotates the stored copy from there. Each turn is recorded with who made it
 * and when in the object's metadata, which is what the audit reads.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const model = require('../objects/model');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

class RotateError extends Error {
    constructor(code, status, message) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

/** The clockwise turn a request asks for: degrees (90, 180, 270, -90, -180, -270) or quarter_turns (±1, ±2, ±3). */
function degreesOf(body) {
    const b = body || {};
    let degrees = null;
    if (b.quarter_turns != null) {
        const q = Number(b.quarter_turns);
        if (!Number.isInteger(q) || q === 0 || Math.abs(q) > 3) throw new RotateError('media.rotate.invalid', 422, 'quarter_turns must be ±1, ±2 or ±3');
        degrees = q * 90;
    } else if (b.degrees != null) {
        degrees = Number(b.degrees);
    } else {
        throw new RotateError('media.rotate.invalid', 422, 'say how far to turn it: degrees (90, 180 or 270) or quarter_turns (±1, ±2, ±3)');
    }
    if (!Number.isFinite(degrees) || degrees % 90 !== 0 || Math.abs(degrees) >= 360) {
        throw new RotateError('media.rotate.invalid', 422, 'a turn is 90, 180 or 270 degrees');
    }
    return ((degrees % 360) + 360) % 360;
}

const sha256File = (file) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (part) => hash.update(part)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

/** The local copy the bytes are stored in, or a refusal: a picture on a remote copy is not turned in place. */
async function localCopy(obj) {
    const locations = await model.listLocations(obj.id);
    const local = locations.find((l) => l.provider === 'local' && l.state === 'present' && l.key && fs.existsSync(l.key));
    if (!local) throw new RotateError('media.rotate.no_local_copy', 409, 'This picture is not stored on this host, so it cannot be turned in place');
    return local;
}

/**
 * Turn one stored picture `degrees` clockwise. `by` is the audited actor (`user:usr_…` or `svc:media`), and
 * `extraMetadata` is merged into the same update (the detector's confidence, model and receipt).
 * Returns the updated object row.
 */
async function rotateObject(obj, degrees, { by = 'unknown', extraMetadata = null, sharp = null } = {}) {
    if (!obj) throw new RotateError('media.object.not_found', 404, 'No such object');
    if (!IMAGE_TYPES.includes(String(obj.mime_type || '').toLowerCase())) throw new RotateError('media.rotate.not_image', 415, 'Only a JPEG, PNG or WebP picture can be turned');
    if (obj.lifecycle_status !== 'ready') throw new RotateError('media.rotate.not_ready', 409, 'The picture is not ready');
    if (obj.legacy_ref) throw new RotateError('media.rotate.legacy', 409, 'A legacy picture is turned through its own product');
    const local = await localCopy(obj);
    const lib = sharp || require('sharp');
    const tmp = path.join(path.dirname(local.key), `.${path.basename(local.key)}.${process.pid}.${Date.now()}.rotate`);
    // The first turn keeps the uploader's file beside the stored copy; no later turn touches it again.
    const original = `${local.key}.original`;
    try { fs.copyFileSync(local.key, original, fs.constants.COPYFILE_EXCL); } catch { /* already kept */ }
    try {
        const image = lib(local.key, { limitInputPixels: 40_000_000, failOn: 'error', animated: false });
        const meta = await image.metadata();
        const format = meta.format === 'jpg' ? 'jpeg' : meta.format;
        if (!['jpeg', 'png', 'webp'].includes(format) || !meta.width || !meta.height) throw new RotateError('media.rotate.not_image', 415, 'The stored file is not a decodable picture');
        const turned = lib(local.key, { limitInputPixels: 40_000_000, failOn: 'error', animated: false }).rotate(degrees);
        const out = format === 'jpeg' ? turned.jpeg({ quality: 92, mozjpeg: true }) : format === 'png' ? turned.png() : turned.webp({ quality: 92 });
        await out.toFile(tmp);
        const size = fs.statSync(tmp).size;
        const hash = await sha256File(tmp);
        fs.renameSync(tmp, local.key);
        const md = model.parseJson(obj.metadata, {});
        const previous = Number(md.rotation) || 0;
        const rotation = (previous + degrees) % 360;
        const audit = Array.isArray(md.rotation_audit) ? md.rotation_audit.slice(-19) : [];
        audit.push({ by: String(by).slice(0, 200), degrees, at: new Date().toISOString() });
        const metadata = {
            ...md,
            ...(extraMetadata || {}),
            rotation,
            orientation_status: extraMetadata && extraMetadata.orientation_source === 'model' ? 'orientation applied by model' : 'rotated by hand',
            rotation_audit: audit,
            rotation_original_kept: true,
        };
        await model.updateObject(obj.id, { size_bytes: size, content_hash: hash, metadata });
        await model.upsertLocation(obj.id, { provider: 'local', key: local.key, state: 'present', size_bytes: size, checksum: hash, verified: true });
        return await model.getObject(obj.id);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
        if (err instanceof RotateError) throw err;
        throw new RotateError('media.rotate.failed', 422, `The picture could not be turned: ${String(err.message || err).slice(0, 200)}`);
    }
}

module.exports = { rotateObject, degreesOf, RotateError, IMAGE_TYPES };
