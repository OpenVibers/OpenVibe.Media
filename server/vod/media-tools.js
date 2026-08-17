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
 * Remux a WebM/MP4 file with ffmpeg to add proper seek metadata.
 * WebM files from MediaRecorder lack Cues and often have Inf duration,
 * which prevents browser-side seeking. A fast copy-remux fixes this.
 * MP4: rewrite the fragmented recording into a plain, faststart (moov-at-front)
 * MP4 so finished-VOD playback seeks instantly. Replaces the original in-place.
 */
function remuxForSeeking(filePath) {
    return new Promise((resolve) => {
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.webm' && ext !== '.mp4') return resolve(false); // WebM + MP4 only

        const tmpPath = filePath + '.remux' + ext;
        const outArgs = ext === '.mp4'
            ? ['-c', 'copy', '-movflags', '+faststart', '-fflags', '+genpts']
            : ['-c', 'copy', '-fflags', '+genpts'];
        const proc = spawn('ffmpeg', [
            '-y', '-i', filePath,
            ...outArgs,
            tmpPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderr = '';
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, filePath);
                    console.log(`[VOD] Remuxed for seeking: ${path.basename(filePath)}`);
                    resolve(true);
                } catch (err) {
                    console.warn(`[VOD] Remux rename failed:`, err.message);
                    try { fs.unlinkSync(tmpPath); } catch {}
                    resolve(false);
                }
            } else {
                console.warn(`[VOD] Remux failed (code ${code}): ${stderr.slice(-200)}`);
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
                resolve(false);
            }
        });

        proc.on('error', () => resolve(false));

        // Timeout: 60s should be plenty for copy-mode remux
        setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
    });
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

async function mergePendingSegments(filePath) {
    for (const segmentPath of getPendingSegmentFiles(filePath)) {
        const ok = await concatWebmFiles(filePath, segmentPath);
        if (!ok) {
            console.warn(`[VOD] Failed to merge segment into ${path.basename(filePath)}: ${path.basename(segmentPath)}`);
        }
    }
}

module.exports = {
    remuxForSeeking,
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
