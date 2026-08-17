/**
 * OpenVibe.Media — VOD health scanner
 *
 * Ported from the predecessor: probe / decode / remux / master-recovery
 * primitives used by the background health job.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const db = require('../db/database');

function probeMediaInfo(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('close', () => {
            try {
                const info = JSON.parse(out);
                const duration = parseFloat(info.format?.duration || '0');
                resolve({
                    ok: true,
                    duration: Number.isFinite(duration) ? duration : 0,
                    format: info.format || {},
                    streams: info.streams || [],
                });
            } catch {
                resolve({ ok: false, duration: 0, format: null, streams: [] });
            }
        });
        proc.on('error', () => resolve({ ok: false, duration: 0, format: null, streams: [] }));
        setTimeout(() => { try { proc.kill(); } catch {} }, 10000);
    });
}

function decodeVodFile(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-v', 'warning', '-xerror', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-']);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', (code) => {
            const warnings = stderr.split('\n').filter(line => /error|warn|corrupt|invalid|timestamp|RTP|concealing|Non-monotonous DTS/i.test(line));
            resolve({ code, stderr, warnings, ok: code === 0 });
        });
        proc.on('error', () => resolve({ code: -1, stderr: '', warnings: [], ok: false }));
        setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
    });
}

function remuxForSeeking(filePath) {
    return new Promise((resolve) => {
        // Match the tmp container to the source so an H.264 .mp4 VOD isn't
        // force-written into a VP8-only WebM (which just fails). For .mp4,
        // faststart makes it instantly seekable.
        const isMp4 = filePath.toLowerCase().endsWith('.mp4');
        const tmpPath = isMp4 ? `${filePath}.remux.tmp.mp4` : `${filePath}.remux.tmp.webm`;
        const args = isMp4
            ? ['-y', '-i', filePath, '-c', 'copy', '-fflags', '+genpts', '-movflags', '+faststart', tmpPath]
            : ['-y', '-i', filePath, '-c', 'copy', '-fflags', '+genpts', tmpPath];
        const proc = spawn('ffmpeg', args);
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, filePath);
                    resolve({ ok: true });
                } catch (err) {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                    resolve({ ok: false, error: err.message });
                }
            } else {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                resolve({ ok: false, error: `ffmpeg remux failed code ${code}` });
            }
        });
        proc.on('error', (err) => {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            resolve({ ok: false, error: err.message });
        });
        setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
    });
}

// Re-encode a served .webm from the lossless .master.mkv archive. Used by the
// health job to REPAIR a broken VOD before resorting to quarantine.
function _rebuildWebmFromMaster(masterPath, webmPath) {
    return new Promise((resolve) => {
        const tmp = webmPath + '.recover.webm';
        const args = ['-y', '-i', masterPath,
            '-c:v', 'libvpx', '-b:v', '1500k', '-crf', '20', '-deadline', 'good', '-cpu-used', '2',
            '-force_key_frames', 'expr:gte(t,n_forced*2)', '-g', '240',
            '-c:a', 'libvorbis', '-b:a', '128k', '-f', 'webm', tmp];
        let ff;
        try { ff = spawn('ffmpeg', args, { stdio: 'ignore' }); } catch { return resolve(false); }
        const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 45 * 60 * 1000);
        ff.on('close', (code) => {
            clearTimeout(to);
            try {
                if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024) {
                    fs.renameSync(tmp, webmPath);
                    return resolve(true);
                }
            } catch { /* fall through */ }
            try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* */ }
            resolve(false);
        });
        ff.on('error', () => { clearTimeout(to); try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* */ } resolve(false); });
    });
}

// Attempt to recover a broken VOD from its master archive. Rebuilds the webm,
// remuxes it for seeking, re-probes, and (if longer) repairs the stored
// duration. Returns { recovered: bool, duration }.
async function recoverFromMaster(vod) {
    // Only WebM recordings have a separate .master.mkv to rebuild from. An MP4
    // has no master (it's itself a lossless copy); guard the extension so the
    // regex can't fall through to the VOD's own path and overwrite the mp4.
    const masterPath = vod.master_file_path
        || (vod.file_path && vod.file_path.endsWith('.webm') ? vod.file_path.replace(/\.webm$/, '.master.mkv') : null);
    if (!masterPath || !fs.existsSync(masterPath) || !vod.file_path) return { recovered: false, duration: 0 };
    let masterDur = 0;
    try { const mi = await probeMediaInfo(masterPath); masterDur = mi.ok ? mi.duration : 0; } catch { /* */ }
    if (!(masterDur > 1)) return { recovered: false, duration: 0 };
    const ok = await _rebuildWebmFromMaster(masterPath, vod.file_path);
    if (!ok) return { recovered: false, duration: 0 };
    try { await remuxForSeeking(vod.file_path); } catch { /* */ }
    let dur = masterDur;
    try { const mi2 = await probeMediaInfo(vod.file_path); if (mi2.ok && mi2.duration > 0) dur = mi2.duration; } catch { /* */ }
    try {
        const stat = fs.statSync(vod.file_path);
        db.repairVodDuration(vod.id, Math.round(dur), stat.size);
        db.updateVodHealth(vod.id, { status: 'ok', issues: ['recovered_from_master'], probeDuration: dur });
    } catch { /* */ }
    return { recovered: true, duration: dur };
}

async function scanVod(vod, options = {}) {
    const filePath = vod.file_path;
    const result = {
        vodId: vod.id,
        filePath,
        status: 'unknown',
        issues: [],
        probe: null,
        decode: null,
        remux: null,
        durationMatch: false,
    };

    if (!filePath || !fs.existsSync(filePath)) {
        // Offloaded to object storage (B2/R2) — the upload was size-verified,
        // so skip local file checks instead of flagging it missing.
        try {
            if (require('./vod-storage').isRemote(vod)) {
                result.status = 'offloaded';
                return result;
            }
        } catch { /* fall through to missing_file */ }
        result.status = 'missing_file';
        result.issues.push('missing_file');
        return result;
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
        if (stat.size <= 0) {
            result.status = 'zero_byte';
            result.issues.push('zero_byte');
            return result;
        }
    } catch (err) {
        result.status = 'missing_file';
        result.issues.push('stat_error');
        return result;
    }

    const probeInfo = await probeMediaInfo(filePath);
    result.probe = probeInfo;
    if (!probeInfo.ok) {
        result.status = 'needs_review';
        result.issues.push('probe_failed');
    } else {
        if (!probeInfo.duration || probeInfo.duration <= 0) {
            result.status = 'needs_review';
            result.issues.push('invalid_duration');
        }
        if (vod.duration_seconds <= 0 && probeInfo.duration > 0) {
            result.durationMatch = false;
            result.issues.push('duration_repair_available');
        } else if (Math.abs((vod.duration_seconds || 0) - probeInfo.duration) > 2) {
            result.durationMatch = false;
            result.issues.push('duration_mismatch');
        } else {
            result.durationMatch = true;
        }
    }

    if (options.decode && probeInfo.ok && probeInfo.duration > 0) {
        const decodeResult = await decodeVodFile(filePath);
        result.decode = decodeResult;
        if (!decodeResult.ok) {
            result.issues.push('decode_failed');
        }
        if (decodeResult.warnings.length > 0) {
            result.issues.push(...decodeResult.warnings.map(w => w.trim()).filter(Boolean));
        }
    }

    if (options.remux && probeInfo.ok) {
        result.remux = await remuxForSeeking(filePath);
        if (!result.remux.ok) {
            result.issues.push('remux_failed');
        }
    }

    if (result.issues.length === 0) {
        result.status = 'ok';
    } else if (result.status === 'unknown') {
        result.status = result.issues.includes('decode_failed') || result.issues.some(i => /invalid|corrupt|failed/.test(i))
            ? 'corrupt'
            : 'needs_review';
    }

    if (options.repairDuration && probeInfo.ok && probeInfo.duration > 0 && (vod.duration_seconds || 0) <= 0) {
        result.repair = db.repairVodDuration(vod.id, Math.round(probeInfo.duration), stat.size);
        result.issues.push('duration_repaired');
        result.status = 'duration_repaired';
    }

    if (options.quarantineBad && ['corrupt', 'missing_file', 'zero_byte'].includes(result.status)) {
        db.updateVodHealth(vod.id, {
            status: result.status,
            issues: result.issues,
            probeDuration: probeInfo.duration,
            probeFormat: probeInfo.format,
            quarantine: true,
        });
    }

    return result;
}

module.exports = {
    probeMediaInfo,
    decodeVodFile,
    remuxForSeeking,
    recoverFromMaster,
    scanVod,
};
