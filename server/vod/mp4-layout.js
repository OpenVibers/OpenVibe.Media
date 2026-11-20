'use strict';
/**
 * An MP4's top-level layout (2026-11-20): its first few box headers, read from a local file or a presigned https URL
 * with a few 16-byte reads, never the whole file.
 *
 * Why it matters: a recording left fragmented (ftyp, a small moov, then thousands of moof+mdat pairs and no index)
 * plays from a URL only after the browser walked every fragment to learn its duration: 40 s for a 370 MB recording on
 * a fast line, minutes for several GB. 54 public recordings of 11-14 to 11-17 were served like that (their edge copies
 * were the recording as written; the finalize remux had made the local one faststart).
 *
 *   layoutOf({ filePath } | { url }) → { ok, kinds: ['ftyp', 'moov', …], fragmented, moovFirst, error? }
 *   fragmented: a moof among the top-level boxes; moovFirst: the moov before any mdat or moof.
 */
const fs = require('fs');
const https = require('https');

const MAX_BOXES = 4;
const TIMEOUT_MS = 15000;

/** n bytes at offset from a local file. */
async function readFileAt(filePath, offset, n) {
    const fh = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, offset);
        return buf.subarray(0, bytesRead);
    } finally { await fh.close(); }
}

/** n bytes at offset from an https URL (a Range request; a server that ignores Range is read for n bytes and cut). */
function readUrlAt(url, offset, n) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch { return reject(new Error('not a URL')); }
        if (u.protocol !== 'https:') return reject(new Error('https only'));
        const req = https.get(u, { headers: { Range: `bytes=${offset}-${offset + n - 1}` }, timeout: TIMEOUT_MS }, (res) => {
            if (res.statusCode === 416) { res.resume(); return resolve(Buffer.alloc(0)); }
            if (res.statusCode !== 206 && res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }
            const parts = []; let got = 0;
            res.on('data', (c) => {
                parts.push(c); got += c.length;
                if (got >= n) { req.destroy(); resolve(Buffer.concat(parts).subarray(0, n)); }
            });
            res.on('end', () => resolve(Buffer.concat(parts).subarray(0, n)));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', (e) => { if (e && e.message !== 'aborted') reject(e); });
    });
}

/** The first top-level boxes of an MP4 at a local path or an https URL. */
async function layoutOf({ filePath = null, url = null } = {}) {
    const read = filePath ? (o, n) => readFileAt(filePath, o, n) : url ? (o, n) => readUrlAt(url, o, n) : null;
    if (!read) return { ok: false, kinds: [], fragmented: false, moovFirst: false, error: 'no source' };
    const kinds = [];
    let offset = 0;
    try {
        for (let i = 0; i < MAX_BOXES; i++) {
            const head = await read(offset, 16);
            if (head.length < 8) break;
            let size = head.readUInt32BE(0);
            const kind = head.toString('latin1', 4, 8);
            if (!/^[a-z0-9 ]{4}$/i.test(kind)) break;          // not a box (a WebM's EBML header, garbage)
            if (size === 1) {
                if (head.length < 16) break;
                size = Number(head.readBigUInt64BE(8));
            }
            kinds.push(kind);
            if (kind === 'mdat' || kind === 'moof' || size === 0 || size < 8) break;   // past the index: enough to say
            offset += size;
        }
    } catch (e) {
        return { ok: false, kinds, fragmented: false, moovFirst: false, error: String((e && e.message) || e).slice(0, 120) };
    }
    if (kinds[0] !== 'ftyp') return { ok: false, kinds, fragmented: false, moovFirst: false, error: 'not an MP4' };
    const moov = kinds.indexOf('moov');
    const media = kinds.findIndex((k) => k === 'mdat' || k === 'moof');
    return { ok: true, kinds, fragmented: kinds.includes('moof'), moovFirst: moov >= 0 && (media < 0 || moov < media) };
}

module.exports = { layoutOf, readFileAt, readUrlAt, MAX_BOXES };
