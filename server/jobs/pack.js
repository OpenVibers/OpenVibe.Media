/**
 * OpenVibe.Media — job type object.pack (heavy lane; docs/media-fabric.md §3, F3.3)
 *
 * Packing after finalize: the durable media segments of one rendition, contiguous and not packed yet, are concatenated
 * into chunk objects of about `params.target_seconds` (60) each — ~30× fewer objects, PUTs, HEADs and keys — and every
 * segment's media_timeline row then names its chunk: key/local_path/durable_provider the chunk's, packed_object_id its
 * sha256 (the chunk's content address), byte_offset/byte_length the segment inside it. Its name, times and sha256 stay
 * the segment's, so the playlists and their URIs do not change; the segment route serves a packed segment as a ranged
 * read of its chunk. The init segment is not packed.
 *
 *   params { rendition ('source'), target_seconds (10-300, 60) }
 *   result { source_id, rendition, packs, segments, bytes, provider, rows_packed, already_packed, waiting, removed_segments, left_behind }
 *
 * Per chunk, two-phase: every segment's bytes are checked against its row's sha256 (this node's copy, else the durable
 * one through the placement router); the chunk is uploaded to the router's durable provider under
 * <object>/<rendition>/<chunk sha prefix>/p<first seq>.m4s and verified there (size + sha256 read back); the rows move
 * to it in one transaction, and only then are the per-segment files and keys deleted — the chunk holds the same,
 * verified bytes, and keeping both would double the stored bytes and keep every per-segment object the packing exists
 * to remove. A delete that fails leaves an orphan the storage report names. A chunk whose rows changed meanwhile (a
 * re-cut) is dropped again before anything is deleted. Never deletes a timeline row.
 * Idempotent: a rerun finds every segment packed and packs nothing. Runs of one segment are not packed. A segment
 * that is not durable yet ends a run: it is packed by a later run once it is. Honours the abort signal (an upload in
 * flight stops) and a budget of derive.budgetMs(the rendition's bytes); the work directory is always removed.
 * Refused: MEDIA_HLS_ENABLED off, a non-media object or a missing timeline (permanent), an object under a hold (retried).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const timeline = require('../objects/timeline');
const derive = require('./derive');
const { JobError } = require('./queue');

const DEFAULT_TARGET_SECONDS = 60;

function disabled() {
    return new JobError('media.hls.disabled', 'Segment-native video is off on this server (MEDIA_HLS_ENABLED)', { permanent: true, status: 409 });
}

function validate({ obj, params }) {
    if (!config.hls.enabled) throw disabled();
    if (!obj) throw new JobError('media.job.invalid', 'object.pack needs object_id', { permanent: true });
    if (!derive.isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) have a timeline', { permanent: true });
    const p = { ...(params || {}) };
    if (p.rendition != null && !/^[a-z0-9_-]{1,32}$/.test(String(p.rendition))) throw new JobError('media.job.invalid', 'params.rendition is a rendition name', { permanent: true });
    if (p.target_seconds != null) {
        const s = Number(p.target_seconds);
        if (!Number.isFinite(s) || s < 10 || s > 300) throw new JobError('media.job.invalid', 'params.target_seconds must be from 10 to 300', { permanent: true });
        p.target_seconds = s;
    }
    return p;
}

const ms = (r) => Number(r.end_ms) - Number(r.start_ms);

/**
 * The chunks to make: maximal runs of contiguous, durable, unpacked media segments, cut once a chunk reaches the target;
 * a short tail joins the chunk before it. Runs of one segment stay as they are. → [[row, …], …] plus the counts.
 */
function plan(rows, targetMs) {
    const segs = rows.filter((r) => Number(r.seq) > 0);
    const runs = [];
    let run = [];
    for (const r of segs) {
        const fits = !r.packed_object_id && r.durability === 'durable' && r.durable_provider;
        const next = run.length && Number(r.seq) === Number(run[run.length - 1].seq) + 1;
        if (fits && (next || !run.length)) { run.push(r); continue; }
        if (run.length) runs.push(run);
        run = fits ? [r] : [];
    }
    if (run.length) runs.push(run);
    const chunks = [];
    for (const rn of runs) {
        if (rn.length < 2) continue;
        const mine = [];
        let cur = [];
        let dur = 0;
        for (const r of rn) {
            cur.push(r);
            dur += ms(r);
            if (dur >= targetMs) { mine.push(cur); cur = []; dur = 0; }
        }
        if (cur.length) {
            if (mine.length && dur < targetMs / 2) mine[mine.length - 1].push(...cur);
            else mine.push(cur);
        }
        chunks.push(...mine.filter((c) => c.length > 1));
    }
    return {
        chunks,
        alreadyPacked: segs.filter((r) => r.packed_object_id).length,
        waiting: segs.filter((r) => !r.packed_object_id && r.durability !== 'durable').length,
    };
}

const aborted = (ctx) => { if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted'); };

/** The segment's bytes as a file in `dir`, checked against its row: this node's copy, else the durable one (router). */
async function segmentFile(row, dir, ctx) {
    if (row.local_path && derive.existing(row.local_path) && await derive.sha256File(row.local_path) === row.sha256) return row.local_path;
    const router = require('../placement/router');
    const vodStorage = require('../vod/vod-storage');
    const decision = await router.route({ locations: timeline.locationsOf({ ...row, local_path: null }), purpose: 'derive', presign: false });
    for (const c of decision.candidates || []) {
        const url = await vodStorage.presignGet(c.provider, c.key, 900).catch(() => null);
        if (!url) continue;
        const res = await fetch(url, { signal: ctx.signal }).catch((err) => { aborted(ctx); return { ok: false, err }; });
        if (!res.ok) continue;
        const file = path.join(dir, `seg-${row.seq}`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        if (await derive.sha256File(file) === row.sha256) return file;
    }
    throw new JobError('segment_unreadable', `${row.name}: no copy with the indexed sha256`, { retryAfterS: 1800 });
}

async function run(job, ctx) {
    if (!config.hls.enabled) throw disabled();
    const started = Date.now();
    const src = await derive.loadSource(job);
    const rendition = String(job.params.rendition || timeline.SOURCE);
    const rows = await timeline.list(src.id, rendition);
    if (!rows.some((r) => Number(r.seq) > 0)) throw new JobError('media.timeline.missing', `No ${rendition} timeline to pack (run object.cmaf first)`, { permanent: true });
    if (await require('../objects/model').isHeld(src.id)) throw new JobError('media.object.held', 'The object is under a hold: its segments stay as they are', { retryAfterS: 6 * 3600 });
    const budget = derive.budgetMs(rows.reduce((a, r) => a + Number(r.byte_length), 0));
    const { chunks, alreadyPacked, waiting } = plan(rows, (job.params.target_seconds || DEFAULT_TARGET_SECONDS) * 1000);
    const out = { source_id: src.id, rendition, packs: 0, segments: 0, bytes: 0, provider: null, rows_packed: 0, already_packed: alreadyPacked, waiting, removed_segments: 0, left_behind: 0 };
    if (!chunks.length) return out;
    const provider = await timeline.durableProvider(src);
    if (!provider) throw new JobError('media.provider.unavailable', 'No durable provider is configured and healthy for the chunks', { retryAfterS: 1800 });
    out.provider = provider;
    const vodStorage = require('../vod/vod-storage');
    const dir = derive.workDir(job.id);
    try {
        for (const chunk of chunks) {
            aborted(ctx);
            if (Date.now() - started > budget) throw new JobError('budget_exceeded', `Packing ran past its ${Math.round(budget / 1000)} s budget; the rest is packed by a retry`, { retryAfterS: 60 });
            // Concatenate, recording where each segment starts in the chunk.
            const tmp = path.join(dir, 'chunk.m4s');
            const fd = fs.openSync(tmp, 'w');
            const hash = crypto.createHash('sha256');
            const placed = [];
            let offset = 0;
            try {
                for (const r of chunk) {
                    aborted(ctx);
                    const bytes = fs.readFileSync(await segmentFile(r, dir, ctx));
                    fs.writeSync(fd, bytes);
                    hash.update(bytes);
                    placed.push({ row: r, byte_offset: offset });
                    offset += bytes.length;
                }
            } finally { fs.closeSync(fd); }
            const sha = hash.digest('hex');
            const name = `p${timeline.segmentName(Number(chunk[0].seq))}`;
            const key = timeline.keyFor(src.id, rendition, name, sha.slice(0, 12));
            // This node keeps a copy of the chunk where it kept copies of the segments.
            const keepLocal = chunk.some((r) => r.local_path && derive.existing(r.local_path));
            const localPath = keepLocal ? timeline.localPathFor(src, rendition, name, sha.slice(0, 12)) : null;
            let uploaded = false;
            let committed = false;
            try {
                if (!vodStorage.providerAvailable(provider)) throw new JobError('media.provider.unavailable', `${provider} is unavailable`, { retryAfterS: 600 });
                await vodStorage.uploadFile(provider, key, tmp, 'video/iso.segment', { signal: ctx.signal });
                uploaded = true;
                aborted(ctx);
                // Durable means verified: the provider gives back exactly these bytes.
                const back = await vodStorage.sha256Object(provider, key);
                if (!back || back.sha256 !== sha) throw new JobError('pack_unverified', `${provider}:${key} does not read back as ${sha.slice(0, 12)}`, { retryAfterS: 600 });
                if (localPath) { fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.renameSync(tmp, localPath); }
                aborted(ctx);
                committed = await timeline.markPacked(src.id, rendition, placed.map((p) => ({
                    row: p.row, key, local_path: localPath, durable_provider: provider, packed_object_id: sha, byte_offset: p.byte_offset,
                })), { jobId: job.id });
                if (!committed) throw new JobError('media.timeline.changed', 'The timeline changed while packing (a re-cut); a retry packs the new segments', { retryAfterS: 60 });
            } finally {
                if (!committed) {
                    if (uploaded) await vodStorage.deleteObject(provider, key).catch(() => { /* best effort: the orphan report names it */ });
                    if (localPath) { try { fs.unlinkSync(localPath); } catch { /* not moved */ } }
                    try { fs.unlinkSync(tmp); } catch { /* moved or gone */ }
                }
            }
            // Phase two, after the commit: the per-segment copies the chunk now replaces.
            const { failed } = await timeline.deleteBytes(chunk);
            if (failed.length) console.warn(`[Pack] ${job.id}: ${failed.length} packed segment key(s) left behind (the storage orphan report names them), first ${failed[0].provider}:${failed[0].key}`);
            out.left_behind += failed.length;
            out.removed_segments += chunk.length - failed.length;
            out.packs++;
            out.segments += chunk.length;
            out.rows_packed += chunk.length;
            out.bytes += offset;
            for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
        }
        return out;
    } finally {
        derive.cleanupWork(job.id);
    }
}

module.exports = {
    spec: { lane: 'heavy', maxAttempts: 3, timeoutMs: 3 * 3600 * 1000, needsObject: true, validate, run },
    plan,
};
