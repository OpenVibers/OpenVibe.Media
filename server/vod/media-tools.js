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

/**
 * Remux a WebM/MP4 file with ffmpeg to add proper seek metadata.
 * WebM files from MediaRecorder lack Cues and often have Inf duration,
 * which prevents browser-side seeking. A fast copy-remux fixes this.
 * MP4: rewrite the fragmented recording into a plain, faststart (moov-at-front)
 * MP4 so finished-VOD playback seeks instantly. Replaces the original in-place.
 *
 * Resolves { ok, seconds, error }: `seconds` is the last packet time the remux wrote (0 when it
 * failed: a partial run's time says nothing about the file).
 */
function remuxForSeekingDetailed(filePath) {
    return new Promise((resolve) => {
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.webm' && ext !== '.mp4') return resolve({ ok: false, seconds: 0, error: 'unsupported container' }); // WebM + MP4 only

        const tmpPath = filePath + '.remux' + ext;
        const outArgs = ext === '.mp4'
            ? ['-c', 'copy', '-movflags', '+faststart', '-fflags', '+genpts']
            : ['-c', 'copy', '-fflags', '+genpts'];
        let proc;
        try {
            proc = spawn('ffmpeg', [
                '-y', '-i', filePath,
                ...outArgs,
                tmpPath,
            ], { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (err) { return resolve({ ok: false, seconds: 0, error: err.message }); }

        let stderr = '';
        proc.stderr.on('data', d => { stderr = tailAppend(stderr, String(d)); });

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, filePath);
                    console.log(`[VOD] Remuxed for seeking: ${path.basename(filePath)}`);
                    resolve({ ok: true, seconds: lastProgressSeconds(stderr), error: null });
                } catch (err) {
                    console.warn(`[VOD] Remux rename failed:`, err.message);
                    try { fs.unlinkSync(tmpPath); } catch {}
                    resolve({ ok: false, seconds: 0, error: err.message });
                }
            } else {
                console.warn(`[VOD] Remux failed (code ${code}): ${stderr.slice(-200)}`);
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
                resolve({ ok: false, seconds: 0, error: `ffmpeg remux exited ${code}` });
            }
        });

        proc.on('error', (err) => resolve({ ok: false, seconds: 0, error: err.message }));

        // Timeout scales with size: a copy-mode remux still rewrites every byte (twice for
        // +faststart), and a flat 60 s killed every multi-hour recording — which left them
        // fragmented with no seek index, so every clip cut from cloud storage had to scan
        // the whole file and timed out. ~45 s per GB, 3 min floor, 45 min ceiling.
        let bytes = 0; try { bytes = fs.statSync(filePath).size; } catch { /* */ }
        const budgetMs = Math.min(45 * 60000, Math.max(180000, Math.round(bytes / 1e9 * 45000) + 60000));
        const killer = setTimeout(() => { console.warn(`[VOD] Remux of ${path.basename(filePath)} exceeded ${Math.round(budgetMs / 1000)} s — killed`); try { proc.kill('SIGKILL'); } catch {} }, budgetMs);
        proc.on('close', () => clearTimeout(killer));
    });
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

const _liveRemuxInProgress = new Set();

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
 */
function remuxForLiveSeeking(filePath) {
    const seekablePath = seekableSidecarPath(filePath);
    if (!seekablePath) return Promise.resolve(false);
    if (_liveRemuxInProgress.has(filePath)) return Promise.resolve(false);
    _liveRemuxInProgress.add(filePath);

    const isMp4 = filePath.endsWith('.mp4');
    const tmpPath = filePath + (isMp4 ? '.live-remux.tmp.mp4' : '.live-remux.tmp.webm');
    const outArgs = isMp4
        ? ['-c', 'copy', '-movflags', '+faststart', '-fflags', '+genpts']
        : ['-c', 'copy', '-fflags', '+genpts'];

    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', [
            '-y', '-i', filePath,
            ...outArgs,
            tmpPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            _liveRemuxInProgress.delete(filePath);
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, seekablePath);
                    resolve(true);
                } catch (err) {
                    console.warn(`[VOD] Live remux rename failed:`, err.message);
                    try { fs.unlinkSync(tmpPath); } catch {}
                    resolve(false);
                }
            } else {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
                resolve(false);
            }
        });

        proc.on('error', () => {
            _liveRemuxInProgress.delete(filePath);
            resolve(false);
        });

        setTimeout(() => {
            _liveRemuxInProgress.delete(filePath);
            try { proc.kill(); } catch {}
        }, 30000);
    });
}

/**
 * Clean up the .seekable.* sidecar after finalization. Guard: the sidecar path
 * must differ from the VOD itself (a bad regex fall-through would otherwise
 * delete the recording); seekableSidecarPath returns null for unknown exts.
 */
function cleanupSeekableFile(filePath) {
    const seekablePath = seekableSidecarPath(filePath);
    if (!seekablePath || seekablePath === filePath) return;
    try { if (fs.existsSync(seekablePath)) fs.unlinkSync(seekablePath); } catch {}
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

function concatWebmFiles(basePath, appendPath) {
    if (!appendPath || !fs.existsSync(appendPath)) return Promise.resolve(true);
    if (!basePath || !fs.existsSync(basePath)) {
        fs.renameSync(appendPath, basePath);
        return Promise.resolve(true);
    }

    const listPath = `${basePath}.concat.${Date.now()}.txt`;
    const tmpPath = `${basePath}.concat.tmp.webm`;
    const escapedBase = basePath.replace(/'/g, `'\\''`);
    const escapedAppend = appendPath.replace(/'/g, `'\\''`);
    fs.writeFileSync(listPath, `file '${escapedBase}'\nfile '${escapedAppend}'\n`, 'utf8');

    const runConcat = (args) => new Promise((resolve) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => stderr += d);
        proc.on('close', (code) => resolve({ code, stderr }));
        proc.on('error', () => resolve({ code: -1, stderr: 'spawn error' }));
        setTimeout(() => { try { proc.kill(); } catch {} }, 120000);
    });

    return (async () => {
        try {
            let result = await runConcat(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-fflags', '+genpts', tmpPath]);
            if (result.code !== 0 || !fs.existsSync(tmpPath)) {
                result = await runConcat(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k', tmpPath]);
            }
            if (result.code === 0 && fs.existsSync(tmpPath)) {
                fs.renameSync(tmpPath, basePath);
                cleanupTempFile(appendPath);
                cleanupTempFile(listPath);
                return true;
            }
            cleanupTempFile(tmpPath);
            cleanupTempFile(listPath);
            return false;
        } catch {
            cleanupTempFile(tmpPath);
            cleanupTempFile(listPath);
            return false;
        }
    })();
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
    makeSegmentPath,
    getPendingSegmentFiles,
    concatWebmFiles,
    mergePendingSegments,
};
