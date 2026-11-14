'use strict';
// ═══════════════════════════════════════════════════════════════
// Avatar ingestion — every avatar on the network is a file HERE.
//
//   POST /internal/avatar-ingest   { url, user_id, username, subject, product?, ref?, shape? }   (service token + loopback only)
//   → { ok, object_id, url: 'https://openvibe.media/o/<id>', width, height, bytes, reused? }
//
// Every source becomes an avatar object the person owns, so a profile never points at another product's object:
//   • an openvibe.media address for an object or paste screenshot is read from local storage (no self-fetch)
//   • an object that is already an avatar owned by this subject is reused, not copied again
//   • anything else is fetched with the precautions below
// With `product` + `ref` the profile's reference is recorded (model.adoptAvatar), which is what makes the delete
// guard (model.softDelete) refuse a cleanup that would break a working profile. `shape: 'banner'` keeps a wide crop.
//
// A person may point at a picture anywhere on the web; no OpenVibe site ever serves or stores that address.
// We fetch it once, on the server, with the precautions a server-side fetch of a user-supplied URL needs:
//   • https only, no credentials in the URL, at most 3 redirects, each hop checked again
//   • the hostname is resolved first and refused if ANY address is private, loopback, link-local, CGNAT,
//     multicast or otherwise not public; the connection is then pinned to the address we checked, so a
//     DNS answer that changes between check and connect (rebinding) cannot reach an internal service
//   • 8 MB cap while streaming, 10 s overall deadline
//   • the bytes are decoded by sharp and re-encoded (512×512 WebP): metadata, scripts hidden in image
//     containers and non-image payloads do not survive; a pixel-count limit stops decompression bombs
// The result is a native media object (kind avatar, unlisted) in Live's `<root>.avatars` namespace, owned by the
// account's subject when Network sends it, created the way an Object API upload is: the namespace and quota are
// checked with the object, and the ready transition, its invariant row and media.object.uploaded commit together.
// /o/<id> serves it with range and caching. (Until 2026-10-10 an avatar was a row in the legacy pastes table.)
// ═══════════════════════════════════════════════════════════════
const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { applyExifOrientation } = require('../images/orientation');

const MAX_BYTES = 8 * 1024 * 1024, DEADLINE_MS = 10_000, MAX_REDIRECTS = 3, SIZE = 512;
let _testResolver = null;      // tests: the address check (null is the real one)
let _testFetcher = null;       // tests: the fetch (null is the real one)
// The house shapes: a square picture everywhere a person appears; a wide one for a channel banner.
const SHAPES = { avatar: { width: SIZE, height: SIZE }, banner: { width: 1600, height: 500 } };
const PRODUCT_RE = /^[a-z][a-z0-9-]{1,20}$/;

// The address rule is openvibe-shared/egress's (the strictest union the network's copies drifted from):
// it also refuses the IPv6 forms that wrap a private IPv4 address (v4-compatible, 6to4, Teredo, NAT64),
// site-local and documentation ranges. IPv6 literals ([::1]) are judged as addresses, not sent to DNS.
const egress = require('openvibe-shared/egress');
const isPublicAddress = (ip) => egress.isPublicAddress(ip);

// The tenant every avatar has lived in (Media has no tenant of Network's own) and the namespace below its root.
const AVATAR_APP = 'live';
const AVATAR_NAMESPACE = 'avatars';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

async function resolvePublic(hostname) {
    const host = egress.normalizeHost(hostname);
    if (net.isIP(host)) { if (!isPublicAddress(host)) throw new Error('That address is not on the public internet'); return { address: host, family: net.isIPv6(host) ? 6 : 4 }; }
    if (egress.isInternalName(host)) throw new Error('That address is not on the public internet');
    const all = await dns.lookup(host, { all: true, verbatim: true });
    if (!all.length) throw new Error('That host could not be found');
    if (!all.every(a => isPublicAddress(a.address))) throw new Error('That address is not on the public internet');
    return all.find(a => a.family === 4) || all[0];
}

function fetchOnce(u, pinned, deadline, cap = MAX_BYTES) {
    return new Promise((resolve, reject) => {
        const req = https.get({
            host: u.hostname, servername: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
            headers: { 'User-Agent': 'OpenVibeMedia/1.0 (+https://openvibe.media; avatar fetch)', Accept: 'image/*' },
            // Connect to the address we checked, nothing else. Newer Node asks for a list (options.all) when it races
            // address families; older Node wants the single-address form.
            lookup: (_h, o, cb) => ((o && o.all) ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
            timeout: Math.max(1000, deadline - Date.now()),
        }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
            if (status !== 200) { res.resume(); return reject(new Error(`The picture could not be loaded (HTTP ${status})`)); }
            if (!/^image\//i.test(String(res.headers['content-type'] || ''))) { res.resume(); return reject(new Error('That link is not a picture')); }
            if (Number(res.headers['content-length']) > cap) { res.destroy(); return reject(new Error(`That picture is too large (${Math.round(cap / (1024 * 1024))} MB at most)`)); }
            const chunks = []; let n = 0;
            res.on('data', (c) => { n += c.length; if (n > cap) { res.destroy(); reject(new Error(`That picture is too large (${Math.round(cap / (1024 * 1024))} MB at most)`)); } else chunks.push(c); });
            res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('The picture took too long to load')));
        req.on('error', reject);
    });
}

async function safeFetchImage(rawUrl, { resolver: givenResolver, fetcher: givenFetcher, maxBytes = MAX_BYTES } = {}) {
    // The tests replace the address check and the fetch (below); the real ones are the defaults.
    const resolver = _testResolver || givenResolver || resolvePublic;
    const fetcher = _testFetcher || givenFetcher || fetchOnce;
    const deadline = Date.now() + DEADLINE_MS;
    let url = String(rawUrl || '');
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let u; try { u = new URL(url); } catch { throw new Error('That is not a web address'); }
        if (u.protocol !== 'https:') throw new Error('Use an https address');
        if (u.username || u.password) throw new Error('Addresses with a username or password are not accepted');
        if (u.port && u.port !== '443') throw new Error('Only the standard https port is accepted');
        const pinned = await resolver(u.hostname);
        const r = await fetcher(u, pinned, deadline, maxBytes);
        if (r.body) {
            // The cap is checked on the bytes as well: whatever the fetch did, an oversized picture is refused.
            if (r.body.length > maxBytes) throw new Error(`That picture is too large (${Math.round(maxBytes / (1024 * 1024))} MB at most)`);
            return r.body;
        }
        url = new URL(r.redirect, u).toString();
    }
    throw new Error('Too many redirects');
}

/** Bytes → a clean WebP in the requested house shape. Throws when the bytes are not a decodable picture. */
async function toAvatar(buf, { shape = 'avatar' } = {}) {
    const size = SHAPES[shape] || SHAPES.avatar;
    const img = sharp(buf, { limitInputPixels: 40_000_000, failOn: 'error', animated: false });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) throw new Error('That picture is too small');
    const out = await applyExifOrientation(img).resize(size.width, size.height, { fit: 'cover', position: 'attention' }).webp({ quality: 88 }).toBuffer();
    return { buffer: out, width: size.width, height: size.height, shape };
}

/** The bytes of one of our own objects, from its local copy. null when there is none (a remote-only object). */
async function localBytes(obj) {
    if (!obj) return null;
    const model = require('../objects/model');
    const locs = await model.listLocations(obj.id);
    for (const l of locs) {
        if (l.provider !== 'local' || !l.key) continue;
        try { return fs.readFileSync(l.key); } catch { /* moved to a remote tier */ }
    }
    return null;
}

/**
 * What a source URL names on this server, if anything: `{ obj }` for an object, `{ buffer }` when its bytes are
 * local, or null to fetch it over the network. Options: `{ subject }` (the person the picture is for), `{ fetch }`.
 * A source that is already this person's avatar object is returned as `{ obj, reuse: true }` so it is not copied
 * again on every profile save.
 */
async function readLocalSource(rawUrl, { subject = null } = {}) {
    const model = require('../objects/model');
    let u; try { u = new URL(String(rawUrl || '')); } catch { return null; }
    if (u.hostname !== new URL(require('../config').publicUrl).hostname) return null;
    let obj = null;
    const m = /^\/o\/(med_[0-9A-HJKMNP-TV-Z]{26})$/.exec(u.pathname);
    if (m) obj = await model.getObject(m[1]);
    else {
        const p = /^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{1,80})\/screenshot\/?$/.exec(u.pathname);
        if (p) obj = await model.getObjectByLegacyRef(model.legacyRef('live', 'paste', p[1])) || await model.getObjectByLegacyRef(model.legacyRef('live', 'avatar', p[1]));
        const f = /^\/f\/(.+)$/.exec(u.pathname);
        if (f) {
            const row = await require('../db/database').get('SELECT object_id FROM files WHERE key = ?', [decodeURIComponent(f[1])]);
            if (row && row.object_id) obj = await model.getObject(row.object_id);
        }
    }
    if (!obj || obj.lifecycle_status !== 'ready') return null;
    // A private picture is copied only for the person it belongs to (their profile is already showing it); for
    // anyone else the remote path is tried and the private object refuses, so a copy never publishes it.
    if (obj.visibility === 'private' && obj.owner_subject !== subject) return null;
    if (obj.kind === 'avatar' && subject && obj.owner_subject === subject) return { obj, reuse: true };
    const buffer = await localBytes(obj);
    return buffer ? { obj, buffer } : null;
}

/**
 * Store one avatar's bytes as a native object; returns its id. Throws (with nothing left behind) when the tenant,
 * the namespace or the quota refuses it.
 */
async function storeAvatar({ db, pic, subject = null, username = null, sourceHost = null, userId = null, keepBoth = false }) {
    const model = require('../objects/model');
    const namespaces = require('../objects/namespaces');
    const invariant = require('../objects/invariant');
    const { announce } = require('../announce');
    const app = await db.getApp(AVATAR_APP);
    if (!app) throw new Error('Picture storage is not configured on this server');
    const { namespace } = namespaces.resolveName(app, AVATAR_NAMESPACE);
    const bytes = pic.buffer.length;
    const sha256 = crypto.createHash('sha256').update(pic.buffer).digest('hex');
    if (!keepBoth && (SUBJECT_RE.test(String(subject || '')) || userId != null)) {
        const owner = [];
        const params = [AVATAR_APP, sha256];
        if (SUBJECT_RE.test(String(subject || ''))) { owner.push('owner_subject = ?'); params.push(subject); }
        if (userId != null) { owner.push('owner_user_id = ?'); params.push(Number(userId)); }
        const existing = await db.get(`SELECT id FROM media_objects WHERE app_id = ? AND kind = 'avatar' AND content_hash = ?
            AND lifecycle_status = 'ready' AND (${owner.join(' OR ')}) ORDER BY created_at DESC LIMIT 1`, params);
        if (existing) return { id: existing.id, duplicate: true };
    }
    // The namespace row, the quota check and the object commit together, as an API upload's init does.
    const made = await db.getDb().tx(async () => {
        const row = await namespaces.ensure(app, namespace);
        if (row.error) return { error: row.error };
        const q = await namespaces.checkQuota(app, namespace, { bytes, objects: 1 });
        if (q) return { error: q.detail || 'Picture storage is full' };
        return {
            id: await model.createObject({
                app_id: AVATAR_APP, namespace, kind: 'avatar', owner_subject: SUBJECT_RE.test(String(subject || '')) ? subject : null,
                // The app-local owner too: the avatar card (thumbnails/audio-card.js) finds an audio-only streamer's
                // picture by the same Live user id its VOD carries, without a Network round trip on a thumbnail request.
                owner_app: userId != null ? AVATAR_APP : null, owner_user_id: userId != null ? Number(userId) : null,
                visibility: 'unlisted', lifecycle_status: 'uploading', mime_type: 'image/webp', size_bytes: bytes, content_hash: sha256,
                metadata: { filename: 'avatar.webp', title: `Avatar${username ? ' of ' + String(username).slice(0, 40) : ''}`, source: 'avatar.ingest', source_host: sourceHost },
            }),
        };
    });
    if (made.error) throw new Error(made.error);
    const obj = await model.getObject(made.id);
    const dest = model.objectFilePath(obj);
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, pic.buffer);
        await announce(AVATAR_APP, 'media.object.uploaded', {
            change: async () => {
                await model.upsertLocation(obj.id, { provider: 'local', key: dest, state: 'present', size_bytes: bytes, checksum: sha256, verified: true });
                await model.updateObject(obj.id, { lifecycle_status: 'ready', canonical_provider: 'local', canonical_key: dest });
                await invariant.record(await model.getObject(obj.id));
            },
            payload: async () => await model.objectPublic(await model.getObject(obj.id)),
        });
    } catch (err) {
        try { fs.unlinkSync(dest); } catch { /* not written */ }
        await db.run('DELETE FROM media_objects WHERE id = ?', [obj.id]).catch(() => {});
        throw err;
    }
    await namespaces.reconcileChain(app, namespace).catch(() => {});
    return { id: obj.id, duplicate: false };
}

function createIngestHandler({ db, config, log = console }) {
    return async function avatarIngest(req, res) {
        try {
            const { url, user_id, username, subject, product = null, ref = null, shape = 'avatar' } = req.body || {};
            if (!url || !user_id) return res.status(400).json({ ok: false, error: 'url and user_id required' });
            if (!SHAPES[shape]) return res.status(400).json({ ok: false, error: 'shape must be avatar or banner' });
            if (product && (!PRODUCT_RE.test(String(product)) || ref == null || String(ref).length > 64)) {
                return res.status(400).json({ ok: false, error: 'product and ref must name the profile slot' });
            }
            const model = require('../objects/model');
            const adopt = async (objectId) => {
                if (!product) return;
                await model.adoptAvatar({ objectId, subject: SUBJECT_RE.test(String(subject || '')) ? subject : null, product: String(product), ref: String(ref) });
            };
            // Our own object: the bytes are here, and a picture that is already this person's avatar is reused as it is.
            const local = await readLocalSource(url, { subject });
            if (local && local.reuse) {
                await adopt(local.obj.id);
                return res.json({ ok: true, object_id: local.obj.id, url: `${config.publicUrl}/o/${local.obj.id}`,
                    width: null, height: null, bytes: Number(local.obj.size_bytes) || 0, reused: true });
            }
            const raw = local && local.buffer ? local.buffer : await safeFetchImage(url);
            const pic = await toAvatar(raw, { shape });
            const sourceHost = (() => { try { return new URL(url).hostname; } catch { return null; } })();
            const stored = await storeAvatar({ db, pic, subject, username, sourceHost });
            const id = stored.id;
            await adopt(id);
            res.json({ ok: true, object_id: id, duplicate: stored.duplicate, url: `${config.publicUrl}/o/${id}`, width: pic.width, height: pic.height, bytes: pic.buffer.length });
        } catch (err) {
            log.warn('[Avatar ingest]', err.message);
            res.status(422).json({ ok: false, error: /unsupported image|Input buffer|corrupt|VipsJpeg|bad seek/i.test(err.message) ? 'That file is not a picture we can read' : err.message });
        }
    };
}

/** Record that a profile slot points at an avatar object (a route of last resort: ingest does this itself). */
function createAdoptHandler({ log = console } = {}) {
    return async function avatarAdopt(req, res) {
        try {
            const { object_id, subject = null, product, ref } = req.body || {};
            if (!object_id || !product || ref == null) return res.status(400).json({ ok: false, error: 'object_id, product and ref are required' });
            if (!PRODUCT_RE.test(String(product)) || String(ref).length > 64) return res.status(400).json({ ok: false, error: 'bad product or ref' });
            const model = require('../objects/model');
            const obj = await model.resolveObject(String(object_id));
            if (!obj) return res.status(404).json({ ok: false, error: 'No such object' });
            if (obj.kind !== 'avatar') return res.status(422).json({ ok: false, error: 'Only an avatar object can be a profile picture' });
            if (obj.lifecycle_status !== 'ready') return res.status(409).json({ ok: false, error: `Object is ${obj.lifecycle_status}` });
            if (subject && obj.owner_subject && subject !== obj.owner_subject) return res.status(422).json({ ok: false, error: 'That object belongs to someone else' });
            const row = await model.adoptAvatar({ objectId: obj.id, subject: subject || obj.owner_subject || null, product: String(product), ref: String(ref) });
            res.json({ ok: true, ref: row });
        } catch (err) {
            log.warn('[Avatar adopt]', err.message);
            res.status(500).json({ ok: false, error: 'Could not record the reference' });
        }
    };
}

/** Drop a profile slot's reference (the picture was removed) or one object's references. */
function createReleaseHandler({ log = console } = {}) {
    return async function avatarRelease(req, res) {
        try {
            const { object_id = null, product = null, ref = null, subject = null } = req.body || {};
            if (!object_id && !(product && ref != null) && !subject) return res.status(400).json({ ok: false, error: 'object_id, product+ref or subject required' });
            const model = require('../objects/model');
            const released = await model.releaseAvatar({ objectId: object_id, product, ref, subject });
            res.json({ ok: true, released });
        } catch (err) {
            log.warn('[Avatar release]', err.message);
            res.status(500).json({ ok: false, error: 'Could not release the reference' });
        }
    };
}

module.exports = { createIngestHandler, createAdoptHandler, createReleaseHandler, storeAvatar, safeFetchImage, readLocalSource, toAvatar, resolvePublic, isPublicAddress, SHAPES,
    _setResolver(fn) { _testResolver = fn || null; }, _setFetcher(fn) { _testFetcher = fn || null; } };
