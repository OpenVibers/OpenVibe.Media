/**
 * OpenVibe.Media — job type rendition.create (heavy lane; docs/media-fabric.md §5, F4 slice 1)
 *
 * One extra rendition of a ready media object, transcoded on demand: a 720p H.264/AAC ladder rung (`params.rendition`,
 * '720p'). It is a re-encode (libx264 + AAC), not a stream copy, of the source — or, equivalently, of the source
 * timeline, whose segment boundaries are forced keyframes here so ABR switches line up. The rows go through
 * timeline.replace(objectId, rendition, rows, { jobId }) (server/jobs/segments.js: the same content-addressed
 * placement, durable upload through the placement router, two-phase commit and stale-byte deletion as object.cmaf), and
 * object.pack is queued for the rendition once they are committed. The source object is never touched.
 *
 *   params { rendition ('720p') }
 *   result { source_id, rendition, target_height, segments, duration_ms, bytes, durable, local_only,
 *            rows: { inserted, updated, unchanged, removed }, uploaded, master_path }
 *   result { …, skipped: true, reason }   when the source is already this rendition's height or smaller (a still is not
 *                                        upscaled), or the rows already exist (skipped: false, already: true)
 *
 * Refused: MEDIA_HLS_ENABLED or MEDIA_RENDITIONS off, a source that is not ready or not media (permanent), an object
 * under a hold (retried), a source with no video stream (permanent), less free disk than the source size plus
 * MEDIA_UPLOAD_MIN_FREE_MB (retried later). Idempotent: a re-run whose bytes match reuses the rows and locations, and
 * only uploads what is not durable yet; an abort or a failure before the commit removes what it staged.
 *
 * The master playlist (GET /o/:id/master.m3u8) lists a rendition only once its rows exist, and the route / /download
 * enqueue this job lazily when one is missing (objects/hls.js, objects/timeline-queue.js): an idempotency key per
 * object and rendition answers a later request with the same job.
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
const DEFAULT_RENDITION = '720p';
// The ladder this slice ships: one rung. The name is the rendition key in media_timeline and the master playlist's URI
// prefix (`720p/index.m3u8`); the value is the target height (the source's aspect ratio is kept, width even).
const RENDITIONS = { '720p': 720 };

function hlsDisabled() {
    return new JobError('media.hls.disabled', 'Segment-native video is off on this server (MEDIA_HLS_ENABLED)', { permanent: true, status: 409 });
}

function disabled() {
    return new JobError('media.renditions.disabled', 'On-demand renditions are off on this server (MEDIA_RENDITIONS)', { permanent: true, status: 409 });
}

function validate({ obj, params }) {
    if (!config.hls.enabled) throw hlsDisabled();
    if (!config.hls.renditions) throw disabled();
    if (!obj) throw new JobError('media.job.invalid', 'rendition.create needs object_id', { permanent: true });
    if (!derive.isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) have renditions', { permanent: true });
    const p = { ...(params || {}) };
    const name = String(p.rendition || DEFAULT_RENDITION);
    if (!Object.prototype.hasOwnProperty.call(RENDITIONS, name)) throw new JobError('media.job.invalid', `params.rendition must be one of ${Object.keys(RENDITIONS).join(', ')}`, { permanent: true });
    p.rendition = name;
    return p;
}

/** A re-encode is far slower than the stream copy derive.budgetMs budgets: 8× it, under the job's own 3 h cap. */
function encodeBudgetMs(bytes) { return Math.min(3 * 3600 * 1000 - 60000, derive.budgetMs(bytes) * 8); }

/** The target segment length: the caller's, else the source timeline's own average (1-10 s), else 4. */
function segmentSeconds(job, srcRows) {
    if (job.params.segment_seconds) return Number(job.params.segment_seconds);
    if (srcRows.length) {
        const avg = srcRows.reduce((a, r) => a + (Number(r.end_ms) - Number(r.start_ms)), 0) / srcRows.length;
        const s = Math.round(avg / 1000);
        if (s >= 1 && s <= 10) return s;
    }
    return DEFAULT_SEGMENT_SECONDS;
}

async function run(job, ctx) {
    if (!config.hls.enabled) throw hlsDisabled();
    if (!config.hls.renditions) throw disabled();
    const src = await derive.loadSource(job);
    const rendition = String(job.params.rendition || DEFAULT_RENDITION);
    const targetHeight = RENDITIONS[rendition];
    if (!targetHeight) throw new JobError('media.job.invalid', `${rendition} is not a rendition of this server`, { permanent: true });
    if (await require('../objects/model').isHeld(src.id)) throw new JobError('media.object.held', 'The object is under a hold: no rendition is made', { retryAfterS: 6 * 3600 });
    // Rows already committed (another run, or a previous request): nothing to do. A pack may have moved them since.
    if (await timeline.has(src.id, rendition)) {
        const rows = await timeline.segments(src.id, rendition);
        return {
            source_id: src.id, rendition, target_height: targetHeight, already: true, skipped: false,
            segments: rows.length, duration_ms: rows.length ? Number(rows[rows.length - 1].end_ms) : 0,
            bytes: rows.reduce((a, r) => a + Number(r.byte_length), 0), master_path: `/o/${src.id}/master.m3u8`,
        };
    }
    const source = await derive.resolveSource(src);
    if (!source) throw new JobError('media_unavailable', 'The source bytes are unavailable (no local file and no cloud copy)', { permanent: true });
    const info = await require('../vod/media-tools').probeVodInfo(source.input);
    const video = (info.streams || []).find((s) => s.codec_type === 'video');
    if (!video) throw new JobError('no_video', 'The source has no video stream to rendition', { permanent: true });
    const height = Number(video.height) || 0;
    // A source already this rendition's height or smaller is not upscaled (a re-encode would only cost bytes).
    if (height > 0 && height <= targetHeight) {
        return { source_id: src.id, rendition, target_height: targetHeight, skipped: true, reason: `the source is ${height}p, not above ${rendition}`, segments: 0, duration_ms: 0, bytes: 0 };
    }
    segments.checkDisk(Number(src.size_bytes) || 0);
    const srcRows = await timeline.segments(src.id, timeline.SOURCE);
    const segSec = segmentSeconds(job, srcRows);
    // Force keyframes at the source timeline's segment boundaries (docs/media-fabric.md §3), so a switch to this
    // rendition lands on a boundary. A list longer than 2000 boundaries is skipped: the argument would be unwieldy,
    // and a source that long is packed long before it is re-encoded.
    const boundaries = srcRows.length && srcRows.length <= 2000 ? srcRows.map((r) => (Number(r.start_ms) / 1000).toFixed(3)) : [];
    const dir = derive.workDir(job.id);
    try {
        const out = path.join(dir, 'out');
        fs.mkdirSync(out, { recursive: true });
        const r = await derive.ffmpeg(['-y', '-nostdin', '-v', 'error', ...derive.inputArgs(source), '-i', source.input,
            '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', `scale=-2:${targetHeight}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
            ...(boundaries.length ? ['-force_key_frames', boundaries.join(',')] : []),
            '-map_metadata', '-1',
            '-f', 'hls', '-hls_time', String(segSec), '-hls_list_size', '0', '-hls_playlist_type', 'vod',
            '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', timeline.INIT_NAME,
            '-start_number', '1', '-hls_segment_filename', path.join(out, '%06d.m4s'), path.join(out, 'index.m3u8')],
        { signal: ctx.signal, timeoutMs: encodeBudgetMs(src.size_bytes) });
        segments.aborted(ctx);
        const tail = String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
        if (!r.ok) {
            const unsupported = /Unknown encoder|not currently supported in container|could not find tag for codec|codec not supported/i.test(r.stderr);
            throw new JobError(unsupported ? 'codec_unsupported' : 'ffmpeg_failed', `ffmpeg exited ${r.code}: ${tail}`, { permanent: unsupported });
        }
        const list = derive.existing(path.join(out, 'index.m3u8')) ? segments.parsePlaylist(fs.readFileSync(path.join(out, 'index.m3u8'), 'utf8')) : [];
        if (!list.length || !derive.existing(path.join(out, timeline.INIT_NAME))) throw new JobError('ffmpeg_failed', `ffmpeg wrote no segments: ${tail}`);

        const published = await segments.publishRendition({ job, ctx, src, rendition, out, list, label: 'Rendition' });
        return {
            source_id: src.id, rendition, target_height: targetHeight, skipped: false, already: false,
            segments: published.segments, duration_ms: published.duration_ms, bytes: published.bytes,
            durable: published.durable, local_only: published.local_only, rows: published.rows, uploaded: published.uploaded,
            master_path: `/o/${src.id}/master.m3u8`, source_unchanged: true,
        };
    } finally {
        derive.cleanupWork(job.id);
    }
}

module.exports = {
    spec: { lane: 'heavy', maxAttempts: 3, timeoutMs: 3 * 3600 * 1000, needsObject: true, validate, run },
    RENDITIONS, DEFAULT_RENDITION, renditionNames: () => Object.keys(RENDITIONS),
};
