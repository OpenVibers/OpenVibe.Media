/**
 * OpenVibe.Media — clip cut reliability.
 *
 *   recutClip(clipId, { reason })   the ONE code path that (re)cuts an existing clip row:
 *                                   resolves the source, cuts, updates the row, thumbnails,
 *                                   commits the outcome with its event, fires the webhook. Records cut_error / cut_attempts and
 *                                   schedules an automatic retry on failure.
 *   start()                         sweeper: every 3 min, failed clips that still have
 *                                   attempts left are re-cut. From the second attempt on, a
 *                                   VOD that lives in cloud storage is first pulled back to
 *                                   local disk (moveToHot) — cutting a multi-hour recording
 *                                   over HTTP is what used to time out — as long as there is
 *                                   comfortable free space for it.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/database');
const config = require('../config');
const cutter = require('./clip-cutter');
const vodStorage = require('./vod-storage');
const { announce } = require('../webhooks');

const MAX_ATTEMPTS = 4;
const BACKOFF_MIN = [2, 10, 30, 90];           // minutes before attempt 2, 3, 4, …
const SWEEP_MS = 3 * 60 * 1000;
const HOT_FETCH_FREE_MULTIPLE = 3;             // need free space ≥ 3× the VOD size to pull it back
let _timer = null, _busy = false;

function freeBytes() {
    try { const st = fs.statfsSync(path.resolve(config.vod.path)); return Number(st.bavail) * Number(st.bsize); } catch { return 0; }
}
function _clipPublic(clip) { try { return require('./clips-routes').clipPublic(clip); } catch { return clip; } }

const RECUT_CAP_MS = 30 * 60 * 1000;         // one clip can never hold the queue longer than this

/** (Re)cut one clip row. Returns { ok, error }. Hard-capped so a hung download/cut can't wedge the sweeper. */
async function recutClip(clipId, opts = {}) {
    let timer = null;
    const cap = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'timed out', capped: true }), RECUT_CAP_MS); });
    const result = await Promise.race([_recutClip(clipId, opts), cap]);
    clearTimeout(timer);
    if (result && result.capped) {
        const clip = db.getClipById(clipId);
        if (clip && clip.status === 'processing') return fail(clipId, clip, Number(clip.cut_attempts) || 1, `gave up after ${Math.round(RECUT_CAP_MS / 60000)} min (hung download or cut)`);
    }
    return result;
}

async function _recutClip(clipId, { reason = 'recut' } = {}) {
    const clip = db.getClipById(clipId);
    if (!clip) return { ok: false, error: 'Clip not found' };
    if (!clip.vod_id) return { ok: false, error: 'Clip has no source VOD' };
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [clip.vod_id]);
    if (!vod) { db.run("UPDATE clips SET status = 'failed', cut_error = ?, cut_next_at = NULL WHERE id = ?", ['Source VOD no longer exists', clipId]); return { ok: false, error: 'Source VOD no longer exists' }; }
    const attempt = (Number(clip.cut_attempts) || 0) + 1;
    db.run("UPDATE clips SET status = 'processing', cut_attempts = ?, cut_next_at = NULL WHERE id = ?", [attempt, clipId]);

    // Attempt 2+: bring a cloud-stored VOD home first when the disk can take it.
    let source = await vodStorage.resolveMediaSource(vod);
    if (source && source.kind === 'url' && attempt >= 2) {
        const need = (Number(vod.file_size) || 0) * HOT_FETCH_FREE_MULTIPLE;
        if (need && freeBytes() > need) {
            console.log(`[Clips] clip ${clipId}: pulling vod ${vod.id} (${(vod.file_size / 1048576).toFixed(0)} MB) back to local disk for a reliable cut`);
            const r = await vodStorage.moveToHot(vod.id, { trigger: 'clip', reason: `fetched to local disk to cut clip ${clipId}` }).catch(e => ({ ok: false, error: e.message }));
            if (r && r.ok) source = await vodStorage.resolveMediaSource(db.get('SELECT * FROM vods WHERE id = ?', [vod.id]));
            else console.warn(`[Clips] clip ${clipId}: hot fetch failed: ${r && r.error}`);
        } else {
            console.log(`[Clips] clip ${clipId}: not enough free disk to pull vod ${vod.id} home — cutting from the cloud copy`);
        }
    }
    if (!source) return fail(clipId, clip, attempt, 'VOD media unavailable (not on disk and no cloud copy)');

    const startTime = Number(clip.start_time) || 0;
    const duration = Math.max(1, (Number(clip.end_time) || 0) - startTime);
    const cut = await cutter.cutClipFile({ source: source.value, startTime, duration });
    if (!cut.ok) return fail(clipId, clip, attempt, cut.error);
    // Thumbnail first (the clip.ready payload carries it), then the ready transition and its event
    // in one transaction (webhooks.announce), then the webhook.
    try { await require('../thumbnails/thumbnail-service').generateClipThumbnail(clipId, cut.filePath); } catch { /* */ }
    announce(clip.app_id, 'clip.ready', {
        change: () => db.run("UPDATE clips SET file_path = ?, duration_seconds = ?, end_time = ?, status = 'ready', cut_error = NULL, cut_next_at = NULL WHERE id = ?",
            [cut.filePath, cut.duration, startTime + cut.duration, clipId]),
        payload: () => _clipPublic(db.getClipById(clipId)),
    });
    require('../objects/model').safeSync('clip', clipId);
    console.log(`[Clips] Clip ${clipId} ${reason} OK from vod ${clip.vod_id} (${startTime.toFixed(1)}-${(startTime + cut.duration).toFixed(1)}s, attempt ${attempt})`);
    return { ok: true };
}

function fail(clipId, clip, attempt, error) {
    const msg = String(error || 'cut failed').slice(0, 500);
    // Nothing to retry when the source itself has no footage there (empty recording, window
    // past the end of what was captured): give up now instead of burning the whole ladder.
    const hopeless = /No decodable footage|Error opening input: End of file|Source VOD no longer exists|Invalid data found when processing input/i.test(msg);
    const more = attempt < MAX_ATTEMPTS && !hopeless;
    const mins = BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)];
    const nextAt = more ? new Date(Date.now() + mins * 60000).toISOString().replace('T', ' ').slice(0, 19) : null;
    announce(clip.app_id, 'clip.failed', {
        change: () => db.run("UPDATE clips SET status = 'failed', cut_error = ?, cut_next_at = ? WHERE id = ?", [msg, nextAt, clipId]),
        payload: () => _clipPublic(db.getClipById(clipId)),
    });
    require('../objects/model').safeSync('clip', clipId);
    console.warn(`[Clips] Clip ${clipId} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}${more ? ` — retry in ${mins} min` : ' — giving up'}`);
    return { ok: false, error: msg, retry_at: nextAt };
}

async function sweep() {
    if (_busy) return;
    _busy = true;
    try {
        const due = db.all(`SELECT id FROM clips WHERE status = 'failed' AND vod_id IS NOT NULL
            AND COALESCE(cut_attempts, 0) < ? AND (cut_next_at IS NULL OR cut_next_at <= CURRENT_TIMESTAMP)
            AND created_at >= datetime('now', '-30 days') ORDER BY created_at DESC LIMIT 4`, [MAX_ATTEMPTS]) || [];
        for (const row of due) { try { await recutClip(row.id, { reason: 'auto-retry' }); } catch (e) { console.warn(`[Clips] auto-retry ${row.id}:`, e.message); } }
    } finally { _busy = false; }
}

function start() {
    if (_timer) return;
    try { vodStorage.cleanupStaleDownloads(); } catch { /* */ }
    // Anything left 'processing' by a crash/restart is really failed — queue it for a retry.
    try { db.run("UPDATE clips SET status = 'failed', cut_error = COALESCE(cut_error, 'interrupted by a restart') WHERE status = 'processing'"); } catch { /* */ }
    setTimeout(() => sweep().catch(() => {}), 40 * 1000);
    _timer = setInterval(() => sweep().catch(e => console.warn('[Clips] retry sweep:', e.message)), SWEEP_MS);
    if (_timer.unref) _timer.unref();
    console.log('[Clips] cut retry sweeper started (every 3 min, up to 4 attempts, hot-fetch from attempt 2)');
}

module.exports = { recutClip, sweep, start, MAX_ATTEMPTS };
