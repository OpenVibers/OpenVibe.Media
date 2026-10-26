'use strict';
/**
 * OpenVibe.Media — the DVR index of a recording while it is written (docs/media-fabric.md §3, F3.2, first step).
 *
 * A recording in progress is a fragmented MP4 (recorder.js: +frag_keyframe+empty_moov+default_base_moof): ftyp and an
 * empty moov first (the init segment), then a moof+mdat pair per keyframe. Each pair is a CMAF fragment a player can
 * start at, so the growing file already is an HLS stream: this module walks its top-level boxes as they are appended
 * and answers the fragments with their offsets and times. The DVR playlist (public/routes.js /v/:id/dvr.m3u8) names
 * them as slices of the file itself, so live seeking needs no second copy of the recording (until 2026-10, a full
 * copy-remux every pass doubled the disk and the I/O of every long stream).
 *
 * Only whole boxes are indexed: a fragment still being written (its moof or mdat runs past the end of the file) waits
 * for the next read. Each read starts where the last stopped, so a refresh costs a stat and the new boxes' headers (a
 * moof is read whole, a few KB; an mdat only by its header). Times come from the timescale in the moov's mdhd and each
 * fragment's tfdt and trun (or tfhd/trex defaults), on the video track when there is one.
 *
 * Periods: the recording is a stream copy, so when the broadcaster's phone turns the frames change shape at a keyframe
 * while the moov still describes the first shape, and a player shows every later frame at the first shape's aspect
 * ratio (stream 2795, 2026-10-26: landscape squeezed into portrait on rewind). For H.264 each fragment's first sample is
 * read up to its first slice (a keyframe's SPS and PPS, a few hundred bytes); a size of another aspect ratio starts a
 * new period, and the playlist puts #EXT-X-DISCONTINUITY and that period's own init segment (dvr/init-<offset>.mp4, the
 * moov rewritten for its SPS: vod/avc-shape.js) before it. A lowered resolution of the same shape is not a period: the
 * decoder follows it in-band.
 */
const fsp = require('fs').promises;
const avc = require('./avc-shape');

const MAX_FRAGMENT_BYTES = 256 * 1024 * 1024;   // a moof+mdat bigger than this is not a fragment the recorder writes
const MAX_MOOV_BYTES = 4 * 1024 * 1024;
const _states = new Map();   // file path → index state (one per recording; dropped by forget())

const SAMPLE_HEAD_BYTES = 4096;   // enough of a keyframe sample for its SPS and PPS (they come before the first slice)

function emptyState() {
    return { offset: 0, initEnd: 0, tracks: new Map(), videoId: null, avc: null, periods: [], fragments: [], pendingMoof: null, broken: null };
}

const u32 = (b, o) => b.readUInt32BE(o);
const u64 = (b, o) => Number(b.readBigUInt64BE(o));
const type4 = (b, o) => b.toString('latin1', o, o + 4);

/** The child boxes of a box body: [{ type, start, size, body }] (start/body relative to `buf`). */
function children(buf, start = 0, end = buf.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
        let size = u32(buf, o);
        const type = type4(buf, o + 4);
        let header = 8;
        if (size === 1) { if (o + 16 > end) break; size = u64(buf, o + 8); header = 16; }
        else if (size === 0) size = end - o;
        if (size < header || o + size > end) break;
        out.push({ type, start: o, size, body: o + header });
        o += size;
    }
    return out;
}
const child = (buf, box, type) => children(buf, box.body, box.start + box.size).find((c) => c.type === type) || null;

/** Tracks from a moov: Map(track_ID → { timescale, handler, defaultDuration }). */
function parseMoov(buf) {
    const tracks = new Map();
    const root = { start: 0, size: buf.length, body: 0 };
    const defaults = new Map();
    const mvex = child(buf, root, 'mvex');
    if (mvex) {
        for (const trex of children(buf, mvex.body, mvex.start + mvex.size).filter((c) => c.type === 'trex')) {
            const p = trex.body + 4;   // version + flags
            defaults.set(u32(buf, p), u32(buf, p + 8));   // track_ID, default_sample_description_index, default_sample_duration
        }
    }
    for (const trak of children(buf, root.body, root.size).filter((c) => c.type === 'trak')) {
        const tkhd = child(buf, trak, 'tkhd');
        const mdia = child(buf, trak, 'mdia');
        if (!tkhd || !mdia) continue;
        const v = buf[tkhd.body];
        const id = u32(buf, tkhd.body + 4 + (v === 1 ? 16 : 8));
        const mdhd = child(buf, mdia, 'mdhd');
        const hdlr = child(buf, mdia, 'hdlr');
        if (!mdhd) continue;
        const mv = buf[mdhd.body];
        const timescale = u32(buf, mdhd.body + 4 + (mv === 1 ? 16 : 8));
        const handler = hdlr ? type4(buf, hdlr.body + 8) : '';
        tracks.set(id, { timescale, handler, defaultDuration: defaults.get(id) || 0 });
    }
    return tracks;
}

/** One moof's per-track { start, duration } in that track's timescale. */
function parseMoof(buf, tracks) {
    const out = new Map();
    const root = { start: 0, size: buf.length, body: 0 };
    for (const traf of children(buf, root.body, root.size).filter((c) => c.type === 'traf')) {
        const tfhd = child(buf, traf, 'tfhd');
        if (!tfhd) continue;
        const flags = u32(buf, tfhd.body) & 0xffffff;
        const id = u32(buf, tfhd.body + 4);
        let p = tfhd.body + 8;
        const baseOffset = (flags & 0x01) ? u64(buf, tfhd.body + 8) : null;   // else the moof's first byte (default-base-is-moof)
        if (flags & 0x01) p += 8;   // base_data_offset
        if (flags & 0x02) p += 4;   // sample_description_index
        let defaultDuration = (tracks.get(id) || {}).defaultDuration || 0;
        if (flags & 0x08) { defaultDuration = u32(buf, p); p += 4; }
        const defaultSize = (flags & 0x10) ? u32(buf, p) : 0;
        const tfdt = child(buf, traf, 'tfdt');
        const start = tfdt ? (buf[tfdt.body] === 1 ? u64(buf, tfdt.body + 4) : u32(buf, tfdt.body + 4)) : null;
        let duration = 0;
        let first = null;   // the first sample's { offset (from the base), size }
        for (const trun of children(buf, traf.body, traf.start + traf.size).filter((c) => c.type === 'trun')) {
            const tf = u32(buf, trun.body) & 0xffffff;
            const count = u32(buf, trun.body + 4);
            let q = trun.body + 8;
            const dataOffset = (tf & 0x001) ? buf.readInt32BE(q) : null;
            if (tf & 0x001) q += 4;   // data_offset
            if (tf & 0x004) q += 4;   // first_sample_flags
            const per = ((tf & 0x100) ? 4 : 0) + ((tf & 0x200) ? 4 : 0) + ((tf & 0x400) ? 4 : 0) + ((tf & 0x800) ? 4 : 0);
            if (!first && count && dataOffset != null) first = { offset: dataOffset, size: (tf & 0x200) ? u32(buf, q + ((tf & 0x100) ? 4 : 0)) : defaultSize };
            if (tf & 0x100) { for (let i = 0; i < count; i++) duration += u32(buf, q + i * per); }
            else duration += count * defaultDuration;
        }
        out.set(id, { start, duration, first, baseOffset });
    }
    return out;
}

/** The H.264 video track of a moov body: { lengthSize, sps, pps, shape: { width, height } }, or null (not H.264). */
function h264Of(moovBody) {
    try {
        const e = avc.videoEntry(moovBody);
        if (!e || !e.avcC) return null;
        const sps = e.avcC.sps[0] || null;
        let shape = { width: e.width, height: e.height };
        if (sps) { try { const i = avc.parseSps(sps); shape = { width: i.width, height: i.height }; } catch { /* the entry's size */ } }
        return { lengthSize: e.avcC.lengthSize, sps, pps: e.avcC.pps[0] || null, shape };
    } catch { return null; }
}

/**
 * Read the start of a video fragment's first sample: when its SPS names a size of another shape than the current
 * period's, a new period starts at this fragment. Never fails the index: an unreadable sample keeps the period.
 */
async function notePeriod(fh, st, moof, t, start) {
    if (!t.first || !(t.first.size > 0)) return;
    try {
        const at = (t.baseOffset != null ? t.baseOffset : moof.offset) + t.first.offset;
        const length = Math.min(t.first.size, SAMPLE_HEAD_BYTES);
        const head = Buffer.alloc(length);
        const { bytesRead } = await fh.read(head, 0, length, at);
        const { sps, pps } = avc.parameterSets(head.subarray(0, bytesRead), st.avc.lengthSize);
        if (!sps) return;
        const info = avc.parseSps(sps);
        const cur = st.periods[st.periods.length - 1];
        const shape = { width: info.width, height: info.height };
        if (avc.sameShape(cur, shape)) return;
        st.periods.push({ offset: moof.offset, start, ...shape, sps, pps: pps || cur.pps || st.avc.pps });
    } catch { /* keep the period */ }
}

async function readAt(fh, offset, length) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : null;
}

/**
 * Index what was appended to `filePath` since the last call. → { initEnd, fragments: [{ offset, length, start, duration }],
 * size } with times in seconds, or { broken } when the file is not a fragmented MP4 this module reads.
 */
async function refresh(filePath) {
    let st = _states.get(filePath);
    if (!st) _states.set(filePath, st = emptyState());
    if (st.broken) return { broken: st.broken };
    const fh = await fsp.open(filePath, 'r');
    try {
        const size = (await fh.stat()).size;
        while (st.offset + 8 <= size) {
            const head = await readAt(fh, st.offset, Math.min(16, size - st.offset));
            if (!head) break;
            let boxSize = u32(head, 0);
            const type = type4(head, 4);
            let header = 8;
            if (boxSize === 1) { if (head.length < 16) break; boxSize = u64(head, 8); header = 16; }
            if (boxSize === 0) break;   // runs to the end: still being written
            if (boxSize < header) { st.broken = `bad box at ${st.offset}`; break; }
            if (st.offset + boxSize > size) break;   // not whole yet
            if (type === 'moov') {
                if (boxSize > MAX_MOOV_BYTES) { st.broken = 'moov too large'; break; }
                const body = await readAt(fh, st.offset + header, boxSize - header);
                st.tracks = parseMoov(body);
                for (const [id, t] of st.tracks) if (t.handler === 'vide' && st.videoId == null) st.videoId = id;
                st.initEnd = st.offset + boxSize;
                st.avc = h264Of(body);
                st.periods = [st.avc ? { offset: null, start: 0, ...st.avc.shape } : { offset: null, start: 0 }];
            } else if (type === 'moof') {
                if (!st.initEnd) { st.broken = 'moof before moov'; break; }
                const body = await readAt(fh, st.offset + header, boxSize - header);
                st.pendingMoof = { offset: st.offset, times: parseMoof(body, st.tracks) };
            } else if (type === 'mdat' && st.pendingMoof) {
                const m = st.pendingMoof;
                const length = st.offset + boxSize - m.offset;
                const id = st.videoId != null && m.times.has(st.videoId) ? st.videoId : m.times.keys().next().value;
                const t = m.times.get(id);
                const track = st.tracks.get(id);
                if (t && track && track.timescale && length <= MAX_FRAGMENT_BYTES) {
                    const start = t.start != null ? t.start / track.timescale : (st.fragments.length ? st.fragments[st.fragments.length - 1].start + st.fragments[st.fragments.length - 1].duration : 0);
                    if (st.avc && id === st.videoId) await notePeriod(fh, st, m, t, start);
                    st.fragments.push({ offset: m.offset, length, start, duration: t.duration / track.timescale, period: st.periods.length - 1 });
                }
                st.pendingMoof = null;
            } else if (type === 'ftyp' || type === 'free' || type === 'skip' || type === 'styp' || type === 'sidx' || type === 'mfra' || type === 'prft') {
                // nothing to index
            } else if (!st.initEnd && type !== 'mdat') {
                st.broken = `unexpected ${type} before moov`; break;
            }
            st.offset += boxSize;
        }
        return { initEnd: st.initEnd, fragments: st.fragments, periods: st.periods, size, broken: st.broken || undefined };
    } finally {
        await fh.close();
    }
}

/**
 * Fragments grouped into segments of at least `target` seconds (each starts on a fragment, so on a keyframe). A segment
 * never spans two periods.
 */
function segments(fragments, target = 6) {
    const out = [];
    let cur = null;
    for (const f of fragments) {
        const period = f.period || 0;
        if (cur && cur.offset + cur.length === f.offset && cur.duration < target && cur.period === period) { cur.length += f.length; cur.duration += f.duration; }
        else { cur = { offset: f.offset, length: f.length, start: f.start, duration: f.duration, period }; out.push(cur); }
    }
    return out;
}

/** A period's init segment URI relative to the playlist: the file's own for the first, a rewritten moov after a change. */
function initUri(index, period) {
    const p = (index.periods || [])[period];
    return p && p.offset != null ? `dvr/init-${p.offset}.mp4` : 'dvr/init.mp4';
}

/**
 * The EVENT playlist of a recording in progress: the init segment and every whole segment so far, as URIs relative to
 * the playlist (dvr/init.mp4, dvr/<offset>-<length>.m4s). Each change of period is a discontinuity with that period's
 * own init segment. `ended` closes it (#EXT-X-ENDLIST).
 */
function playlist(index, { target = 6, ended = false } = {}) {
    const segs = segments(index.fragments, target);
    const longest = segs.reduce((m, s) => Math.max(m, s.duration), 0);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.max(target + 4, Math.ceil(longest))}`,
        '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-INDEPENDENT-SEGMENTS'];
    let period = null;
    for (const s of segs) {
        if (s.period !== period) {
            if (period !== null) lines.push('#EXT-X-DISCONTINUITY');
            lines.push(`#EXT-X-MAP:URI="${initUri(index, s.period)}"`);
            period = s.period;
        }
        lines.push(`#EXTINF:${s.duration.toFixed(3)},`, `dvr/${s.offset}-${s.length}.m4s`);
    }
    if (period === null) lines.push(`#EXT-X-MAP:URI="${initUri(index, 0)}"`);
    if (ended) lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
}

/** The init segment of the period that starts at fragment `offset` (the moov rewritten for its SPS), or null. */
function periodInit(initBytes, index, offset) {
    const p = (index.periods || []).find((x) => x.offset != null && x.offset === offset);
    if (!p || !p.sps) return null;
    return avc.initWith(initBytes, { sps: p.sps, pps: p.pps });
}

/** Forget a recording's index (finalized, or its file replaced). */
function forget(filePath) { _states.delete(filePath); }

module.exports = { refresh, segments, playlist, periodInit, forget, _parseMoov: parseMoov, _parseMoof: parseMoof, MAX_FRAGMENT_BYTES };
