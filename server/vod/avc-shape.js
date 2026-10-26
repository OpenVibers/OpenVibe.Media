'use strict';
/**
 * OpenVibe.Media — the H.264 picture size a recording in progress sends, and an init segment for it (the DVR's periods,
 * vod/fmp4-index.js).
 *
 * A recording is a stream copy: when the broadcaster's phone turns, the frames change shape at a keyframe, whose in-band
 * SPS names the new size, while the file's moov still describes the first one. A player given that one init segment
 * keeps the first shape's aspect ratio for every frame (Chrome showed a landscape stretch of stream 2795 squeezed into
 * 720x1280 as 1280x2276). So the DVR starts a new period at each change of shape, and gives it an init segment made from
 * the file's own moov with the new SPS and PPS and the new size.
 *
 *   nals(buf, lengthSize)        the NAL units of a length-prefixed sample (what the recorder's mp4 holds): [{ type, data }]
 *   parameterSets(buf, size)     the SPS and PPS before the first slice of a sample: { sps, pps } (Buffers, or null)
 *   parseSps(sps)                { profile, compat, level, chromaFormat, bitDepthLuma, bitDepthChroma, width, height }
 *   parseAvcC(body)              { lengthSize, sps: [Buffer], pps: [Buffer] } from an avcC box body
 *   videoEntry(moov)             the video track's sample entry in a moov body: { type, width, height, avcC } or null
 *   initWith(init, { sps, pps }) the init segment (ftyp + moov bytes) rewritten for that SPS/PPS: avcC, the sample entry's
 *                                width/height and the track header's size
 *   sameShape(a, b)              whether two sizes have one aspect ratio (a lowered resolution is not a new shape)
 */

const u32 = (b, o) => b.readUInt32BE(o);
const u64 = (b, o) => Number(b.readBigUInt64BE(o));
const type4 = (b, o) => b.toString('latin1', o, o + 4);

const SAME_SHAPE = 0.04;   // |ln(aspect a / aspect b)|, as in jobs/shapes.js: 1280x720 and 426x240 are one shape
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
const VISUAL_ENTRY_FIELDS = 78;   // a VisualSampleEntry's fields before its child boxes (ISO 14496-12 12.1.3)

/** Boxes inside [start, end) of buf: [{ type, start, size, header, body }]. */
function boxes(buf, start = 0, end = buf.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
        let size = u32(buf, o);
        const type = type4(buf, o + 4);
        let header = 8;
        if (size === 1) { if (o + 16 > end) break; size = u64(buf, o + 8); header = 16; }
        else if (size === 0) size = end - o;
        if (size < header || o + size > end) break;
        out.push({ type, start: o, size, header, body: o + header });
        o += size;
    }
    return out;
}
const find = (buf, box, type, skip = 0) => boxes(buf, box.body + skip, box.start + box.size).find((c) => c.type === type) || null;

function nals(buf, lengthSize = 4) {
    const out = [];
    let o = 0;
    while (o + lengthSize <= buf.length) {
        let n = 0;
        for (let i = 0; i < lengthSize; i++) n = n * 256 + buf[o + i];
        o += lengthSize;
        if (!n || o + n > buf.length) break;   // a read that stops mid-NAL keeps the ones before it
        out.push({ type: buf[o] & 0x1f, data: buf.subarray(o, o + n) });
        o += n;
    }
    return out;
}

function parameterSets(buf, lengthSize = 4) {
    let sps = null, pps = null;
    for (const n of nals(buf, lengthSize)) {
        if (n.type >= 1 && n.type <= 5) break;   // the first slice: parameter sets come before it
        if (n.type === 7 && !sps) sps = Buffer.from(n.data);
        else if (n.type === 8 && !pps) pps = Buffer.from(n.data);
    }
    return { sps, pps };
}

/** An RBSP bit reader (emulation prevention bytes removed). */
function bits(nal) {
    const rbsp = [];
    for (let i = 1; i < nal.length; i++) {   // past the NAL header byte
        if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
        rbsp.push(nal[i]);
    }
    let pos = 0;
    const bit = () => {
        if (pos >= rbsp.length * 8) throw new Error('SPS ends early');
        const b = (rbsp[pos >> 3] >> (7 - (pos & 7))) & 1;
        pos++;
        return b;
    };
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
    const ue = () => { let zeros = 0; while (!bit()) { if (++zeros > 31) throw new Error('bad exp-Golomb code'); } return (2 ** zeros) - 1 + u(zeros); };
    const se = () => { const k = ue(); return k % 2 ? (k + 1) / 2 : -(k / 2); };
    return { u, ue, se };
}

function parseSps(sps) {
    if (!sps || sps.length < 4 || (sps[0] & 0x1f) !== 7) throw new Error('not an SPS');
    const r = bits(sps);
    const profile = r.u(8);
    const compat = r.u(8);
    const level = r.u(8);
    r.ue();   // seq_parameter_set_id
    let chromaFormat = 1, bitDepthLuma = 8, bitDepthChroma = 8, separateColourPlane = 0;
    if (HIGH_PROFILES.has(profile)) {
        chromaFormat = r.ue();
        if (chromaFormat === 3) separateColourPlane = r.u(1);
        bitDepthLuma = r.ue() + 8;
        bitDepthChroma = r.ue() + 8;
        r.u(1);   // qpprime_y_zero_transform_bypass_flag
        if (r.u(1)) {   // seq_scaling_matrix_present_flag
            for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
                if (!r.u(1)) continue;
                let last = 8, next = 8;
                for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
                    if (next !== 0) next = (last + r.se() + 256) % 256;
                    last = next === 0 ? last : next;
                }
            }
        }
    }
    r.ue();   // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
        r.u(1); r.se(); r.se();
        const cycle = r.ue();
        for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue();   // max_num_ref_frames
    r.u(1);   // gaps_in_frame_num_value_allowed_flag
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);   // mb_adaptive_frame_field_flag
    r.u(1);   // direct_8x8_inference_flag
    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (r.u(1)) { cropLeft = r.ue(); cropRight = r.ue(); cropTop = r.ue(); cropBottom = r.ue(); }
    const arrayType = separateColourPlane ? 0 : chromaFormat;
    const cropX = arrayType === 0 ? 1 : (chromaFormat === 3 ? 1 : 2);
    const cropY = (arrayType === 0 ? 1 : (chromaFormat === 1 ? 2 : 1)) * (2 - frameMbsOnly);
    const width = widthMbs * 16 - cropX * (cropLeft + cropRight);
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropY * (cropTop + cropBottom);
    if (width <= 0 || height <= 0) throw new Error('SPS names no picture');
    return { profile, compat, level, chromaFormat, bitDepthLuma, bitDepthChroma, width, height };
}

function parseAvcC(body) {
    if (!body || body.length < 7 || body[0] !== 1) return null;
    const lengthSize = (body[4] & 3) + 1;
    let o = 6;
    const read = (count) => {
        const list = [];
        for (let i = 0; i < count && o + 2 <= body.length; i++) {
            const n = body.readUInt16BE(o);
            o += 2;
            if (o + n > body.length) break;
            list.push(Buffer.from(body.subarray(o, o + n)));
            o += n;
        }
        return list;
    };
    const sps = read(body[5] & 0x1f);
    const pps = o < body.length ? read(body[o++]) : [];
    return { lengthSize, sps, pps };
}

/** The video track's trak, its sample entry and the boxes on the way, in a moov body (offsets in `moov`). */
function videoPath(moov) {
    for (const trak of boxes(moov).filter((b) => b.type === 'trak')) {
        const mdia = find(moov, trak, 'mdia');
        const hdlr = mdia && find(moov, mdia, 'hdlr');
        if (!hdlr || type4(moov, hdlr.body + 8) !== 'vide') continue;
        const minf = find(moov, mdia, 'minf');
        const stbl = minf && find(moov, minf, 'stbl');
        const stsd = stbl && find(moov, stbl, 'stsd');
        if (!stsd) return null;
        const entry = boxes(moov, stsd.body + 8, stsd.start + stsd.size)[0];
        if (!entry || entry.size < entry.header + VISUAL_ENTRY_FIELDS) return null;
        return { trak, tkhd: find(moov, trak, 'tkhd'), mdia, minf, stbl, stsd, entry };
    }
    return null;
}

function videoEntry(moov) {
    const p = videoPath(moov);
    if (!p) return null;
    const { entry } = p;
    const avcC = (entry.type === 'avc1' || entry.type === 'avc3') ? find(moov, entry, 'avcC', VISUAL_ENTRY_FIELDS) : null;
    return {
        type: entry.type,
        width: moov.readUInt16BE(entry.body + 24),
        height: moov.readUInt16BE(entry.body + 26),
        avcC: avcC ? parseAvcC(moov.subarray(avcC.body, avcC.start + avcC.size)) : null,
    };
}

const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length + 8, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
};

function avcCBox(sps, ppsList, lengthSize, info) {
    const parts = [Buffer.from([1, info.profile, info.compat, info.level, 0xfc | (lengthSize - 1), 0xe0 | 1])];
    const withLength = (b) => { const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); };
    parts.push(withLength(sps), Buffer.from([ppsList.length]), ...ppsList.map(withLength));
    if (HIGH_PROFILES.has(info.profile)) {   // ISO 14496-15 5.3.3.1.2: the chroma and bit-depth fields, no SPS extensions
        parts.push(Buffer.from([0xfc | (info.chromaFormat & 3), 0xf8 | ((info.bitDepthLuma - 8) & 7), 0xf8 | ((info.bitDepthChroma - 8) & 7), 0]));
    }
    return box('avcC', ...parts);
}

/**
 * A container box of `buf` rebuilt with `keep` bytes of its own fields first and each child replaced by what `map`
 * returns for it (a Buffer), or copied when it returns nothing.
 */
function rebuild(buf, b, keep, map) {
    const kids = boxes(buf, b.body + keep, b.start + b.size).map((c) => map(c) || buf.subarray(c.start, c.start + c.size));
    return box(b.type, buf.subarray(b.body, b.body + keep), ...kids);
}

function initWith(init, { sps, pps }) {
    const top = boxes(init);
    const moovBox = top.find((b) => b.type === 'moov');
    if (!moovBox) throw new Error('no moov');
    const moov = init.subarray(moovBox.body, moovBox.start + moovBox.size);
    const p = videoPath(moov);
    if (!p || !(p.entry.type === 'avc1' || p.entry.type === 'avc3')) throw new Error('not an H.264 video track');
    const info = parseSps(sps);
    const old = find(moov, p.entry, 'avcC', VISUAL_ENTRY_FIELDS);
    const prior = old ? parseAvcC(moov.subarray(old.body, old.start + old.size)) : null;
    const lengthSize = prior ? prior.lengthSize : 4;
    const ppsList = pps ? [pps] : (prior ? prior.pps : []);

    const fields = Buffer.from(moov.subarray(p.entry.body, p.entry.body + VISUAL_ENTRY_FIELDS));
    fields.writeUInt16BE(info.width, 24);
    fields.writeUInt16BE(info.height, 26);
    const entry = box(p.entry.type, fields, ...boxes(moov, p.entry.body + VISUAL_ENTRY_FIELDS, p.entry.start + p.entry.size)
        .map((c) => (c.type === 'avcC' ? avcCBox(sps, ppsList, lengthSize, info) : moov.subarray(c.start, c.start + c.size))));
    const tkhd = Buffer.from(moov.subarray(p.tkhd.start, p.tkhd.start + p.tkhd.size));
    const sizeAt = p.tkhd.header + (tkhd[p.tkhd.header] === 1 ? 88 : 76);   // width, height: 16.16 fixed point
    tkhd.writeUInt32BE(info.width * 65536, sizeAt);
    tkhd.writeUInt32BE(info.height * 65536, sizeAt + 4);

    const at = (b) => (c) => c.start === b.start;
    const stsd = rebuild(moov, p.stsd, 8, (c) => (at(p.entry)(c) ? entry : null));
    const stbl = rebuild(moov, p.stbl, 0, (c) => (at(p.stsd)(c) ? stsd : null));
    const minf = rebuild(moov, p.minf, 0, (c) => (at(p.stbl)(c) ? stbl : null));
    const mdia = rebuild(moov, p.mdia, 0, (c) => (at(p.minf)(c) ? minf : null));
    const trak = rebuild(moov, p.trak, 0, (c) => (at(p.mdia)(c) ? mdia : at(p.tkhd)(c) ? tkhd : null));
    const newMoov = box('moov', ...boxes(moov).map((c) => (at(p.trak)(c) ? trak : moov.subarray(c.start, c.start + c.size))));
    return Buffer.concat(top.map((b) => (b === moovBox ? newMoov : init.subarray(b.start, b.start + b.size))));
}

function sameShape(a, b) {
    if (!a || !b || !a.width || !a.height || !b.width || !b.height) return true;
    return Math.abs(Math.log((a.width / a.height) / (b.width / b.height))) <= SAME_SHAPE;
}

module.exports = { nals, parameterSets, parseSps, parseAvcC, videoEntry, initWith, sameShape, SAME_SHAPE, _boxes: boxes };
