/**
 * OpenVibe.Media — server-side clip cutter
 *
 * Cuts a clip from any source ffmpeg can read (a local VOD/recording file OR a
 * presigned B2/R2 URL) and creates/updates the clip row + thumbnail. Ported
 * from the predecessor (AI overview + chat-notify hooks dropped — Live owns
 * those); no req/res coupling.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../db/database');
const config = require('../config');

const CLIPS_DIR = path.resolve(config.vod.clipsPath);
// libvpx is SLOW — measured at ~3.3x realtime on an idle box, so a 25s clip takes ~8s
// alone but several times that when encodes overlap. Three at once on a 4-core box that
// also runs live x264 and whisper is how clips ended up timing out in batches.
const MAX_CONCURRENT = parseInt(process.env.CLIP_MAX_CONCURRENT_FFMPEG || '2', 10);
// How long a cut will queue for a free encoder slot before giving up. Sized for a BULK
// backlog, not a single request: re-cutting 12 clips at 2 concurrent, each taking 1-3
// minutes on a loaded box, left the tail waiting well past the old 5 minutes and they
// were written off as failed. This is a background job, so waiting costs nothing.
const QUEUE_WAIT_MS = parseInt(process.env.CLIP_QUEUE_WAIT_MS || '1800000', 10);
let _active = 0;

function _ffprobe(file) {
    return new Promise((resolve) => {
        const ff = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        ff.stdout.on('data', d => { out += d; });
        const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } resolve(null); }, 15000);
        ff.on('close', () => { clearTimeout(to); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
        ff.on('error', () => { clearTimeout(to); resolve(null); });
    });
}

function isBusy() {
    return _active >= MAX_CONCURRENT;
}

/**
 * Cut a clip file. Returns { ok, filePath, duration } or { ok: false, error }.
 * @param {object} o
 * @param {string} o.source     local path OR http(s) URL ffmpeg can read
 * @param {number} o.startTime  seconds into the source to start
 * @param {number} o.duration   clip length in seconds
 */
async function cutClipFile({ source, startTime, duration }) {
    if (!source || !(duration >= 1)) return { ok: false, error: 'Invalid cut parameters' };
    const isUrl = /^https?:\/\//i.test(String(source));
    if (!isUrl && !fs.existsSync(source)) return { ok: false, error: 'Source missing' };
    // Wait for a free encoder slot rather than failing. Returning 'busy' here marked the
    // clip FAILED permanently for a purely transient reason — fire a handful of re-cuts at
    // once and everything past MAX_CONCURRENT was written off instantly. This is a
    // background job with no deadline, so queueing is always the right answer.
    if (isBusy()) {
        const waitedOk = await new Promise((resolve) => {
            const deadline = Date.now() + QUEUE_WAIT_MS;
            const tick = () => {
                if (!isBusy()) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(tick, 500);
            };
            tick();
        });
        if (!waitedOk) return { ok: false, error: `encoder busy for over ${Math.round(QUEUE_WAIT_MS / 1000)}s` };
    }
    try { if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true }); } catch { /* */ }

    const ss = Math.max(0, Number(startTime) || 0);
    const dur = Math.max(1, Number(duration) || 20);
    const filename = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`;
    const outPath = path.join(CLIPS_DIR, filename);

    _active++;
    let timedOut = false;
    let exitCode = null;
    const _stderrRef = { get: () => '' };
    // Re-encode the (short) clip instead of stream-copying. `-ss` before `-i`
    // is a fast seek to the nearest keyframe, and because we re-encode, ffmpeg
    // then decodes to the EXACT requested start — the clip begins precisely
    // where asked with a fresh keyframe at t=0. A `-c copy` cut can only start
    // on a source keyframe, which on sparsely-keyframed live recordings means
    // an opening of black/frozen frames.
    const ok = await new Promise((resolve) => {
        const args = [
            '-y', '-ss', String(ss), '-i', source, '-t', String(dur),
            '-c:v', 'libvpx', '-b:v', '2000k', '-crf', '18', '-deadline', 'realtime', '-cpu-used', '4',
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'libopus', '-b:a', '128k',
            '-avoid_negative_ts', 'make_zero', '-f', 'webm', outPath,
        ];
        // Keep stderr. It used to be discarded, so every failure surfaced as the useless
        // string "ffmpeg cut failed" and the only way to learn anything was to reproduce
        // the command by hand.
        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let errTail = '';
        ff.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000); });
        // Budget generously: this is a background job with no deadline, and the old
        // dur*2 + 40s budget was tight enough that a burst of concurrent encodes on a
        // busy box blew through it — which is exactly how a batch of clips failed at once.
        const budgetMs = Math.round(dur) * 8000 + (isUrl ? 90000 : 45000);
        const to = setTimeout(() => { timedOut = true; try { ff.kill('SIGKILL'); } catch { /* */ } resolve(false); }, budgetMs);
        ff.on('close', (code) => { clearTimeout(to); exitCode = code; resolve(code === 0); });
        ff.on('error', (e) => { clearTimeout(to); errTail += `\nspawn error: ${e.message}`; resolve(false); });
        _stderrRef.get = () => errTail;
    }).finally(() => { _active = Math.max(0, _active - 1); });

    if (!ok) {
        try { fs.existsSync(outPath) && fs.unlinkSync(outPath); } catch { /* */ }
        // Surface ffmpeg's own last words — the real reason, not a generic label.
        const tail = String(_stderrRef.get() || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
        const why = timedOut
            ? `ffmpeg timed out after ${Math.round((Math.round(dur) * 8000 + (isUrl ? 90000 : 45000)) / 1000)}s`
            : `ffmpeg exited ${exitCode}`;
        return { ok: false, error: tail ? `${why}: ${tail}` : why };
    }

    // Validate real decodable footage (a seek near EOF can yield a header-only file).
    const pi = await _ffprobe(outPath);
    const hasVideo = pi && (pi.streams || []).some(s => s.codec_type === 'video');
    const realDur = pi && pi.format ? Number(pi.format.duration) : 0;
    if (!hasVideo || !(realDur >= 1)) {
        try { fs.unlinkSync(outPath); } catch { /* */ }
        return { ok: false, error: 'No decodable footage in the requested window' };
    }

    return { ok: true, filePath: outPath, duration: realDur };
}

/**
 * Cut a clip and create its row (used by internal jobs; the API route creates
 * the row first and updates it). Returns the created clip row, or null.
 */
async function cutClip(o) {
    const { appId, source, startTime, duration, streamId, vodId = null, userId, title, description = '', isPublic = 1, autoGenerated = true } = o || {};
    if (!appId) return null;
    const cut = await cutClipFile({ source, startTime, duration });
    if (!cut.ok) return null;

    const ss = Math.max(0, Number(startTime) || 0);
    const res = db.createClip({
        app_id: appId, vod_id: vodId, stream_id: streamId, user_id: userId,
        title: (title || 'Auto Clip').slice(0, 200), description: description || '',
        file_path: cut.filePath, start_time: ss, end_time: ss + cut.duration, duration_seconds: cut.duration,
        is_public: (isPublic === 0 || isPublic === false) ? 0 : 1,
        auto_generated: autoGenerated ? 1 : 0,
        status: 'ready',
    });
    const clipId = res && res.lastInsertRowid;
    if (!clipId) return null;
    const clip = db.getClipById(clipId);
    try { require('../thumbnails/thumbnail-service').generateClipThumbnail(clipId, cut.filePath).catch(() => {}); } catch { /* */ }
    return clip;
}

module.exports = { cutClip, cutClipFile, isBusy, CLIPS_DIR };
