'use strict';
// ═══════════════════════════════════════════════════════════════
// Avatar ingestion — every avatar on the network is a file HERE.
//
//   POST /internal/avatar-ingest   { url, user_id, username }        (internal key + loopback only)
//   → { ok, slug, url: 'https://openvibe.media/p/<slug>/screenshot', width, height, bytes }
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
// The result is stored as an unlisted "screenshot" paste owned by the account, so avatars live in the same
// system as every other picture (deletable, reportable, served with range/caching by the paste routes).
// ═══════════════════════════════════════════════════════════════
const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const MAX_BYTES = 8 * 1024 * 1024, DEADLINE_MS = 10_000, MAX_REDIRECTS = 3, SIZE = 512;

function isPublicAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;            // CGNAT
        if (a === 169 && b === 254) return false;                       // link-local / cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && (b === 168 || b === 0)) return false;
        if (a === 198 && (b === 18 || b === 19)) return false;
        return true;
    }
    if (net.isIPv6(ip)) {
        const x = ip.toLowerCase();
        if (x === '::' || x === '::1') return false;
        if (x.startsWith('::ffff:')) return isPublicAddress(x.slice(7));
        if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')) return false;   // unique-local, link-local, multicast
        if (x.startsWith('64:ff9b:') || x.startsWith('2001:db8:')) return false;
        return true;
    }
    return false;
}

async function resolvePublic(hostname) {
    if (net.isIP(hostname)) { if (!isPublicAddress(hostname)) throw new Error('That address is not on the public internet'); return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }; }
    const all = await dns.lookup(hostname, { all: true, verbatim: true });
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

function createIngestHandler({ db, config, screenshotsDir, generateSlug, log = console }) {
    return async function avatarIngest(req, res) {
        try {
            const { url, user_id, username } = req.body || {};
            if (!url || !user_id) return res.status(400).json({ ok: false, error: 'url and user_id required' });
            const raw = await safeFetchImage(url);
            const pic = await toAvatar(raw);
            fs.mkdirSync(screenshotsDir, { recursive: true });
            const file = path.join(screenshotsDir, `avatar-n${parseInt(user_id, 10) || 0}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`);
            fs.writeFileSync(file, pic.buffer);
            const slug = generateSlug();
            const info = db.run(`INSERT INTO pastes (app_id, slug, user_id, type, title, content, language, visibility, screenshot_path, metadata, ip_address)
                    VALUES ('network', ?, ?, 'screenshot', ?, '', 'text', 'unlisted', ?, ?, NULL)`,
                [slug, parseInt(user_id, 10) || null, `Avatar${username ? ' of ' + String(username).slice(0, 40) : ''}`, file,
                    JSON.stringify({ kind: 'avatar', source_host: (() => { try { return new URL(url).hostname; } catch { return null; } })(), size_bytes: pic.buffer.length, mime_type: 'image/webp' })]);
            if (info && typeof db.syncObject === 'function') db.syncObject('paste', info.lastInsertRowid);   // the avatar's media_object
            res.json({ ok: true, slug, url: `${config.publicUrl}/p/${slug}/screenshot`, width: pic.width, height: pic.height, bytes: pic.buffer.length });
        } catch (err) {
            log.warn('[Avatar ingest]', err.message);
            res.status(422).json({ ok: false, error: /unsupported image|Input buffer|corrupt|VipsJpeg|bad seek/i.test(err.message) ? 'That file is not a picture we can read' : err.message });
        }
    };
}

module.exports = { createIngestHandler, safeFetchImage, isPublicAddress, toAvatar, resolvePublic };
