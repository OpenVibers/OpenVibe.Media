'use strict';

/**
 * OpenVibe.Media — a video attachment's web copy (docs/attachments.md)
 *
 * A browser plays two things well: an MP4 with H.264 and AAC, and a WebM with VP8/VP9/AV1 and Opus/Vorbis.
 * Everything else a person can attach — an MKV, an AVI, a WMV, a FLV, a 3GP, an HEVC MOV, an MP4 whose
 * index sits at the end of the file — is stored as it is and served as it is, so the player shows a black
 * box. This module answers two questions about a stored video:
 *
 *   probe(file)     what it is: the container (from the bytes), the codecs, the length, the size after the
 *                   rotation is applied, the frame rate, and whether the MP4 index comes first (faststart).
 *   webSafe(info)   whether a browser can play it as it is. Web-safe: the container is MP4 or WebM, the video
 *                   is H.264, VP8, VP9 or AV1, the audio is AAC, Opus or Vorbis (or there is none), and an
 *                   MP4 has its moov atom first.
 *
 * A file that is not web-safe gets a copy made in the background (server/jobs/attachment-playback.js) with
 * copyArgs(): H.264 (yuv420p) + AAC in an MP4 whose index comes first, at most 1080 lines tall, the source
 * frame rate up to 60, the rotation applied.
 */

const fs = require('fs');
const ctypes = require('../objects/content-type');
const mediaTools = require('../vod/media-tools');

// The codecs a browser plays.
const WEB_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const WEB_AUDIO_CODECS = new Set(['aac', 'opus', 'vorbis']);
const WEB_CONTAINERS = new Set(['mp4', 'webm']);
// How much of the file the faststart check reads (the moov atom is at the front when it is there).
const FASTSTART_WINDOW = 4 * 1024 * 1024;

/** The rotation a stream carries, in degrees (0, 90, 180, 270). ffprobe reports it in the tags or beside the stream. */
function rotationOf(stream) {
    if (!stream) return 0;
    const fromTags = Number(stream.tags && stream.tags.rotate);
    if (Number.isFinite(fromTags) && fromTags) return Math.abs(Math.round(fromTags / 90) * 90) % 360;
    const sides = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
    for (const s of sides) {
        const r = Number(s.rotation);
        if (Number.isFinite(r) && r) return Math.abs(Math.round(r / 90) * 90) % 360;
    }
    return 0;
}

/** '30/1' -> 30. */
function rateOf(stream) {
    if (!stream) return 0;
    for (const raw of [stream.avg_frame_rate, stream.r_frame_rate]) {
        const text = String(raw || '');
        if (!text || text === '0/0') continue;
        const [n, d] = text.split('/').map(Number);
        if (!Number.isFinite(n) || !Number.isFinite(d) || !d) continue;
        const fps = n / d;
        if (fps > 0 && Number.isFinite(fps)) return fps;
    }
    return 0;
}

/**
 * Does this MP4 have its moov atom first? The boxes are walked from the front: the first 'moov' before the
 * first 'mdat' means the index is at the front, so a player can start without fetching the whole file.
 * False for a file that is not an MP4 (the rule does not apply there) and for one whose index is at the end.
 */
function faststart(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.statSync(file).size;
        const window = Math.min(FASTSTART_WINDOW, size);
        const buf = Buffer.alloc(window);
        const got = fs.readSync(fd, buf, 0, window, 0);
        let off = 0;
        let moov = null;
        let mdat = null;
        while (off + 8 <= got) {
            let size32 = buf.readUInt32BE(off);
            const type = buf.subarray(off + 4, off + 8).toString('latin1');
            let header = 8;
            if (size32 === 1) {
                if (off + 16 > got) break;
                size32 = Number(buf.readBigUInt64BE(off + 8));
                header = 16;
            } else if (size32 === 0) {
                size32 = size - off;   // the box runs to the end of the file
            }
            if (type === 'moov' && moov == null) moov = off;
            if (type === 'mdat' && mdat == null) mdat = off;
            if (moov != null && mdat != null) break;
            if (size32 < header) break;
            off += size32;
        }
        return moov != null && (mdat == null || moov < mdat);
    } catch { return false; } finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* */ } } }
}

/**
 * Everything Media knows about a stored video.
 *   -> { ok, reason, container, duration_s, width, height, rotation, video_codec, audio_codec, fps, faststart }
 * width/height are the size the video is shown at (the rotation applied). ok is false when ffprobe could not
 * read the file; reason says why.
 */
async function probe(file, { timeoutMs = 30000 } = {}) {
    const container = ctypes.container(ctypes.readHead(file));
    const info = await mediaTools.probeDuration(file, { timeoutMs });
    if (!info || !info.ok) return { ok: false, reason: (info && info.error) || 'the video could not be read', container };
    const streams = Array.isArray(info.streams) ? info.streams : [];
    const video = streams.find((s) => s.codec_type === 'video' && Number(s.width) > 0) || streams.find((s) => s.codec_type === 'video') || null;
    const audio = streams.find((s) => s.codec_type === 'audio') || null;
    const rotation = rotationOf(video);
    let width = Number(video && video.width) || 0;
    let height = Number(video && video.height) || 0;
    if (rotation === 90 || rotation === 270) { const w = width; width = height; height = w; }
    const duration = Number(info.seconds) || Number(info.format && info.format.duration) || 0;
    return {
        ok: true, reason: null, container,
        duration_s: duration > 0 ? Math.round(duration * 1000) / 1000 : 0,
        width: width || null, height: height || null, rotation,
        video_codec: video ? String(video.codec_name || '') : null,
        audio_codec: audio ? String(audio.codec_name || '') : null,
        fps: rateOf(video),
        faststart: container === 'mp4' ? faststart(file) : false,
    };
}

/**
 * Can a browser play this file as it is? -> { safe, reason }. The rule: the container is MP4 or WebM, the
 * video is H.264, VP8, VP9 or AV1, the audio is AAC, Opus or Vorbis (or there is none), and an MP4 has its
 * index first. Everything else gets a web copy made in the background.
 */
function webSafe(info) {
    if (!info || !info.ok) return { safe: false, reason: (info && info.reason) || 'the video could not be read' };
    if (!info.video_codec) return { safe: false, reason: 'the file has no video stream' };
    if (!WEB_VIDEO_CODECS.has(info.video_codec)) return { safe: false, reason: `${info.video_codec} does not play in a browser` };
    if (info.audio_codec && !WEB_AUDIO_CODECS.has(info.audio_codec)) return { safe: false, reason: `${info.audio_codec} does not play in a browser` };
    if (!WEB_CONTAINERS.has(info.container)) return { safe: false, reason: `${info.container || 'this container'} does not play in a browser` };
    if (info.container === 'mp4' && !info.faststart) return { safe: false, reason: 'the MP4 index is at the end of the file' };
    return { safe: true, reason: null };
}

/**
 * The ffmpeg arguments that make the web copy: H.264 (yuv420p) + AAC in an MP4 whose index comes first
 * (-movflags +faststart), at most `maxHeight` lines tall, the source frame rate up to `maxFps`, the rotation
 * applied (-autorotate, the ffmpeg default, said out loud so the output is never rotated twice).
 */
function copyArgs({ input, output, info = {}, maxHeight = 1080, maxFps = 60, crf = 23, preset = 'veryfast', threads = 2, audio = true }) {
    const height = Number(info.height) || 0;
    const fps = Number(info.fps) || 0;
    const args = ['-y', '-nostdin', '-v', 'error', '-autorotate', '1', '-i', String(input),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-threads', String(threads)];
    if (height > maxHeight) args.push('-vf', `scale=-2:${maxHeight}`);
    if (fps > 0) args.push('-r', String(Math.round(Math.min(maxFps, fps) * 1000) / 1000));
    if (audio) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    else args.push('-an');
    args.push('-movflags', '+faststart', '-map_metadata', '-1', String(output));
    return args;
}

module.exports = {
    WEB_VIDEO_CODECS, WEB_AUDIO_CODECS, WEB_CONTAINERS,
    probe, webSafe, copyArgs, faststart, rotationOf, rateOf,
};
