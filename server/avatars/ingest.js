'use strict';
// ═══════════════════════════════════════════════════════════════
// Avatar ingestion — every avatar on the network is a file HERE.
//
//   POST /internal/avatar-ingest   { url, user_id, username, subject }   (internal key + loopback only)
//   → { ok, object_id, url: 'https://openvibe.media/o/<id>', width, height, bytes }
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

const MAX_BYTES = 8 * 1024 * 1024, DEADLINE_MS = 10_000, MAX_REDIRECTS = 3, SIZE = 512;

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

function fetchOnce(u, pinned, deadline) {
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
            if (Number(res.headers['content-length']) > MAX_BYTES) { res.destroy(); return reject(new Error('That picture is too large (8 MB at most)')); }
            const chunks = []; let n = 0;
            res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) { res.destroy(); reject(new Error('That picture is too large (8 MB at most)')); } else chunks.push(c); });
            res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('The picture took too long to load')));
        req.on('error', reject);
    });
}

async function safeFetchImage(rawUrl, { resolver = resolvePublic, fetcher = fetchOnce } = {}) {
    const deadline = Date.now() + DEADLINE_MS;
    let url = String(rawUrl || '');
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let u; try { u = new URL(url); } catch { throw new Error('That is not a web address'); }
        if (u.protocol !== 'https:') throw new Error('Use an https address');
        if (u.username || u.password) throw new Error('Addresses with a username or password are not accepted');
        if (u.port && u.port !== '443') throw new Error('Only the standard https port is accepted');
        const pinned = await resolver(u.hostname);
        const r = await fetcher(u, pinned, deadline);
        if (r.body) return r.body;
        url = new URL(r.redirect, u).toString();
    }
    throw new Error('Too many redirects');
}

/** Bytes → a clean square WebP. Throws when the bytes are not a decodable picture. */
async function toAvatar(buf) {
    const img = sharp(buf, { limitInputPixels: 40_000_000, failOn: 'error', animated: false });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16) throw new Error('That picture is too small');
    const out = await img.rotate().resize(SIZE, SIZE, { fit: 'cover', position: 'attention' }).webp({ quality: 88 }).toBuffer();
    return { buffer: out, width: SIZE, height: SIZE };
}

/**
 * Store one avatar's bytes as a native object; returns its id. Throws (with nothing left behind) when the tenant,
 * the namespace or the quota refuses it.
 */
async function storeAvatar({ db, pic, subject = null, username = null, sourceHost = null }) {
    const model = require('../objects/model');
    const namespaces = require('../objects/namespaces');
    const invariant = require('../objects/invariant');
    const { announce } = require('../webhooks');
    const app = await db.getApp(AVATAR_APP);
    if (!app) throw new Error('Picture storage is not configured on this server');
    const { namespace } = namespaces.resolveName(app, AVATAR_NAMESPACE);
    const bytes = pic.buffer.length;
    const sha256 = crypto.createHash('sha256').update(pic.buffer).digest('hex');
    // The namespace row, the quota check and the object commit together, as an API upload's init does.
    const made = await db.getDb().tx(async () => {
        const row = await namespaces.ensure(app, namespace);
        if (row.error) return { error: row.error };
        const q = await namespaces.checkQuota(app, namespace, { bytes, objects: 1 });
        if (q) return { error: q.detail || 'Picture storage is full' };
        return {
            id: await model.createObject({
                app_id: AVATAR_APP, namespace, kind: 'avatar', owner_subject: SUBJECT_RE.test(String(subject || '')) ? subject : null,
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
    return obj.id;
}

function createIngestHandler({ db, config, log = console }) {
    return async function avatarIngest(req, res) {
        try {
            const { url, user_id, username, subject } = req.body || {};
            if (!url || !user_id) return res.status(400).json({ ok: false, error: 'url and user_id required' });
            const raw = await safeFetchImage(url);
            const pic = await toAvatar(raw);
            const sourceHost = (() => { try { return new URL(url).hostname; } catch { return null; } })();
            const id = await storeAvatar({ db, pic, subject, username, sourceHost });
            res.json({ ok: true, object_id: id, url: `${config.publicUrl}/o/${id}`, width: pic.width, height: pic.height, bytes: pic.buffer.length });
        } catch (err) {
            log.warn('[Avatar ingest]', err.message);
            res.status(422).json({ ok: false, error: /unsupported image|Input buffer|corrupt|VipsJpeg|bad seek/i.test(err.message) ? 'That file is not a picture we can read' : err.message });
        }
    };
}

module.exports = { createIngestHandler, storeAvatar, safeFetchImage, isPublicAddress, toAvatar, resolvePublic };
