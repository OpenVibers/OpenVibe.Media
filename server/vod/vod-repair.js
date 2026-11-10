'use strict';
/**
 * OpenVibe.Media — repair a finished recording that does not decode.
 *
 * A stream copy can carry a truncated H.264 access unit (a lost RTP fragment in the WebRTC ingest). The muxer writes
 * it, ffprobe calls the file healthy, and a browser stops the whole playback on it (VODs 6297/6298, 2026-11-10). The
 * finalize decode check (server/vod/decode-check.js, server/vod/finalize.js) marks such a recording `needs_repair`
 * and hides it; this module is what turns it back into a playable one:
 *
 *   scan (first 10 s, or the whole file for an operator run) → a clean file is left alone;
 *   re-encode the file in place (decode-check.repair: the corrupt access unit becomes the decoder's concealed picture,
 *   so the output is a valid stream) → probe again;
 *   write duration/size/health in the row and its object together, lift the quarantine, and announce vod.ready;
 *   cut the timeline again when HLS is on, so the streaming playlist serves the repaired bytes too.
 *
 * The bytes are replaced atomically by decode-check; this module never deletes a recording it could not repair. A VOD
 * on B2/R2 with no local copy is left for the storage tiering path to bring back (→ skipped: 'not_local').
 */
const fs = require('fs');
const db = require('../db/database');
const tools = require('./media-tools');
const decode = require('./decode-check');
const objects = () => require('../objects/model');
const { announce } = require('../announce');

const FULL_SCAN_TIMEOUT_MS = 30 * 60 * 1000;

/** Is this VOD one a repair can work on: a local file, not held, not still recording. */
function eligible(vod) {
    if (!vod || !vod.file_path || vod.is_recording) return { ok: false, reason: 'not_finished' };
    if (!fs.existsSync(vod.file_path)) return { ok: false, reason: 'not_local' };
    if (!/\.mp4$/i.test(vod.file_path)) return { ok: false, reason: 'not_mp4' };
    return { ok: true };
}

/**
 * Write the settled, playable state: duration/size/probe, health ok, quarantine lifted, visibility restored — and
 * announce vod.ready when asked. Row and object commit together (objects.withObject).
 */
async function publishReady(vod, { duration, size, format = null, issues = ['decode_repaired'], announceReady = true }) {
    const stored = Math.round(duration);
    const change = async () => await objects().withObject('vod', vod.id, async () => await db.run(
        `UPDATE vods SET is_recording = 0, duration_seconds = ?, duration_source = 'probe', file_size = ?,
            probe_duration_seconds = ?, probe_format_json = ?, health_status = 'ok', health_issues_json = ?,
            last_health_scan_at = datetime('now'), quarantined_at = NULL,
            is_public = CASE WHEN COALESCE(visibility, 'public') = 'public' THEN 1 ELSE 0 END WHERE id = ?`,
        [stored, size, duration, JSON.stringify(format || {}), JSON.stringify(issues), vod.id]
    ));
    if (announceReady) {
        await announce(vod.app_id, 'vod.ready', {
            change,
            payload: async () => require('./finalize').vodPublic(await db.getVodById(vod.id), { hls: false }),
        });
    } else {
        await change();
    }
    return stored;
}

/**
 * Scan (and with `apply`, repair) one VOD.
 * → { vod, ok, skipped?, error?, duration?, size?, recut?, before?, after? }
 */
async function repairVod(vod, { full = false, apply = false, recut = true, announceReady = true } = {}) {
    const out = { vod: vod && vod.id, ok: false };
    const can = eligible(vod);
    if (!can.ok) return { ...out, skipped: can.reason };
    try { if (await objects().isHeldRow(vod)) return { ...out, skipped: 'held' }; } catch { /* the scan is read-only */ }
    const scanOpts = { seconds: full ? 0 : decode.FIRST_SECONDS, timeoutMs: full ? FULL_SCAN_TIMEOUT_MS : undefined };
    const before = await decode.scan(vod.file_path, scanOpts);
    out.before = { ok: before.ok, code: before.code, timedOut: before.timedOut, errors: before.errors };
    if (before.ok) {
        // Already clean (a scan marked needs_repair on a transient error, or an earlier repair's row write failed):
        // settle the row without touching the bytes.
        if (apply && vod.health_status !== 'ok') {
            const info = await tools.probeVodInfo(vod.file_path);
            const stat = fs.statSync(vod.file_path);
            const duration = info.duration > 0 ? info.duration : Number(vod.duration_seconds) || 0;
            try {
                const stored = await publishReady(vod, { duration, size: stat.size, format: info.format, issues: ['decode_check_ok'], announceReady });
                return { ...out, ok: true, duration: stored, size: stat.size, issues: ['decode_check_ok'] };
            } catch (err) { return { ...out, error: `stored_failed: ${err.message}` }; }
        }
        return { ...out, ok: true, skipped: 'clean' };
    }
    if (!apply) return { ...out, ok: true, skipped: 'needs_repair' };

    const fixed = await decode.repair(vod.file_path, { durationSeconds: vod.duration_seconds });
    if (!fixed.ok) return { ...out, error: fixed.error };

    const info = await tools.probeVodInfo(vod.file_path);
    const duration = info.duration > 0 ? info.duration : Number(vod.duration_seconds) || 0;
    const stat = fs.statSync(vod.file_path);
    const after = await decode.scan(vod.file_path, scanOpts);
    out.after = { ok: after.ok, errors: after.errors };
    if (!after.ok) return { ...out, error: `still_broken: ${after.errors[0] || 'decode'}` };

    let stored;
    try {
        stored = await publishReady(vod, { duration, size: stat.size, format: info.format, issues: ['decode_repaired'], announceReady });
    } catch (err) {
        return { ...out, error: `stored_failed: ${err.message}` };
    }

    const version = `${stat.size}-${Math.round(stat.mtimeMs)}`;
    let recutJob = null;
    if (recut && vod.object_id) {
        try { recutJob = await require('../objects/timeline-queue').queueRecut(vod.app_id, vod.object_id, { reason: 'decode_repair', version }); }
        catch (err) { out.recutError = err.message; }
    }
    return { ...out, ok: true, duration: stored, size: stat.size, recut: recutJob };
}

module.exports = { repairVod, publishReady, eligible, FULL_SCAN_TIMEOUT_MS };
