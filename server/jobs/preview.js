/**
 * OpenVibe.Media — job type preview.make
 *
 * A short, muted hover preview for one finished recording or clip: about 6 s from a moment with motion, 320 px wide,
 * MP4 H.264 and WebM, aimed under 400 KB (server/thumbnails/preview-service.js owns the files and the /p/<name> route).
 * It runs in the light lane (a 6 s 320 px encode costs about as much as a thumbnail) and only touches the source's
 * preview_url / preview_webm_url columns: the source file and its thumbnail are never changed.
 *
 *   params { kind: 'vod' | 'clip', id: <row id> }
 *   result { kind, id, preview_url, preview_webm_url, start_seconds, seconds, bytes, webm_bytes }
 *
 * A moment with motion is the first scene change in a 20 s window around 10% in (ffmpeg's `scene` score); when the
 * scene is static the 10% mark itself is used. A virtual clip (a window over its VOD's timeline, no file of its own)
 * previews its window. An audio-only item, a private item, a source under 1.5 s and one that is gone are answered as
 * done with no preview (a preview is an extra, never a reason to retry a recording forever).
 *
 * The backfill (sweepMissing) queues a small batch of them, newest first and due based, so the recordings made before
 * previews existed reach their turn without a retry storm for the ones that can never have one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');
const { JobError } = require('./queue');
const previews = require('../thumbnails/preview-service');

const TYPE = 'preview.make';
const MIN_SOURCE_SECONDS = 1.5;
const WIDTH = previews.PREVIEW_WIDTH;
const SECONDS = previews.PREVIEW_SECONDS;
const MAX_BYTES = previews.MAX_BYTES;
const CANDIDATE_WINDOW = 400;

function targetOf(params = {}) {
    const kind = String(params.kind || '');
    const id = Number(params.id);
    if (!['vod', 'clip'].includes(kind)) throw new JobError('media.job.invalid', "preview.make needs params.kind 'vod' | 'clip'", { permanent: true });
    if (!Number.isInteger(id) || id < 1) throw new JobError('media.job.invalid', 'preview.make needs params.id (the vod or clip id)', { permanent: true });
    return { kind, id };
}

async function rowOf(appId, kind, id) {
    return kind === 'vod' ? await db.getVodById(id, appId) : await db.getClipById(id, appId);
}

async function validate({ appId, params }) {
    const t = targetOf(params || {});
    const row = await rowOf(appId, t.kind, t.id);
    if (!row) throw new JobError('media.job.not_found', `${t.kind} ${t.id} not found`, { status: 404, permanent: true });
    return t;
}

/** The file ffmpeg previews, the clip window's start in it, and the window's own duration. */
async function sourceOf(appId, kind, row) {
    const vodStorage = require('../vod/vod-storage');
    const virtual = kind === 'clip' && !row.file_path && row.vod_id != null;
    const recording = virtual ? await db.getVodById(row.vod_id, appId) : (kind === 'vod' ? row : null);
    if (virtual && !recording) return null;
    const source = await vodStorage.resolveMediaSource(virtual ? recording : row);
    if (!source) return null;
    return {
        input: source.value,
        remote: source.kind === 'url',
        offset: virtual ? Math.max(0, Number(row.start_time) || 0) : 0,
        duration: kind === 'clip' ? Number(row.duration_seconds) || 0 : 0,
        recording,
    };
}

/** First scene change (seconds from the start of the scanned window), or null. */
async function firstSceneChange(input, remote, from, scanSeconds, ctx) {
    const r = await require('./derive').ffmpeg([
        '-hide_banner', '-nostdin', '-v', 'info', ...require('./derive').inputArgs({ remote }),
        '-ss', from.toFixed(2), '-t', scanSeconds.toFixed(2), '-i', input,
        '-an', '-vf', "select='gt(scene,0.08)',showinfo", '-f', 'null', '-',
    ], { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
    if (!r.ok) return null;
    const m = /pts_time:([0-9.]+)/.exec(String(r.stderr || ''));
    if (!m) return null;
    const at = Number(m[1]);
    return Number.isFinite(at) && at >= 0 ? at : null;
}

/** Where the preview starts (seconds inside the item's own window) and how long it is. */
function pickWindow(duration) {
    const len = Math.min(SECONDS, Math.max(1, duration));
    const anchor = duration > 20
        ? Math.min(duration * 0.1, duration - len)
        : Math.max(0, (duration - len) / 2);
    return { len: Math.round(len * 1000) / 1000, anchor: Math.round(anchor * 1000) / 1000 };
}

/** Encode one format, retrying a too-large result at a higher CRF. Returns the file size, or null. */
async function encode(input, remote, startAbs, seconds, out, codec, ctx, attempt = 0) {
    const d = require('./derive');
    const mp4 = codec === 'mp4';
    const args = ['-y', '-nostdin', '-v', 'error', ...d.inputArgs({ remote }),
        '-ss', startAbs.toFixed(3), '-t', seconds.toFixed(3), '-i', input,
        '-an', '-vf', `scale=${WIDTH}:-2`];
    if (mp4) {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(30 + attempt * 4),
            '-maxrate', `${Math.max(160, 420 - attempt * 80)}k`, '-bufsize', '840k',
            '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-movflags', '+faststart', '-f', 'mp4', out);
    } else {
        // VP9 where this ffmpeg has it, VP8 otherwise (both are WebM; a hover preview needs only the codec a browser plays).
        // `-b:v 0` (pure CRF) let a high-motion 6 s clip reach 600 KB in production: a constrained bitrate keeps the
        // 400 KB aim while the CRF still drops quiet scenes. attempt 1 and 2 lower it further.
        args.push('-c:v', 'libvpx-vp9', '-crf', String(40 + attempt * 6),
            '-b:v', `${Math.max(120, 300 - attempt * 60)}k`, '-maxrate', `${Math.max(180, 420 - attempt * 80)}k`,
            '-bufsize', '840k', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-f', 'webm', out);
    }
    let r = await d.ffmpeg(args, { signal: ctx.signal, timeoutMs: 5 * 60 * 1000, niceness: 5 });
    if (!r.ok && !mp4 && /Unknown encoder|libvpx-vp9/i.test(r.stderr)) {
        args.splice(args.indexOf('libvpx-vp9'), 1, 'libvpx');
        args.splice(args.indexOf('-row-mt'), 2);
        const maxrate = args.indexOf('-maxrate'); if (maxrate >= 0) args.splice(maxrate, 4);
        r = await d.ffmpeg(args, { signal: ctx.signal, timeoutMs: 5 * 60 * 1000, niceness: 5 });
    }
    if (!r.ok || !d.existing(out) || !fs.statSync(out).size) return null;
    const size = fs.statSync(out).size;
    if (size > MAX_BYTES && attempt < 2) {
        try { fs.unlinkSync(out); } catch { /* gone */ }
        return await encode(input, remote, startAbs, seconds, out, codec, ctx, attempt + 1);
    }
    return size;
}

async function run(job, ctx) {
    const { kind, id } = targetOf(job.params);
    const row = await rowOf(job.app_id, kind, id);
    if (!row) throw new JobError('media.job.not_found', `${kind} ${id} not found`, { status: 404, permanent: true });
    const visibility = row.visibility || (Number(row.is_public) ? 'public' : 'private');
    // An extra for cards, never content in its own right: a private or audio-only item gets none.
    if (visibility === 'private' || Number(row.audio_only)) return { kind, id, preview_url: null, preview_webm_url: null, skipped: 'not_public_or_no_video' };
    const src = await sourceOf(job.app_id, kind, row);
    if (!src) return { kind, id, preview_url: null, preview_webm_url: null, skipped: 'no_source' };
    const derive = require('./derive');
    const probe = await derive.probeStreams({ input: src.input, remote: src.remote }, { signal: ctx && ctx.signal, timeoutMs: 60000 }).catch(() => null);
    if (!probe || !probe.video) return { kind, id, preview_url: null, preview_webm_url: null, skipped: 'no_video' };
    const duration = src.duration > 0 ? src.duration : Number(probe.duration) || 0;
    if (!(duration >= MIN_SOURCE_SECONDS)) return { kind, id, preview_url: null, preview_webm_url: null, skipped: 'too_short' };
    const { len, anchor } = pickWindow(duration);
    // A moment with motion: the first scene change in a 20 s window just before the 10% mark.
    let start = anchor;
    const scanStart = Math.max(0, anchor - 4);
    const scanLen = Math.min(20, Math.max(0, duration - scanStart));
    if (scanLen > 1) {
        const at = await firstSceneChange(src.input, src.remote, src.offset + scanStart, scanLen, { signal: ctx && ctx.signal }).catch(() => null);
        if (at != null && at + len <= scanLen + 0.25) start = scanStart + at;
    }
    start = Math.max(0, Math.min(start, Math.max(0, duration - len)));
    const names = previews.previewNames(kind, id);
    const dir = previews.PREVIEW_DIR;
    const mp4Path = path.join(dir, names.mp4);
    const webmPath = path.join(dir, names.webm);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const startAbs = src.offset + start;
    const [mp4, webm] = await Promise.all([
        encode(src.input, src.remote, startAbs, len, mp4Path, 'mp4', { signal: ctx && ctx.signal }),
        encode(src.input, src.remote, startAbs, len, webmPath, 'webm', { signal: ctx && ctx.signal }),
    ]);
    if (!mp4 && !webm) {
        try { for (const f of [mp4Path, webmPath]) fs.unlinkSync(f); } catch { /* gone */ }
        throw new JobError('generate_failed', 'Failed to encode a preview');
    }
    if (!mp4) { try { fs.unlinkSync(mp4Path); } catch { /* gone */ } }
    if (!webm) { try { fs.unlinkSync(webmPath); } catch { /* gone */ } }
    const previewUrl = mp4 ? previews.previewUrl(names.mp4) : previews.previewUrl(names.webm);
    const webmUrl = webm ? previews.previewUrl(names.webm) : null;
    const old = { preview_url: row.preview_url, preview_webm_url: row.preview_webm_url };
    const table = kind === 'vod' ? 'vods' : 'clips';
    await db.run(`UPDATE ${table} SET preview_url = ?, preview_webm_url = ? WHERE id = ? AND app_id = ?`, [previewUrl, webmUrl, id, job.app_id]);
    previews.removePreviewFiles(old.preview_url, old.preview_webm_url);
    return { kind, id, preview_url: previewUrl, preview_webm_url: webmUrl, start_seconds: Math.round(startAbs * 1000) / 1000, seconds: len, bytes: mp4 || webm, webm_bytes: webm || 0 };
}

/** Queue this item's preview (idempotent: joins one already queued or running). Never throws. */
async function queuePreview(appId, kind, id, { createdBy = 'system:preview' } = {}) {
    try {
        const row = await rowOf(appId, kind, id);
        if (!row || Number(row.audio_only)) return null;
        if ((row.visibility || (Number(row.is_public) ? 'public' : 'private')) === 'private') return null;
        if (row.preview_url) return null;
        const { enqueue } = require('./queue');
        return await enqueue({ appId, type: TYPE, params: { kind, id }, dedupeActive: true, createdBy });
    } catch (err) {
        console.warn(`[Previews] could not queue ${kind} ${id}: ${err.message}`);
        return null;
    }
}

// ── Backfill (newest first, small batches, due based) ────────
const MIN_AGE_MS = 10 * 60 * 1000;
const RETRY_FAILED_MS = 6 * 3600 * 1000;
const RETRY_DONE_MS = 24 * 3600 * 1000;
const cursorKey = (appId, kind) => `preview_backfill.cursor.${kind}.${appId}`;

function dbTimeMs(value) {
    if (!value) return NaN;
    const t = String(value);
    const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) ? ms : NaN;
}

async function lastAttempt(appId, kind, id) {
    return await db.get(`SELECT status, error_code, created_at FROM media_jobs
        WHERE app_id = ? AND job_type = ? AND params::jsonb ->> 'kind' = ? AND params::jsonb ->> 'id' = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`, [appId, TYPE, kind, String(id)]);
}

function dueAt(last) {
    if (!last) return 0;
    if (last.status === 'queued' || last.status === 'running') return Infinity;
    const at = dbTimeMs(last.created_at);
    if (!Number.isFinite(at)) return 0;
    if (last.status === 'failed') return at + RETRY_FAILED_MS;
    // Succeeded with no preview_url: the item was skipped (no video, too short), so once a day is enough.
    return at + RETRY_DONE_MS;
}

/** One batch for one kind: public, finished, non-audio items with a picture and no preview, newest first. */
async function sweepKind(appId, kind, { now, batch, minAgeMs }) {
    const table = kind === 'vod' ? 'vods' : 'clips';
    const where = kind === 'vod'
        ? `app_id = ? AND is_public = 1 AND COALESCE(is_recording, 0) = 0 AND COALESCE(clips_only, 0) = 0
           AND COALESCE(health_status, '') NOT IN ('missing_file', 'zero_byte')`
        : `app_id = ? AND is_public = 1 AND status = 'ready'`;
    const cursor = Number(await db.getSetting(cursorKey(appId, kind))) || 0;
    const rows = await db.all(`SELECT id, created_at, duration_seconds, thumbnail_url, preview_url, file_path${kind === 'clip' ? ', vod_id' : ''} FROM ${table}
        WHERE ${where}
          AND audio_only IS NOT TRUE
          AND preview_url IS NULL AND thumbnail_url IS NOT NULL
          AND COALESCE(duration_seconds, 0) >= 2
          AND id < ?
        ORDER BY id DESC LIMIT ?`, [appId, cursor || '9223372036854775807', CANDIDATE_WINDOW]);
    let missing = 0, queued = 0, examined = 0, lastId = 0;
    for (const row of rows) {
        examined++;
        lastId = Number(row.id);
        if (row.preview_url) continue;
        // A clip with neither a file nor a VOD has nothing to preview (a failed cut).
        if (kind === 'clip' && !row.file_path && row.vod_id == null) continue;
        const created = dbTimeMs(row.created_at);
        if (Number.isFinite(created) && now - created < minAgeMs) continue;   // finalize/cut may still queue it
        missing++;
        if (now < dueAt(await lastAttempt(appId, kind, row.id))) continue;
        try {
            const out = await require('./queue').enqueue({ appId, type: TYPE, params: { kind, id: row.id }, dedupeActive: true, createdBy: 'system:preview-backfill' });
            if (out && out.created && queued < batch) queued++;
            if (queued >= batch) break;
        } catch (err) {
            console.warn(`[Previews] backfill could not queue ${kind} ${row.id}: ${err.message}`);
        }
    }
    const done = examined === rows.length && rows.length < CANDIDATE_WINDOW;
    await db.setSetting(cursorKey(appId, kind), done ? 0 : lastId, 'number');
    return { missing, queued };
}

/** → { missing, queued } across every tenant (or one app). */
async function sweepMissing({ now = Date.now(), limit = null, appId = null, minAgeMs = MIN_AGE_MS } = {}) {
    const batch = Math.max(1, Math.min(10, Number(limit) || config.jobs.previewBackfillBatch || 2));
    const apps = appId ? [{ app_id: appId }]
        : await db.all(`SELECT DISTINCT app_id FROM vods WHERE is_public = 1 AND COALESCE(is_recording, 0) = 0 AND preview_url IS NULL
            UNION SELECT DISTINCT app_id FROM clips WHERE is_public = 1 AND preview_url IS NULL`);
    let missing = 0, queued = 0;
    for (const { app_id: app } of apps) {
        for (const kind of ['vod', 'clip']) {
            const r = await sweepKind(app, kind, { now, batch, minAgeMs });
            missing += r.missing; queued += r.queued;
        }
    }
    if (queued) console.log(`[Previews] backfill: queued ${queued} preview job(s); ${missing} item(s) have no preview`);
    return { missing, queued };
}

module.exports = {
    spec: { lane: 'light', maxAttempts: 2, timeoutMs: 5 * 60 * 1000, needsObject: false, backoffS: () => 120, validate, run },
    targetOf, pickWindow, sourceOf, queuePreview, sweepMissing, dueAt,
};
