/**
 * OpenVibe.Media — VOD finalization pipeline
 *
 * Ported from the predecessor's finalizeVodRecording/_doFinalize, keyed by
 * vodId (there is no stream registry here — apps own stream state):
 *   merge pending chunk segments → seekable remux → probe → master recovery
 *   (truncated-webm rebuild) → thumbnail → DB update + vod.ready event (one
 *   transaction) → webhook vod.ready.
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
const config = require('../config');
const tools = require('./media-tools');
const { announce } = require('../webhooks');

/** Absolute-ize a stored Media-relative URL (/t/…, /api/thumbnails/…). */
function _absUrl(u) {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    return `${config.publicUrl}${u.startsWith('/') ? '' : '/'}${u}`;
}

const _finalizing = new Set();

function isFinalizing(vodId) {
    return _finalizing.has(Number(vodId));
}

// Public shape of a vod row for API responses + webhooks.
function vodPublic(vod) {
    if (!vod) return null;
    return {
        unique_views: vod.unique_views || 0,

        id: vod.id,
        app_id: vod.app_id,
        stream_id: vod.stream_id,
        managed_stream_id: vod.managed_stream_id || null,
        user_id: vod.user_id,
        title: vod.title,
        description: vod.description,
        status: db.vodStatus(vod),
        duration: vod.duration_seconds || 0,
        duration_seconds: vod.duration_seconds || 0,
        // Where the duration came from: probe (ffprobe), remux (packet timeline) or unknown (stored 0).
        duration_source: vod.duration_source || null,
        file_size: vod.file_size || 0,
        // Basename only (server paths stay private) — the inherited SPA derives
        // its /file/<name> playback URL from this.
        file_path: vod.file_path ? path.basename(vod.file_path) : null,
        // Absolute URLs — consumers on other origins (app SPAs) render these
        // directly; relative paths resolved against the app's origin and broke.
        playback_url: `${config.publicUrl}/v/${vod.id}`,
        thumbnail_url: _absUrl(vod.thumbnail_url),
        storage_provider: vod.storage_provider || 'local',
        visibility: vod.visibility || 'public',
        // Kept alongside visibility — inherited SPA surfaces (manager badges,
        // visibility toggles) read the boolean, and omitting it rendered every
        // VOD as "Private" in the owner's manager.
        is_public: (vod.visibility || (vod.is_public ? 'public' : 'private')) === 'public',
        health_status: vod.health_status,
        clips_only: !!vod.clips_only,
        is_recording: !!vod.is_recording,
        ai_overview: vod.ai_overview || null,
        ai_analyzed_at: vod.ai_analyzed_at || null,
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

/**
 * The state change for a VOD outcome and its event/webhook, committed together (webhooks.announce).
 * `row()` gives the row the payload describes (read inside the transaction). Returns the payload,
 * or null when the transaction failed (then nothing changed and nothing was announced).
 */
function _commitVodOutcome(vod, event, change, row = () => db.getVodById(vod.id)) {
    try {
        return announce(vod.app_id, event, { change, payload: () => vodPublic(row()) }).data;
    } catch (err) {
        console.error(`[VOD] vod ${vod.id}: ${event} not committed:`, err.message);
        return null;
    }
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
        // Every outcome (ready, quarantined, failed) re-projects the object; a deleted row was already marked by trigger.
        require('../objects/model').safeSync('vod', vodId);
    }
}

// Health issues finalize itself records when it cannot settle a recording. A later successful
// finalize (the vod.finalize retry job) lifts the quarantine they caused.
const FINALIZE_ISSUES = ['probe_failed', 'inflated_duration', 'stat_failed', 'finalize_failed'];

function _issuesOf(vod) {
    try { const v = JSON.parse(vod.health_issues_json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Quarantined by finalize (not by the health job or an operator): a good finalize lifts it. */
function _finalizeQuarantined(vod) {
    return !!vod.quarantined_at && _issuesOf(vod).some(i => FINALIZE_ISSUES.includes(i));
}

async function _doFinalize(vodId, opts) {
    const vod = db.getVodById(vodId);
    if (!vod) return null;
    const filePath = vod.file_path;
    // The recorder's own start time bounds the duration (a container claiming more than the
    // recorder ran is corrupt). An orphan has none: created_at is when the row was made, and
    // now - created_at says nothing about the footage, so it is never used.
    const wallClockSeconds = opts.startTimeMs ? Math.max(0, Math.round((Date.now() - opts.startTimeMs) / 1000)) : null;

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
        // No media was ever written (ingest started but produced nothing, or the
        // process died before ffmpeg opened the file). Nothing to review — delete
        // the row so a 0:00 ghost never reaches listings.
        console.warn(`[VOD] vod ${vodId}: no recording file — deleting empty row`);
        _commitVodOutcome(vod, 'vod.failed', () => db.run('DELETE FROM vods WHERE id = ?', [vodId]), () => vod);
        return null;
    }

    const issues = [];
    // Merge any pending browser-chunk segments before remuxing.
    if (opts.segmentPath && opts.segmentPath !== filePath) {
        if (!(await tools.concatWebmFiles(filePath, opts.segmentPath))) issues.push('merge_failed');
    }
    if (await tools.mergePendingSegments(filePath)) { if (!issues.includes('merge_failed')) issues.push('merge_failed'); }

    // A recording that never received media (e.g. an RTP ingest that was
    // started and stopped without packets) leaves a zero-byte file. There is
    // nothing to review, so treat it like a missing file: report the failure and
    // delete the row and file — a 0:00 ghost must never reach listings.
    if (tools.getFileSizeSafe(filePath) === 0) {
        console.warn(`[VOD] vod ${vodId}: zero-byte recording — deleting empty recording`);
        try { fs.unlinkSync(filePath); } catch { /* */ }
        try { tools.cleanupSeekableFile(filePath); } catch { /* */ }
        try { if (vod.master_file_path && fs.existsSync(vod.master_file_path)) fs.unlinkSync(vod.master_file_path); } catch { /* */ }
        _commitVodOutcome(vod, 'vod.failed', () => db.run('DELETE FROM vods WHERE id = ?', [vodId]),
            () => ({ ...vod, health_status: 'zero_byte', is_public: 0 }));
        return null;
    }

    // Remux for proper seeking support (fast copy-mode, no re-encode). Its last packet time is a
    // measurement of the file (source 'remux'); a failed remux measures nothing.
    const remux = await tools.remuxForSeekingDetailed(filePath);
    if (!remux.ok && remux.error !== 'unsupported container') issues.push('remux_failed');

    // Clean up the live seekable copy (no longer needed after final remux)
    tools.cleanupSeekableFile(filePath);

    // The duration is what the file says: ffprobe's, else the packets' (a stream-copy pass when the
    // remux gave none), never the wall clock. Nothing measurable: 0 and needs_review.
    const measure = async (p, remuxS) => {
        const probe = await tools.probeDuration(p);
        let packets = remuxS || 0;
        if (!packets && !(probe.seconds > 0)) packets = (await tools.streamCopyDuration(p)).seconds;
        return { probe, choice: tools.chooseDuration({ probeS: probe.seconds, remuxS: packets, wallS: wallClockSeconds }) };
    };
    let { probe, choice } = await measure(filePath, remux.ok ? remux.seconds : 0);
    let durationSeconds = choice.seconds;
    let probeFormatJson = JSON.stringify(probe.format || {});
    if (!probe.ok) console.warn(`[VOD] ffprobe failed for vod ${vodId}: ${probe.error}`);

    // ── Recover from the lossless master if the served webm came out truncated ──
    // Only WebM recordings have a separate lossless master; an RTMP/H.264 MP4 is
    // ITSELF a lossless stream-copy, so the .webm regex must NOT fall through.
    const masterPath = filePath.endsWith('.webm')
        ? (vod.master_file_path || filePath.replace(/\.webm$/, '.master.mkv'))
        : null;
    let masterDur = 0;
    if (masterPath && fs.existsSync(masterPath)) {
        try { const mi = await tools.probeDuration(masterPath); masterDur = mi.seconds || 0; } catch { /* */ }
        if (masterDur > 0 && masterDur > durationSeconds + 15 && masterDur > durationSeconds * 1.15) {
            console.warn(`[VOD] vod ${vodId}: webm ${durationSeconds}s is short vs master ${masterDur}s — rebuilding webm from master`);
            const ok = await rebuildWebmFromMaster(masterPath, filePath);
            if (ok) {
                let again = { ok: false, seconds: 0 };
                try { again = await tools.remuxForSeekingDetailed(filePath); tools.cleanupSeekableFile(filePath); } catch { /* */ }
                const rebuilt = await measure(filePath, again.ok ? again.seconds : 0);
                if (rebuilt.choice.seconds > durationSeconds) {
                    ({ probe, choice } = rebuilt);
                    durationSeconds = choice.seconds;
                    probeFormatJson = JSON.stringify(probe.format || {});
                }
                console.log(`[VOD] vod ${vodId}: recovered from master → ${durationSeconds}s`);
            } else {
                console.warn(`[VOD] vod ${vodId}: master recovery failed — keeping master for manual recovery`);
            }
        }
    }

    for (const i of choice.issues) if (!issues.includes(i)) issues.push(i);
    const durationSource = choice.source;
    const stored = Math.round(durationSeconds);
    const measured = durationSeconds > 0 ? durationSeconds : 0;

    if (opts.ffmpegCorrupted) {
        console.warn(`[VOD] Finalized VOD ${vodId} marked corrupt by FFmpeg diagnostics; quarantining without deletion`);
        _commitVodOutcome(vod, 'vod.failed', () => db.run(`UPDATE vods SET is_recording = 0, duration_seconds = ?, duration_source = ?, health_status = ?, health_issues_json = ?, probe_duration_seconds = ?, probe_format_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            [stored, durationSource, 'corrupt', JSON.stringify(['ffmpeg-corruption-detected', ...issues]), measured, probeFormatJson, vodId]));
        return db.getVodById(vodId);
    }

    // Nothing measurable (ffprobe and the packet pass both failed, or every value is impossible):
    // the stored duration is 0 and the recording waits for review, hidden. Never the wall clock.
    if (durationSource === 'unknown') {
        console.warn(`[VOD] vod ${vodId}: no measurable duration (${issues.join(', ')}) — stored 0, needs_review`);
        _commitVodOutcome(vod, 'vod.failed', () => db.run(`UPDATE vods SET is_recording = 0, duration_seconds = 0, duration_source = 'unknown', health_status = 'needs_review', health_issues_json = ?, probe_duration_seconds = 0, probe_format_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            [JSON.stringify(issues), probeFormatJson, vodId]));
        return db.getVodById(vodId);
    }

    // Very short recordings are quarantined for review instead of deleted.
    const MIN_VOD_SECONDS = parseInt(process.env.MIN_VOD_SECONDS || '2', 10);
    if (durationSeconds < MIN_VOD_SECONDS) {
        console.log(`[VOD] Quarantining short vod ${vodId}: duration ${durationSeconds}s`);
        _commitVodOutcome(vod, 'vod.failed', () => db.run(`UPDATE vods SET is_recording = 0, duration_seconds = ?, duration_source = ?, health_status = ?, health_issues_json = ?, probe_duration_seconds = ?, probe_format_json = ?, last_health_scan_at = datetime('now'), quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
            [stored, durationSource, 'needs_review', JSON.stringify(['short_duration', ...issues]), measured, probeFormatJson, vodId]));
        return db.getVodById(vodId);
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        // The file vanished between the probe and here. Record it (no wall-clock duration left
        // behind by the live updates) and leave it for review.
        console.error(`[VOD] Failed to stat finalized VOD ${vodId}:`, err.message);
        db.run(`UPDATE vods SET is_recording = 0, duration_seconds = 0, duration_source = 'unknown', health_status = 'needs_review',
                health_issues_json = ?, last_health_scan_at = datetime('now') WHERE id = ?`, [JSON.stringify(['stat_failed', ...issues]), vodId]);
        return null;
    }
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

    // Thumbnail BEFORE the ready commit, so the vod.ready payload has it (failure is non-fatal).
    // The row is still is_recording = 1 here, so ask for the 10%-in frame, not the live edge.
    try {
        const thumbService = require('../thumbnails/thumbnail-service');
        await thumbService.generateVodThumbnail(vodId, filePath, { liveEdge: false });
    } catch (err) {
        console.warn(`[VOD] Thumbnail generation failed for vod ${vodId}:`, err.message);
    }

    // A quarantine an earlier finalize attempt left (nothing measurable then) is lifted: the
    // recording is back to the visibility its owner chose.
    const lift = _finalizeQuarantined(db.getVodById(vodId) || vod);

    // The ready transition and the vod.ready event commit together (then the webhook goes out).
    // A failed commit throws, as the plain UPDATE did before.
    announce(vod.app_id, 'vod.ready', {
        change: () => db.run(`UPDATE vods SET is_recording = 0, duration_seconds = ?, duration_source = ?, file_size = ?, probe_duration_seconds = ?, probe_format_json = ?, health_status = ?, health_issues_json = ?${lift ? ", quarantined_at = NULL, is_public = CASE WHEN COALESCE(visibility, 'public') = 'public' THEN 1 ELSE 0 END" : ''} WHERE id = ?`,
            [stored, durationSource, stat.size, measured, probeFormatJson, 'ok', JSON.stringify(issues), vodId]),
        payload: () => vodPublic(db.getVodById(vodId)),
    });
    console.log(`[VOD] Finalized: vod ${vodId}, ${stored}s (${durationSource}), ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    return db.getVodById(vodId);
}

module.exports = { finalizeVod, isFinalizing, vodPublic, rebuildWebmFromMaster, _absUrl, FINALIZE_ISSUES };
