'use strict';
/**
 * Media's S3 surface (ADR-031 and its zone amendment), path style: https://s3.openvibe.media/<zone name>/<key>.
 *
 * Served by Host (MEDIA_S3_HOSTS), not by path: nginx passes the request line untouched, since SigV4 signs the path.
 *
 *   GET    /                         ListBuckets: the active zones of the key's environment (those it may reach)
 *   HEAD   /<zone>                   HeadBucket
 *   GET    /<zone>?location          GetBucketLocation
 *   GET    /<zone>?list-type=2       ListObjectsV2 (prefix, delimiter, max-keys, continuation-token, start-after)
 *   GET    /<zone>                   ListObjects (v1: prefix, delimiter, max-keys, marker)
 *   PUT    /<zone>                   CreateBucket: 200 for a zone that exists (clients probe this way), else NotImplemented
 *   POST   /<zone>?delete            DeleteObjects
 *   PUT    /<zone>/<key>             PutObject (one request; aws-chunked bodies too)
 *   POST   /<zone>/<key>?uploads     CreateMultipartUpload; PUT ?partNumber&uploadId UploadPart; POST ?uploadId Complete;
 *                                    DELETE ?uploadId Abort; GET ?uploadId ListParts; GET /<zone>?uploads ListMultipartUploads
 *   GET    /<zone>/<key>             GetObject (Range)
 *   HEAD   /<zone>/<key>             HeadObject
 *   DELETE /<zone>/<key>             DeleteObject (Media's soft delete; refused under a retention hold)
 *   PUT    /<zone>/<key> + x-amz-copy-source   CopyObject; with ?partNumber&uploadId UploadPartCopy (server-side copies)
 *   everything else                  NotImplemented (ACLs, policies, versioning, bucket deletion)
 *
 * Every request is signed (SigV4, header or presigned) with an access key (server/s3/keys.js). The key fixes the
 * project and environment, so a bucket name resolves to one zone id of that environment (server/s3/zones.js); a key
 * scoped to zones reaches only those. A request is authorised as the project's app would be: the same tenant, the
 * same quotas (the zone's ceiling and the environment's), the same objects as the native API (/api/v2/:project).
 *
 * An object written here is an ordinary Media object: a med_ id in the zone's namespace, with `zone_id` and its key.
 * A write stores the bytes first, then in one transaction under the tenant's quota lock tombstones the key's previous
 * object (Media's deletion path; refused while it is held) and makes the new one ready. The default zone also lists
 * the environment's native objects, under a derived key: the child namespace path and the med_ id.
 *
 * Responses never run in a browser: every one carries a sandbox CSP and nosniff, whatever type the object declares.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');
const express = require('express');
const db = require('../db/database');
const config = require('../config');
const model = require('../objects/model');
const namespaces = require('../objects/namespaces');
const sigv4 = require('./sigv4');
const keys = require('./keys');
const usage = require('./usage');
const zones = require('./zones');
const mp = require('./multipart');

const MAX_KEY_BYTES = 1024;
const MAX_LIST = 1000;
const MAX_META_BYTES = 2048;
const DERIVED_KEY = /^(?:[a-z0-9][a-z0-9_-]{0,39}\/){0,3}med_[0-9A-HJKMNP-TV-Z]{26}$/;
const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

const STATUS = {
    AccessDenied: 403, InvalidAccessKeyId: 403, SignatureDoesNotMatch: 403, RequestTimeTooSkewed: 403,
    AuthorizationHeaderMalformed: 400, AuthorizationQueryParametersError: 400, InvalidRequest: 400, InvalidArgument: 400,
    KeyTooLongError: 400, MissingContentLength: 411, EntityTooLarge: 400, BadDigest: 400, XAmzContentSHA256Mismatch: 400,
    IncompleteBody: 400, MalformedXML: 400, InvalidRange: 416, NoSuchBucket: 404, NoSuchKey: 404, QuotaExceeded: 403,
    NotImplemented: 501, MethodNotAllowed: 405, InternalError: 500, ServiceUnavailable: 503, InvalidBucketName: 400,
    NoSuchUpload: 404, EntityTooSmall: 400, InvalidPart: 400, InvalidPartOrder: 400, PreconditionFailed: 412,
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const requestId = () => crypto.randomBytes(8).toString('hex').toUpperCase();

function baseHeaders(res) {
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('x-amz-request-id', res.locals.rid || (res.locals.rid = requestId()));
    res.set('Cache-Control', 'private, no-store');
    // Cloudflare reads these over Cache-Control: it never keeps an S3 answer, even one a client asked to be cacheable.
    res.set('CDN-Cache-Control', 'no-store');
    res.set('Cloudflare-CDN-Cache-Control', 'no-store');
}

/** Headers as given (Express's res.set would add a charset to a text Content-Type; S3 answers the stored type). */
function setAll(res, headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

function xml(res, status, body) {
    baseHeaders(res);
    res.status(status).type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
}

function s3error(req, res, code, message, extra = '') {
    const status = STATUS[code] || 400;
    res.locals.s3code = code; // the zone's usage counts refusals by code (server/s3/usage.js)
    baseHeaders(res);
    if (req.method === 'HEAD') return res.status(status).end();
    xml(res, status, `<Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message><Resource>${esc(req.originalUrl.split('?')[0])}</Resource>`
        + `${extra}<RequestId>${res.locals.rid}</RequestId></Error>`);
}

const etagOf = (obj) => {
    const md = model.parseJson(obj.metadata, {});
    if (md.etag) return `"${md.etag}"`;                      // a multipart object: md5 of the parts' md5s, then -<parts>
    return md.md5 ? `"${md.md5}"` : `"${String(obj.content_hash || obj.id).slice(0, 32)}-1"`;
};
const lastModified = (obj) => new Date(String(obj.updated_at || obj.created_at).replace(' ', 'T') + (String(obj.updated_at || obj.created_at).endsWith('Z') ? '' : 'Z'));
const isoOf = (d) => (Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d{3}Z$/, '.000Z') : new Date(0).toISOString());

// ── Authentication: the signature, the key, the tenant ───────

async function authenticate(req, res, next) {
    res.locals.rid = requestId();
    if (!keys.enabled()) return s3error(req, res, 'ServiceUnavailable', 'The S3 surface is not configured on this Media');
    const parsed = sigv4.parse(req);
    if (parsed.error) return s3error(req, res, parsed.error.code, parsed.error.message);
    if (parsed.anonymous) return s3error(req, res, 'AccessDenied', 'Every request must be signed with an access key');
    const key = await keys.find(parsed.accessKeyId);
    if (!key) return s3error(req, res, 'InvalidAccessKeyId', 'The access key ID you provided does not exist in our records');
    const bad = sigv4.verify(req, parsed, key.secret);
    if (bad) return s3error(req, res, bad.code, bad.message);
    try {
        const quota = (key.env === 'sandbox' ? config.apps.sandboxQuotaMb : config.apps.projectQuotaMb) * 1024 * 1024;
        req.appRow = await db.ensureProjectTenant(key.project_id, key.env, quota);
    } catch (err) {
        return s3error(req, res, 'AccessDenied', err.message);
    }
    req.appId = req.appRow.app_id;
    req.s3 = { key, parsed };
    next();
}

const mayRead = (key) => key.permissions === 'read' || key.permissions === 'read-write';
const mayWrite = (key) => key.permissions === 'write' || key.permissions === 'read-write';

/** The zone a bucket name names for this key, or an S3 error answered (and null returned). */
async function zoneFor(req, res, bucket) {
    const { key } = req.s3;
    const zone = await zones.byName(key.project_id, key.env, bucket);
    if (!zone || zone.state !== 'active') { s3error(req, res, 'NoSuchBucket', 'The specified bucket does not exist'); return null; }
    if (key.zones.length && !key.zones.includes(zone.id)) { s3error(req, res, 'AccessDenied', 'This access key is not scoped to this bucket'); return null; }
    req.s3.zone = zone; // from here the request counts in the zone's usage
    return zone;
}

// ── Keys and objects ─────────────────────────────────────────

/** The object key from the path (decoded once), or null when it is not a valid S3 key. */
function keyOf(rest) {
    let k;
    try { k = decodeURIComponent(rest); } catch { return null; }
    const bytes = Buffer.byteLength(k, 'utf8');
    return bytes >= 1 && bytes <= MAX_KEY_BYTES ? k : null;
}

/** The ready object a key names in a zone (S3-written, or a native object's derived key in the default zone). */
async function findObject(zone, tenantId, key) {
    const row = await db.get(`SELECT * FROM media_objects WHERE zone_id = ? AND object_key = ? AND lifecycle_status = 'ready'`, [zone.id, key]);
    if (row) return row;
    if (!zone.is_default || !DERIVED_KEY.test(key)) return null;
    const parts = key.split('/');
    const id = parts.pop();
    const ns = parts.length ? `${zone.namespace}.${parts.join('.')}` : zone.namespace;
    return await db.get(`SELECT * FROM media_objects WHERE id = ? AND app_id = ? AND namespace = ? AND object_key IS NULL
        AND lifecycle_status = 'ready'`, [id, tenantId, ns]) || null;
}

/** SQL for the key every object of a zone lists under (its own, or the derived one in the default zone). */
function effectiveKeySql(zone) {
    if (!zone.is_default) return 'o.object_key';
    const n = zone.namespace.length + 2;
    return `COALESCE(o.object_key, CASE WHEN o.namespace = '${zone.namespace.replace(/'/g, "''")}' THEN o.id
        ELSE replace(substr(o.namespace, ${n}), '.', '/') || '/' || o.id END)`;
}

// ── Reading bytes ────────────────────────────────────────────

/** bytes=a-b | a- | -n against `size` → { start, end } | 'invalid' | null (no Range). */
function parseRange(header, size) {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;            // S3 ignores a range it cannot read
    let start, end;
    if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'invalid'; start = Math.max(0, size - n); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start >= size || end < start) return 'invalid';
    return { start, end };
}

function objectHeaders(obj) {
    const md = model.parseJson(obj.metadata, {});
    const h = {
        'Content-Type': obj.mime_type || 'application/octet-stream',
        ETag: etagOf(obj),
        'Last-Modified': lastModified(obj).toUTCString(),
        'Accept-Ranges': 'bytes',
    };
    for (const [k, v] of Object.entries(md.s3_meta || {})) h[`x-amz-meta-${k}`] = v;
    if (md.content_disposition) h['Content-Disposition'] = md.content_disposition;
    if (md.content_encoding) h['Content-Encoding'] = md.content_encoding;
    // The stored Cache-Control is kept but never sent: zones are private, and a shared cache (Cloudflare in front of
    // the S3 host) would serve a signed answer to anyone asking for the same URL (baseHeaders: private, no-store).
    return h;
}

/** Presigned GETs may override response headers, as S3 allows. */
function responseOverrides(req) {
    const o = {};
    const map = { 'response-content-type': 'Content-Type', 'response-content-disposition': 'Content-Disposition',
        'response-content-encoding': 'Content-Encoding', 'response-content-language': 'Content-Language',
        'response-expires': 'Expires' };
    for (const [q, h] of Object.entries(map)) if (typeof req.query[q] === 'string' && req.query[q].length <= 512) o[h] = req.query[q];
    return o;
}

async function sendObject(req, res, obj, { head = false } = {}) {
    const size = Number(obj.size_bytes) || 0;
    const headers = { ...objectHeaders(obj), ...responseOverrides(req) };
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((s) => s.trim()).includes(headers.ETag)) { baseHeaders(res); setAll(res, headers); return res.status(304).end(); }
    const ims = req.headers['if-modified-since'] ? new Date(req.headers['if-modified-since']) : null;
    if (ims && Number.isFinite(ims.getTime()) && lastModified(obj).getTime() <= ims.getTime() + 999) { baseHeaders(res); setAll(res, headers); return res.status(304).end(); }
    const im = req.headers['if-match'];
    if (im && !im.split(',').map((s) => s.trim()).includes(headers.ETag) && im.trim() !== '*') return s3error(req, res, 'PreconditionFailed', 'At least one of the preconditions you specified did not hold');
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') { res.set('Content-Range', `bytes */${size}`); return s3error(req, res, 'InvalidRange', 'The requested range is not satisfiable'); }
    baseHeaders(res);
    setAll(res, headers);
    if (range) {
        res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${size}`).set('Content-Length', String(range.end - range.start + 1));
    } else res.status(200).set('Content-Length', String(size));
    if (head || req.method === 'HEAD') return res.end();
    if (require('../drill').refuseBytes(res)) return;
    const from = range || (size ? { start: 0, end: size - 1 } : null);
    if (!from) return res.end();
    const src = await openBytes(req, obj, from);
    if (src) return await pipeline(src, res).catch(() => res.destroy());
    if (!res.headersSent) return s3error(req, res, 'InternalError', 'The object bytes are unavailable right now');
    res.destroy();
}

/**
 * A readable stream of the object's bytes from..to (inclusive), or null when no copy answers. The placement router
 * ranks the copies; a local one streams from disk, a remote one is fetched and passed on (S3 clients do not follow
 * redirects). GetObject and the copies (CopyObject, UploadPartCopy) read through here.
 */
async function openBytes(req, obj, from) {
    const router = require('../placement/router');
    const decision = await router.route({ object: obj, purpose: 'download', session: router.sessionFor(req, obj.id), contentType: obj.mime_type || 'application/octet-stream', expiresIn: 300 });
    for (const loc of decision.candidates || []) {
        if (loc.provider === 'local') {
            if (!fs.existsSync(loc.key)) continue;
            return fs.createReadStream(loc.key, { start: from.start, end: from.end });
        }
        const url = (loc.provider === decision.provider && decision.url)
            || await require('../vod/vod-storage').presignGet(loc.provider, loc.key, 300, {}).catch(() => null);
        if (!url) continue;
        const up = await fetch(url, { headers: { Range: `bytes=${from.start}-${from.end}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
        if (!up || !(up.status === 206 || up.status === 200) || !up.body) continue;
        const { Readable } = require('stream');
        return Readable.fromWeb(up.body);
    }
    return null;
}

// ── Writing ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32Update(crc, buf) {
    let c = crc ^ 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** x-amz-meta-* headers (at most 2 KB, as S3 allows), names lowercased. */
function userMeta(req) {
    const out = {};
    let bytes = 0;
    for (const [k, v] of Object.entries(req.headers)) {
        if (!k.startsWith('x-amz-meta-')) continue;
        const name = k.slice('x-amz-meta-'.length);
        const value = Array.isArray(v) ? v.join(',') : String(v);
        bytes += name.length + value.length;
        out[name] = value;
    }
    return bytes > MAX_META_BYTES ? null : out;
}

/**
 * Stream the body (decoded from aws-chunked when it is) to a temporary file, hashing it: sha256, md5, crc32.
 * → { bytes, sha256, md5, crc32, trailers } | { error: { code, message } }
 */
async function receive(req, tmp, cap, parsed) {
    const sha = crypto.createHash('sha256'), md5 = crypto.createHash('md5'), sha1 = crypto.createHash('sha1');
    let crc = 0, n = 0, trailers = {};
    const counter = new PassThrough();
    counter.on('data', (chunk) => {
        n += chunk.length;
        if (n > cap) { counter.destroy(Object.assign(new Error('too large'), { code: 'EntityTooLarge' })); return; }
        sha.update(chunk); md5.update(chunk); sha1.update(chunk); crc = crc32Update(crc, chunk);
    });
    const stages = [req];
    if (sigv4.isStreaming(parsed)) stages.push(sigv4.chunkDecoder(parsed, { onTrailers: (t) => { trailers = t; } }));
    stages.push(counter, fs.createWriteStream(tmp));
    try {
        await pipeline(...stages);
    } catch (err) {
        return { error: { code: err.code && STATUS[err.code] ? err.code : 'IncompleteBody', message: err.code === 'EntityTooLarge' ? `Objects sent in one request are at most ${cap} bytes` : (err.message || 'The request body ended early') } };
    }
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc);
    return { bytes: n, sha256: sha.digest('hex'), md5: md5.digest(), sha1: sha1.digest('base64'), crc32: crcBuf.toString('base64'), trailers };
}

/** Every integrity claim the client made about the body, checked: Content-MD5, x-amz-content-sha256, x-amz-checksum-*. */
function integrityProblem(req, parsed, got) {
    const md5 = req.headers['content-md5'];
    if (md5 && md5 !== got.md5.toString('base64')) return ['BadDigest', 'The Content-MD5 you specified did not match what we received'];
    if (/^[0-9a-f]{64}$/.test(parsed.payloadHash) && parsed.payloadHash !== got.sha256) {
        return ['XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed'];
    }
    const claims = { ...got.trailers };
    for (const k of ['x-amz-checksum-crc32', 'x-amz-checksum-sha256', 'x-amz-checksum-sha1']) if (req.headers[k]) claims[k] = String(req.headers[k]);
    const ours = { 'x-amz-checksum-crc32': got.crc32, 'x-amz-checksum-sha256': Buffer.from(got.sha256, 'hex').toString('base64'), 'x-amz-checksum-sha1': got.sha1 };
    for (const [k, v] of Object.entries(claims)) if (ours[k] && ours[k] !== v) return ['BadDigest', `The ${k.slice('x-amz-checksum-'.length)} checksum you specified did not match what we received`];
    return null;
}

const mimeOf = (req) => String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 127) || 'application/octet-stream';

/** The metadata an S3 write keeps on its object: its file name, user metadata and the response headers it set. */
function objectMeta(req, key, meta) {
    const md = { filename: key.split('/').pop().slice(0, 200), s3: true, created_by: req.s3.key.id };
    if (meta && Object.keys(meta).length) md.s3_meta = meta;
    for (const [h, f] of [['content-disposition', 'content_disposition'], ['content-encoding', 'content_encoding'], ['cache-control', 'cache_control']]) {
        if (req.headers[h] && String(req.headers[h]).length <= 512) md[f] = String(req.headers[h]);
    }
    return md;
}

/**
 * Make stored bytes (the file at `tmp`) the object under `key`, in one transaction under the tenant's quota lock: the
 * quota with the real size, the zone still active, the key's previous object through the deletion path (refused while
 * held), then the new object, ready, with its location, invariant and media.object.uploaded event. PutObject and
 * CompleteMultipartUpload both end here. → { obj } | { error: [code, message] } (the caller removes `tmp` on error).
 */
async function commitObject(req, zone, key, { tmp, bytes, sha256, mime, md }) {
    let outcome;
    try {
        const events = require('../events');
        outcome = await db.getDb().tx(async () => {
            const previous = await db.get(`SELECT * FROM media_objects WHERE zone_id = ? AND object_key = ? AND lifecycle_status = 'ready'`, [zone.id, key]);
            const q = await namespaces.checkQuota(req.appRow, zone.namespace, { bytes, objects: 1, excludeId: previous ? previous.id : null });
            if (q) return { error: ['QuotaExceeded', q.detail] };
            const fresh = await zones.byId(zone.id);
            if (!fresh || fresh.state !== 'active') return { error: ['NoSuchBucket', 'The specified bucket does not exist'] };
            if (previous) {
                if (await model.isHeld(previous.id)) return { error: ['AccessDenied', 'The object under this key is under a retention hold and cannot be replaced'] };
                const pmd = model.parseJson(previous.metadata, {});
                pmd.pre_delete_status = previous.lifecycle_status;
                pmd.retention_until = new Date(Date.now() + config.objects.retentionDays * 864e5).toISOString();
                pmd.deleted_by = `${req.s3.key.id} (overwrite)`;
                await db.run(`UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = ov_now(), metadata = ?, updated_at = ov_now() WHERE id = ?`,
                    [JSON.stringify(pmd), previous.id]);
                await namespaces.settle(previous.id);
            }
            await namespaces.ensure(req.appRow, db.rootNamespace(req.appRow));
            const id = await model.createObject({
                app_id: req.appId, namespace: zone.namespace, kind: 'file', owner_subject: null, owner_app: req.appId, owner_user_id: null,
                visibility: 'private', lifecycle_status: 'uploading', mime_type: mime, size_bytes: bytes, metadata: md,
            });
            const obj = await model.getObject(id);
            const dest = model.objectFilePath(obj);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.renameSync(tmp, dest);
            await db.run(`UPDATE media_objects SET lifecycle_status = 'ready', content_hash = ?, canonical_provider = 'local', canonical_key = ?,
                zone_id = ?, object_key = ?, updated_at = ov_now() WHERE id = ?`, [sha256, dest, zone.id, key, id]);
            await model.upsertLocation(id, { provider: 'local', key: dest, state: 'present', size_bytes: bytes, checksum: sha256, verified: true });
            const ready = await model.getObject(id);
            await require('../objects/invariant').record(ready);
            await events.record('media.object.uploaded', req.appId, await model.objectPublic(ready));
            await events.recordObjectChanges();
            return { obj: ready };
        });
        require('../events').kick();
    } catch (err) {
        console.error('[S3] commit error:', err.message);
        return { error: ['InternalError', 'We encountered an internal error. Please try again.'] };
    }
    if (!outcome.error) await namespaces.reconcileChain(req.appRow, zone.namespace).catch(() => {});
    return outcome;
}

async function putObject(req, res, zone, key) {
    const { key: akey, parsed } = req.s3;
    if (!mayWrite(akey)) { req.resume(); return s3error(req, res, 'AccessDenied', 'This access key is read-only'); }
    if (req.headers['x-amz-copy-source']) { req.resume(); return await copyObject(req, res, zone, key); }
    const acl = String(req.headers['x-amz-acl'] || 'private');
    if (acl !== 'private' && acl !== 'bucket-owner-full-control') { req.resume(); return s3error(req, res, 'AccessDenied', 'Zones are private: objects cannot be made public over S3'); }
    if (DERIVED_KEY.test(key)) {
        req.resume();
        return s3error(req, res, 'InvalidArgument', 'Keys of the form [path/]med_<id> are the ids of objects written through the native API; choose another key');
    }
    const meta = userMeta(req);
    if (!meta) { req.resume(); return s3error(req, res, 'InvalidArgument', `User metadata is limited to ${MAX_META_BYTES} bytes`); }
    const declared = Number(sigv4.isStreaming(parsed) ? req.headers['x-amz-decoded-content-length'] : req.headers['content-length']);
    const cap = config.objects.maxUploadMb * 1024 * 1024;
    if (!Number.isFinite(declared)) { req.resume(); return s3error(req, res, 'MissingContentLength', 'You must provide the Content-Length HTTP header'); }
    if (declared > cap) { res.set('Connection', 'close'); req.resume(); return s3error(req, res, 'EntityTooLarge', `Objects sent in one request are at most ${cap} bytes`); }
    // Room for the declared size before a byte is stored; checked again with the real size below.
    const pre = await namespaces.checkQuota(req.appRow, zone.namespace, { bytes: declared, objects: 0 });
    if (pre) { res.set('Connection', 'close'); req.resume(); return s3error(req, res, 'QuotaExceeded', pre.detail); }

    const tmpDir = path.join(config.objects.path, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `s3-${crypto.randomBytes(8).toString('hex')}`);
    const drop = () => { try { fs.unlinkSync(tmp); } catch { /* not written */ } };
    const got = await receive(req, tmp, Math.max(declared, 0), parsed);
    if (got.error) { drop(); return s3error(req, res, got.error.code, got.error.message); }
    if (got.bytes !== declared) { drop(); return s3error(req, res, 'IncompleteBody', `You did not provide the number of bytes specified by the Content-Length HTTP header (${declared}; ${got.bytes} received)`); }
    const bad = integrityProblem(req, parsed, got);
    if (bad) { drop(); return s3error(req, res, bad[0], bad[1]); }

    const md = { ...objectMeta(req, key, meta), md5: got.md5.toString('hex') };
    const outcome = await commitObject(req, zone, key, { tmp, bytes: got.bytes, sha256: got.sha256, mime: mimeOf(req), md });
    if (outcome.error) { drop(); return s3error(req, res, outcome.error[0], outcome.error[1]); }
    baseHeaders(res);
    res.set('ETag', etagOf(outcome.obj));
    for (const k of ['x-amz-checksum-crc32', 'x-amz-checksum-sha256']) if (req.headers[k] || got.trailers[k]) res.set(k, req.headers[k] || got.trailers[k]);
    res.status(200).end();
}

// ── Copies (CopyObject, UploadPartCopy) ──────────────────────

/**
 * The source x-amz-copy-source names ("bucket/key" or "/bucket/key", URL-encoded), read with the same key: a zone of
 * the key's environment it may read, and an object there. → { zone, key, obj } or null (the S3 error answered).
 * The destination stays the zone the request counts against (req.s3.zone).
 */
async function copySource(req, res) {
    const raw = String(req.headers['x-amz-copy-source'] || '');
    const [pathPart, query] = raw.split('?');
    if (query && /(^|&)versionId=/.test(query)) { s3error(req, res, 'NotImplemented', 'Zones keep no versions: copy the current object'); return null; }
    let src;
    try { src = decodeURIComponent(pathPart).replace(/^\//, ''); } catch { src = ''; }
    const slash = src.indexOf('/');
    if (slash < 1 || slash === src.length - 1) { s3error(req, res, 'InvalidArgument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey'); return null; }
    const key = keyOf(src.slice(slash + 1));
    if (key == null) { s3error(req, res, 'KeyTooLongError', `Keys are 1 to ${MAX_KEY_BYTES} bytes`); return null; }
    if (!mayRead(req.s3.key)) { s3error(req, res, 'AccessDenied', 'This access key cannot read the copy source'); return null; }
    const dest = req.s3.zone;
    const zone = await zoneFor(req, res, src.slice(0, slash));
    req.s3.zone = dest;
    if (!zone) return null;
    const obj = await findObject(zone, req.appId, key);
    if (!obj) { s3error(req, res, 'NoSuchKey', 'The specified key does not exist.', `<Key>${esc(key)}</Key>`); return null; }
    const etag = etagOf(obj);
    const at = lastModified(obj).getTime();
    const list = (h) => String(req.headers[h] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const when = (h) => { const d = req.headers[h] ? new Date(req.headers[h]) : null; return d && Number.isFinite(d.getTime()) ? d.getTime() : null; };
    const im = list('x-amz-copy-source-if-match'), inm = list('x-amz-copy-source-if-none-match');
    const ims = when('x-amz-copy-source-if-modified-since'), ius = when('x-amz-copy-source-if-unmodified-since');
    // S3's order: if-match wins over if-unmodified-since, if-none-match over if-modified-since.
    const ok = (im.length ? im.includes(etag) || im.includes('*') : (ius == null || at <= ius + 999))
        && (inm.length ? !inm.includes(etag) : (ims == null || at > ims + 999));
    if (!ok) { s3error(req, res, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'); return null; }
    return { zone, key, obj };
}

/** Copy the source's bytes from..to into a temporary file, hashing them. → { tmp, bytes, sha256, md5 } | { error } */
async function copyBytes(req, obj, from) {
    const tmpDir = path.join(config.objects.path, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `s3c-${crypto.randomBytes(8).toString('hex')}`);
    const sha = crypto.createHash('sha256'), md5 = crypto.createHash('md5');
    let bytes = 0;
    if (!from) { fs.writeFileSync(tmp, ''); return { tmp, bytes: 0, sha256: sha.digest('hex'), md5: md5.digest('hex') }; }
    if (require('../drill').enabled) return { error: ['ServiceUnavailable', 'This Media is a restore drill: no bytes are served'] };
    const src = await openBytes(req, obj, from);
    if (!src) return { error: ['InternalError', 'The copy source bytes are unavailable right now'] };
    const { Transform } = require('stream');
    const tap = new Transform({ transform(chunk, _enc, cb) { sha.update(chunk); md5.update(chunk); bytes += chunk.length; cb(null, chunk); } });
    try {
        await pipeline(src, tap, fs.createWriteStream(tmp));
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* not written */ }
        return { error: ['InternalError', `The copy did not complete: ${err.message}`] };
    }
    if (bytes !== from.end - from.start + 1) { try { fs.unlinkSync(tmp); } catch { /* */ } return { error: ['InternalError', 'The copy source ended early'] }; }
    return { tmp, bytes, sha256: sha.digest('hex'), md5: md5.digest('hex') };
}

async function copyObject(req, res, zone, key) {
    const src = await copySource(req, res);
    if (!src) return;
    const directive = String(req.headers['x-amz-metadata-directive'] || 'COPY').toUpperCase();
    if (directive !== 'COPY' && directive !== 'REPLACE') return s3error(req, res, 'InvalidArgument', 'Unknown metadata directive: COPY or REPLACE');
    if (src.zone.id === zone.id && src.key === key && directive === 'COPY') {
        return s3error(req, res, 'InvalidRequest', "This copy request is illegal because it is trying to copy an object to itself without changing the object's metadata, storage class, website redirect location or encryption attributes.");
    }
    const size = Number(src.obj.size_bytes) || 0;
    const cap = (config.objects.multipartMaxMb || 20480) * 1024 * 1024;
    if (size > cap) return s3error(req, res, 'EntityTooLarge', `A copy in one request is at most ${cap} bytes; use UploadPartCopy`);
    const pre = await namespaces.checkQuota(req.appRow, zone.namespace, { bytes: size, objects: 0 });
    if (pre) return s3error(req, res, 'QuotaExceeded', pre.detail);
    let md, mime;
    if (directive === 'COPY') {
        const from = model.parseJson(src.obj.metadata, {});
        md = { filename: key.split('/').pop().slice(0, 200), s3: true, created_by: req.s3.key.id };
        for (const f of ['s3_meta', 'content_disposition', 'content_encoding', 'cache_control']) if (from[f] !== undefined) md[f] = from[f];
        mime = src.obj.mime_type || 'application/octet-stream';
    } else {
        const meta = userMeta(req);
        if (!meta) return s3error(req, res, 'InvalidArgument', `User metadata is limited to ${MAX_META_BYTES} bytes`);
        md = objectMeta(req, key, meta);
        mime = mimeOf(req);
    }
    const got = await copyBytes(req, src.obj, size ? { start: 0, end: size - 1 } : null);
    if (got.error) return s3error(req, res, got.error[0], got.error[1]);
    const outcome = await commitObject(req, zone, key, { tmp: got.tmp, bytes: got.bytes, sha256: got.sha256, mime, md: { ...md, md5: got.md5 } });
    if (outcome.error) { try { fs.unlinkSync(got.tmp); } catch { /* */ } return s3error(req, res, outcome.error[0], outcome.error[1]); }
    xml(res, 200, `<CopyObjectResult xmlns="${XMLNS}"><ETag>${esc(etagOf(outcome.obj))}</ETag><LastModified>${isoOf(lastModified(outcome.obj))}</LastModified></CopyObjectResult>`);
}

async function copyPart(req, res, zone, key, up, n) {
    const src = await copySource(req, res);
    if (!src) return;
    const size = Number(src.obj.size_bytes) || 0;
    let from = size ? { start: 0, end: size - 1 } : null;
    const rangeHeader = req.headers['x-amz-copy-source-range'];
    if (rangeHeader) {
        const m = /^bytes=(\d+)-(\d+)$/.exec(String(rangeHeader).trim());
        if (!m || Number(m[1]) > Number(m[2]) || Number(m[2]) >= size) return s3error(req, res, 'InvalidArgument', 'The x-amz-copy-source-range value must be of the form bytes=first-last where first and last are the zero-based offsets of the first and last bytes to copy, within the source');
        from = { start: Number(m[1]), end: Number(m[2]) };
    }
    const bytes = from ? from.end - from.start + 1 : 0;
    const cap = (config.objects.multipartMaxPartMb || 256) * 1024 * 1024;
    if (bytes > cap) return s3error(req, res, 'EntityTooLarge', `A part is at most ${cap} bytes`);
    const total = await mp.bytesSoFar(up, n) + bytes;
    if (total > (config.objects.multipartMaxMb || 20480) * 1024 * 1024) return s3error(req, res, 'EntityTooLarge', 'The object would be larger than this surface accepts');
    const pre = await namespaces.checkQuota(req.appRow, zone.namespace, { bytes: total, objects: 0 });
    if (pre) return s3error(req, res, 'QuotaExceeded', pre.detail);
    const got = await copyBytes(req, src.obj, from);
    if (got.error) return s3error(req, res, got.error[0], got.error[1]);
    if (!await mp.find(up.id, zone, key)) { try { fs.unlinkSync(got.tmp); } catch { /* */ } return s3error(req, res, 'NoSuchUpload', 'The upload was aborted or completed while this part was copied'); }
    const part = await mp.storePart(up, n, got.tmp, { bytes: got.bytes, md5: got.md5 });
    xml(res, 200, `<CopyPartResult xmlns="${XMLNS}"><ETag>"${part.md5}"</ETag><LastModified>${isoOf(new Date(Number(part.created_at) || Date.now()))}</LastModified></CopyPartResult>`);
}

// ── Multipart uploads ────────────────────────────────────────

/** Read a small XML request body (Complete, DeleteObjects), aws-chunked or not, checking x-amz-content-sha256. */
async function readXmlBody(req, limit = 2 * 1024 * 1024) {
    const chunks = [];
    let n = 0;
    const body = sigv4.isStreaming(req.s3.parsed) ? req.pipe(sigv4.chunkDecoder(req.s3.parsed)) : req;
    for await (const c of body) {
        n += c.length;
        if (n > limit) return { error: ['MalformedXML', 'The request body is too large'] };
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks);
    if (/^[0-9a-f]{64}$/.test(req.s3.parsed.payloadHash) && crypto.createHash('sha256').update(raw).digest('hex') !== req.s3.parsed.payloadHash) {
        return { error: ['XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed'] };
    }
    return { text: raw.toString('utf8') };
}

async function createMultipart(req, res, zone, key) {
    req.resume();
    if (!mayWrite(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key is read-only');
    const acl = String(req.headers['x-amz-acl'] || 'private');
    if (acl !== 'private' && acl !== 'bucket-owner-full-control') return s3error(req, res, 'AccessDenied', 'Zones are private: objects cannot be made public over S3');
    if (DERIVED_KEY.test(key)) return s3error(req, res, 'InvalidArgument', 'Keys of the form [path/]med_<id> are the ids of objects written through the native API; choose another key');
    const meta = userMeta(req);
    if (!meta) return s3error(req, res, 'InvalidArgument', `User metadata is limited to ${MAX_META_BYTES} bytes`);
    const up = await mp.create({ zone, key, appId: req.appId, accessKeyId: req.s3.key.id, contentType: mimeOf(req), metadata: objectMeta(req, key, meta) });
    xml(res, 200, `<InitiateMultipartUploadResult xmlns="${XMLNS}"><Bucket>${esc(zone.name)}</Bucket><Key>${esc(key)}</Key><UploadId>${up.id}</UploadId></InitiateMultipartUploadResult>`);
}

async function uploadPart(req, res, zone, key) {
    const { key: akey, parsed } = req.s3;
    if (!mayWrite(akey)) { req.resume(); return s3error(req, res, 'AccessDenied', 'This access key is read-only'); }
    const n = Number(req.query.partNumber);
    if (!Number.isInteger(n) || n < 1 || n > 10000) { req.resume(); return s3error(req, res, 'InvalidArgument', 'Part number must be an integer between 1 and 10000, inclusive'); }
    const up = await mp.find(req.query.uploadId, zone, key);
    if (!up) { req.resume(); return s3error(req, res, 'NoSuchUpload', 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.'); }
    if (req.headers['x-amz-copy-source']) { req.resume(); return await copyPart(req, res, zone, key, up, n); }
    const declared = Number(sigv4.isStreaming(parsed) ? req.headers['x-amz-decoded-content-length'] : req.headers['content-length']);
    const cap = (config.objects.multipartMaxPartMb || 256) * 1024 * 1024;
    if (!Number.isFinite(declared)) { req.resume(); return s3error(req, res, 'MissingContentLength', 'You must provide the Content-Length HTTP header'); }
    if (declared > cap) { res.set('Connection', 'close'); req.resume(); return s3error(req, res, 'EntityTooLarge', `A part is at most ${cap} bytes`); }
    const total = await mp.bytesSoFar(up, n) + declared;
    if (total > (config.objects.multipartMaxMb || 20480) * 1024 * 1024) { res.set('Connection', 'close'); req.resume(); return s3error(req, res, 'EntityTooLarge', 'The object would be larger than this surface accepts'); }
    const pre = await namespaces.checkQuota(req.appRow, zone.namespace, { bytes: total, objects: 0 });
    if (pre) { res.set('Connection', 'close'); req.resume(); return s3error(req, res, 'QuotaExceeded', pre.detail); }
    const tmpDir = path.join(config.objects.path, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `s3p-${crypto.randomBytes(8).toString('hex')}`);
    const drop = () => { try { fs.unlinkSync(tmp); } catch { /* not written */ } };
    const got = await receive(req, tmp, Math.max(declared, 0), parsed);
    if (got.error) { drop(); return s3error(req, res, got.error.code, got.error.message); }
    if (got.bytes !== declared) { drop(); return s3error(req, res, 'IncompleteBody', `You did not provide the number of bytes specified by the Content-Length HTTP header (${declared}; ${got.bytes} received)`); }
    const bad = integrityProblem(req, parsed, got);
    if (bad) { drop(); return s3error(req, res, bad[0], bad[1]); }
    if (!await mp.find(up.id, zone, key)) { drop(); return s3error(req, res, 'NoSuchUpload', 'The upload was aborted or completed while this part arrived'); }
    const part = await mp.storePart(up, n, tmp, { bytes: got.bytes, md5: got.md5.toString('hex') });
    baseHeaders(res);
    res.set('ETag', `"${part.md5}"`);
    for (const k of ['x-amz-checksum-crc32', 'x-amz-checksum-sha256']) if (req.headers[k] || got.trailers[k]) res.set(k, req.headers[k] || got.trailers[k]);
    res.status(200).end();
}

async function completeMultipart(req, res, zone, key) {
    if (!mayWrite(req.s3.key)) { req.resume(); return s3error(req, res, 'AccessDenied', 'This access key is read-only'); }
    const up = await mp.find(req.query.uploadId, zone, key);
    if (!up) { req.resume(); return s3error(req, res, 'NoSuchUpload', 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.'); }
    const body = await readXmlBody(req).catch((err) => ({ error: [err.code && STATUS[err.code] ? err.code : 'IncompleteBody', err.message] }));
    if (body.error) return s3error(req, res, body.error[0], body.error[1]);
    const items = body.text.match(/<Part>[\s\S]*?<\/Part>/g) || [];
    if (!/<CompleteMultipartUpload[\s>]/.test(body.text) || !items.length || items.length > 10000) return s3error(req, res, 'MalformedXML', 'The XML you provided was not well-formed or did not validate');
    const wanted = items.map((x) => ({ n: Number((/<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(x) || [])[1]), etag: ((/<ETag>([\s\S]*?)<\/ETag>/.exec(x) || [])[1] || '').replace(/&quot;/g, '"') }));
    if (wanted.some((w) => !Number.isInteger(w.n))) return s3error(req, res, 'MalformedXML', 'Every part names its PartNumber');
    const joined = await mp.assemble(up, wanted);
    if (joined.error) return s3error(req, res, joined.error[0], joined.error[1]);
    const kept = up.metadata && typeof up.metadata === 'object' ? up.metadata : model.parseJson(up.metadata, {});   // jsonb
    const md = { ...kept, etag: joined.etag };
    const outcome = await commitObject(req, zone, key, { tmp: joined.tmp, bytes: joined.bytes, sha256: joined.sha256, mime: up.content_type, md });
    if (outcome.error) { try { fs.unlinkSync(joined.tmp); } catch { /* moved or gone */ } return s3error(req, res, outcome.error[0], outcome.error[1]); }
    await mp.abort(up);
    const host = String(req.headers.host || '');
    xml(res, 200, `<CompleteMultipartUploadResult xmlns="${XMLNS}"><Location>https://${esc(host)}/${esc(zone.name)}/${esc(sigv4.awsEncode(key, true))}</Location>`
        + `<Bucket>${esc(zone.name)}</Bucket><Key>${esc(key)}</Key><ETag>${esc(etagOf(outcome.obj))}</ETag></CompleteMultipartUploadResult>`);
}

async function abortMultipart(req, res, zone, key) {
    req.resume();
    if (!mayWrite(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key is read-only');
    const up = await mp.find(req.query.uploadId, zone, key);
    if (!up) return s3error(req, res, 'NoSuchUpload', 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.');
    await mp.abort(up);
    baseHeaders(res);
    res.status(204).end();
}

async function listParts(req, res, zone, key) {
    if (!mayRead(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key cannot read');
    const up = await mp.find(req.query.uploadId, zone, key);
    if (!up) return s3error(req, res, 'NoSuchUpload', 'The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.');
    const after = Number(req.query['part-number-marker']) || 0;
    const max = Math.min(1000, Math.max(1, Number(req.query['max-parts']) || 1000));
    const all = (await mp.parts(up)).filter((p) => p.part_number > after);
    const page = all.slice(0, max);
    const items = page.map((p) => `<Part><PartNumber>${p.part_number}</PartNumber><LastModified>${new Date(Number(p.created_at)).toISOString()}</LastModified>`
        + `<ETag>"${p.md5}"</ETag><Size>${Number(p.size_bytes)}</Size></Part>`).join('');
    const truncated = all.length > max;
    xml(res, 200, `<ListPartsResult xmlns="${XMLNS}"><Bucket>${esc(zone.name)}</Bucket><Key>${esc(key)}</Key><UploadId>${up.id}</UploadId>`
        + `<PartNumberMarker>${after}</PartNumberMarker>${truncated ? `<NextPartNumberMarker>${page[page.length - 1].part_number}</NextPartNumberMarker>` : ''}`
        + `<MaxParts>${max}</MaxParts><IsTruncated>${truncated}</IsTruncated><StorageClass>STANDARD</StorageClass>${items}</ListPartsResult>`);
}

async function listUploads(req, res, zone) {
    if (!mayRead(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key cannot read');
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    const rows = await mp.listForZone(zone, { prefix });
    const items = rows.map((u) => `<Upload><Key>${esc(u.object_key)}</Key><UploadId>${u.id}</UploadId><StorageClass>STANDARD</StorageClass>`
        + `<Initiated>${new Date(Number(u.created_at)).toISOString()}</Initiated></Upload>`).join('');
    xml(res, 200, `<ListMultipartUploadsResult xmlns="${XMLNS}"><Bucket>${esc(zone.name)}</Bucket><Prefix>${esc(prefix)}</Prefix>`
        + `<MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>${items}</ListMultipartUploadsResult>`);
}

async function deleteOne(req, zone, key) {
    const obj = await findObject(zone, req.appId, key);
    if (!obj) return { ok: true };                 // S3 answers 204 for a key that is not there
    if (await model.isHeld(obj.id)) return { error: ['AccessDenied', 'The object is under a retention hold'] };
    try {
        await model.softDelete(obj, { by: `${req.s3.key.id}` });
    } catch (err) {
        if (err instanceof model.HeldError) return { error: ['AccessDenied', 'The object is under a retention hold'] };
        throw err;
    }
    await namespaces.reconcileChain(req.appRow, obj.namespace).catch(() => {});
    return { ok: true };
}

// ── Listing ──────────────────────────────────────────────────

async function listObjects(req, res, zone, { v2 }) {
    const q = req.query;
    const prefix = typeof q.prefix === 'string' ? q.prefix : '';
    const delimiter = typeof q.delimiter === 'string' && q.delimiter ? q.delimiter : '';
    const maxKeys = Math.min(MAX_LIST, Math.max(0, Number.isFinite(Number(q['max-keys'])) ? Number(q['max-keys']) : MAX_LIST));
    let after = '';
    if (v2) {
        if (typeof q['continuation-token'] === 'string' && q['continuation-token']) {
            try { after = Buffer.from(q['continuation-token'], 'base64url').toString('utf8'); } catch { return s3error(req, res, 'InvalidArgument', 'The continuation token provided is incorrect'); }
        } else if (typeof q['start-after'] === 'string') after = q['start-after'];
    } else if (typeof q.marker === 'string') after = q.marker;
    const encodeUrl = q['encoding-type'] === 'url';
    const enc = (s) => (encodeUrl ? sigv4.awsEncode(s, true) : s);

    const scope = zones.objectScope(zone, req.appId);
    const ek = effectiveKeySql(zone);
    const named = zone.is_default ? '' : ' AND o.zone_id = ?';
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const page = (cursor, limit) => db.all(`SELECT * FROM (SELECT o.*, ${ek} AS s3_key FROM media_objects o WHERE ${scope.where}${named}
        AND o.lifecycle_status = 'ready') x WHERE x.s3_key > ? AND x.s3_key LIKE ? ESCAPE '\\' ORDER BY x.s3_key LIMIT ?`,
    [...scope.args, ...(zone.is_default ? [] : [zone.id]), cursor, like, limit]);
    // Keys come in byte order. A delimiter folds every key below a common prefix into that prefix, so the cursor jumps
    // past the whole prefix (its last possible key) once the prefix is listed. A marker that is a common prefix itself
    // (a v1 NextMarker) is skipped the same way.
    const SKIP = '\u{10FFFF}';
    let cursor = delimiter && after && after.endsWith(delimiter) ? `${after}${SKIP}` : after;
    const contents = [], prefixes = [];
    let truncated = false;
    const full = () => contents.length + prefixes.length >= maxKeys;
    for (let pass = 0; pass < 100 && !full(); pass++) {
        const rows = await page(cursor, MAX_LIST);
        for (const r of rows) {
            if (full()) break;
            if (prefixes.length && r.s3_key.startsWith(prefixes[prefixes.length - 1])) continue;
            const i = delimiter ? r.s3_key.indexOf(delimiter, prefix.length) : -1;
            if (i >= 0) {
                const cp = r.s3_key.slice(0, i + delimiter.length);
                prefixes.push(cp);
                cursor = `${cp}${SKIP}`;
            } else {
                contents.push(r);
                cursor = r.s3_key;
            }
        }
        if (rows.length < MAX_LIST) break;
    }
    if (full()) truncated = (await page(cursor, 1)).length > 0;
    const last = cursor;
    const items = contents.map((o) => `<Contents><Key>${esc(enc(o.s3_key))}</Key><LastModified>${isoOf(lastModified(o))}</LastModified>`
        + `<ETag>${esc(etagOf(o))}</ETag><Size>${Number(o.size_bytes) || 0}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('');
    const cps = prefixes.map((p) => `<CommonPrefixes><Prefix>${esc(enc(p))}</Prefix></CommonPrefixes>`).join('');
    const common = `<Name>${esc(zone.name)}</Name><Prefix>${esc(enc(prefix))}</Prefix>${delimiter ? `<Delimiter>${esc(enc(delimiter))}</Delimiter>` : ''}`
        + `<MaxKeys>${maxKeys}</MaxKeys>${encodeUrl ? '<EncodingType>url</EncodingType>' : ''}<IsTruncated>${truncated}</IsTruncated>`;
    if (v2) {
        const token = typeof q['continuation-token'] === 'string' ? `<ContinuationToken>${esc(q['continuation-token'])}</ContinuationToken>` : '';
        const next = truncated ? `<NextContinuationToken>${Buffer.from(last).toString('base64url')}</NextContinuationToken>` : '';
        const sa = typeof q['start-after'] === 'string' ? `<StartAfter>${esc(enc(q['start-after']))}</StartAfter>` : '';
        return xml(res, 200, `<ListBucketResult xmlns="${XMLNS}">${common}<KeyCount>${contents.length + prefixes.length}</KeyCount>${token}${next}${sa}${items}${cps}</ListBucketResult>`);
    }
    const marker = `<Marker>${esc(enc(after))}</Marker>`;
    const lastListed = prefixes.length && (!contents.length || prefixes[prefixes.length - 1] > contents[contents.length - 1].s3_key)
        ? prefixes[prefixes.length - 1] : (contents.length ? contents[contents.length - 1].s3_key : '');
    const nextMarker = truncated && delimiter ? `<NextMarker>${esc(enc(lastListed))}</NextMarker>` : '';
    return xml(res, 200, `<ListBucketResult xmlns="${XMLNS}">${common}${marker}${nextMarker}${items}${cps}</ListBucketResult>`);
}

async function listBuckets(req, res) {
    const { key } = req.s3;
    if (!mayRead(key)) return s3error(req, res, 'AccessDenied', 'This access key cannot read');
    const rows = (await zones.listActive(key.project_id, key.env)).filter((z) => !key.zones.length || key.zones.includes(z.id));
    const buckets = rows.map((z) => {
        const rec = model.parseJson(z.record, {});
        return `<Bucket><Name>${esc(z.name)}</Name><CreationDate>${esc(rec.created_at || new Date(Number(z.updated_at)).toISOString())}</CreationDate></Bucket>`;
    }).join('');
    xml(res, 200, `<ListAllMyBucketsResult xmlns="${XMLNS}"><Owner><ID>${esc(key.project_id)}</ID><DisplayName>${esc(key.project_id)}</DisplayName></Owner><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`);
}

/** POST /<zone>?delete: the keys of a <Delete> document, each through DeleteObject's path. */
async function deleteObjects(req, res, zone) {
    if (!mayWrite(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key is read-only');
    const chunks = [];
    let n = 0;
    try {
        const body = sigv4.isStreaming(req.s3.parsed) ? req.pipe(sigv4.chunkDecoder(req.s3.parsed)) : req;
        for await (const c of body) { n += c.length; if (n > 2 * 1024 * 1024) return s3error(req, res, 'MalformedXML', 'The delete request is too large'); chunks.push(c); }
    } catch (err) { return s3error(req, res, err.code && STATUS[err.code] ? err.code : 'IncompleteBody', err.message); }
    const raw = Buffer.concat(chunks);
    if (/^[0-9a-f]{64}$/.test(req.s3.parsed.payloadHash) && crypto.createHash('sha256').update(raw).digest('hex') !== req.s3.parsed.payloadHash) {
        return s3error(req, res, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed');
    }
    const text = raw.toString('utf8');
    const objectsXml = text.match(/<Object>[\s\S]*?<\/Object>/g) || [];
    if (!/<Delete[\s>]/.test(text) || objectsXml.length > MAX_LIST) return s3error(req, res, 'MalformedXML', 'The XML you provided was not well-formed or did not validate');
    const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(text);
    const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
    let out = '';
    for (const o of objectsXml) {
        const m = /<Key>([\s\S]*?)<\/Key>/.exec(o);
        const key = m ? unxml(m[1]) : '';
        if (!key || Buffer.byteLength(key) > MAX_KEY_BYTES) { out += `<Error><Key>${esc(key)}</Key><Code>InvalidArgument</Code><Message>Invalid key</Message></Error>`; continue; }
        const r = await deleteOne(req, zone, key);
        if (r.error) out += `<Error><Key>${esc(key)}</Key><Code>${r.error[0]}</Code><Message>${esc(r.error[1])}</Message></Error>`;
        else if (!quiet) out += `<Deleted><Key>${esc(key)}</Key></Deleted>`;
    }
    xml(res, 200, `<DeleteResult xmlns="${XMLNS}">${out}</DeleteResult>`);
}

// ── Dispatch ─────────────────────────────────────────────────

const router = express.Router();
router.use(authenticate);

router.use(async (req, res) => {
    try {
        const p = sigv4.signedPath(req);
        const slash = p.indexOf('/', 1);
        const bucket = decodeURIComponent(slash < 0 ? p.slice(1) : p.slice(1, slash));
        const rest = slash < 0 ? '' : p.slice(slash + 1);
        req.s3.hasKey = !!rest;
        usage.track(req, res);
        const q = req.query;
        if (!bucket) {
            if (req.method === 'GET') return await listBuckets(req, res);
            return s3error(req, res, 'MethodNotAllowed', 'The specified method is not allowed against this resource');
        }
        if (!rest) {
            if (req.method === 'PUT' && !Object.keys(q).length) {
                // CreateBucket: zones are made through OpenVibe.Zone; a client that probes with it gets its zone back.
                const z = await zones.byName(req.s3.key.project_id, req.s3.key.env, bucket);
                if (z && z.state === 'active' && (!req.s3.key.zones.length || req.s3.key.zones.includes(z.id))) { req.resume(); baseHeaders(res); return res.status(200).end(); }
                req.resume();
                return s3error(req, res, 'NotImplemented', 'Create zones in OpenVibe.Zone (https://openvibe.zone): a zone is a bucket');
            }
            const zone = await zoneFor(req, res, bucket);
            if (!zone) return;
            if (req.method === 'HEAD') { if (!mayRead(req.s3.key)) return s3error(req, res, 'AccessDenied', ''); baseHeaders(res); res.set('x-amz-bucket-region', 'us-east-1'); return res.status(200).end(); }
            if (req.method === 'GET' && q.location !== undefined) return xml(res, 200, `<LocationConstraint xmlns="${XMLNS}"/>`);
            if (req.method === 'POST' && q.delete !== undefined) return await deleteObjects(req, res, zone);
            if (req.method === 'GET' && q.uploads !== undefined) return await listUploads(req, res, zone);
            if (req.method === 'GET' && !['acl', 'policy', 'versioning', 'cors', 'lifecycle', 'tagging', 'versions', 'website', 'encryption', 'logging', 'notification', 'replication', 'object-lock', 'ownershipControls', 'publicAccessBlock', 'accelerate', 'requestPayment'].some((k) => q[k] !== undefined)) {
                if (!mayRead(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key cannot read');
                return await listObjects(req, res, zone, { v2: q['list-type'] === '2' });
            }
            req.resume();
            return s3error(req, res, 'NotImplemented', 'A header or query you provided implies functionality that is not implemented');
        }
        const key = keyOf(rest);
        if (key == null) { req.resume(); return s3error(req, res, 'KeyTooLongError', `Keys are 1 to ${MAX_KEY_BYTES} bytes`); }
        const zone = await zoneFor(req, res, bucket);
        if (!zone) { req.resume(); return; }
        if (req.method === 'POST' && q.uploads !== undefined) return await createMultipart(req, res, zone, key);
        if (q.uploadId !== undefined) {
            if (req.method === 'PUT' && q.partNumber !== undefined) return await uploadPart(req, res, zone, key);
            if (req.method === 'POST') return await completeMultipart(req, res, zone, key);
            if (req.method === 'DELETE') return await abortMultipart(req, res, zone, key);
            if (req.method === 'GET') return await listParts(req, res, zone, key);
        }
        if (q.partNumber !== undefined) {
            req.resume();
            return s3error(req, res, 'NotImplemented', 'Reading one part of a completed object is not supported; use a Range');
        }
        if (['acl', 'tagging', 'retention', 'legal-hold', 'torrent', 'restore', 'attributes', 'versionId'].some((k) => q[k] !== undefined)) {
            req.resume();
            return s3error(req, res, 'NotImplemented', 'A header or query you provided implies functionality that is not implemented');
        }
        if (req.method === 'PUT') return await putObject(req, res, zone, key);
        if (req.method === 'GET' || req.method === 'HEAD') {
            if (!mayRead(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key cannot read');
            const obj = await findObject(zone, req.appId, key);
            if (!obj) return s3error(req, res, 'NoSuchKey', 'The specified key does not exist.', `<Key>${esc(key)}</Key>`);
            return await sendObject(req, res, obj);
        }
        if (req.method === 'DELETE') {
            if (!mayWrite(req.s3.key)) return s3error(req, res, 'AccessDenied', 'This access key is read-only');
            const r = await deleteOne(req, zone, key);
            if (r.error) return s3error(req, res, r.error[0], r.error[1]);
            baseHeaders(res);
            return res.status(204).end();
        }
        req.resume();
        return s3error(req, res, 'MethodNotAllowed', 'The specified method is not allowed against this resource');
    } catch (err) {
        console.error('[S3] error:', err.message);
        if (!res.headersSent) return s3error(req, res, 'InternalError', 'We encountered an internal error. Please try again.');
        res.destroy();
    }
});

/** Is this request for the S3 surface? Its Host is one of MEDIA_S3_HOSTS (default s3.openvibe.media). */
function isS3Host(req) {
    const hosts = String(process.env.MEDIA_S3_HOSTS || 's3.openvibe.media').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return hosts.includes(host);
}

module.exports = router;
module.exports.isS3Host = isS3Host;
module.exports.parseRange = parseRange;
module.exports.DERIVED_KEY = DERIVED_KEY;
