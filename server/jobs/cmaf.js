/**
 * OpenVibe.Media — job type object.cmaf (heavy lane; docs/media-fabric.md §3, F3.1)
 *
 * The source representation of a finished video (or audio) object as CMAF under HLS: a stream copy by default, or
 * selective H.264/AAC transcoding with MEDIA_CMAF_TRANSCODE, into fragmented-MP4 segments, init.mp4 plus
 * 000001.m4s, …, stored under the object's `source/` prefix and indexed in media_timeline (objects/timeline.js), one
 * row per segment with its times, size, sha256 and durability. The source object is never touched: its bytes,
 * locations, visibility, metadata and lifecycle stay as they are. Once the rows are committed, `object.pack` is queued
 * (objects/timeline-queue.js) so packing follows the cut by itself.
 *
 *   params { segment_seconds }   the target segment length, 1-10 (4): a segment ends at the first keyframe after it
 *   result { source_id, rendition: 'source', segments, duration_ms, bytes, durable, local_only,
 *            rows: { inserted, updated, unchanged, removed }, uploaded, master_path, video, audio }
 *
 * Bytes: each segment lands on this node's disk (OBJECTS_PATH/.timeline/…); with a durable provider it is uploaded under
 * <object>/source/<version>/<name> (version = the sha's prefix) and its row says `durable` once the provider confirms the
 * size. The provider is the placement router's choice (timeline.durableProvider: the source's own canonical copy first),
 * never a hard-coded one. The row materialization and the two-phase commit live in server/jobs/segments.js, shared with
 * rendition.create (F4).
 * Idempotent: a rerun makes the same bytes (bitexact), reuses a row whose sha256 matches and its location as it is, and
 * uploads only what is not durable yet. A run that aborts or fails before the commit removes its staged files and keys.
 * A picture that changes shape mid-stream (a phone turned, a resolution lowered: jobs/shapes.js) is re-encoded with
 * MEDIA_CMAF_TRANSCODE in one period per shape, each on its own canvas with its own init segment, so the playlist
 * switches shape between periods instead of stretching every frame to the first size; `shapes` in the result counts them.
 * Refused: MEDIA_HLS_ENABLED off, a source that is not ready or not media (permanent), less free disk than the source
 * size plus MEDIA_UPLOAD_MIN_FREE_MB (retried later), a codec fMP4 cannot carry (permanent), a clip whose file was
 * replaced (a trim or re-cut) while it ran (permanent, media.source.changed: nothing is committed).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const timeline = require('../objects/timeline');
const derive = require('./derive');
const segments = require('./segments');
const shapes = require('./shapes');
const { JobError } = require('./queue');

const DEFAULT_SEGMENT_SECONDS = 4;

function transcodeBudgetMs(duration) {
    return Math.min(13 * 3600 * 1000, Math.max(10 * 60000, Math.round(duration * 3000 + 10 * 60000)));
}

/** The H.264 re-encode: a keyframe at every segment boundary, frame times as they are. */
function x264Args(segmentSeconds) {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads', String(config.hls.transcodeThreads),
        '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`, '-sc_threshold', '0', '-fps_mode', 'passthrough'];
}
const AAC_ARGS = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];

function disabled() {
    return new JobError('media.hls.disabled', 'Segment-native video is off on this server (MEDIA_HLS_ENABLED)', { permanent: true, status: 409 });
}

function validate({ obj, params }) {
    if (!config.hls.enabled) throw disabled();
    if (!obj) throw new JobError('media.job.invalid', 'object.cmaf needs object_id', { permanent: true });
    if (!derive.isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) have a timeline', { permanent: true });
    const p = { ...(params || {}) };
    if (p.segment_seconds != null) {
        const s = Number(p.segment_seconds);
        if (!Number.isFinite(s) || s < 1 || s > 10) throw new JobError('media.job.invalid', 'params.segment_seconds must be from 1 to 10', { permanent: true });
        p.segment_seconds = s;
    }
    return p;
}

/** The whole input as one HLS fMP4 rendition (one shape): → the produced segments, [{ name, seconds }]. */
async function cutWhole({ source, out, codecArgs, segmentSeconds, ctx, timeoutMs, niceness }) {
    const r = await derive.ffmpeg(['-y', '-nostdin', '-v', 'error', ...derive.inputArgs(source), '-i', source.input,
        '-map', '0:v:0?', '-map', '0:a:0?', ...codecArgs, '-map_metadata', '-1', '-fflags', '+bitexact', '-flags', '+bitexact',
        '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_list_size', '0',
        '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', timeline.INIT_NAME,
        '-start_number', '1', '-hls_segment_filename', path.join(out, '%06d.m4s'), path.join(out, 'index.m3u8')],
    { signal: ctx.signal, timeoutMs, niceness });
    segments.aborted(ctx);
    const tail = String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
    if (!r.ok) {
        const unsupported = /not currently supported in container|could not find tag for codec|codec not supported/i.test(r.stderr);
        throw new JobError(unsupported ? 'codec_unsupported' : 'ffmpeg_failed', `ffmpeg exited ${r.code}: ${tail}`, { permanent: unsupported });
    }
    const list = derive.existing(path.join(out, 'index.m3u8')) ? segments.parsePlaylist(fs.readFileSync(path.join(out, 'index.m3u8'), 'utf8')) : [];
    if (!list.length || !derive.existing(path.join(out, timeline.INIT_NAME))) throw new JobError('ffmpeg_failed', `ffmpeg wrote no segments: ${tail}`);
    return list;
}

async function run(job, ctx) {
    if (!config.hls.enabled) throw disabled();
    const src = await derive.loadSource(job);
    // A clip can be cut again in place (a trim, a re-cut): its object keeps its id while its file changes. The rows are
    // committed only while the file is still the one this run cut (read FOR SHARE in the commit's transaction, so a
    // re-cut's row update waits for it); otherwise nothing is published and the next request queues the new file's job.
    const version = await derive.fileVersion(src);
    const source = await derive.resolveSource(src);
    if (!source) throw new JobError('media_unavailable', 'The source bytes are unavailable (no local file and no cloud copy)', { permanent: true });
    let video = 'copy';
    let audio = 'copy';
    let codecArgs = ['-c', 'copy'];
    let timeoutMs = derive.budgetMs(src.size_bytes);
    const segmentSeconds = Number(job.params.segment_seconds || DEFAULT_SEGMENT_SECONDS);
    let info;
    try { info = await derive.probeStreams(source, { signal: ctx.signal }); }
    catch (err) {
        segments.aborted(ctx);
        // Preserve the old copy path if an input cannot be probed while the new feature is off.
        if (config.hls.transcode) throw new JobError('probe_failed', `ffprobe failed: ${err.message}`);
    }
    segments.aborted(ctx);
    if (info && !info.audio) audio = 'none';
    if (config.hls.transcode && info) {
        video = info.video && info.video.codec_name !== 'h264' ? 'h264' : 'copy';
        audio = !info.audio ? 'none' : ['aac', 'mp3'].includes(info.audio.codec_name) ? 'copy' : 'aac';
        if (video === 'h264' || audio === 'aac') {
            if (!(info.duration > 0)) throw new JobError('duration_unknown', 'Cannot bound a transcode without a measured duration', { permanent: true });
            if (info.duration > config.hls.transcodeMaxSeconds) {
                throw new JobError('too_long_to_transcode', `Source duration ${info.duration}s exceeds MEDIA_CMAF_TRANSCODE_MAX_SECONDS`, { permanent: true });
            }
            timeoutMs = transcodeBudgetMs(info.duration);
            codecArgs = video === 'h264' ? x264Args(segmentSeconds) : ['-c:v', 'copy'];
            codecArgs.push(...(audio === 'aac' ? AAC_ARGS : ['-c:a', 'copy']));
        }
    }
    // Frames of more than one size (shapes.js): one period per shape, each re-encoded on its own canvas. A copy would
    // carry frames its init does not describe, and one encode scales every frame to the first size (a portrait part
    // stretched into 16:9). A probe that fails leaves the cut as it was.
    let periods = null;
    let shapeStart = 0;
    if (config.hls.transcode && info && info.video && info.duration > 0 && info.duration <= config.hls.transcodeMaxSeconds) {
        let read = null;
        try { read = await shapes.probe(source, { signal: ctx.signal, timeoutMs: derive.budgetMs(src.size_bytes) }); }
        catch (err) { segments.aborted(ctx); console.warn(`[Cmaf] ${job.id}: shape probe failed (${err.message.slice(0, 200)}); cut as one shape`); }
        segments.aborted(ctx);
        if (read && shapes.varies(read.changes)) {
            periods = shapes.plan(read.changes, { end: read.start + info.duration });
            shapeStart = read.start;
            video = 'h264';
            if (audio !== 'none') audio = 'aac';
            timeoutMs = transcodeBudgetMs(info.duration);
            codecArgs = [...x264Args(segmentSeconds), ...(audio === 'aac' ? AAC_ARGS : [])];
            console.log(`[Cmaf] ${job.id}: ${read.changes.length} frame sizes → ${periods.length} period(s): ${periods.map((p) => `${p.width}x${p.height}`).join(', ')}`);
        }
    }
    segments.checkDisk(Number(src.size_bytes) || 0);
    const rendition = timeline.SOURCE;
    const dir = derive.workDir(job.id);
    try {
        const out = path.join(dir, 'out');
        fs.mkdirSync(out, { recursive: true });
        const list = periods
            ? await shapes.cut({ source, periods, start: shapeStart, out, segmentSeconds, audio: audio !== 'none', encode: () => codecArgs,
                signal: ctx.signal, timeoutMs, niceness: 15 })
            : await cutWhole({ source, out, codecArgs, segmentSeconds, ctx, timeoutMs, niceness: video === 'h264' || audio === 'aac' ? 15 : 0 });

        const check = version == null ? null : async () => {
            if (await derive.fileVersion(src, { lock: true }) !== version) {
                throw new JobError('media.source.changed', 'The clip was cut again while this ran; its new file gets a timeline of its own', { permanent: true });
            }
        };
        const published = await segments.publishRendition({ job, ctx, src, rendition, out, list, label: 'Cmaf', check });
        if (video === 'h264') require('../placement/metrics-binding').inc('media_cmaf_transcodes_total', { stream: 'video' });
        if (audio === 'aac') require('../placement/metrics-binding').inc('media_cmaf_transcodes_total', { stream: 'audio' });
        return {
            source_id: src.id, rendition, segments: published.segments, duration_ms: published.duration_ms, bytes: published.bytes,
            durable: published.durable, local_only: published.local_only, rows: published.rows, uploaded: published.uploaded,
            master_path: `/o/${src.id}/master.m3u8`, source_unchanged: true, video, audio, shapes: periods ? periods.length : 1,
        };
    } finally {
        derive.cleanupWork(job.id);
    }
}

module.exports = {
    spec: { lane: 'heavy', maxAttempts: 3, timeoutMs: () => config.hls.transcode ? 13 * 3600 * 1000 : 3 * 3600 * 1000, needsObject: true, validate, run },
    parsePlaylist: segments.parsePlaylist,
};
