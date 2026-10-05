/**
 * OpenVibe.Media — job types object.waveform and object.sprite (heavy lane; roadmap WS-G task 13)
 *
 * Preview variants of a ready vod/clip (or a native video/audio object). Like object.remux they never
 * touch the source: each output is a new private `asset` object in the same tenant, owned like the
 * source, with a verified local copy, a `derived_from` relationship and the source's variant of that name
 * (GET /api/v2/objects/:id lists variants).
 *
 *   object.waveform  params { width?, height? }   a PNG of the audio's waveform (ffmpeg showwavespic), 1800×140
 *                    by default. It decodes the whole audio track, so a remote source over
 *                    MEDIA_PREVIEW_REMOTE_MAX_MB (2048) is refused: the egress would cost more than the preview.
 *                    result { source_id, object_id, size_bytes, width, height, method: 'waveform' }
 *   object.sprite    params { frames?, columns?, tile_width? }   a JPEG sheet of evenly spaced frames for
 *                    seek previews: 100 frames by default (at most one per 2 s), 10 columns, 160 px wide
 *                    tiles. With MEDIA_HLS_ENABLED and a source timeline the sheet is cut from the timeline's
 *                    own segments: each sample time picks its row and one frame is decoded from that row's
 *                    bytes (this node's file, or the packed chunk's byte range), so a packed long VOD is never
 *                    decoded end to end. A source without a timeline falls back to one fast seek per frame.
 *                    The layout is in the object's metadata (sprite: { interval_seconds, count, columns,
 *                    rows, tile_width, tile_height }): frame i covers [i × interval, (i + 1) × interval) and
 *                    sits at column i % columns, row ⌊i / columns⌋.
 *                    result { source_id, object_id, size_bytes, sprite, method: 'sprite' }
 *
 * Refused before any work: a source that is not ready or not a video/audio object, a waveform of a source
 * with no audio or a sprite of one with no video (permanent), not enough disk or quota (as the other
 * derive jobs).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const timeline = require('../objects/timeline');
const { JobError } = require('./queue');
const d = require('./derive');

const MB = 1024 * 1024;
const REMOTE_MAX_BYTES = (Number(process.env.MEDIA_PREVIEW_REMOTE_MAX_MB) || 2048) * MB;
const int = (v, dflt, min, max, name) => {
    if (v == null) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new JobError('media.job.invalid', `params.${name} must be an integer from ${min} to ${max}`, { permanent: true });
    return n;
};

/** Which streams the source has: { audio, video, duration }. */
async function streamsOf(input) {
    const info = await require('../vod/media-tools').probeVodInfo(input).catch(() => null);
    const streams = (info && info.streams) || [];
    // An unreadable probe says nothing: ffmpeg itself decides then.
    if (!streams.length) return { audio: null, video: null, duration: Number(info && info.duration) || 0 };
    return { audio: streams.some((s) => s.codec_type === 'audio'), video: streams.some((s) => s.codec_type === 'video'), duration: Number(info.duration) || 0 };
}

// ── object.waveform ─────────────────────────────────────────

function validateWaveform({ obj, params }) {
    if (!obj) throw new JobError('media.job.invalid', 'object.waveform needs object_id', { permanent: true });
    if (!d.isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) have a waveform', { permanent: true });
    const p = params || {};
    return { width: int(p.width, 1800, 200, 4000, 'width'), height: int(p.height, 140, 40, 600, 'height') };
}

async function runWaveform(job, ctx) {
    const src = await d.loadSource(job);
    const p = validateWaveform({ obj: src, params: job.params });
    if (ctx.checkpoint && ctx.checkpoint.object_id) { d.cleanupWork(job.id); return { source_id: src.id, method: 'waveform', ...ctx.checkpoint }; }
    const source = await d.resolveSource(src);
    if (!source) throw new JobError('media_unavailable', 'The source bytes are unavailable (no local file and no cloud copy)', { permanent: true });
    if (source.remote && Number(src.size_bytes) > REMOTE_MAX_BYTES) {
        throw new JobError('too_large', `A waveform decodes the whole audio track; this source is only in cloud storage and larger than ${REMOTE_MAX_BYTES / MB} MB`, { permanent: true });
    }
    await d.checkRoom(src, 8 * MB);
    const out = path.join(d.workDir(job.id), 'waveform.png');
    const r = await d.ffmpeg(['-y', '-nostdin', '-v', 'error', ...d.inputArgs(source), '-i', source.input,
        '-filter_complex', `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${p.width}x${p.height}:colors=#60a5fa:scale=sqrt[w]`, '-map', '[w]', '-frames:v', '1', out],
    { signal: ctx.signal, timeoutMs: 2 * 3600 * 1000 });
    if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted');
    if (!r.ok || !d.existing(out) || fs.statSync(out).size === 0) {
        d.cleanupWork(job.id);
        const noAudio = /matches no streams|0:a:0/i.test(r.stderr);
        throw new JobError(noAudio ? 'no_audio' : 'ffmpeg_failed', noAudio ? 'The source has no audio track' : `ffmpeg exited ${r.code}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`, { permanent: noAudio });
    }
    const made = await d.adopt({
        src, file: out, ext: '.png', job, variant: 'waveform', kind: 'asset', suffix: 'waveform',
        relation: { method: 'waveform', width: p.width, height: p.height },
        metadata: { waveform: { width: p.width, height: p.height } },
        saveCheckpoint: ctx.saveCheckpoint,
        checkpointFor: (id, size) => ({ object_id: id, size_bytes: size, width: p.width, height: p.height }),
    });
    d.cleanupWork(job.id);
    return { source_id: src.id, method: 'waveform', object_id: made.id, size_bytes: made.size, width: p.width, height: p.height };
}

// ── object.sprite ───────────────────────────────────────────

function validateSprite({ obj, params }) {
    if (!obj) throw new JobError('media.job.invalid', 'object.sprite needs object_id', { permanent: true });
    if (!d.isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video objects) have a preview sprite', { permanent: true });
    const p = params || {};
    return { frames: int(p.frames, 100, 4, 400, 'frames'), columns: int(p.columns, 10, 1, 40, 'columns'), tile_width: int(p.tile_width, 160, 64, 480, 'tile_width') };
}

/** The layout for a duration: frames at most one per 2 s. */
function spriteLayout(duration, { frames, columns, tile_width }) {
    const count = Math.max(1, Math.min(frames, Math.floor(duration / 2) || 1));
    const interval = duration > 0 ? duration / count : 0;
    const cols = Math.min(columns, count);
    return { count, interval_seconds: Math.round(interval * 1000) / 1000, columns: cols, rows: Math.ceil(count / cols), tile_width, tile_height: Math.round(tile_width * 9 / 16 / 2) * 2 };
}

const tileFilter = (layout) => `scale=${layout.tile_width}:${layout.tile_height}:force_original_aspect_ratio=decrease,pad=${layout.tile_width}:${layout.tile_height}:(ow-iw)/2:(oh-ih)/2`;

/** A frame that cannot be read (a gap in a recording) is black rather than failing the sheet. */
async function blackTile(file, layout, ctx) {
    await d.ffmpeg(['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${layout.tile_width}x${layout.tile_height}`, '-frames:v', '1', file], { signal: ctx.signal, timeoutMs: 60000 });
}

/** Assemble the grid from the per-frame tiles, adopt it as the source's sprite variant, return the job result. */
async function finishSprite({ src, job, ctx, dir, layout, duration }) {
    const out = path.join(dir, 'sprite.jpg');
    const r = await d.ffmpeg(['-y', '-nostdin', '-v', 'error', '-framerate', '1', '-i', path.join(dir, 'f%04d.jpg'),
        '-vf', `tile=${layout.columns}x${layout.rows}`, '-frames:v', '1', '-q:v', '4', out], { signal: ctx.signal, timeoutMs: 10 * 60 * 1000 });
    if (!r.ok || !d.existing(out) || fs.statSync(out).size === 0) {
        d.cleanupWork(job.id);
        throw new JobError('ffmpeg_failed', `ffmpeg exited ${r.code}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
    const made = await d.adopt({
        src, file: out, ext: '.jpg', job, variant: 'sprite', kind: 'asset', suffix: 'sprite',
        relation: { method: 'sprite', ...layout },
        metadata: { sprite: layout, source_duration_seconds: duration },
        saveCheckpoint: ctx.saveCheckpoint,
        checkpointFor: (id, size) => ({ object_id: id, size_bytes: size, sprite: layout }),
    });
    d.cleanupWork(job.id);
    return { source_id: src.id, method: 'sprite', object_id: made.id, size_bytes: made.size, sprite: layout };
}

/** The old path: one fast seek per frame over the source itself. A source with no timeline uses it. */
async function runSeekSprite(job, ctx, src, p) {
    const source = await d.resolveSource(src);
    if (!source) throw new JobError('media_unavailable', 'The source bytes are unavailable (no local file and no cloud copy)', { permanent: true });
    await d.checkRoom(src, 16 * MB);
    const meta = await streamsOf(source.input);
    const md = require('../objects/model').parseJson(src.metadata, {});
    const duration = meta.duration || Number(md.duration_seconds) || 0;
    if (!(duration > 0)) throw new JobError('no_duration', 'The source has no known duration to spread frames over', { permanent: true });
    if (meta.video === false) throw new JobError('no_video', 'The source has no video track', { permanent: true });
    const layout = spriteLayout(duration, p);
    const dir = d.workDir(job.id);
    const tile = tileFilter(layout);
    for (let i = 0; i < layout.count; i++) {
        if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted');
        const frame = path.join(dir, `f${String(i).padStart(4, '0')}.jpg`);
        if (d.existing(frame)) continue;
        const at = Math.min(duration - 0.1, i * layout.interval_seconds + layout.interval_seconds / 2);
        const r = await d.ffmpeg(['-y', '-nostdin', '-v', 'error', ...d.inputArgs(source), '-ss', String(Math.max(0, at).toFixed(3)), '-i', source.input,
            '-frames:v', '1', '-vf', tile, '-q:v', '5', frame], { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
        if (!r.ok || !d.existing(frame)) await blackTile(frame, layout, ctx);
    }
    return finishSprite({ src, job, ctx, dir, layout, duration });
}

/** `length` bytes at `offset` of a local file, or null (short read, gone). */
function readRange(file, offset, length) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const b = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
            const n = fs.readSync(fd, b, read, length - read, offset + read);
            if (!n) break;
            read += n;
        }
        return read === length ? b : null;
    } catch { return null; } finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* gone */ } } }
}

/**
 * A row's bytes, checked against the row's sha256: this node's file (a segment, or the packed chunk's byte range
 * [byte_offset, byte_offset + byte_length)), else a ranged read of the durable copy through the placement router.
 * null = no verified copy (the frame falls back to black).
 */
async function rowBuffer(row, ctx) {
    const length = Number(row.byte_length);
    if (row.local_path && d.existing(row.local_path)) {
        const b = row.packed_object_id ? readRange(row.local_path, Number(row.byte_offset), length) : fs.readFileSync(row.local_path);
        if (b && b.length === length && crypto.createHash('sha256').update(b).digest('hex') === row.sha256) return b;
    }
    if (row.durable_provider && row.durability === 'durable' && row.key) {
        const vodStorage = require('../vod/vod-storage');
        const url = await vodStorage.presignGet(row.durable_provider, row.key, 900).catch(() => null);
        if (!url) return null;
        const packed = !!row.packed_object_id;
        const headers = packed ? { range: `bytes=${Number(row.byte_offset)}-${Number(row.byte_offset) + length - 1}` } : {};
        const res = await fetch(url, { headers, signal: ctx.signal }).catch(() => null);
        if (!res || !res.ok) return null;
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length === length && crypto.createHash('sha256').update(b).digest('hex') === row.sha256) return b;
    }
    return null;
}

/**
 * The sheet from the timeline (F3.1): each sample time picks the row covering it (segmentAt) and one frame is
 * decoded from that row's bytes — init.mp4 + the segment as one small file, never the source, never a full-file
 * decode. Layout, metadata and the player contract are the seek path's.
 */
async function runTimelineSprite(job, ctx, src, p, rows, segs) {
    await d.checkRoom(src, 16 * MB);
    const duration = Number(segs[segs.length - 1].end_ms) / 1000;
    if (!(duration > 0)) throw new JobError('no_duration', 'The timeline has no duration to spread frames over', { permanent: true });
    const layout = spriteLayout(duration, p);
    const dir = d.workDir(job.id);
    const initRow = rows.find((r) => Number(r.seq) === 0) || null;
    const cache = new Map();
    // One small playable file per row: the init segment then the row's bytes. fMP4 media segments need the init
    // prepended, and decoding one GOP is what keeps this off the source.
    const piece = async (row) => {
        const seq = Number(row.seq);
        if (cache.has(seq)) return cache.get(seq);
        const body = await rowBuffer(row, ctx);
        let file = null;
        if (body) {
            const head = initRow && seq !== 0 ? await rowBuffer(initRow, ctx) : null;
            file = path.join(dir, `seg-${String(seq).padStart(6, '0')}.mp4`);
            fs.writeFileSync(file, head ? Buffer.concat([head, body]) : body);
        }
        cache.set(seq, file);
        return file;
    };
    // An audio-only source has a timeline but no frame to cut: permanent, like the seek path's `no_video`.
    const first = await piece(segs[0]);
    if (first) {
        const info = await require('../vod/media-tools').probeVodInfo(first);
        if (info.streams.length && !info.streams.some((s) => s.codec_type === 'video')) {
            d.cleanupWork(job.id);
            throw new JobError('no_video', 'The source has no video track', { permanent: true });
        }
    }
    const tile = tileFilter(layout);
    let decoded = 0;
    for (let i = 0; i < layout.count; i++) {
        if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted');
        const frame = path.join(dir, `f${String(i).padStart(4, '0')}.jpg`);
        if (d.existing(frame)) { decoded++; continue; }
        const at = Math.min(duration - 0.1, i * layout.interval_seconds + layout.interval_seconds / 2);
        const row = await timeline.segmentAt(src.id, timeline.SOURCE, Math.max(0, at) * 1000);
        let ok = false;
        if (row) {
            const file = await piece(row);
            if (file) {
                // Seek is relative to the segment's own start (ffmpeg shifts the fMP4 segment's tfdt to 0 with the init).
                const rel = Math.max(0, at - Number(row.start_ms) / 1000);
                const r = await d.ffmpeg(['-y', '-nostdin', '-v', 'error', ...(rel > 0 ? ['-ss', rel.toFixed(3)] : []), '-i', file,
                    '-frames:v', '1', '-vf', tile, '-q:v', '5', frame], { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
                ok = r.ok && d.existing(frame);
            }
        }
        if (ok) decoded++;
        else await blackTile(frame, layout, ctx);
    }
    if (!decoded) {
        d.cleanupWork(job.id);
        throw new JobError('segment_unreadable', 'No frame could be read from the timeline segments; a retry reads the durable copies', { retryAfterS: 1800 });
    }
    return finishSprite({ src, job, ctx, dir, layout, duration });
}

async function runSprite(job, ctx) {
    const src = await d.loadSource(job);
    const p = validateSprite({ obj: src, params: job.params });
    if (ctx.checkpoint && ctx.checkpoint.object_id) { d.cleanupWork(job.id); return { source_id: src.id, method: 'sprite', ...ctx.checkpoint }; }
    // Sprites ride the timeline when there is one (MEDIA_HLS_ENABLED); a source without one keeps the seek path.
    const rows = config.hls.enabled ? await timeline.list(src.id) : [];
    const segs = rows.filter((r) => Number(r.seq) > 0);
    return segs.length ? runTimelineSprite(job, ctx, src, p, rows, segs) : runSeekSprite(job, ctx, src, p);
}

module.exports = {
    waveform: { lane: 'heavy', maxAttempts: 3, timeoutMs: 3 * 3600 * 1000, needsObject: true, validate: validateWaveform, run: runWaveform },
    sprite: { lane: 'heavy', maxAttempts: 3, timeoutMs: 3 * 3600 * 1000, needsObject: true, validate: validateSprite, run: runSprite },
    spriteLayout,
};
