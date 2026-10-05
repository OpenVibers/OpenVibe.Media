/**
 * OpenVibe.Media — codecs and resolution from an init segment (docs/media-fabric.md §5, F4).
 *
 * The master playlist names each variant's RESOLUTION and CODECS, but serving it must not read segment bytes: at
 * publish time (server/jobs/segments.js) this pure parser reads the init.mp4 a cut just wrote and the answer is stored
 * in the object's metadata under renditions.<name> = { width, height, codecs }. parseInit never throws — an unreadable
 * box answers nulls and the variant is listed without the attributes, as every pre-F4 object already is.
 *
 * Recognised tracks: video avc1 → `avc1.<profile><compat><level>` from its avcC box (width/height from the sample entry,
 * else tkhd); audio mp4a → `mp4a.40.<audioObjectType>` from the esds DecoderSpecificInfo (AAC-LC is `mp4a.40.2`); an
 * `Opus` sample entry → `opus`. One track whose codec is anything else makes `codecs` null: a partial CODECS is worse
 * than none, and a client falls back to probing. width/height stay known even then.
 */
'use strict';

/** The child boxes of [start, end), header included: { type, start, content, end }. A malformed run ends the walk. */
function boxes(buf, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
        let size = buf.readUInt32BE(p);
        const type = buf.toString('latin1', p + 4, p + 8);
        let header = 8;
        if (size === 1) { if (p + 16 > end) break; size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
        else if (size === 0) size = end - p;
        if (size < header || p + size > end) break;
        out.push({ type, start: p, content: p + header, end: p + size });
        p += size;
    }
    return out;
}

/** The first child of `parent` (a box, or { content, end } for a raw range) named one of `types`. */
function child(buf, parent, ...types) {
    for (const b of boxes(buf, parent.content, parent.end)) if (types.includes(b.type)) return b;
    return null;
}

/** avc1 width/height from the VisualSampleEntry body, or null. */
function entrySize(buf, entry) {
    if (entry.content + 28 > entry.end) return null;
    const w = buf.readUInt16BE(entry.content + 24);
    const h = buf.readUInt16BE(entry.content + 26);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** The 16.16 fixed width/height of a trak's tkhd, or null (the fallback when the sample entry gave none). */
function tkhdSize(buf, trak) {
    const tkhd = child(buf, trak, 'tkhd');
    if (!tkhd || tkhd.content >= tkhd.end) return null;
    const base = (buf[tkhd.content] === 1 ? tkhd.content + 88 : tkhd.content + 76);
    if (base + 8 > tkhd.end) return null;
    const w = buf.readUInt32BE(base) / 65536;
    const h = buf.readUInt32BE(base + 4) / 65536;
    return w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : null;
}

/** `avc1.<profile><compat><level>` from an avc1 sample entry's avcC box, or null. */
function avcCodec(buf, entry) {
    const avcC = child(buf, { content: entry.content + 78, end: entry.end }, 'avcC');
    if (!avcC || avcC.content + 4 > avcC.end) return null;
    const hex = (n) => n.toString(16).padStart(2, '0');
    return `avc1.${hex(buf[avcC.content + 1])}${hex(buf[avcC.content + 2])}${hex(buf[avcC.content + 3])}`;
}

/** The descriptors in [start, end): { tag, payload, end }. A truncated length ends the walk. */
function descriptors(buf, start, end) {
    const out = [];
    let p = start;
    while (p + 2 <= end) {
        const tag = buf[p];
        let size = 0;
        let q = p + 1;
        let n = 0;
        while (q < end && n < 4) { const b = buf[q++]; size = (size << 7) | (b & 0x7f); n++; if (!(b & 0x80)) break; }
        if (size <= 0 || q + size > end) break;
        out.push({ tag, payload: q, end: q + size });
        p = q + size;
    }
    return out;
}

/** The first descriptor with `tag`, descending into the ES (0x03) and DecoderConfig (0x04) descriptors that nest. */
function findDescriptor(buf, start, end, tag) {
    for (const d of descriptors(buf, start, end)) {
        if (d.tag === tag) return d;
        if (d.tag === 0x03 || d.tag === 0x04) {
            // ES_Descriptor payload: ES_ID(2)+flags(1); DecoderConfigDescriptor payload: 13 bytes before nested ones.
            const inner = d.tag === 0x03 ? d.payload + 3 : d.payload + 13;
            if (inner < d.end) { const found = findDescriptor(buf, inner, d.end, tag); if (found) return found; }
        }
    }
    return null;
}

/** `mp4a.40.<objectType>` from an mp4a sample entry's esds DecoderSpecificInfo, or null (not AAC, or unreadable). */
function aacCodec(buf, entry) {
    const esds = child(buf, { content: entry.content + 28, end: entry.end }, 'esds');
    if (!esds || esds.content + 4 > esds.end) return null;
    const dc = findDescriptor(buf, esds.content + 4, esds.end, 0x04);
    if (!dc || dc.payload >= dc.end || buf[dc.payload] !== 0x40) return null;   // objectTypeIndication 0x40 = AAC
    const dsi = findDescriptor(buf, dc.payload + 13, dc.end, 0x05);
    if (!dsi || dsi.payload >= dsi.end) return null;
    let aot = buf[dsi.payload] >> 3;   // AudioSpecificConfig: 5 bits of audioObjectType (AAC-LC = 2)
    if (aot === 31) {
        if (dsi.payload + 2 > dsi.end) return null;
        aot = 32 + (((buf[dsi.payload] & 0x07) << 3) | (buf[dsi.payload + 1] >> 5));
    }
    return aot > 0 ? `mp4a.40.${aot}` : null;
}

/**
 * { width, height, codecs } for an init segment (`codecs` a comma-joined RFC 6381 list, or null). Never throws.
 */
function parseInit(input) {
    const out = { width: null, height: null, codecs: null };
    try {
        const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
        const moov = child(buf, { content: 0, end: buf.length }, 'moov');
        if (!moov) return out;
        const codecs = [];
        let unknown = false;
        const traks = boxes(buf, moov.content, moov.end).filter((b) => b.type === 'trak');
        for (const trak of traks) {
            const stsd = child(buf, child(buf, child(buf, child(buf, trak, 'mdia'), 'minf'), 'stbl'), 'stsd');
            const entry = stsd ? boxes(buf, stsd.content + 8, stsd.end)[0] : null;
            if (!entry) { unknown = true; continue; }
            if (entry.type === 'avc1') {
                const codec = avcCodec(buf, entry);
                if (!codec) { unknown = true; continue; }
                codecs.push(codec);
                if (out.width == null) { const size = entrySize(buf, entry); if (size) { out.width = size.width; out.height = size.height; } }
            } else if (entry.type === 'mp4a') {
                const codec = aacCodec(buf, entry);
                if (!codec) { unknown = true; continue; }
                codecs.push(codec);
            } else if (entry.type === 'Opus') {
                codecs.push('opus');
            } else { unknown = true; }
        }
        if (out.width == null && traks.length) { const size = tkhdSize(buf, traks[0]); if (size) { out.width = size.width; out.height = size.height; } }
        if (!unknown && codecs.length) out.codecs = codecs.join(',');
    } catch { /* a malformed init: no attributes */ }
    return out;
}

module.exports = { parseInit };
