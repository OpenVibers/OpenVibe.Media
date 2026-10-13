/**
 * OpenVibe.Media — shared ffmpeg/ffprobe helpers
 *
 * Extracted from the predecessor's VOD routes: seekable remux (WebM cues /
 * MP4 faststart), DVR sidecar remux for live recordings, probes, and the
 * browser-chunk segment concat used by the chunked upload flow.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');

/**
 * Seconds of the last `time=HH:MM:SS.xx` progress stamp in ffmpeg's stderr, or 0. A stream-copy
 * run reports the timestamp of the last packet it wrote, which is the media's real length even
 * when the container header has no (or a wrong) duration.
 */
function lastProgressSeconds(text) {
    const re = /time=\s*(-?\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g;
    let m, last = null;
    while ((m = re.exec(String(text || '')))) last = m;
    if (!last) return 0;
    const s = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
    return Number.isFinite(s) && s > 0 ? s : 0;
}

/** Keep the tail of a growing ffmpeg stderr (a multi-hour run prints megabytes of progress). */
function tailAppend(buf, chunk, max = 16384) {
    const out = buf + chunk;
    return out.length > max ? out.slice(-max) : out;
}

// ── Big files off the event loop ─────────────────────────────
// Freeing a multi-GB recording takes ext4 seconds under load, and an unlinkSync/renameSync holds
// every Media request for that long: on 2026-10-13 the live DVR remux of a 4-hour recording froze
// the event loop for up to 14 s at a time and Prometheus marked Media down. Recordings, their
// sidecars and remux temp files are removed and replaced with fs.promises only.

/** Remove a file without holding the event loop. → true when nothing is left at that path; never throws. */
function removeFile(filePath) {
    if (!filePath) return Promise.resolve(false);
    return fsp.rm(filePath, { force: true }).then(() => true, () => false);
}

/**
 * Whether the disk holding `dir` can take `bytes` more and still keep its reserve (5 GB or a tenth of
 * the disk, whichever is larger). A copy-mode remux writes a whole second copy of its input, and the
 * disk is shared with PostgreSQL. An unreadable statfs does not stop the caller.
 */
async function hasRoomFor(dir, bytes) {
    let s;
    try { s = await fsp.statfs(dir); } catch { return true; }
    const free = s.bavail * s.bsize;
    return free - bytes >= Math.max(5e9, s.blocks * s.bsize * 0.1);
}

/**
 * Kill budget of a copy-mode remux of `bytes`: it still rewrites every byte (twice for +faststart),
 * and a flat 60 s killed every multi-hour recording, which left them fragmented with no seek index,
 * so every clip cut from cloud storage had to scan the whole file and timed out. ~45 s per GB,
 * 3 min floor, 45 min ceiling.
 */
function remuxBudgetMs(bytes) {
    return Math.min(45 * 60000, Math.max(180000, Math.round(bytes / 1e9 * 45000) + 60000));
}

/**
 * Run ffmpeg to its end. → { code, stderr } (code null when it could not start or was killed).
 * SIGKILLed after budgetMs (onTimeout runs first); onSpawn sees the process (the live remux keeps it to stop it).
 */
function runFfmpeg(args, { budgetMs, onTimeout, onSpawn } = {}) {
    return new Promise((resolve) => {
        let proc;
        try { proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (err) { return resolve({ code: null, stderr: err.message }); }
        let stderr = '', done = false;
        const killer = budgetMs ? setTimeout(() => { if (onTimeout) onTimeout(); try { proc.kill('SIGKILL'); } catch {} }, budgetMs) : null;
        const finish = (code) => { if (done) return; done = true; clearTimeout(killer); resolve({ code, stderr }); };
        proc.stderr.on('data', d => { stderr = tailAppend(stderr, String(d)); });
        proc.on('close', (code) => finish(code));
        proc.on('error', (err) => { stderr = tailAppend(stderr, err.message); finish(null); });
        if (onSpawn) onSpawn(proc);
    });
}

/**
 * Remux a WebM/MP4 file with ffmpeg to add proper seek metadata.
 * WebM files from MediaRecorder lack Cues and often have Inf duration,
 * which prevents browser-side seeking. A fast copy-remux fixes this.
 * MP4: rewrite the fragmented recording into a plain, faststart (moov-at-front)
 * MP4 so finished-VOD playback seeks instantly. Replaces the original in-place.
 * Skipped ('no room for the remux copy') when the disk cannot take the copy next to the original.
 *
 * Resolves { ok, seconds, error }: `seconds` is the last packet time the remux wrote (0 when it
 * failed: a partial run's time says nothing about the file).
 */
async function remuxForSeekingDetailed(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.webm' && ext !== '.mp4') return { ok: false, seconds: 0, error: 'unsupported container' }; // WebM + MP4 only

    let bytes = 0; try { bytes = (await fsp.stat(filePath)).size; } catch { /* ffmpeg reports the missing file */ }
    if (!(await hasRoomFor(path.dirname(filePath), bytes))) {
        console.warn(`[VOD] Remux of ${path.basename(filePath)} skipped: not enough free disk for a ${(bytes / 1e9).toFixed(1)} GB copy`);
        return { ok: false, seconds: 0, error: 'no room for the remux copy' };
    }

    const tmpPath = filePath + '.remux' + ext;
    const outArgs = ext === '.mp4'
        ? ['-c', 'copy', '-movflags', '+faststart', '-fflags', '+genpts']
        : ['-c', 'copy', '-fflags', '+genpts'];
    const budgetMs = remuxBudgetMs(bytes);
    const { code, stderr } = await runFfmpeg(['-y', '-i', filePath, ...outArgs, tmpPath], {
        budgetMs, onTimeout: () => console.warn(`[VOD] Remux of ${path.basename(filePath)} exceeded ${Math.round(budgetMs / 1000)} s — killed`),
    });
    if (code === 0 && fs.existsSync(tmpPath)) {
        try {
            await fsp.rename(tmpPath, filePath);
            console.log(`[VOD] Remuxed for seeking: ${path.basename(filePath)}`);
            return { ok: true, seconds: lastProgressSeconds(stderr), error: null };
        } catch (err) {
            console.warn(`[VOD] Remux rename failed:`, err.message);
            await removeFile(tmpPath);
            return { ok: false, seconds: 0, error: err.message };
        }
    }
    await removeFile(tmpPath);
    console.warn(`[VOD] Remux failed (code ${code}): ${stderr.slice(-200)}`);
    return { ok: false, seconds: 0, error: `ffmpeg remux exited ${code}` };
}

/** remuxForSeekingDetailed(), answering true/false (the callers that only need the outcome). */
function remuxForSeeking(filePath) {
    return remuxForSeekingDetailed(filePath).then(r => r.ok);
}

const isUrl = (src) => /^https?:\/\//i.test(String(src || ''));
// A remote source (a presigned B2/R2 URL) is read with ranged HTTP requests; nothing else is allowed.
const urlArgs = (src) => (isUrl(src) ? ['-protocol_whitelist', 'https,http,tls,tcp', '-rw_timeout', '30000000'] : []);

/**
 * ffprobe a local file or a presigned https URL (ranged reads). Resolves
 * { ok, seconds (float, 0 when the container states no duration), format, streams, error };
 * ok is false when ffprobe could not read the source at all.
 */
function probeDuration(src, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve) => {
        let proc, out = '', done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(killer); resolve(r); };
        try {
            proc = spawn('ffprobe', ['-v', 'quiet', ...urlArgs(src), '-print_format', 'json', '-show_format', '-show_streams', String(src)],
                { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (err) { return resolve({ ok: false, seconds: 0, format: null, streams: [], error: err.message }); }
        const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish({ ok: false, seconds: 0, format: null, streams: [], error: `ffprobe timed out after ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
        proc.stdout.on('data', d => { out += d; });
        proc.on('error', (err) => finish({ ok: false, seconds: 0, format: null, streams: [], error: err.message }));
        proc.on('close', (code) => {
            let info = null;
            try { info = JSON.parse(out); } catch { /* unreadable */ }
            if (!info || !info.format) return finish({ ok: false, seconds: 0, format: null, streams: [], error: `ffprobe could not read the source (exit ${code})` });
            const d = parseFloat(info.format.duration);
            finish({ ok: true, seconds: Number.isFinite(d) && d > 0 ? d : 0, format: info.format, streams: info.streams || [], error: null });
        });
    });
}

/**
 * The media's length measured by reading every packet: a stream-copy pass into the null muxer
 * (nothing is written). Resolves { ok, seconds, error }. For containers whose header has no
 * duration (a live WebM, a fragmented MP4 that was never remuxed) and to cross-check one that
 * looks wrong. Reads the whole source: a remote one is downloaded in full.
 */
function streamCopyDuration(src, { timeoutMs = 20 * 60 * 1000 } = {}) {
    return new Promise((resolve) => {
        let proc, err = '', done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(killer); resolve(r); };
        try {
            proc = spawn('ffmpeg', ['-nostdin', '-hide_banner', ...urlArgs(src), '-i', String(src), '-map', '0', '-c', 'copy', '-f', 'null', '-'],
                { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) { return resolve({ ok: false, seconds: 0, error: e.message }); }
        const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish({ ok: false, seconds: 0, error: `stream-copy pass timed out after ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
        proc.stderr.on('data', d => { err = tailAppend(err, String(d)); });
        proc.on('error', (e) => finish({ ok: false, seconds: 0, error: e.message }));
        proc.on('close', (code) => {
            const seconds = code === 0 ? lastProgressSeconds(err) : 0;
            finish(seconds > 0 ? { ok: true, seconds, error: null } : { ok: false, seconds: 0, error: `stream-copy pass gave no duration (exit ${code})` });
        });
    });
}

/**
 * The stored duration of a recording, from what was measured — never from the wall clock.
 *   probeS  ffprobe's container duration of the finished file (0 = none / unreadable)
 *   remuxS  the last packet time of a stream-copy pass over it (0 = none)
 *   wallS   how long the recorder ran, when it is known (a bound only, never a value)
 * Returns { seconds, source: 'probe' | 'remux' | 'unknown', issues }. A container header far
 * longer than the packet timeline is corrupt, so the packets win; a value longer than the
 * recorder ran (1.5x + 30 s) is impossible, so it is refused. Nothing usable: 0, 'unknown'.
 */
function chooseDuration({ probeS = 0, remuxS = 0, wallS = null } = {}) {
    const issues = [];
    let probe = probeS > 0 ? probeS : 0;
    const remux = remuxS > 0 ? remuxS : 0;
    if (probe && remux && probe > remux * 1.5 + 30) { issues.push('inflated_container_duration'); probe = 0; }
    const limit = wallS > 0 ? wallS * 1.5 + 30 : Infinity;
    for (const [s, source] of [[probe, 'probe'], [remux, 'remux']]) {
        if (!s) continue;
        if (s > limit) { if (!issues.includes('inflated_duration')) issues.push('inflated_duration'); continue; }
        return { seconds: s, source, issues };
    }
    if (!probeS && !remuxS) issues.push('probe_failed');
    return { seconds: 0, source: 'unknown', issues };
}

/** Probe a media file's start_time (seconds), or 0 if probing fails. */
function probeStartTime(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json',
            '-show_entries', 'format=start_time',
            filePath,
        ]);
        let out = '';
        probe.stdout.on('data', d => out += d);
        probe.on('close', () => {
            try {
                const info = JSON.parse(out);
                const startTime = parseFloat(info.format?.start_time || '0');
                resolve(Number.isFinite(startTime) && startTime > 0 ? startTime : 0);
            } catch { resolve(0); }
        });
        probe.on('error', () => resolve(0));
        setTimeout(() => { try { probe.kill(); } catch {} resolve(0); }, 5000);
    });
}

function probeVodDuration(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json',
            '-show_format', filePath,
        ]);
        let out = '';
        probe.stdout.on('data', d => out += d);
        probe.on('close', () => {
            try {
                const info = JSON.parse(out);
                const duration = Math.round(parseFloat(info.format?.duration || '0'));
                resolve(duration > 0 ? duration : 0);
            } catch { resolve(0); }
        });
        probe.on('error', () => resolve(0));
        setTimeout(() => { try { probe.kill(); } catch {} resolve(0); }, 10000);
    });
}

function probeVodInfo(filePath) {
    return new Promise((resolve) => {
        const probe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json',
            '-show_format', '-show_streams',
            filePath,
        ]);
        let out = '';
        probe.stdout.on('data', d => out += d);
        probe.on('close', () => {
            try {
                const info = JSON.parse(out);
                const duration = Math.round(parseFloat(info.format?.duration || '0'));
                resolve({
                    duration: duration > 0 ? duration : 0,
                    format: info.format || null,
                    streams: info.streams || [],
                });
            } catch { resolve({ duration: 0, format: null, streams: [] }); }
        });
        probe.on('error', () => resolve({ duration: 0, format: null, streams: [] }));
        setTimeout(() => { try { probe.kill(); } catch {} resolve({ duration: 0, format: null, streams: [] }); }, 10000);
    });
}

function getFileSizeSafe(filePath) {
    try { return filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch { return 0; }
}

function cleanupTempFile(filePath) {
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// ── Live DVR sidecar ─────────────────────────────────────────

// Per recording: { running, proc, notBefore, retired, warned }. Every pass rewrites the whole growing
// file (twice for MP4 +faststart), so a 4-hour recording's pass takes minutes and its copy is as big
// as the recording. One pass runs at a time, it may use at most 1/LIVE_REMUX_DUTY of the wall clock
// (the next waits 9× as long as the last took), its kill budget scales with the file, and it is
// skipped while the disk cannot take the copy. The old flat 30 s kill cut every long pass short,
// dropped the guard while ffmpeg still ran and let the next tick start another full copy.
const _liveRemux = new Map();
const LIVE_REMUX_DUTY = 10;
const LIVE_REMUX_NICE = 10;

function seekableSidecarPath(filePath) {
    if (!filePath) return null;
    if (filePath.endsWith('.webm')) return filePath.replace(/\.webm$/, '.seekable.webm');
    if (filePath.endsWith('.mp4')) return filePath.replace(/\.mp4$/, '.seekable.mp4');
    return null;
}

/**
 * Produce a fully-indexed seekable snapshot of the growing recording so DVR
 * viewers can seek anywhere without the whole file. WebM: copy-remux to write
 * cues. MP4: copy-remux with +faststart so a complete moov sits at the front.
 * Writes to <file>.seekable.<ext> WITHOUT touching the growing original.
 * → true when a new snapshot replaced the old one; false when this call did nothing
 * (a pass is running or not yet due, no room, or the pass failed).
 */
async function remuxForLiveSeeking(filePath) {
    const seekablePath = seekableSidecarPath(filePath);
    if (!seekablePath) return false;
    let state = _liveRemux.get(filePath);
    if (!state) _liveRemux.set(filePath, state = { running: false, proc: null, notBefore: 0, retired: false, warned: false });
    if (state.running || Date.now() < state.notBefore) return false;
    state.running = true;
    const started = Date.now();
    const tmpPath = filePath + (filePath.endsWith('.mp4') ? '.live-remux.tmp.mp4' : '.live-remux.tmp.webm');
    try {
        let bytes;
        try { bytes = (await fsp.stat(filePath)).size; } catch { return false; }
        if (!(await hasRoomFor(path.dirname(filePath), bytes))) {
            if (!state.warned) console.warn(`[VOD] Live seek snapshot of ${path.basename(filePath)} paused: not enough free disk for a ${(bytes / 1e9).toFixed(1)} GB copy`);
            state.warned = true;
            return false;
        }
        state.warned = false;
        const outArgs = filePath.endsWith('.mp4')
            ? ['-c', 'copy', '-movflags', '+faststart', '-fflags', '+genpts']
            : ['-c', 'copy', '-fflags', '+genpts'];
        const { code } = await runFfmpeg(['-y', '-i', filePath, ...outArgs, tmpPath], {
            budgetMs: remuxBudgetMs(bytes),
            // Lower priority than the recordings it copies. Only with a pid: setPriority(undefined) renices Media itself.
            onSpawn: (proc) => { state.proc = proc; if (proc.pid) { try { os.setPriority(proc.pid, LIVE_REMUX_NICE); } catch { /* not permitted: run as is */ } } },
        });
        state.proc = null;
        if (code === 0 && !state.retired && fs.existsSync(tmpPath)) {
            try {
                await fsp.rename(tmpPath, seekablePath);
                if (state.retired) await removeFile(seekablePath);   // finalized while it was renaming
                return !state.retired;
            } catch (err) { console.warn(`[VOD] Live remux rename failed:`, err.message); }
        }
        await removeFile(tmpPath);
        return false;
    } finally {
        state.running = false;
        state.notBefore = Date.now() + (Date.now() - started) * (LIVE_REMUX_DUTY - 1);
    }
}

/**
 * Clean up the .seekable.* sidecar after finalization. Guard: the sidecar path
 * must differ from the VOD itself (a bad regex fall-through would otherwise
 * delete the recording); seekableSidecarPath returns null for unknown exts.
 * Stops a live pass still running for it (that pass removes its own temp file).
 * The removal runs off the event loop. → a promise of it; callers need not wait.
 */
function cleanupSeekableFile(filePath) {
    const seekablePath = seekableSidecarPath(filePath);
    if (!seekablePath || seekablePath === filePath) return Promise.resolve(false);
    const state = _liveRemux.get(filePath);
    _liveRemux.delete(filePath);
    if (state) { state.retired = true; try { if (state.proc) state.proc.kill('SIGKILL'); } catch { /* already gone */ } }
    return removeFile(seekablePath);
}

// ── Browser-chunk segments (chunked upload flow) ─────────────

function makeSegmentPath(filePath, segmentId) {
    const base = filePath.replace(/\.webm$/, '');
    return `${base}.seg-${segmentId}-${Date.now()}.webm`;
}

function getPendingSegmentFiles(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.webm$/, '');
    try {
        return fs.readdirSync(dir)
            .filter((name) => name.startsWith(`${base}.seg-`) && name.endsWith('.webm'))
            .map((name) => path.join(dir, name))
            .sort((a, b) => {
                const am = /\.seg-(\d+)-(\d+)\.webm$/.exec(a);
                const bm = /\.seg-(\d+)-(\d+)\.webm$/.exec(b);
                const aSeg = parseInt(am?.[1] || '0', 10);
                const bSeg = parseInt(bm?.[1] || '0', 10);
                if (aSeg !== bSeg) return aSeg - bSeg;
                const aTs = parseInt(am?.[2] || '0', 10);
                const bTs = parseInt(bm?.[2] || '0', 10);
                return aTs - bTs;
            });
    } catch {
        return [];
    }
}

async function concatWebmFiles(basePath, appendPath) {
    if (!appendPath || !fs.existsSync(appendPath)) return true;
    if (!basePath || !fs.existsSync(basePath)) {
        try { await fsp.rename(appendPath, basePath); return true; } catch { return false; }
    }

    const listPath = `${basePath}.concat.${Date.now()}.txt`;
    const tmpPath = `${basePath}.concat.tmp.webm`;
    const escapedBase = basePath.replace(/'/g, `'\\''`);
    const escapedAppend = appendPath.replace(/'/g, `'\\''`);
    fs.writeFileSync(listPath, `file '${escapedBase}'\nfile '${escapedAppend}'\n`, 'utf8');
    // The copy pass rewrites the whole recording: its budget scales with it (a flat 120 s cut long ones short).
    const budgetMs = remuxBudgetMs(getFileSizeSafe(basePath) + getFileSizeSafe(appendPath));

    try {
        let result = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-fflags', '+genpts', tmpPath], { budgetMs });
        if (result.code !== 0 || !fs.existsSync(tmpPath)) {
            result = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k', tmpPath], { budgetMs });
        }
        if (result.code === 0 && fs.existsSync(tmpPath)) {
            await fsp.rename(tmpPath, basePath);
            await removeFile(appendPath);
            cleanupTempFile(listPath);
            return true;
        }
    } catch { /* fall through: nothing merged */ }
    await removeFile(tmpPath);
    cleanupTempFile(listPath);
    return false;
}

/** Merge pending browser-chunk segments; resolves the number that could not be merged. */
async function mergePendingSegments(filePath) {
    let failed = 0;
    for (const segmentPath of getPendingSegmentFiles(filePath)) {
        const ok = await concatWebmFiles(filePath, segmentPath);
        if (!ok) {
            failed++;
            console.warn(`[VOD] Failed to merge segment into ${path.basename(filePath)}: ${path.basename(segmentPath)}`);
        }
    }
    return failed;
}

module.exports = {
    remuxForSeeking,
    remuxForSeekingDetailed,
    lastProgressSeconds,
    probeDuration,
    streamCopyDuration,
    chooseDuration,
    remuxForLiveSeeking,
    seekableSidecarPath,
    cleanupSeekableFile,
    probeStartTime,
    probeVodDuration,
    probeVodInfo,
    getFileSizeSafe,
    cleanupTempFile,
    removeFile,
    hasRoomFor,
    remuxBudgetMs,
    makeSegmentPath,
    getPendingSegmentFiles,
    concatWebmFiles,
    mergePendingSegments,
};
