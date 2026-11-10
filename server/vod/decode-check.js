'use strict';
/**
 * OpenVibe.Media — does a finished recording decode, and can a broken one be made good again?
 *
 * A recording is a stream copy of what the broadcaster sent. WebRTC has no retransmission to a recording consumer, so
 * a lost RTP packet arrives as a truncated H.264 access unit: ffmpeg's muxer writes it (it does not decode), and
 * browsers are not forgiving — Chrome stops the whole pipeline with MEDIA_ERR_DECODE on the first bad frame. The robot
 * phone's 2026-11-10 VODs 6297/6298 each had a truncated IDR (the keyframe at 1.175 s / 3.120 s, the large burst a
 * lossy uplink is most likely to lose a fragment of); ffmpeg concealed it and only complained at a later P-frame that
 * referenced it (1.7 s / 3.6 s), while Chrome rejected the IDR itself. A plain ffprobe never noticed either.
 *
 *   scan(file, { seconds = 10, timeoutMs })   decode the first seconds with `ffmpeg -xerror` and read the decoder's
 *                                             error lines. `ok` only when the exit code is 0 AND no serious decode
 *                                             error was logged: a tiny 1-thread stream can exit 0 on a bad frame, a
 *                                             big multi-thread one exits 183, and the null muxer's "non monotonically
 *                                             increasing dts" is a VFR artefact, never a fault. `seconds: 0` decodes
 *                                             the whole file (the operator repair script does this).
 *   repair(file, { durationSeconds })         re-encode the video to H.264/AAC in a temporary MP4 beside the file, verify
 *                                             that output's first seconds and its duration, then rename it over the
 *                                             file. A broken span cannot be cut out of a stream copy (every P-frame
 *                                             after it references the bad picture), so a decode + clean encode is the
 *                                             repair; the caller only does it on a file that failed `scan`.
 *
 * `repair` re-encodes and cannot recover the lost bytes: it replaces the corrupt access unit with the decoder's
 * concealed picture, so the result is a valid stream with a short glitch at the repair point. Video is H.264 High
 * (browser-safe) on its original timing (`-fps_mode passthrough`), with a keyframe every 4 s for the player and the
 * CMAF cut; audio is AAC. The file is replaced atomically on the same filesystem, so a reader never sees a half file.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tools = require('./media-tools');

const FIRST_SECONDS = 10;
const SCAN_TIMEOUT_MS = 120000;
const REPAIR_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const KEYFRAME_SECONDS = 4;

// A decoder error means the bytes are not the stream they claim to be. The null muxer's DTS complaints are the
// variable frame timing of a wall-clock-timestamped RTP capture, not a fault: every healthy recording logs them.
const SERIOUS = /error while decoding|corrupted macroblock|corrupt decoded frame|Error processing packet|Invalid level prefix|cbp too large|negative number of zero coeffs|Invalid NAL unit size|missing picture in access unit|concealing \d+ corrupted|decode_slice_header error|no frame!/i;

function _run(args, timeoutMs) {
    return new Promise((resolve) => {
        let proc;
        try { proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (err) { return resolve({ code: -1, stderr: err.message, timedOut: false }); }
        try { require('os').setPriority(proc.pid, 15); } catch { /* best effort */ }
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
        proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-20000); });
        proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stderr: err.message, timedOut }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
    });
}

function seriousLines(stderr) {
    return String(stderr || '').split('\n').map((l) => l.trim()).filter((l) => l && SERIOUS.test(l));
}

/**
 * Decode `filePath`'s first `seconds` (0 = the whole file) and say whether it is clean.
 * → { ok, code, timedOut, errors, seconds }
 */
async function scan(filePath, { seconds = FIRST_SECONDS, timeoutMs = SCAN_TIMEOUT_MS } = {}) {
    const args = ['-nostdin', '-v', 'warning', '-xerror', '-i', filePath, '-map', '0:v:0?', '-map', '0:a:0?'];
    if (seconds > 0) args.push('-t', String(seconds));
    // The null muxer duplicates/drops frames to a constant rate by default, which invents duplicate DTS on a
    // variable-timestamp capture; passthrough decodes the frames as they are, like a player's decoder does.
    args.push('-fps_mode', 'passthrough', '-f', 'null', '-');
    const r = await _run(args, timeoutMs);
    const errors = seriousLines(r.stderr);
    // "The input would not open" (missing file, unreadable container) is not a decode fault: finalize's stat and probe
    // paths already settle that. ffmpeg returns the same AVERROR_INVALIDDATA exit (183) for both, so an unopenable
    // input is told apart by its open error lines.
    const openFailed = /Error opening input|moov atom not found|detected only with low score|could not find codec parameters/i.test(r.stderr);
    return {
        ok: r.code === 0 && !r.timedOut && errors.length === 0,
        fault: errors.length > 0 || (r.code === 183 && !openFailed),
        code: r.code,
        timedOut: r.timedOut,
        errors: errors.slice(0, 8),
        seconds,
    };
}

function _freeBytes(dir) {
    try {
        const st = fs.statfsSync(dir);
        return Number(st.bavail) * Number(st.bsize);
    } catch { return Infinity; }
}

function _timeoutMs(durationSeconds) {
    const estimated = (Number(durationSeconds) || 300) * 4000 + 60000;
    return Math.max(5 * 60000, Math.min(3 * 3600 * 1000, estimated));
}

/**
 * Re-encode a broken MP4 in place (atomically) and verify the result. Refuses anything that is not a local MP4 with
 * a video stream, or when there is no room for the temporary file.
 * → { ok, error?, duration?, size? }
 */
async function repair(filePath, { durationSeconds = 0, timeoutMs = null } = {}) {
    if (!/\.mp4$/i.test(String(filePath))) return { ok: false, error: 'not_an_mp4' };
    let stat;
    try { stat = fs.statSync(filePath); } catch (err) { return { ok: false, error: `missing: ${err.message}` }; }
    const info = await tools.probeVodInfo(filePath);
    const video = (info.streams || []).find((s) => s.codec_type === 'video');
    if (!video) return { ok: false, error: 'no_video' };
    if (_freeBytes(path.dirname(filePath)) < stat.size + REPAIR_MIN_FREE_BYTES) return { ok: false, error: 'insufficient_disk' };

    const tmp = `${filePath}.repair-${process.pid}.mp4`;
    await tools.removeFile(tmp);
    const fullRange = /^(pc|j)$/i.test(String(video.color_range || '')) || /^yuvj/i.test(String(video.pix_fmt || ''));
    const args = [
        '-y', '-nostdin', '-v', 'error',
        '-fflags', '+genpts', '-i', filePath,
        '-map', '0:v:0', '-map', '0:a:0?',
        ...(fullRange ? ['-vf', 'scale=in_range=pc:out_range=tv'] : []),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-fps_mode', 'passthrough',
        '-force_key_frames', `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`, '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '160k',
        '-map_metadata', '-1', '-movflags', '+faststart', '-max_muxing_queue_size', '1024',
        '-f', 'mp4', tmp,
    ];
    const r = await _run(args, timeoutMs || _timeoutMs(durationSeconds || info.duration));
    if (r.code !== 0 || r.timedOut || !fs.existsSync(tmp)) {
        await tools.removeFile(tmp);
        const tail = String(r.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        return { ok: false, error: `encode_failed: ${r.timedOut ? 'timed out' : `exit ${r.code}`}${tail ? `: ${tail}` : ''}` };
    }
    const verified = await scan(tmp);
    const out = await tools.probeVodInfo(tmp);
    if (!verified.ok || !(out.duration > 0)) {
        await tools.removeFile(tmp);
        return { ok: false, error: `verify_failed: ${verified.errors[0] || 'no duration'}` };
    }
    try {
        fs.renameSync(tmp, filePath);
    } catch (err) {
        await tools.removeFile(tmp);
        return { ok: false, error: `replace_failed: ${err.message}` };
    }
    // The live DVR sidecars describe the bytes we just replaced.
    await tools.removeFile(filePath.replace(/\.mp4$/i, '.seekable.mp4'));
    return { ok: true, duration: out.duration, size: fs.statSync(filePath).size };
}

module.exports = { scan, repair, seriousLines, FIRST_SECONDS };
