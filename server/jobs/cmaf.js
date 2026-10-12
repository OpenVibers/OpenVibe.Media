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
 * Refused: MEDIA_HLS_ENABLED off, a source that is not ready or not media (permanent), less free disk than the source
 * size plus MEDIA_UPLOAD_MIN_FREE_MB (retried later), a codec fMP4 cannot carry (permanent).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const timeline = require('../objects/timeline');
const derive = require('./derive');
const segments = require('./segments');
const { JobError } = require('./queue');

const DEFAULT_SEGMENT_SECONDS = 4;

function transcodeBudgetMs(duration) {
    return Math.min(13 * 3600 * 1000, Math.max(10 * 60000, Math.round(duration * 3000 + 10 * 60000)));
}

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

async function run(job, ctx) {
    if (!config.hls.enabled) throw disabled();
    const src = await derive.loadSource(job);
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
            codecArgs = video === 'h264'
                ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads', String(config.hls.transcodeThreads),
                    '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`, '-sc_threshold', '0', '-fps_mode', 'passthrough']
                : ['-c:v', 'copy'];
            codecArgs.push(...(audio === 'aac' ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-c:a', 'copy']));
        }
    }
    segments.checkDisk(Number(src.size_bytes) || 0);
    const rendition = timeline.SOURCE;
    const dir = derive.workDir(job.id);
    try {
        const out = path.join(dir, 'out');
        fs.mkdirSync(out, { recursive: true });
        const r = await derive.ffmpeg(['-y', '-nostdin', '-v', 'error', ...derive.inputArgs(source), '-i', source.input,
            '-map', '0:v:0?', '-map', '0:a:0?', ...codecArgs, '-map_metadata', '-1', '-fflags', '+bitexact', '-flags', '+bitexact',
            '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_list_size', '0',
            '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', timeline.INIT_NAME,
            '-start_number', '1', '-hls_segment_filename', path.join(out, '%06d.m4s'), path.join(out, 'index.m3u8')],
        { signal: ctx.signal, timeoutMs, niceness: video === 'h264' || audio === 'aac' ? 15 : 0 });
        segments.aborted(ctx);
        const tail = String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
        if (!r.ok) {
            const unsupported = /not currently supported in container|could not find tag for codec|codec not supported/i.test(r.stderr);
            throw new JobError(unsupported ? 'codec_unsupported' : 'ffmpeg_failed', `ffmpeg exited ${r.code}: ${tail}`, { permanent: unsupported });
        }
        const list = derive.existing(path.join(out, 'index.m3u8')) ? segments.parsePlaylist(fs.readFileSync(path.join(out, 'index.m3u8'), 'utf8')) : [];
        if (!list.length || !derive.existing(path.join(out, timeline.INIT_NAME))) throw new JobError('ffmpeg_failed', `ffmpeg wrote no segments: ${tail}`);

        const published = await segments.publishRendition({ job, ctx, src, rendition, out, list, label: 'Cmaf' });
        if (video === 'h264') require('../placement/metrics-binding').inc('media_cmaf_transcodes_total', { stream: 'video' });
        if (audio === 'aac') require('../placement/metrics-binding').inc('media_cmaf_transcodes_total', { stream: 'audio' });
        return {
            source_id: src.id, rendition, segments: published.segments, duration_ms: published.duration_ms, bytes: published.bytes,
            durable: published.durable, local_only: published.local_only, rows: published.rows, uploaded: published.uploaded,
            master_path: `/o/${src.id}/master.m3u8`, source_unchanged: true, video, audio,
        };
    } finally {
        derive.cleanupWork(job.id);
    }
}

module.exports = {
    spec: { lane: 'heavy', maxAttempts: 3, timeoutMs: () => config.hls.transcode ? 13 * 3600 * 1000 : 3 * 3600 * 1000, needsObject: true, validate, run },
    parsePlaylist: segments.parsePlaylist,
};
