'use strict';

/**
 * OpenVibe.Media — job type attachment.playback (the composer's web copy; docs/attachments.md)
 *
 * A video a person attached to a message is served as it was uploaded, so a browser that cannot play it
 * (an MKV, an AVI, a WMV, an HEVC MOV, an MP4 whose index is at the end) shows nothing. This job makes the
 * copy every browser plays: H.264 (yuv420p) + AAC in an MP4 with the index first, at most 1080 lines tall,
 * the source frame rate up to 60, the rotation applied (server/attachments/playback.js).
 *
 *   params { attachment_id }   the attachment to make the copy for
 *   result { attachment_id, copy: 'playback.mp4' | 'original', bytes, duration_s, width, height, web_safe }
 *
 * The original is never touched: it stays as it was uploaded, and the attachment's answer names the copy
 * (playback.url) once it is ready. A video longer than MEDIA_ATTACHMENT_PLAYBACK_MAX_SECONDS is refused as
 * too long and the attachment says so (status 'failed' with the reason); so does a file ffmpeg cannot read.
 * The copy runs inside the transcode budget the CMAF job uses (transcodeBudgetMs), so one long video
 * cannot hold the lane for ever.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const queue = require('./queue');
const derive = require('./derive');
const playback = require('../attachments/playback');
const { transcodeBudgetMs } = require('./cmaf');

const { JobError } = queue;
const TYPE = 'attachment.playback';
const COPY_NAME = 'playback.mp4';

function validate({ params }) {
    const id = String((params && params.attachment_id) || '').trim();
    if (!/^att_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new JobError('media.job.invalid', 'params.attachment_id must be an attachment id', { permanent: true });
    return { attachment_id: id };
}

/** The attachment is playable as it is: the original is the playback. */
async function ready(id, { duration_s = null, width = null, height = null, name = null, mime = null } = {}) {
    await db.run(`UPDATE media_attachments SET playback_status = 'ready', playback_reason = NULL, playback_name = ?, playback_mime = ?,
                 duration_s = COALESCE(?, duration_s), width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ?`,
    [name, mime, duration_s, width, height, id]);
}

/** The copy could not be made. The original stays; the attachment says why. */
async function failed(id, reason) {
    await db.run('UPDATE media_attachments SET playback_status = ?, playback_reason = ? WHERE id = ?',
    ['failed', String(reason || 'the web copy could not be made').slice(0, 300), id]);
}

/** Queue the web copy of one attachment. */
async function enqueue(attachmentId) {
    const out = await queue.enqueue({ appId: queue.SYSTEM_APP, type: TYPE, params: { attachment_id: attachmentId }, createdBy: 'system:attachments' });
    return out && out.job ? out.job.id : null;
}

async function run(job, ctx = {}) {
    const { attachment_id: id } = validate({ params: job.params });
    const row = await db.get('SELECT * FROM media_attachments WHERE id = ?', [id]);
    if (!row) throw new JobError('media.attachment.not_found', 'the attachment is gone', { permanent: true });
    const dir = path.join(config.attachments.path, id);
    const input = path.join(dir, row.stored_name);
    if (!fs.existsSync(input)) throw new JobError('media.attachment.not_found', 'the attachment bytes are gone', { permanent: true });

    const info = await playback.probe(input);
    if (!info.ok) {
        await failed(id, info.reason || 'the video could not be read');
        throw new JobError('media.attachment.unreadable', info.reason || 'the video could not be read', { permanent: true });
    }
    if (!info.duration_s) {
        await failed(id, 'the length of the video could not be measured');
        throw new JobError('media.attachment.duration_unknown', 'the length of the video could not be measured', { permanent: true });
    }
    const safe = playback.webSafe(info);
    if (safe.safe) {
        await ready(id, { duration_s: info.duration_s, width: info.width, height: info.height, name: null, mime: row.mime });
        return { attachment_id: id, copy: 'original', bytes: Number(row.size_bytes) || 0, duration_s: info.duration_s, width: info.width, height: info.height, web_safe: true };
    }

    const cfg = config.attachments.playback;
    const maxSeconds = Number(cfg.maxSeconds) || 0;
    if (maxSeconds > 0 && info.duration_s > maxSeconds) {
        const reason = `the video is ${Math.round(info.duration_s)} s long, longer than the ${maxSeconds} s a web copy may take`;
        await failed(id, reason);
        throw new JobError('media.attachment.too_long', reason, { permanent: true });
    }

    const output = path.join(dir, COPY_NAME);
    const args = playback.copyArgs({ input, output, info,
        maxHeight: Number(cfg.maxHeight) || 1080, maxFps: Number(cfg.maxFps) || 60,
        crf: Number(cfg.crf), preset: String(cfg.preset || 'veryfast'), threads: Number(cfg.threads) || 2 });
    const r = await derive.ffmpeg(args, { signal: ctx.signal, timeoutMs: transcodeBudgetMs(info.duration_s), niceness: 15 });
    if (!r.ok) {
        const tail = String(r.stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 240);
        await failed(id, `the web copy could not be made: ${tail || `ffmpeg exited ${r.code}`}`);
        throw new JobError('media.attachment.copy_failed', `ffmpeg exited ${r.code}: ${tail}`, { permanent: false });
    }
    let bytes = 0;
    try { bytes = fs.statSync(output).size; } catch { /* the file is not there */ }
    if (!bytes) {
        await failed(id, 'the web copy came out empty');
        throw new JobError('media.attachment.copy_failed', 'the web copy came out empty', { permanent: true });
    }
    await ready(id, { duration_s: info.duration_s, width: info.width, height: info.height, name: COPY_NAME, mime: 'video/mp4' });
    return { attachment_id: id, copy: COPY_NAME, bytes, duration_s: info.duration_s, width: info.width, height: info.height, web_safe: false };
}

module.exports = {
    TYPE, COPY_NAME,
    spec: { lane: 'playback', maxAttempts: 2, timeoutMs: () => 13 * 3600 * 1000, needsObject: false, validate, run },
    run, enqueue, ready, failed, validate,
};
