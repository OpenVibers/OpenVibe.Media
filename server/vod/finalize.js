/**
 * OpenVibe.Media — VOD finalization pipeline
 *
 * Ported from the predecessor's finalizeVodRecording/_doFinalize, keyed by
 * vodId (there is no stream registry here — apps own stream state):
 *   merge pending chunk segments → seekable remux → probe → master recovery
 *   (truncated-webm rebuild) → DB update → thumbnail → webhook vod.ready.
 *
 * Guarded against double-invocation; refuses to finalize while the recorder
 * still holds the file open (stops it gracefully instead — its ffmpeg exit
 * handler re-invokes finalize on the fully-flushed file).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('../db/database');
const tools = require('./media-tools');
const { sendWebhook } = require('../webhooks');

const _finalizing = new Set();

function isFinalizing(vodId) {
    return _finalizing.has(Number(vodId));
}

// Public shape of a vod row for API responses + webhooks.
function vodPublic(vod) {
    if (!vod) return null;
    return {
        id: vod.id,
        app_id: vod.app_id,
        stream_id: vod.stream_id,
        user_id: vod.user_id,
        title: vod.title,
        description: vod.description,
        status: db.vodStatus(vod),
        duration: vod.duration_seconds || 0,
        file_size: vod.file_size || 0,
        playback_url: `/v/${vod.id}`,
        thumbnail_url: vod.thumbnail_url || null,
        storage_provider: vod.storage_provider || 'local',
        visibility: vod.visibility || 'public',
        health_status: vod.health_status,
        clips_only: !!vod.clips_only,
        is_recording: !!vod.is_recording,
        view_count: vod.view_count || 0,
        created_at: vod.created_at,
        meta: (() => { try { return JSON.parse(vod.meta_json || '{}'); } catch { return {}; } })(),
    };
}

// Re-encode the lossless master into the served WebM format. Heavy (a real
// transcode), so it only runs on the recovery path when the primary webm came
// out truncated.
function rebuildWebmFromMaster(masterPath, webmPath) {
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

function _webhookForVod(vod, event) {
    try {
        sendWebhook(vod.app_id, event, vodPublic(vod)).catch(() => {});
    } catch { /* non-critical */ }
}

/**
 * Finalize a VOD recording. Returns the updated vod row (or null).
 * @param {number} vodId
 * @param {object} [opts]
 * @param {number} [opts.startTimeMs]  wall-clock recording start (for duration sanity)
 * @param {boolean} [opts.ffmpegCorrupted]  recorder flagged heavy corruption
 * @param {string} [opts.segmentPath]  trailing chunk segment not yet merged
 */
async function finalizeVod(vodId, opts = {}) {
    vodId = Number(vodId);
    if (_finalizing.has(vodId)) return null;

    // If the recorder still holds this VOD open, stop it gracefully instead of
    // locking in a truncated duration — its exit handler re-finalizes.
    try {
        const recorder = require('./recorder');
        if (recorder.isRecording(vodId)) {
            console.log(`[VOD] finalize requested for vod ${vodId} while still recording — stopping gracefully first`);
            recorder.stopRecording(vodId);
            return null;
        }
    } catch { /* proceed */ }
    _finalizing.add(vodId);

    try {
        return await _doFinalize(vodId, opts);
    } finally {
        _finalizing.delete(vodId);
    }
}

async function _doFinalize(vodId, opts) {
    const vod = db.getVodById(vodId);
    if (!vod) return null;
    const filePath = vod.file_path;
    const startTime = opts.startTimeMs || new Date(String(vod.created_at).replace(' ', 'T') + 'Z').getTime();

    // Ephemeral clips-only recording: it existed only to serve live clips. Never
    // published — delete the file (+ any offloaded object) and its row.
    if (vod.clips_only) {
        try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* */ }
        try { tools.cleanupSeekableFile(filePath); } catch { /* */ }
        try { if (vod.master_file_path && fs.existsSync(vod.master_file_path)) fs.unlinkSync(vod.master_file_path); } catch { /* */ }
        try { if (vod.storage_provider && vod.storage_provider !== 'local') require('./vod-storage').deleteVodObjects(vod).catch(() => {}); } catch { /* */ }
        try { db.run('DELETE FROM vods WHERE id = ?', [vodId]); } catch { /* */ }
        console.log(`[VOD] Discarded ephemeral clips-only recording (vod ${vodId})`);
        return null;
    }

    if (!filePath || !fs.existsSync(filePath)) {
        db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
        const failed = db.getVodById(vodId);
        _webhookForVod(failed, 'vod.failed');
        return failed;
    }

    // Merge any pending browser-chunk segments before remuxing.
    if (opts.segmentPath && opts.segmentPath !== filePath) {
        await tools.concatWebmFiles(filePath, opts.segmentPath);
    }
    await tools.mergePendingSegments(filePath);

    // A recording that never received media (e.g. an RTP ingest that was
    // started and stopped without packets) leaves a zero-byte file. Quarantine
    // it as failed — the wall-clock fallback below must never mark it ready.
    if (tools.getFileSizeSafe(filePath) === 0) {
        console.warn(`[VOD] vod ${vodId}: zero-byte recording — quarantining`);
        db.run(`UPDATE vods SET is_recording = 0, health_status = 'zero_byte', health_issues_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            [JSON.stringify(['zero_byte']), vodId]);
        const failed = db.getVodById(vodId);
        _webhookForVod(failed, 'vod.failed');
        return failed;
    }

    // Remux for proper seeking support (fast copy-mode, no re-encode)
    await tools.remuxForSeeking(filePath);

    // Clean up the live seekable copy (no longer needed after final remux)
    tools.cleanupSeekableFile(filePath);

    // Probe actual duration with ffprobe
    const wallClockSeconds = Math.max(0, Math.round((Date.now() - startTime) / 1000));
    let durationSeconds = wallClockSeconds;
    let probeFormatJson = JSON.stringify({});
    try {
        const probeInfo = await tools.probeVodInfo(filePath);
        if (probeInfo.duration > 0) {
            // Guard against a corrupt/inflated container duration: real footage can
            // never be meaningfully longer than the wall-clock recording time.
            if (wallClockSeconds > 0 && probeInfo.duration > wallClockSeconds * 1.5 + 30) {
                console.warn(`[VOD] vod ${vodId}: probed duration ${probeInfo.duration}s >> wall-clock ${wallClockSeconds}s — using wall-clock (inflated/corrupt container)`);
                durationSeconds = wallClockSeconds;
            } else {
                durationSeconds = probeInfo.duration;
            }
        }
        probeFormatJson = JSON.stringify(probeInfo.format || {});
    } catch (probeErr) {
        console.warn(`[VOD] ffprobe failed for vod ${vodId}:`, probeErr.message);
    }

    // ── Recover from the lossless master if the served webm came out truncated ──
    // Only WebM recordings have a separate lossless master; an RTMP/H.264 MP4 is
    // ITSELF a lossless stream-copy, so the .webm regex must NOT fall through.
    const masterPath = filePath.endsWith('.webm')
        ? (vod.master_file_path || filePath.replace(/\.webm$/, '.master.mkv'))
        : null;
    let masterDur = 0;
    if (masterPath && fs.existsSync(masterPath)) {
        try { const mi = await tools.probeVodInfo(masterPath); masterDur = mi.duration || 0; } catch { /* */ }
        if (masterDur > 0 && masterDur > durationSeconds + 15 && masterDur > durationSeconds * 1.15) {
            console.warn(`[VOD] vod ${vodId}: webm ${durationSeconds}s is short vs master ${masterDur}s — rebuilding webm from master`);
            const ok = await rebuildWebmFromMaster(masterPath, filePath);
            if (ok) {
                try { await tools.remuxForSeeking(filePath); tools.cleanupSeekableFile(filePath); } catch { /* */ }
                try {
                    const mi2 = await tools.probeVodInfo(filePath);
                    if (mi2.duration > durationSeconds) { durationSeconds = mi2.duration; probeFormatJson = JSON.stringify(mi2.format || {}); }
                } catch { /* */ }
                console.log(`[VOD] vod ${vodId}: recovered from master → ${durationSeconds}s`);
            } else {
                console.warn(`[VOD] vod ${vodId}: master recovery failed — keeping master for manual recovery`);
            }
        }
    }

    if (opts.ffmpegCorrupted) {
        console.warn(`[VOD] Finalized VOD ${vodId} marked corrupt by FFmpeg diagnostics; quarantining without deletion`);
        db.run(`UPDATE vods SET is_recording = 0, health_status = ?, health_issues_json = ?, probe_duration_seconds = ?, probe_format_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            ['corrupt', JSON.stringify(['ffmpeg-corruption-detected']), durationSeconds > 0 ? durationSeconds : 0, probeFormatJson, vodId]);
        const failed = db.getVodById(vodId);
        _webhookForVod(failed, 'vod.failed');
        return failed;
    }

    // Very short recordings are quarantined for review instead of deleted.
    const MIN_VOD_SECONDS = parseInt(process.env.MIN_VOD_SECONDS || '3', 10);
    if (durationSeconds < MIN_VOD_SECONDS) {
        console.log(`[VOD] Quarantining short vod ${vodId}: duration ${durationSeconds}s`);
        db.run(`UPDATE vods SET is_recording = 0, health_status = ?, health_issues_json = ?, probe_duration_seconds = ?, probe_format_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            ['needs_review', JSON.stringify(['short_duration']), durationSeconds > 0 ? durationSeconds : 0, probeFormatJson, vodId]);
        const failed = db.getVodById(vodId);
        _webhookForVod(failed, 'vod.failed');
        return failed;
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        console.error(`[VOD] Failed to stat finalized VOD ${vodId}:`, err.message);
        db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
        return null;
    }
    db.run('UPDATE vods SET is_recording = 0, duration_seconds = ?, file_size = ?, probe_duration_seconds = ?, probe_format_json = ?, health_status = ? WHERE id = ?',
        [durationSeconds, stat.size, durationSeconds, probeFormatJson, 'ok', vodId]);

    console.log(`[VOD] Finalized: vod ${vodId}, ${durationSeconds}s, ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    // The lossless .master.mkv archive is only a fallback. Delete it ONLY once
    // the served webm is confirmed complete; if recovery failed, KEEP it.
    if (masterPath) {
        try {
            const webmComplete = !masterDur || durationSeconds >= masterDur - 8;
            if (fs.existsSync(masterPath)) {
                if (webmComplete) {
                    fs.unlinkSync(masterPath);
                    console.log(`[VOD] Removed master archive for vod ${vodId} (${path.basename(masterPath)})`);
                    db.run('UPDATE vods SET master_file_path = NULL WHERE id = ?', [vodId]);
                } else {
                    console.warn(`[VOD] vod ${vodId}: KEEPING master (webm ${durationSeconds}s still < master ${masterDur}s)`);
                }
            } else {
                db.run('UPDATE vods SET master_file_path = NULL WHERE id = ?', [vodId]);
            }
        } catch (e) {
            console.warn(`[VOD] Master cleanup failed for vod ${vodId}:`, e.message);
        }
    }

    // Thumbnail, then webhook vod.ready (thumbnail awaited so the payload has it;
    // failure is non-fatal).
    try {
        const thumbService = require('../thumbnails/thumbnail-service');
        await thumbService.generateVodThumbnail(vodId, filePath);
    } catch (err) {
        console.warn(`[VOD] Thumbnail generation failed for vod ${vodId}:`, err.message);
    }

    const finalVod = db.getVodById(vodId);
    _webhookForVod(finalVod, 'vod.ready');
    return finalVod;
}

module.exports = { finalizeVod, isFinalizing, vodPublic, rebuildWebmFromMaster };
