/**
 * OpenVibe.Media — job type object.cmaf (heavy lane; docs/media-fabric.md §3, F3.1)
 *
 * The source representation of a finished video (or audio) object as CMAF under HLS: a stream copy (ffmpeg -c copy,
 * no re-encode) into fragmented-MP4 segments cut on the source's own keyframes (variable duration), init.mp4 plus
 * 000001.m4s, …, stored under the object's `source/` prefix and indexed in media_timeline (objects/timeline.js), one
 * row per segment with its times, size, sha256 and durability. The source object is never touched: its bytes,
 * locations, visibility, metadata and lifecycle stay as they are. Once the rows are committed, `object.pack` is queued
 * (objects/timeline-queue.js) so packing follows the cut by itself.
 *
 *   params { segment_seconds }   the target segment length, 1-10 (4): a segment ends at the first keyframe after it
 *   result { source_id, rendition: 'source', segments, duration_ms, bytes, durable, local_only,
 *            rows: { inserted, updated, unchanged, removed }, uploaded, master_path }
 *
 * Bytes: each segment lands on this node's disk (OBJECTS_PATH/.timeline/…); with a durable provider it is uploaded under
 * <object>/source/<version>/<name> (version = the sha's prefix) and its row says `durable` once the provider confirms the
 * size. The provider is the placement router's choice (timeline.durableProvider: the source's own canonical copy first),
 * never a hard-coded one. A segment already packed into a chunk (object.pack, F3.3) whose bytes are unchanged keeps its
 * packed row as it is.
 * Idempotent: a rerun makes the same bytes (bitexact), reuses a row whose sha256 matches and its location as it is, and
 * uploads only what is not durable yet. Two-phase: a re-cut writes beside the published segments and the rows commit in
 * one transaction before the old bytes go, so playback never reads bytes that disagree with the playlist; a run that
 * aborts or fails before the commit removes its staged files and keys. An upload that fails leaves its row `local` and
 * fails the attempt, so the retry finishes it.
 * Refused: MEDIA_HLS_ENABLED off, a source that is not ready or not media (permanent), less free disk than the source
 * size plus MEDIA_UPLOAD_MIN_FREE_MB (retried later), a codec fMP4 cannot carry (permanent).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const timeline = require('../objects/timeline');
const derive = require('./derive');
const { JobError } = require('./queue');

const MB = 1024 * 1024;
const DEFAULT_SEGMENT_SECONDS = 4;

function disabled() {
    return new JobError('media.hls.disabled', 'Segment-native video is off on this server (MEDIA_HLS_ENABLED)', { permanent: true, status: 409 });
}

function validate({ obj, params }) {
    if (!config.hls.enabled) throw disabled();
    if (!obj) throw new JobError('media.job.invalid', 'object.cmaf needs object_id', { permanent: true });
    if (!derive.isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) have a timeline', { permanent: true });
    const p = { ...(params || {}) };
    if (p.segment_seconds != null) {
        const s = Number(p.segment_seconds);
        if (!Number.isFinite(s) || s < 1 || s > 10) throw new JobError('media.job.invalid', 'params.segment_seconds must be from 1 to 10', { permanent: true });
        p.segment_seconds = s;
    }
    return p;
}

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

function checkDisk(needBytes) {
    const reserve = config.objects.uploadMinFreeMb * MB;
    let free = Infinity;
    try { const st = fs.statfsSync(config.objects.path); free = Number(st.bavail) * Number(st.bsize); } catch { /* unknown */ }
    if (free < needBytes + reserve) {
        throw new JobError('insufficient_disk', `Not enough free disk: need ${Math.ceil((needBytes + reserve) / MB)} MB, ${Math.floor(free / MB)} MB free`, { retryAfterS: 1800 });
    }
}

const aborted = (ctx) => { if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted'); };

async function run(job, ctx) {
    if (!config.hls.enabled) throw disabled();
    const src = await derive.loadSource(job);
    const source = await derive.resolveSource(src);
    if (!source) throw new JobError('media_unavailable', 'The source bytes are unavailable (no local file and no cloud copy)', { permanent: true });
    checkDisk(Number(src.size_bytes) || 0);
    const rendition = timeline.SOURCE;
    const dir = derive.workDir(job.id);
    try {
        const out = path.join(dir, 'out');
        fs.mkdirSync(out, { recursive: true });
        const r = await derive.ffmpeg(['-y', '-nostdin', '-v', 'error', ...derive.inputArgs(source), '-i', source.input,
            '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags', '+bitexact',
            '-f', 'hls', '-hls_time', String(job.params.segment_seconds || DEFAULT_SEGMENT_SECONDS), '-hls_list_size', '0',
            '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', timeline.INIT_NAME,
            '-start_number', '1', '-hls_segment_filename', path.join(out, '%06d.m4s'), path.join(out, 'index.m3u8')],
        { signal: ctx.signal, timeoutMs: derive.budgetMs(src.size_bytes) });
        aborted(ctx);
        const tail = String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
        if (!r.ok) {
            const unsupported = /not currently supported in container|could not find tag for codec|codec not supported/i.test(r.stderr);
            throw new JobError(unsupported ? 'codec_unsupported' : 'ffmpeg_failed', `ffmpeg exited ${r.code}: ${tail}`, { permanent: unsupported });
        }
        const list = derive.existing(path.join(out, 'index.m3u8')) ? parsePlaylist(fs.readFileSync(path.join(out, 'index.m3u8'), 'utf8')) : [];
        if (!list.length || !derive.existing(path.join(out, timeline.INIT_NAME))) throw new JobError('ffmpeg_failed', `ffmpeg wrote no segments: ${tail}`);

        // Times on the object's own axis: cumulative EXTINF in ms, so each segment ends where the next starts.
        const files = [{ seq: 0, name: timeline.INIT_NAME, start_ms: 0, end_ms: 0, keyframe_ms: null }];
        let cum = 0;
        list.forEach((s, i) => {
            const start = Math.round(cum * 1000);
            cum += s.seconds;
            files.push({ seq: i + 1, name: timeline.segmentName(i + 1), file: s.name, start_ms: start, end_ms: Math.round(cum * 1000), keyframe_ms: start });
        });

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
            const { failed: stuck } = await timeline.deleteBytes(stale);
            if (stuck.length) console.warn(`[Cmaf] ${job.id}: ${stuck.length} old segment(s) left behind (the storage orphan report names them), first ${stuck[0].provider}:${stuck[0].key}`);
            if (failed.length) {
                throw new JobError('upload_failed', `${failed.length} segment(s) not durable yet (${failed[0].slice(0, 200)}); a retry uploads only those`, { retryAfterS: 600 });
            }
            const segs = rows.filter((x) => x.seq > 0);
            // Packing follows the cut by itself (F3): once the rows and their bytes are committed, object.pack is
            // queued once per object (dedupeActive and its idempotency key, objects/timeline-queue.js). A queue error
            // never fails the cut (the timeline is already published); a run whose upload failed is left to its retry.
            try { await require('../objects/timeline-queue').queuePack(job.app_id, src.id); }
            catch (err) { console.warn(`[Cmaf] ${job.id}: pack queue failed: ${err.message}`); }
            return {
                source_id: src.id, rendition, segments: segs.length, duration_ms: segs[segs.length - 1].end_ms,
                bytes: rows.reduce((a, x) => a + x.byte_length, 0),
                durable: rows.filter((x) => x.durability === 'durable').length, local_only: rows.filter((x) => x.durability === 'local').length,
                rows: written, uploaded, master_path: `/o/${src.id}/master.m3u8`, source_unchanged: true,
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
    } finally {
        derive.cleanupWork(job.id);
    }
}

module.exports = {
    spec: { lane: 'heavy', maxAttempts: 3, timeoutMs: 3 * 3600 * 1000, needsObject: true, validate, run },
    parsePlaylist,
};
