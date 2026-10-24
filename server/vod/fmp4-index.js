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
 */
const fsp = require('fs').promises;

const MAX_FRAGMENT_BYTES = 256 * 1024 * 1024;   // a moof+mdat bigger than this is not a fragment the recorder writes
const MAX_MOOV_BYTES = 4 * 1024 * 1024;
const _states = new Map();   // file path → index state (one per recording; dropped by forget())

function emptyState() {
    return { offset: 0, initEnd: 0, tracks: new Map(), videoId: null, fragments: [], pendingMoof: null, broken: null };
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
        if (flags & 0x01) p += 8;   // base_data_offset
        if (flags & 0x02) p += 4;   // sample_description_index
        let defaultDuration = (tracks.get(id) || {}).defaultDuration || 0;
        if (flags & 0x08) defaultDuration = u32(buf, p);
        const tfdt = child(buf, traf, 'tfdt');
        const start = tfdt ? (buf[tfdt.body] === 1 ? u64(buf, tfdt.body + 4) : u32(buf, tfdt.body + 4)) : null;
        let duration = 0;
        for (const trun of children(buf, traf.body, traf.start + traf.size).filter((c) => c.type === 'trun')) {
            const tf = u32(buf, trun.body) & 0xffffff;
            const count = u32(buf, trun.body + 4);
            let q = trun.body + 8;
            if (tf & 0x001) q += 4;   // data_offset
            if (tf & 0x004) q += 4;   // first_sample_flags
            const per = ((tf & 0x100) ? 4 : 0) + ((tf & 0x200) ? 4 : 0) + ((tf & 0x400) ? 4 : 0) + ((tf & 0x800) ? 4 : 0);
            if (tf & 0x100) { for (let i = 0; i < count; i++) duration += u32(buf, q + i * per); }
            else duration += count * defaultDuration;
        }
        out.set(id, { start, duration });
    }
    return out;
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
                    st.fragments.push({ offset: m.offset, length, start, duration: t.duration / track.timescale });
                }
                st.pendingMoof = null;
            } else if (type === 'ftyp' || type === 'free' || type === 'skip' || type === 'styp' || type === 'sidx' || type === 'mfra' || type === 'prft') {
                // nothing to index
            } else if (!st.initEnd && type !== 'mdat') {
                st.broken = `unexpected ${type} before moov`; break;
            }
            st.offset += boxSize;
        }
        return { initEnd: st.initEnd, fragments: st.fragments, size, broken: st.broken || undefined };
    } finally {
        await fh.close();
    }
}

/** Fragments grouped into segments of at least `target` seconds (each starts on a fragment, so on a keyframe). */
function segments(fragments, target = 6) {
    const out = [];
    let cur = null;
    for (const f of fragments) {
        if (cur && cur.offset + cur.length === f.offset && cur.duration < target) { cur.length += f.length; cur.duration += f.duration; }
        else { cur = { offset: f.offset, length: f.length, start: f.start, duration: f.duration }; out.push(cur); }
    }
    return out;
}

/**
 * The EVENT playlist of a recording in progress: the init segment and every whole segment so far, as URIs relative to
 * the playlist (dvr/init.mp4, dvr/<offset>-<length>.m4s). `ended` closes it (#EXT-X-ENDLIST).
 */
function playlist(index, { target = 6, ended = false } = {}) {
    const segs = segments(index.fragments, target);
    const longest = segs.reduce((m, s) => Math.max(m, s.duration), 0);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.max(target + 4, Math.ceil(longest))}`,
        '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="dvr/init.mp4"`];
    for (const s of segs) lines.push(`#EXTINF:${s.duration.toFixed(3)},`, `dvr/${s.offset}-${s.length}.m4s`);
    if (ended) lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
}

/** Forget a recording's index (finalized, or its file replaced). */
function forget(filePath) { _states.delete(filePath); }

module.exports = { refresh, segments, playlist, forget, _parseMoov: parseMoov, _parseMoof: parseMoof, MAX_FRAGMENT_BYTES };
