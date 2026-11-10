'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const model = require('./model');
const namespaces = require('./namespaces');
const { normalizeImageFile } = require('../images/orientation');

const CUTOVER = '2026-11-10 10:16:29';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', (part) => hash.update(part)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
}

function parseMetadata(value) { return model.parseJson(value, {}); }
function newCounts() {
    return { scanned: 0, already_classified: 0, normalize: 0, orientation_unknown: 0, no_exif: 0, unsupported: 0, unreadable: 0, changed: 0, variant_errors: 0, errors: 0 };
}

async function remoteDownload(vs, loc, file) {
    const url = await vs.presignGet(loc.provider, loc.key, 120, { contentType: 'application/octet-stream' });
    if (!url) throw new Error('remote source unavailable');
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error('remote source unavailable');
    const stream = fs.createWriteStream(file);
    for await (const chunk of response.body) if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
    await new Promise((resolve, reject) => stream.end((err) => err ? reject(err) : resolve()));
}

async function runBatch({ db, after = '', batch = 50, apply = false, before = CUTOVER, variants = null, normalize = normalizeImageFile, now = () => new Date() } = {}) {
    const out = newCounts();
    const rows = await db.all(`SELECT id, app_id, namespace, kind, mime_type, size_bytes, content_hash, metadata, created_at
        FROM media_objects WHERE lifecycle_status = 'ready' AND lower(mime_type) IN (?, ?, ?) AND id > ? AND created_at <= ?
        ORDER BY id LIMIT ?`, [...IMAGE_TYPES, after, before, batch]);
    const vs = () => require('../vod/vod-storage');
    const scratch = path.join(require('../config').objects.path, '.tmp');
    fs.mkdirSync(scratch, { recursive: true });
    const localVariants = variants || require('../thumbnails/variants').createVariants({
        dir: require('../config').thumbnails.variants.objectsPath,
        maxBytes: require('../config').thumbnails.variants.maxBytes,
        concurrency: 1,
    });

    for (const obj of rows) {
        out.scanned++;
        const metadata = parseMetadata(obj.metadata);
        if (metadata.orientation_status === 'orientation unknown' || metadata.orientation_status === 'orientation applied') {
            out.already_classified++;
            continue;
        }
        const locations = await model.listLocations(obj.id);
        const local = locations.find((l) => l.provider === 'local' && l.state === 'present' && fs.existsSync(l.key));
        const remote = locations.find((l) => l.provider !== 'local' && l.state === 'present');
        const nonce = crypto.randomBytes(8).toString('hex');
        const source = local ? local.key : path.join(scratch, `${obj.id}.${nonce}.source`);
        const normalized = path.join(scratch, `${obj.id}.${nonce}.normalized`);
        const backup = path.join(scratch, `${obj.id}.${nonce}.original`);
        try {
            if (!local && remote) await remoteDownload(vs(), remote, source);
            if (!local && !remote) {
                out.unreadable++;
                out.orientation_unknown++;
                if (apply) await markUnknown(obj, metadata, 'source unavailable', db);
                continue;
            }
            const probe = require('sharp')(source, { limitInputPixels: 40_000_000, failOn: 'error', animated: false });
            const image = await probe.metadata();
            const hasExif = !!(image.exif && image.exif.length);
            const hasDetails = hasExif || !!(image.xmp && image.xmp.length) || !!(image.iptc && image.iptc.length);
            if (hasDetails || (image.orientation && image.orientation !== 1)) {
                out.normalize++;
                if (!apply) continue;
                await normalize(source, normalized, obj.mime_type);
                const size = fs.statSync(normalized).size;
                const checksum = await hashFile(normalized);
                if (local) fs.copyFileSync(local.key, backup);
                else fs.copyFileSync(source, backup);
                const changedRemote = [];
                try {
                    for (const loc of locations.filter((l) => l.provider !== 'local' && l.state === 'present')) {
                        await vs().uploadFile(loc.provider, loc.key, normalized, obj.mime_type);
                        changedRemote.push(loc);
                    }
                    if (local) {
                        fs.renameSync(normalized, local.key);
                        const stamp = now(); fs.utimesSync(local.key, stamp, stamp);
                    }
                    const nextMetadata = { ...metadata, orientation_status: 'orientation applied', orientation_applied: true };
                    await require('../db/database').getDb().tx(async () => {
                        await model.updateObject(obj.id, { content_hash: checksum, size_bytes: size, metadata: nextMetadata });
                        for (const loc of locations) {
                            if (loc.provider === 'local' || changedRemote.some((r) => r.id === loc.id)) {
                                await db.run('UPDATE media_locations SET checksum = ?, size_bytes = ?, verified_at = ov_now(), updated_at = ov_now() WHERE id = ?', [checksum, size, loc.id]);
                            }
                        }
                    });
                    const app = await db.getApp(obj.app_id);
                    if (app) await namespaces.reconcileChain(app, obj.namespace);
                    out.changed++;
                    if (local) {
                        try {
                            await localVariants.get(local.key, { w: 320, fmt: 'webp' });
                            await localVariants.get(local.key, { w: 640, fmt: 'webp' });
                        } catch { out.variant_errors++; }
                    }
                } catch (err) {
                    for (const loc of changedRemote.reverse()) {
                        try { await vs().uploadFile(loc.provider, loc.key, backup, obj.mime_type); } catch { /* the failed object stays visible in the error count */ }
                    }
                    if (local && fs.existsSync(backup)) fs.copyFileSync(backup, local.key);
                    throw err;
                }
            } else {
                out.orientation_unknown++;
                out.no_exif++;
                if (apply) await markUnknown(obj, metadata, 'no orientation data in the original', db);
            }
        } catch {
            out.errors++;
        } finally {
            for (const file of [normalized, backup, local ? null : source]) if (file) { try { fs.unlinkSync(file); } catch { /* absent */ } }
        }
    }
    return { ...out, next_after: rows.length ? rows[rows.length - 1].id : after, done: rows.length < batch };
}

async function markUnknown(obj, metadata, reason, db) {
    await model.updateObject(obj.id, { metadata: { ...metadata, orientation_status: 'orientation unknown', orientation_reason: reason } });
}

module.exports = { runBatch, CUTOVER, IMAGE_TYPES };
