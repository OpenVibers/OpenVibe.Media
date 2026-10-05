/**
 * OpenVibe.Media — clip cut reliability.
 *
 *   recutClip(clipId, { reason })   the ONE code path that (re)cuts an existing clip row:
 *                                   resolves the source, cuts, updates the row, thumbnails,
 *                                   commits the outcome with its event, fires the webhook. Records cut_error / cut_attempts and
 *                                   schedules an automatic retry on failure.
 *   spec                            the media job clip.cut (lane clips; roadmap WS-G task 3): a new clip's
 *                                   cut and every re-cut run as a job, so they carry media.job.* events and a
 *                                   job id the UI can reattach to (GET /api/v2/:app/jobs/:id). The queue
 *                                   owns the retries (backoff 2, 10, 30 min; a hopeless source fails at once).
 *   timelineWindow / makeVirtual    a clip over a source that has a CMAF timeline (F3.5) is virtual: no cut, no
 *                                   file; ready at once (storage_provider 'timeline') and played as its window of
 *                                   the source's segments. clip.cut is the materialized path (asked for, or no
 *                                   timeline); materializing a virtual clip keeps it playing until the file is in.
 *   start()                         sweeper: every 3 min, failed clips that still have
 *                                   attempts left are re-cut (or turned virtual, as a recut is,
 *                                   when the source now has a timeline). From the second attempt on, a
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
const objects = () => require('../objects/model');

const MAX_ATTEMPTS = 4;
const BACKOFF_MIN = [2, 10, 30, 90];           // minutes before attempt 2, 3, 4, …
const SWEEP_MS = 3 * 60 * 1000;
const HOT_FETCH_FREE_MULTIPLE = 3;             // need free space ≥ 3× the VOD size to pull it back
let _timer = null, _busy = false;

function freeBytes() {
    try { const st = fs.statfsSync(path.resolve(config.vod.path)); return Number(st.bavail) * Number(st.bsize); } catch { return 0; }
}
async function _clipPublic(clip) { try { return await require('./clips-routes').clipPublic(clip, { hls: false }); } catch { return clip; } }

const RECUT_CAP_MS = 30 * 60 * 1000;         // one clip can never hold the queue longer than this

/** (Re)cut one clip row. Returns { ok, error }. Hard-capped so a hung download/cut can't wedge the sweeper. */
async function recutClip(clipId, opts = {}) {
    let timer = null;
    const cap = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'timed out', capped: true }), RECUT_CAP_MS); });
    const result = await Promise.race([_recutClip(clipId, opts), cap]);
    clearTimeout(timer);
    if (result && result.capped) {
        const clip = await db.getClipById(clipId);
        if (clip && clip.status === 'processing') return await fail(clipId, clip, Number(clip.cut_attempts) || 1, `gave up after ${Math.round(RECUT_CAP_MS / 60000)} min (hung download or cut)`);
    }
    return result;
}

async function _recutClip(clipId, { reason = 'recut', viaJob = false } = {}) {
    const clip = await db.getClipById(clipId);
    if (!clip) return { ok: false, error: 'Clip not found' };
    if (!clip.vod_id) return { ok: false, error: 'Clip has no source VOD' };
    const vod = await db.get('SELECT * FROM vods WHERE id = ?', [clip.vod_id]);
    if (!vod) {
        await objects().withObject('clip', clipId, async () => await db.run("UPDATE clips SET status = 'failed', cut_error = ?, cut_next_at = NULL WHERE id = ?", ['Source VOD no longer exists', clipId]));
        return { ok: false, error: 'Source VOD no longer exists' };
    }
    const attempt = (Number(clip.cut_attempts) || 0) + 1;
    // Row and object (back to uploading) together. A virtual clip being materialized stays ready and playing meanwhile.
    if (isVirtual(clip)) await db.run('UPDATE clips SET cut_attempts = ?, cut_next_at = NULL WHERE id = ?', [attempt, clipId]);
    else await objects().withObject('clip', clipId, async () => await db.run("UPDATE clips SET status = 'processing', cut_attempts = ?, cut_next_at = NULL WHERE id = ?", [attempt, clipId]));

    // Attempt 2+: bring a cloud-stored VOD home first when the disk can take it.
    let source = await vodStorage.resolveMediaSource(vod);
    if (source && source.kind === 'url' && attempt >= 2) {
        const need = (Number(vod.file_size) || 0) * HOT_FETCH_FREE_MULTIPLE;
        if (need && freeBytes() > need) {
            console.log(`[Clips] clip ${clipId}: pulling vod ${vod.id} (${(vod.file_size / 1048576).toFixed(0)} MB) back to local disk for a reliable cut`);
            const r = await vodStorage.moveToHot(vod.id, { trigger: 'clip', reason: `fetched to local disk to cut clip ${clipId}` }).catch(e => ({ ok: false, error: e.message }));
            if (r && r.ok) source = await vodStorage.resolveMediaSource(await db.get('SELECT * FROM vods WHERE id = ?', [vod.id]));
            else console.warn(`[Clips] clip ${clipId}: hot fetch ${r && r.held ? 'refused (the VOD is under a retention hold, its placement stays)' : `failed: ${r && r.error}`} — cutting from the cloud copy`);
        } else {
            console.log(`[Clips] clip ${clipId}: not enough free disk to pull vod ${vod.id} home — cutting from the cloud copy`);
        }
    }
    if (!source) return await fail(clipId, clip, attempt, 'VOD media unavailable (not on disk and no cloud copy)', { viaJob });

    const startTime = Number(clip.start_time) || 0;
    const duration = Math.max(1, (Number(clip.end_time) || 0) - startTime);
    const cut = await cutter.cutClipFile({ source: source.value, startTime, duration });
    if (!cut.ok) return await fail(clipId, clip, attempt, cut.error, { viaJob });
    // Thumbnail first (the clip.ready payload carries it), then the ready transition, the clip's
    // object and its event in one transaction (webhooks.announce), then the webhook.
    try { await require('../thumbnails/thumbnail-service').generateClipThumbnail(clipId, cut.filePath); } catch { /* */ }
    await announce(clip.app_id, 'clip.ready', {
        change: async () => await objects().withObject('clip', clipId, async () => await db.run(`UPDATE clips SET file_path = ?, duration_seconds = ?, end_time = ?, status = 'ready', cut_error = NULL, cut_next_at = NULL,
            storage_provider = CASE WHEN storage_provider = 'timeline' THEN 'local' ELSE storage_provider END WHERE id = ?`,
            [cut.filePath, cut.duration, startTime + cut.duration, clipId])),
        payload: async () => await _clipPublic(await db.getClipById(clipId)),
    });
    console.log(`[Clips] Clip ${clipId} ${reason} OK from vod ${clip.vod_id} (${startTime.toFixed(1)}-${(startTime + cut.duration).toFixed(1)}s, attempt ${attempt})`);
    return { ok: true, duration_seconds: cut.duration };
}

/** A failed attempt. Under a job the queue schedules the retry, so nothing is left for the sweeper. */
async function fail(clipId, clip, attempt, error, { viaJob = false } = {}) {
    const msg = String(error || 'cut failed').slice(0, 500);
    // Nothing to retry when the source itself has no footage there (empty recording, window
    // past the end of what was captured): give up now instead of burning the whole ladder.
    const hopeless = /No decodable footage|Error opening input: End of file|Source VOD no longer exists|Invalid data found when processing input/i.test(msg);
    const more = !viaJob && attempt < MAX_ATTEMPTS && !hopeless;
    const mins = BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)];
    const nextAt = more ? new Date(Date.now() + mins * 60000).toISOString().replace('T', ' ').slice(0, 19) : null;
    // A virtual clip whose materialization failed still plays from the timeline: it keeps its status and says why.
    if (isVirtual(clip)) {
        await db.run('UPDATE clips SET cut_error = ?, cut_next_at = NULL WHERE id = ?', [msg, clipId]);
        console.warn(`[Clips] Clip ${clipId} materialization attempt ${attempt} failed: ${msg} — it stays virtual`);
        return { ok: false, error: msg, retry_at: null, hopeless };
    }
    await announce(clip.app_id, 'clip.failed', {
        change: async () => await objects().withObject('clip', clipId, async () => await db.run("UPDATE clips SET status = 'failed', cut_error = ?, cut_next_at = ? WHERE id = ?", [msg, nextAt, clipId])),
        payload: async () => await _clipPublic(await db.getClipById(clipId)),
    });
    console.warn(`[Clips] Clip ${clipId} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}${viaJob ? (hopeless ? ' — giving up' : ' — the job retries') : more ? ` — retry in ${mins} min` : ' — giving up'}`);
    return { ok: false, error: msg, retry_at: nextAt, hopeless };
}

// ── Virtual clips (docs/media-fabric.md §4, F3.5) ────────────

function isVirtual(clip) { return !!clip && !clip.file_path && clip.storage_provider === 'timeline' && clip.status === 'ready'; }

/**
 * The window [startTime, endTime) seconds over the source timeline of a VOD → { objectId, endTime } (endTime clamped to
 * the timeline's end), or null: MEDIA_HLS_ENABLED off (nothing would play it), no ready object, no timeline yet, or no
 * segment inside the window. Null means the clip is cut (clip.cut).
 */
async function timelineWindow(vod, startTime, endTime) {
    if (!config.hls.enabled || !vod || !vod.object_id || vod.is_recording) return null;
    const obj = await objects().getObject(vod.object_id);
    if (!obj || obj.lifecycle_status !== 'ready') return null;
    const timeline = require('../objects/timeline');
    const rows = timeline.clipRows(await timeline.list(obj.id, timeline.SOURCE), Math.round(startTime * 1000), Math.round(endTime * 1000));
    if (!rows.some((r) => Number(r.seq) > 0)) return null;
    const last = rows[rows.length - 1];
    return { objectId: obj.id, endTime: startTime + Number(last.end_ms) / 1000 };
}

/** Make a clip row virtual and ready (no ffmpeg): row, object and clip.ready event in one transaction, then the webhook. */
async function makeVirtual(clipId, win) {
    const clip = await db.getClipById(clipId);
    if (!clip) return { ok: false, error: 'Clip not found' };
    const startTime = Number(clip.start_time) || 0;
    const endTime = Math.min(Number(clip.end_time) || 0, win.endTime);
    await announce(clip.app_id, 'clip.ready', {
        change: async () => await objects().withObject('clip', clipId, async () => await db.run(`UPDATE clips SET file_path = NULL, storage_provider = 'timeline',
            duration_seconds = ?, end_time = ?, status = 'ready', cut_error = NULL, cut_next_at = NULL WHERE id = ?`, [endTime - startTime, endTime, clipId])),
        payload: async () => await _clipPublic(await db.getClipById(clipId)),
    });
    console.log(`[Clips] Clip ${clipId} virtual over vod ${clip.vod_id}'s timeline (${startTime.toFixed(1)}-${endTime.toFixed(1)}s)`);
    return { ok: true, duration_seconds: endTime - startTime };
}

/** A file-less clip over a source with a timeline → made virtual (true); otherwise false and it is cut. */
async function retryVirtual(clipId) {
    const clip = await db.getClipById(clipId);
    if (!clip || clip.file_path || !clip.vod_id) return false;
    const win = await timelineWindow(await db.getVodById(clip.vod_id), Number(clip.start_time) || 0, Number(clip.end_time) || 0);
    if (!win) return false;
    await makeVirtual(clipId, win);
    return true;
}

async function sweep() {
    if (_busy) return;
    _busy = true;
    try {
        const due = await db.all(`SELECT id FROM clips WHERE status = 'failed' AND vod_id IS NOT NULL
            AND COALESCE(cut_attempts, 0) < ? AND (cut_next_at IS NULL OR cut_next_at <= ov_now())
            AND created_at >= datetime('now', '-30 days')
            AND NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.job_type = 'clip.cut' AND j.app_id = clips.app_id AND CAST(json_extract(j.params, '$.clip_id') AS INTEGER) = clips.id)
            ORDER BY created_at DESC LIMIT 4`, [MAX_ATTEMPTS]) || [];
        for (const row of due) {
            try {
                // The same recovery as POST /api/clips/:id/recut: a failed clip whose source now has a timeline turns virtual.
                if (!(await retryVirtual(row.id))) await recutClip(row.id, { reason: 'auto-retry' });
            } catch (e) { console.warn(`[Clips] auto-retry ${row.id}:`, e.message); }
        }
    } finally { _busy = false; }
}

async function start() {
    if (_timer) return;
    try { vodStorage.cleanupStaleDownloads(); } catch { /* */ }
    // Anything left 'processing' by a crash/restart is really failed — queue it for a retry. The rows
    // and their objects (uploading -> failed) in one transaction.
    try {
        await objects().withObject('clip', (ids) => ids, async () => {
            const ids = (await db.all("SELECT id FROM clips WHERE status = 'processing'")).map(r => r.id);
            if (ids.length) await db.run(`UPDATE clips SET status = 'failed', cut_error = COALESCE(cut_error, 'interrupted by a restart') WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
            return ids;
        });
    } catch (err) { console.warn('[Clips] marking interrupted cuts failed:', err.message); }
    setTimeout(() => sweep().catch(() => {}), 40 * 1000);
    _timer = setInterval(() => sweep().catch(e => console.warn('[Clips] retry sweep:', e.message)), SWEEP_MS);
    if (_timer.unref) _timer.unref();
    console.log('[Clips] cut retry sweeper started (every 3 min, up to 4 attempts, hot-fetch from attempt 2)');
}

// ── clip.cut as a media job ──────────────────────────────────

/** The clip's media object (legacy:<app>:clip:<id>), the job's object. */
async function clipObjectId(appId, clipId) {
    const row = await db.get('SELECT id FROM media_objects WHERE legacy_ref = ?', [`legacy:${appId}:clip:${clipId}`]);
    return row ? row.id : null;
}

/** Queue the cut of a clip row → { job, created }. A repeated request for the same clip reuses its active job. */
async function enqueueCut(appId, clipId, { reason = 'cut', createdBy = null, ownerUserId = null } = {}) {
    const queue = require('../jobs/queue');
    const out = await queue.enqueue({ appId, type: 'clip.cut', objectId: await clipObjectId(appId, clipId), params: { clip_id: Number(clipId), reason }, dedupeActive: true, createdBy, ownerUserId });
    try { require('../jobs/worker').kick(); } catch { /* the poll picks it up */ }
    return out;
}

const spec = {
    lane: 'clips',
    maxAttempts: MAX_ATTEMPTS,
    timeoutMs: RECUT_CAP_MS + 5 * 60 * 1000,
    needsObject: false,
    backoffS: (attempt) => BACKOFF_MIN[Math.min(Math.max(0, attempt - 1), BACKOFF_MIN.length - 1)] * 60,   // after attempt 1: 2 min, then 10, 30
    validate({ params }) {
        const id = Number(params && params.clip_id);
        if (!Number.isInteger(id) || id < 1) throw new (require('../jobs/queue').JobError)('media.job.invalid', 'clip.cut needs params.clip_id', { permanent: true });
        return { clip_id: id, reason: String((params && params.reason) || 'cut').slice(0, 40) };
    },
    async run(job) {
        const { JobError } = require('../jobs/queue');
        const clip = await db.getClipById(job.params.clip_id);
        if (!clip || clip.app_id !== job.app_id) throw new JobError('not_found', 'The clip no longer exists', { permanent: true });
        const r = await recutClip(clip.id, { reason: job.params.reason || 'cut', viaJob: true });
        if (!r.ok) throw new JobError('clip_cut_failed', r.error || 'cut failed', { permanent: !!r.hopeless });
        return { clip_id: clip.id, status: 'ready', duration_seconds: r.duration_seconds ?? null };
    },
};

module.exports = { recutClip, sweep, start, enqueueCut, clipObjectId, timelineWindow, makeVirtual, isVirtual, spec, MAX_ATTEMPTS };
