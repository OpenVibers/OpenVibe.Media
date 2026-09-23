/**
 * OpenVibe.Media — multipart uploads of native v2 objects (docs/object-model.md#multipart-uploads)
 *
 * A session belongs to one `uploading` object whose size is declared. Every part but the last is
 * exactly part_size bytes, the last is the rest, so the server knows each part's size up front and
 * refuses any other. Parts are stored under OBJECTS_PATH/.parts/<upload id>/<n> (written to a temp
 * file and renamed, so a dropped connection never leaves half a part) and recorded with their
 * sha256 in media_upload_parts. Re-sending a part replaces it. That makes a session resumable: after
 * a drop, GET the session, then send the parts in `missing`.
 *
 * Complete checks that every part is there (and matches the client's per-part sha256 when given),
 * concatenates them into OBJECTS_PATH/<app>/<id> while hashing the whole object, and then the route
 * runs the same checks as a single-part complete. Abort (or expiry after MEDIA_MULTIPART_TTL_HOURS)
 * deletes the parts; the object stays `uploading` so it can be sent again.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { ids } = require('openvibe-contracts');
const db = require('../db/database');
const config = require('../config');

const MB = 1024 * 1024;
const MAX_PARTS = 10000;

function partsRoot() { return path.join(config.objects.path, '.parts'); }
function sessionDir(uploadId) { return path.join(partsRoot(), uploadId); }
function partFile(uploadId, n) { return path.join(sessionDir(uploadId), String(n)); }

function getSession(uploadId) {
    return uploadId ? db.get('SELECT * FROM media_uploads WHERE id = ?', [String(uploadId)]) : null;
}

function activeFor(objectId) {
    return db.get("SELECT * FROM media_uploads WHERE object_id = ? AND status IN ('active', 'completing') ORDER BY created_at DESC LIMIT 1", [objectId]);
}

function listParts(uploadId) {
    return db.all('SELECT part_number, size_bytes, sha256, received_at FROM media_upload_parts WHERE upload_id = ? ORDER BY part_number', [uploadId]);
}

/** Exact size of part n (1-based) of a session. */
function partSize(session, n) {
    if (n < session.parts_expected) return session.part_size;
    return session.total_size - session.part_size * (session.parts_expected - 1);
}

function isExpired(session) {
    return Date.parse(String(session.expires_at).replace(' ', 'T') + 'Z') < Date.now();
}

/** Part size for a total: the requested one within bounds, grown when the part count would pass 10,000. */
function choosePartSize(total, requested) {
    const min = config.objects.multipartMinPartMb * MB;
    const max = config.objects.multipartMaxPartMb * MB;
    let size = Number(requested) > 0 ? Math.floor(Number(requested)) : config.objects.multipartDefaultPartMb * MB;
    if (size < min) return { error: `part_size must be at least ${min} bytes` };
    if (size > max) return { error: `part_size must be at most ${max} bytes` };
    if (Math.ceil(total / size) > MAX_PARTS) size = Math.ceil(total / MAX_PARTS);
    if (size > max) return { error: 'the object is too large for multipart parts of the maximum size' };
    return { size };
}

function freeBytes() {
    try { const st = fs.statfsSync(config.objects.path); return Number(st.bavail) * Number(st.bsize); } catch { return Infinity; }
}

/**
 * Start a session for `obj` (uploading, size declared). An active session for the object is
 * replaced (its parts deleted). Returns the session row, or { error, status, code }.
 */
function initiate(obj, { partSize: requested } = {}) {
    const total = Number(obj.size_bytes) || 0;
    if (!total) return { status: 400, code: 'media.object.invalid', error: 'Declare size_bytes before a multipart upload' };
    if (total > config.objects.multipartMaxMb * MB) return { status: 413, code: 'media.object.too_large', error: `Multipart uploads are limited to ${config.objects.multipartMaxMb * MB} bytes` };
    const chosen = choosePartSize(total, requested);
    if (chosen.error) return { status: 400, code: 'media.object.invalid', error: chosen.error };
    // Parts and the assembled object both sit on disk until complete.
    const need = 2 * total + config.objects.uploadMinFreeMb * MB;
    const free = freeBytes();
    if (free < need) return { status: 507, code: 'media.storage.insufficient', error: `Not enough free space for this upload (${Math.floor(free / MB)} MB free)` };
    const prior = activeFor(obj.id);
    if (prior) abort(prior.id);
    const id = `mup_${ids.ulid()}`;
    const parts = Math.max(1, Math.ceil(total / chosen.size));
    db.run(`INSERT INTO media_uploads (id, object_id, app_id, part_size, total_size, parts_expected, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`, [id, obj.id, obj.app_id, chosen.size, total, parts, `+${Math.max(1, config.objects.multipartTtlHours)} hours`]);
    fs.mkdirSync(sessionDir(id), { recursive: true });
    return getSession(id);
}

/**
 * Stream one part to disk. Resolves { part_number, size_bytes, sha256 } or { status, code, error }.
 * `expectSha256` (X-Content-SHA256) must match when given.
 */
function receivePart(req, session, n, { expectSha256 = null } = {}) {
    const want = partSize(session, n);
    const tmp = `${partFile(session.id, n)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.mkdirSync(sessionDir(session.id), { recursive: true });
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(tmp);
        let got = 0, done = false;
        const drop = () => { try { fs.unlinkSync(tmp); } catch { /* not written */ } };
        const finish = (r) => { if (done) return; done = true; resolve(r); };
        const fail = (r) => {
            if (done) return;
            const end = () => { drop(); finish(r); };
            if (out.closed) end(); else { out.once('close', end); out.destroy(); }
        };
        req.on('data', (c) => {
            if (done) return;
            got += c.length;
            if (got > want) { req.unpipe(out); req.resume(); return fail({ status: 413, code: 'media.upload.part_too_large', error: `Part ${n} is ${want} bytes` }); }
            hash.update(c);
        });
        req.on('aborted', () => fail({ status: 400, code: 'media.object.upload_interrupted', error: 'Upload did not complete' }));
        req.on('error', () => fail({ status: 400, code: 'media.object.upload_interrupted', error: 'Upload did not complete' }));
        out.on('error', (e) => fail({ status: 500, code: 'media.object.store_failed', error: e.message }));
        out.on('finish', () => {
            if (done) return;
            const sha = hash.digest('hex');
            if (got !== want) { drop(); return finish({ status: 400, code: 'media.upload.part_size_mismatch', error: `Part ${n} must be ${want} bytes, received ${got}` }); }
            if (expectSha256 && String(expectSha256).toLowerCase() !== sha) { drop(); return finish({ status: 400, code: 'media.upload.part_hash_mismatch', error: `Part ${n} does not match X-Content-SHA256` }); }
            // The session may have been completed or aborted while this part streamed in.
            const now = getSession(session.id);
            if (!now || now.status !== 'active') { drop(); return finish({ status: 409, code: 'media.upload.not_active', error: `The upload is ${now ? now.status : 'gone'}` }); }
            try {
                fs.renameSync(tmp, partFile(session.id, n));
                db.run(`INSERT INTO media_upload_parts (upload_id, part_number, size_bytes, sha256) VALUES (?, ?, ?, ?)
                        ON CONFLICT(upload_id, part_number) DO UPDATE SET size_bytes = excluded.size_bytes, sha256 = excluded.sha256, received_at = CURRENT_TIMESTAMP`,
                [session.id, n, got, sha]);
                db.run('UPDATE media_uploads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [session.id]);
            } catch (e) { drop(); return finish({ status: 500, code: 'media.object.store_failed', error: e.message }); }
            finish({ part_number: n, size_bytes: got, sha256: sha });
        });
        req.pipe(out);
    });
}

/** Public shape of a session (never paths). */
function sessionPublic(session, { parts = true } = {}) {
    const out = {
        upload_id: session.id, object_id: session.object_id, status: session.status,
        part_size: session.part_size, total_size: session.total_size, parts_expected: session.parts_expected,
        expires_at: new Date(Date.parse(String(session.expires_at).replace(' ', 'T') + 'Z')).toISOString(),
        created_at: session.created_at,
    };
    if (parts) {
        const list = listParts(session.id);
        const have = new Set(list.map(p => p.part_number));
        out.parts = list;
        out.received_bytes = list.reduce((a, p) => a + p.size_bytes, 0);
        const missing = [];
        for (let n = 1; n <= session.parts_expected; n++) if (!have.has(n)) missing.push(n);
        out.missing = missing;
    }
    return out;
}

/** active -> completing, unless someone else got there first. */
function beginComplete(session) {
    return db.run("UPDATE media_uploads SET status = 'completing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'", [session.id]).changes > 0;
}
function reopen(session) {
    db.run("UPDATE media_uploads SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'completing'", [session.id]);
}

/**
 * Check the parts and concatenate them into `dest` (via a temp file), hashing the whole object.
 * `clientParts` [{ part_number, sha256 }] (optional) must match what was received.
 * Resolves { bytes, sha256 } or { status, code, error, missing? }.
 */
async function assemble(session, dest, clientParts = null) {
    const list = listParts(session.id);
    const byN = new Map(list.map(p => [p.part_number, p]));
    const missing = [];
    for (let n = 1; n <= session.parts_expected; n++) if (!byN.has(n) || !fs.existsSync(partFile(session.id, n))) missing.push(n);
    if (missing.length) return { status: 409, code: 'media.upload.parts_missing', error: `${missing.length} part(s) missing`, missing };
    if (Array.isArray(clientParts)) {
        for (const c of clientParts) {
            const p = byN.get(Number(c && c.part_number));
            if (!p) return { status: 400, code: 'media.upload.invalid_part', error: `No part ${c && c.part_number}` };
            if (c.sha256 && String(c.sha256).toLowerCase() !== p.sha256) return { status: 400, code: 'media.upload.part_hash_mismatch', error: `Part ${p.part_number} differs from the one received` };
        }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.assembling`;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    let bytes = 0;
    try {
        let failed = null;
        out.on('error', (e) => { failed = e; });
        for (let n = 1; n <= session.parts_expected; n++) {
            for await (const chunk of fs.createReadStream(partFile(session.id, n), { highWaterMark: 1024 * 1024 })) {
                if (failed) throw failed;
                hash.update(chunk);
                bytes += chunk.length;
                if (!out.write(chunk)) await once(out, 'drain');
            }
        }
        await new Promise((resolve, reject) => { out.end((err) => (err || failed ? reject(err || failed) : resolve())); });
    } catch (err) {
        out.destroy();
        try { fs.unlinkSync(tmp); } catch { /* none */ }
        return { status: 500, code: 'media.object.store_failed', error: err.message };
    }
    if (bytes !== session.total_size) {
        try { fs.unlinkSync(tmp); } catch { /* none */ }
        return { status: 400, code: 'media.object.size_mismatch', error: `Assembled ${bytes} bytes, declared ${session.total_size}` };
    }
    fs.renameSync(tmp, dest);
    return { bytes, sha256: hash.digest('hex') };
}

function finish(session) {
    db.run("UPDATE media_uploads SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [session.id]);
    removeParts(session.id);
}

function removeParts(uploadId) {
    try { fs.rmSync(sessionDir(uploadId), { recursive: true, force: true }); } catch { /* best effort */ }
    db.run('DELETE FROM media_upload_parts WHERE upload_id = ?', [uploadId]);
}

/** Delete a session's parts; the object stays uploading. */
function abort(uploadId, status = 'aborted') {
    db.run("UPDATE media_uploads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('active', 'completing')", [status, uploadId]);
    removeParts(uploadId);
}

/**
 * Expire sessions past their expiry (incomplete multipart uploads) and remove part directories that
 * no session owns. Returns { expired, orphan_dirs }.
 */
function purgeExpired() {
    let expired = 0, orphans = 0;
    for (const s of db.all("SELECT id FROM media_uploads WHERE status IN ('active', 'completing') AND expires_at < datetime('now')")) {
        abort(s.id, 'expired');
        expired++;
    }
    let dirs = [];
    try { dirs = fs.readdirSync(partsRoot()); } catch { /* none yet */ }
    for (const d of dirs) {
        const s = getSession(d);
        if (s && ['active', 'completing'].includes(s.status)) continue;
        try { fs.rmSync(path.join(partsRoot(), d), { recursive: true, force: true }); orphans++; } catch { /* next time */ }
    }
    return { expired, orphan_dirs: orphans };
}

/** Sessions that are still open (reconciliation: incomplete multipart uploads). */
function openSessions() {
    return db.all("SELECT u.*, (SELECT COUNT(*) FROM media_upload_parts p WHERE p.upload_id = u.id) AS parts_received FROM media_uploads u WHERE status IN ('active', 'completing') ORDER BY created_at");
}

module.exports = {
    MAX_PARTS, getSession, activeFor, listParts, partSize, isExpired, choosePartSize,
    initiate, receivePart, sessionPublic, beginComplete, reopen, assemble, finish, abort, purgeExpired, openSessions, partFile,
};
