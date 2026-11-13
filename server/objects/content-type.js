/**
 * OpenVibe.Media — content-type checks for v2 uploads (docs/object-model.md#content-types)
 *
 * 1. The declared type must suit the kind: vod -> video/* or audio/*, clip -> video/*, thumbnail /
 *    screenshot / avatar -> image/* (not SVG). file and asset take any well-formed type.
 * 2. Bytes that /o/:id serves inline (image/* except SVG, video/*, audio/*, application/pdf) must look like
 *    what their type says: the first bytes are checked against the container signatures below at
 *    complete. A kind with a rule is always checked. An SVG is served as an attachment (routes.js INLINE).
 * Anything else is served as an attachment with nosniff, so its declared type is taken as given.
 */
'use strict';

const fs = require('fs');

const TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/;
const KIND_RULES = {
    vod: { re: /^(video|audio)\//, what: 'video/* or audio/*' },
    clip: { re: /^video\//, what: 'video/*' },
    thumbnail: { re: /^image\/(?!svg)/, what: 'image/* (not SVG)' },
    screenshot: { re: /^image\/(?!svg)/, what: 'image/* (not SVG)' },
    avatar: { re: /^image\/(?!svg)/, what: 'image/* (not SVG)' },
};

function normalize(type) {
    const t = String(type || '').split(';')[0].trim().toLowerCase();
    return TYPE_RE.test(t) ? t : null;
}

/** null when `type` suits `kind`, else the reason. */
function kindProblem(kind, type) {
    const rule = KIND_RULES[kind];
    if (!rule) return null;
    if (!type) return `a ${kind} needs a content type (${rule.what})`;
    return rule.re.test(type) ? null : `a ${kind} must be ${rule.what}, not ${type}`;
}

/**
 * What the first bytes are: { family: 'image' | 'video' | 'av' | 'audio' | 'pdf', format } or null.
 * 'av' = a container that holds video, audio or both (Matroska/WebM, MP4/MOV, Ogg).
 *
 * The video containers it knows, each with the name a browser knows it by: mp4 (isom and friends), mov
 * (QuickTime), m4v, 3gp, 3g2, matroska (MKV), webm, avi, asf (WMV), flv, mpegts (MTS/M2TS), mpegps, ogg (OGV).
 */
function sniff(head) {
    const b = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
    const at = (i, s) => b.length >= i + s.length && b.subarray(i, i + s.length).toString('latin1') === s;
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { family: 'image', format: 'jpeg' };
    if (at(0, '\x89PNG\r\n\x1a\n')) return { family: 'image', format: 'png' };
    if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { family: 'image', format: 'gif' };
    if (at(0, 'RIFF') && at(8, 'WEBP')) return { family: 'image', format: 'webp' };
    if (at(0, 'BM')) return { family: 'image', format: 'bmp' };
    if (at(4, 'ftyp')) {
        const brand = b.subarray(8, 12).toString('latin1');
        if (/^(avif|avis|heic|heix|mif1|msf1)$/.test(brand)) return { family: 'image', format: brand };
        if (/^M4A |^M4B /.test(brand)) return { family: 'audio', format: 'm4a' };
        // The ISO base media brands: QuickTime (qt  ), M4V, 3GP and 3G2 are MP4 containers too, but they
        // are not the same thing to a browser (an HEVC MOV plays nowhere), so each keeps its own name.
        if (/^qt/.test(brand)) return { family: 'av', format: 'mov' };
        if (/^M4V/.test(brand)) return { family: 'av', format: 'm4v' };
        if (/^3gp/.test(brand)) return { family: 'av', format: '3gp' };
        if (/^3g2/.test(brand)) return { family: 'av', format: '3g2' };
        return { family: 'av', format: 'mp4' };
    }
    // Matroska and WebM share the EBML header; the DocType inside it says which one this is.
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
        const top = b.subarray(0, 64).toString('latin1');
        return { family: 'av', format: top.indexOf('webm') >= 0 ? 'webm' : 'matroska' };
    }
    if (at(0, 'OggS')) return { family: 'av', format: 'ogg' };
    if (at(0, 'RIFF') && at(8, 'AVI ')) return { family: 'video', format: 'avi' };
    if (at(0, 'RIFF') && at(8, 'WAVE')) return { family: 'audio', format: 'wav' };
    if (at(0, 'fLaC')) return { family: 'audio', format: 'flac' };
    if (at(0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { family: 'audio', format: 'mp3' };
    if (at(0, 'FLV')) return { family: 'video', format: 'flv' };
    if (b.length >= 16 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { family: 'video', format: 'asf' };
    if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0xba) return { family: 'video', format: 'mpegps' };
    if (b.length >= 4 && b[0] === 0x47 && b.length >= 189 && b[188] === 0x47) return { family: 'video', format: 'mpegts' };
    if (at(0, '%PDF-')) return { family: 'pdf', format: 'pdf' };
    return null;
}

/**
 * The container a file's bytes name, as one word: mp4, mov, webm, matroska, avi, asf, flv, 3gp, 3g2, m4v,
 * mpegts, mpegps, ogg, jpeg, png… (the formats sniff() knows). Null when the bytes are not one.
 */
function container(head) {
    const got = sniff(head);
    return got ? got.format : null;
}

/**
 * Is `type` served inline (so its bytes must match it)? An SVG is served as an attachment on this origin (it is
 * never inline, INLINE in routes.js), so its text bytes are taken as given, like any other downloaded file.
 */
function servedInline(type) {
    const t = String(type || '').toLowerCase();
    return /^(image\/(?!svg)|video\/|audio\/)/.test(t) || t === 'application/pdf';
}

/** null when the bytes fit the declared type (or need no check), else the reason. */
function contentProblem(kind, type, head) {
    if (!KIND_RULES[kind] && !servedInline(type)) return null;
    const family = String(type || '').split('/')[0];
    const want = type === 'application/pdf' ? 'pdf' : family;
    const got = sniff(head);
    if (!got) return `the bytes are not a recognised ${want} format`;
    const ok = got.family === want || (got.family === 'av' && (want === 'video' || want === 'audio'));
    return ok ? null : `the bytes are ${got.format} (${got.family}), not ${type}`;
}

function readHead(file, n = 512) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(n);
        const got = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, got);
    } finally { fs.closeSync(fd); }
}

module.exports = { normalize, kindProblem, sniff, container, servedInline, contentProblem, readHead, KIND_RULES };
