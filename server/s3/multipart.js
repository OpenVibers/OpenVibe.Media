'use strict';
/**
 * S3 multipart uploads on Media's S3 surface (ADR-031): what the AWS CLI, the SDKs' Upload helpers and rclone use for
 * large files, and the way past a proxy's per-request size limit (each part is its own request).
 *
 *   create({ zone, key, appId, accessKeyId, contentType, metadata })   → upload row (UploadId mpu_<ULID>)
 *   find(uploadId, zone, key)                                          → the upload, or null (another zone or key: null)
 *   storePart(upload, n, tmp, { bytes, md5 })                          → the part row (a re-sent part replaces the old)
 *   parts(upload) / bytesSoFar(upload, exceptPart)
 *   assemble(upload, wanted)       wanted = [{ n, etag }] ascending → { tmp, bytes, sha256, etag } | { error }
 *   abort(upload) / sweep()        remove the parts (files and rows); sweep ends uploads past expires_at
 *
 * S3's rules: part numbers 1 to 10000; every part but the last is at least 5 MiB; Complete names its parts in
 * ascending order with their ETags; the object's ETag is the MD5 of the parts' MD5s, then "-<count>".
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');
const db = require('../db/database');
const config = require('../config');

const MIN_PART = 5 * 1024 * 1024;
const TTL_MS = Math.max(1, config.objects.multipartTtlHours || 24) * 3600 * 1000;
const dirOf = (uploadId) => path.join(config.objects.path, '.tmp', 's3mp', uploadId);

async function create({ zone, key, appId, accessKeyId, contentType, metadata, now = Date.now() }) {
    const id = `mpu_${ids.ulid(now)}`;
    await db.run(`INSERT INTO media_s3_uploads (id, zone_id, object_key, app_id, access_key_id, content_type, metadata, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, zone.id, key, appId, accessKeyId, contentType, JSON.stringify(metadata || {}), now, now + TTL_MS]);
    fs.mkdirSync(dirOf(id), { recursive: true });
    return await db.get('SELECT * FROM media_s3_uploads WHERE id = ?', [id]);
}

async function find(uploadId, zone, key) {
    if (!/^mpu_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(uploadId || ''))) return null;
    const u = await db.get('SELECT * FROM media_s3_uploads WHERE id = ?', [uploadId]);
    return u && u.zone_id === zone.id && u.object_key === key ? u : null;
}

async function parts(upload) {
    return await db.all('SELECT * FROM media_s3_parts WHERE upload_id = ? ORDER BY part_number', [upload.id]);
}

async function bytesSoFar(upload, exceptPart = 0) {
    const r = await db.get('SELECT COALESCE(SUM(size_bytes), 0) AS b FROM media_s3_parts WHERE upload_id = ? AND part_number <> ?', [upload.id, exceptPart]);
    return Number(r.b);
}

/** Move a received part (the file at `tmp`) into the upload; a part sent again replaces the earlier one. */
async function storePart(upload, n, tmp, { bytes, md5, now = Date.now() }) {
    const dest = path.join(dirOf(upload.id), String(n).padStart(5, '0'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
    await db.run(`INSERT INTO media_s3_parts (upload_id, part_number, size_bytes, md5, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (upload_id, part_number) DO UPDATE SET size_bytes = excluded.size_bytes, md5 = excluded.md5,
            file_path = excluded.file_path, created_at = excluded.created_at`, [upload.id, n, bytes, md5, dest, now]);
    return await db.get('SELECT * FROM media_s3_parts WHERE upload_id = ? AND part_number = ?', [upload.id, n]);
}

/** Join the named parts into one file, checking S3's rules. The upload's own part files stay until abort or commit. */
async function assemble(upload, wanted) {
    if (!wanted.length) return { error: ['MalformedXML', 'The XML you provided was not well-formed or did not validate'] };
    for (let i = 1; i < wanted.length; i++) {
        if (wanted[i].n <= wanted[i - 1].n) return { error: ['InvalidPartOrder', 'The list of parts was not in ascending order'] };
    }
    const have = new Map((await parts(upload)).map((p) => [p.part_number, p]));
    const chosen = [];
    for (const [i, w] of wanted.entries()) {
        const p = have.get(w.n);
        const etag = String(w.etag || '').replace(/^"|"$/g, '').toLowerCase();
        if (!p || p.md5 !== etag) return { error: ['InvalidPart', `Part ${w.n} was not uploaded, or its ETag does not match`] };
        if (i < wanted.length - 1 && Number(p.size_bytes) < MIN_PART) return { error: ['EntityTooSmall', `Part ${w.n} is smaller than the 5 MiB every part but the last must be`] };
        if (!fs.existsSync(p.file_path)) return { error: ['InvalidPart', `Part ${w.n} is no longer stored`] };
        chosen.push(p);
    }
    const tmp = path.join(config.objects.path, '.tmp', `s3mp-${upload.id}-${crypto.randomBytes(4).toString('hex')}`);
    const sha = crypto.createHash('sha256');
    const md5s = crypto.createHash('md5');
    let bytes = 0;
    const out = fs.createWriteStream(tmp);
    try {
        for (const p of chosen) {
            md5s.update(Buffer.from(p.md5, 'hex'));
            await new Promise((resolve, reject) => {
                const src = fs.createReadStream(p.file_path);
                src.on('data', (c) => { sha.update(c); bytes += c.length; });
                src.on('error', reject);
                out.once('error', reject);
                src.on('end', resolve);
                src.pipe(out, { end: false });
            });
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
        out.destroy();
        try { fs.unlinkSync(tmp); } catch { /* not written */ }
        return { error: ['InternalError', `The parts could not be joined: ${err.message}`] };
    }
    return { tmp, bytes, sha256: sha.digest('hex'), etag: `${md5s.digest('hex')}-${chosen.length}` };
}

async function abort(upload) {
    fs.rmSync(dirOf(upload.id), { recursive: true, force: true });
    await db.run('DELETE FROM media_s3_uploads WHERE id = ?', [upload.id]);
}

async function sweep({ now = Date.now() } = {}) {
    const old = await db.all('SELECT * FROM media_s3_uploads WHERE expires_at < ? LIMIT 500', [now]);
    for (const u of old) await abort(u);
    return old.length;
}

async function listForZone(zone, { prefix = '', limit = 1000 } = {}) {
    return await db.all(`SELECT * FROM media_s3_uploads WHERE zone_id = ? AND object_key LIKE ? ESCAPE '\\' ORDER BY object_key, id LIMIT ?`,
        [zone.id, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit]);
}

module.exports = { create, find, parts, bytesSoFar, storePart, assemble, abort, sweep, listForZone, MIN_PART };
