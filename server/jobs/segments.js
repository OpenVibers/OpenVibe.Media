/**
 * OpenVibe.Media — publishing a produced rendition's segments into the timeline (docs/media-fabric.md §3, F3.1/F4).
 *
 * Shared by the jobs that cut one rendition of a media object — object.cmaf's stream copy (server/jobs/cmaf.js) and
 * rendition.create's transcode (server/jobs/rendition.js). Both run ffmpeg into an HLS fMP4 directory; this module
 * turns that output into media_timeline rows and publishes them:
 *
 *   parsePlaylist    ffmpeg's index.m3u8 → [{ name, seconds }], in order.
 *   producedFiles    those plus the init segment → [{ seq, name, file, start_ms, end_ms, keyframe_ms }], times on the
 *                    object's own axis (cumulative EXTINF, so each segment ends where the next starts).
 *   publishRendition hash each file, place it content-addressed on this node (timeline.localPathFor/keyFor, versioned
 *                    by the sha prefix) and — through the placement router's durable provider (timeline.durableProvider,
 *                    purpose `durable`) — on B2/R2, then commit every row of the rendition in ONE transaction
 *                    (timeline.replace). Only then are the bytes a previous cut named and this one does not deleted, and
 *                    a location any row of any object still names is kept (F3.4; timeline.deleteBytes). Finally
 *                    object.pack is queued for the rendition so packing follows the cut by itself.
 *
 * Idempotent: a rerun makes the same bytes (bitexact), reuses a row whose sha256 matches and its location as it is, keeps
 * a packed row whose chunk holds the same bytes, and uploads only what is not durable yet. Two-phase: the rows commit
 * before the old bytes go, so playback never reads bytes that disagree with the playlist; a run that aborts or fails
 * before the commit removes the files and keys it staged (content-addressed: never one another run already committed). A
 * durable delete that fails leaves an orphan the storage report names, never bytes a live row still points at.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const timeline = require('../objects/timeline');
const derive = require('./derive');
const { JobError } = require('./queue');

/** The segments ffmpeg wrote, in order: [{ name, seconds }] from its playlist (#EXTINF before each URI). */
function parsePlaylist(text) {
    const out = [];
    let dur = null;
    for (const line of String(text).split(/\r?\n/)) {
        const inf = /^#EXTINF:([\d.]+)/.exec(line);
        if (inf) { dur = Number(inf[1]); continue; }
        if (line && !line.startsWith('#') && dur != null) { out.push({ name: line.trim(), seconds: dur }); dur = null; }
    }
    return out;
}

/** The produced files as timeline rows in the making: the init segment (seq 0) then each media segment, in order. */
function producedFiles(list) {
    const files = [{ seq: 0, name: timeline.INIT_NAME, start_ms: 0, end_ms: 0, keyframe_ms: null }];
    let cum = 0;
    list.forEach((s, i) => {
        const start = Math.round(cum * 1000);
        cum += s.seconds;
        files.push({ seq: i + 1, name: timeline.segmentName(i + 1), file: s.name, start_ms: start, end_ms: Math.round(cum * 1000), keyframe_ms: start });
    });
    return files;
}

function checkDisk(needBytes) {
    const reserve = require('../config').objects.uploadMinFreeMb * 1024 * 1024;
    let free = Infinity;
    try { const st = fs.statfsSync(require('../config').objects.path); free = Number(st.bavail) * Number(st.bsize); } catch { /* unknown */ }
    if (free < needBytes + reserve) {
        throw new JobError('insufficient_disk', `Not enough free disk: need ${Math.ceil((needBytes + reserve) / 1048576)} MB, ${Math.floor(free / 1048576)} MB free`, { retryAfterS: 1800 });
    }
}

const aborted = (ctx) => { if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted'); };

/**
 * Publish `files` (producedFiles) of `rendition` for `src` from the work directory `out`. Returns the row counts and
 * the totals the job result is built from. Throws JobError: the timeline changed under a pack, or a segment that is not
 * durable yet. `label` names the job in warnings (e.g. 'Cmaf').
 */
async function publishRendition({ job, ctx, src, rendition, out, list, label = 'Segments' }) {
    const files = producedFiles(list);
    const prev = new Map((await timeline.list(src.id, rendition)).map((x) => [Number(x.seq), x]));
    const vodStorage = require('../vod/vod-storage');
    const target = await timeline.durableProvider(src);
    // B2/R2 configured but none healthy (breakers open) is "not durable yet", retried later, never a quiet success.
    const remoteConfigured = vodStorage.REMOTE_PROVIDERS.some((p) => vodStorage.providerConfigured(p));
    const rows = [];
    let uploaded = 0;
    const failed = [];
    // Bytes written before the new rows commit are staged: an abort or a failure before the commit removes them
    // again, so a cancelled run leaves neither untracked keys nor files.
    const stagedRemote = [];
    const stagedLocal = [];
    let committed = false;
    try {
        for (const f of files) {
            aborted(ctx);
            const tmp = path.join(out, f.file || f.name);
            if (!derive.existing(tmp)) throw new JobError('ffmpeg_failed', `ffmpeg listed ${f.file || f.name} but did not write it`);
            const size = fs.statSync(tmp).size;
            const sha = await derive.sha256File(tmp);
            const old = prev.get(f.seq);
            const match = !!old && old.sha256 === sha;
            if (match && old.packed_object_id) {
                // Already packed into a chunk (object.pack): the same bytes, so the row and its chunk stay as they are.
                rows.push(Object.fromEntries(['seq', ...timeline.FIELDS].map((k) => [k, k === 'seq' ? f.seq : old[k]])));
                continue;
            }
            // Content-addressed: the same bytes always land at the same versioned location, so a rerun rewrites
            // nothing and a re-cut writes beside the old segment until the new rows are published.
            const version = sha.slice(0, 12);
            const dest = timeline.localPathFor(src, rendition, f.name, version);
            const key = timeline.keyFor(src.id, rendition, f.name, version);
            let localPath = dest;
            let durable = match && old.durability === 'durable' ? old.durable_provider : null;
            if (match && old.local_path && derive.existing(old.local_path)) {
                localPath = old.local_path;   // the previous copy is exactly these bytes: keep it and its location
            } else {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.renameSync(tmp, dest);
                stagedLocal.push(dest);
            }
            if (!durable && !target && remoteConfigured) failed.push(`${f.name}: no healthy durable provider`);
            if (!durable && target) {
                try {
                    if (!vodStorage.providerAvailable(target)) throw new Error(`${target} is unavailable`);
                    await vodStorage.uploadFile(target, key, localPath, f.seq === 0 ? 'video/mp4' : 'video/iso.segment', { signal: ctx.signal });
                    stagedRemote.push({ provider: target, key });
                    durable = target;
                    uploaded++;
                } catch (err) {
                    if (ctx.signal.aborted) throw ctx.signal.reason || err;   // a cancelled upload is not "not durable yet"
                    failed.push(`${f.name}: ${err.message}`);
                }
            }
            rows.push({
                seq: f.seq, name: f.name, start_ms: f.start_ms, end_ms: f.end_ms, keyframe_ms: f.keyframe_ms, key, local_path: localPath,
                durable_provider: durable, packed_object_id: null, byte_offset: null, byte_length: size, sha256: sha,
                durability: durable ? 'durable' : 'local',
            });
        }
        aborted(ctx);
        let written;
        try {
            written = await timeline.replace(src.id, rendition, rows, { jobId: job.id, expect: prev });
        } catch (err) {
            // An object.pack committed after `prev` was read: these rows would name the segment keys it deleted.
            if (err instanceof timeline.TimelineChanged) throw new JobError('media.timeline.changed', 'The timeline changed while cutting (a pack); a retry cuts against the new rows', { retryAfterS: 60 });
            throw err;
        }
        committed = true;
        // Phase two, only once the new rows are published: the bytes a previous cut named that this one does not.
        // A deletion that fails leaves an orphan the storage report names, never bytes a live row still points at.
        const named = new Set(rows.map((r) => `${r.key}\n${r.local_path || ''}`));
        const stale = [...prev.values()].filter((old) => !named.has(`${old.key}\n${old.local_path || ''}`));
        // A location any row still names — another object's, or the source's own (another rendition/seq, or a
        // different local_path with the same key) — is kept: the old cut's rows go, the shared bytes stay, and the
        // last naming object's removal deletes them. `isNamed` counts every object, no exception.
        const { failed: stuck, kept } = await timeline.deleteBytes(stale);
        if (stuck.length) console.warn(`[${label}] ${job.id}: ${stuck.length} old segment(s) left behind (the storage orphan report names them), first ${stuck[0].provider}:${stuck[0].key}`);
        if (kept.length) console.warn(`[${label}] ${job.id}: ${kept.length} old segment location(s) kept — another object's rows name them`);
        if (failed.length) {
            throw new JobError('upload_failed', `${failed.length} segment(s) not durable yet (${failed[0].slice(0, 200)}); a retry uploads only those`, { retryAfterS: 600 });
        }
        const segs = rows.filter((x) => x.seq > 0);
        // Packing follows the cut by itself (F3): once the rows and their bytes are committed, object.pack is queued
        // for this rendition (dedupeActive joins an active pack; a later cut queues a new one, objects/timeline-queue.js).
        // A queue error never fails the cut (the timeline is already published); a run whose upload failed is left to
        // its retry.
        try { await require('../objects/timeline-queue').queuePack(job.app_id, src.id, { rendition }); }
        catch (err) { console.warn(`[${label}] ${job.id}: pack queue failed: ${err.message}`); }
        return {
            rows: written, uploaded,
            durable: rows.filter((x) => x.durability === 'durable').length,
            local_only: rows.filter((x) => x.durability === 'local').length,
            segments: segs.length, bytes: rows.reduce((a, x) => a + x.byte_length, 0),
            duration_ms: segs.length ? Number(segs[segs.length - 1].end_ms) : 0,
        };
    } catch (err) {
        if (!committed) {
            // Content-addressed: another run may have committed these very keys and files, so only unnamed ones go.
            for (const k of stagedRemote) {
                if (!await timeline.isNamed({ provider: k.provider, key: k.key }).catch(() => true)) await vodStorage.deleteObject(k.provider, k.key).catch(() => { /* best effort */ });
            }
            for (const p of stagedLocal) {
                if (await timeline.isNamed({ localPath: p }).catch(() => true)) continue;
                try { fs.unlinkSync(p); } catch { /* already gone */ }
            }
        }
        throw err;
    }
}

module.exports = { parsePlaylist, producedFiles, checkDisk, aborted, publishRendition };
