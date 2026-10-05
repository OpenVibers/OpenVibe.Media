/**
 * OpenVibe.Media — materialized clips over the source's bytes (docs/materialized-clips.md, F3.6)
 *
 * A clip whose source has a CMAF timeline (MEDIA_HLS_ENABLED) can be materialized instead of re-encoded end to end:
 * its interior segments are the source's own rows — same key/local_path/durable_provider/packed_object_id/byte_* and
 * sha256, renumbered and relative to the clip — and only the two window edges are re-encoded from the source
 * segment's bytes (its init + segment, read the way the sprite job reads them: local copy, packed slice, or a ranged
 * durable GET, sha256 verified) into one fMP4 segment plus its own init, starting on a keyframe. The clip's rows land
 * in ONE transaction that first locks the source rows it names FOR SHARE and aborts (retryable) when any is gone or any
 * location column moved under it — the whole location, so a pack between the read and the pin aborts and re-plans.
 *
 *   planWindow(rows, startMs, endMs)   pure: head/interior/tail over the source's media segments. An edge within
 *                                      EDGE_MS (100 ms) of a segment boundary is not re-encoded: the clip starts or
 *                                      ends on that boundary. null = nothing playable in the window.
 *   pinRows({…})                       the FOR SHARE read + timeline.replace in one transaction; throws JobError
 *                                      (media.timeline.changed, retryable) when a named source row is gone or moved.
 *   materialize({ job, ctx, clip, vod })  the whole path (encode edges, place their bytes content-addressed under the
 *                                      clip's own keys, pin the rows). null = not applicable (the flag off, no source
 *                                      timeline, an empty window): clip.cut keeps its full re-encode.
 *
 * Placement is publishRendition's (server/jobs/segments.js): bytes are staged until the pin commits and removed when
 * it does not; a durable upload that fails is retried with the row kept local. Edge names: the two inits are the
 * rows with negative seq (-1 init-head.mp4, -2 init-tail.mp4) the migration admits; every media piece (a copied
 * interior segment or a re-encoded edge) is named by its clip seq, so two pieces never share a playlist URI.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const timeline = require('../objects/timeline');
const model = require('../objects/model');
const derive = require('../jobs/derive');
const previews = require('../jobs/previews');
const segments = require('../jobs/segments');
const { JobError } = require('../jobs/queue');

const EDGE_MS = 100;
// The whole location of a source row the plan names: every column a pack or a re-cut could move, as
// timeline.replace's expect compares (docs/materialized-clips.md step 3), plus byte_offset/byte_length.
const LOCATION_FIELDS = ['key', 'local_path', 'durable_provider', 'packed_object_id', 'byte_offset', 'byte_length', 'sha256'];

function locationOf(row) {
    return LOCATION_FIELDS.map((f) => (row[f] == null ? '\u0000' : String(row[f]))).join('\n');
}

/**
 * Plan a clip window over one rendition's rows.
 * → { originMs, endMs, durationMs, sourceInit, sourceRows, pieces } or null.
 * A piece is { kind: 'copy', source } or { kind: 'head'|'tail', source, start_ms, end_ms, init } (source milliseconds).
 * sourceRows are the source rows the plan copies and therefore names: the seq 0 init when an interior copy needs it
 * (init_name NULL rows decode with it), plus every copied segment. The pin compares exactly these.
 */
function planWindow(rows, startMs, endMs) {
    const segs = rows.filter((r) => Number(r.seq) > 0).sort((a, b) => Number(a.seq) - Number(b.seq));
    if (!segs.length) return null;
    const first = segs[0];
    const last = segs[segs.length - 1];
    let start = Math.max(0, Math.floor(Number(startMs) || 0));
    let end = Math.floor(Number(endMs) || 0);
    if (!(end > start)) return null;
    if (end <= Number(first.start_ms) || start >= Number(last.end_ms)) return null;
    start = Math.max(start, Number(first.start_ms));
    end = Math.min(end, Number(last.end_ms));
    const at = (t) => segs.find((r) => Number(r.start_ms) <= t && t < Number(r.end_ms)) || null;
    const headSeg = at(start);
    const tailSeg = at(end - 1);
    const overlapping = segs.filter((r) => Number(r.end_ms) > start && Number(r.start_ms) < end);
    const pieces = [];
    for (const r of overlapping) {
        const rs = Number(r.start_ms);
        const re = Number(r.end_ms);
        // An edge within 100 ms of a segment boundary is not re-encoded: the clip starts or ends on that boundary.
        const headCut = r === headSeg && start - rs > EDGE_MS;
        const tailCut = r === tailSeg && re - end > EDGE_MS;
        if (!headCut && !tailCut) { pieces.push({ kind: 'copy', source: r }); continue; }
        const a = headCut ? start : rs;
        const b = tailCut ? end : re;
        if (!(b > a)) { pieces.push({ kind: 'copy', source: r }); continue; }
        // One segment holding both edges is re-encoded once, as the head edge (its init-head carries it).
        pieces.push({ kind: headCut ? 'head' : 'tail', source: r, start_ms: a, end_ms: b, init: headCut ? timeline.HEAD_INIT : timeline.TAIL_INIT });
    }
    if (!pieces.length) return null;
    const firstPiece = pieces[0];
    const lastPiece = pieces[pieces.length - 1];
    const originMs = firstPiece.kind === 'copy' ? Number(firstPiece.source.start_ms) : firstPiece.start_ms;
    const snapEndMs = lastPiece.kind === 'copy' ? Number(lastPiece.source.end_ms) : lastPiece.end_ms;
    if (!(snapEndMs > originMs)) return null;
    const sourceInit = rows.find((r) => Number(r.seq) === 0) || null;
    const sourceRows = [];
    if (pieces.some((p) => p.kind === 'copy') && sourceInit) sourceRows.push(sourceInit);
    for (const p of pieces) if (p.kind === 'copy') sourceRows.push(p.source);
    return { originMs, endMs: snapEndMs, durationMs: snapEndMs - originMs, sourceInit, sourceRows, pieces };
}

/** A copied source segment row as the clip's own: the location, bytes and times, seq renumbered, times relative. */
function copiedRow(source, seq, originMs) {
    const row = { seq };
    for (const f of timeline.FIELDS) row[f] = source[f] == null ? null : source[f];
    row.name = timeline.segmentName(seq);   // the clip's own URI: a copied source name could collide with an edge's
    row.start_ms = Number(source.start_ms) - originMs;
    row.end_ms = Number(source.end_ms) - originMs;
    row.keyframe_ms = source.keyframe_ms == null ? null : Number(source.keyframe_ms) - originMs;
    row.init_name = null;                   // decodes with the rendition's seq 0 init
    return row;
}

/** The source's seq 0 init as the clip's own row (seq 0, times 0), or null. */
function copiedInitRow(source) {
    const row = copiedRow(source, 0, 0);
    row.name = timeline.INIT_NAME;
    row.start_ms = 0;
    row.end_ms = 0;
    row.keyframe_ms = null;
    return row;
}

/** A source segment's bytes with its init prepended, checked against the row's sha256 (previews.rowBuffer). */
async function readPiece(segRow, initRow, ctx) {
    const seg = await previews.rowBuffer(segRow, ctx);
    if (!seg) throw new JobError('segment_unreadable', `${segRow.name}: no copy with the indexed sha256`, { retryAfterS: 1800 });
    const init = initRow ? await previews.rowBuffer(initRow, ctx) : null;
    if (initRow && !init) throw new JobError('segment_unreadable', `${initRow.name}: no copy with the indexed sha256`, { retryAfterS: 1800 });
    return init ? Buffer.concat([init, seg]) : seg;
}

/** Re-encode one edge piece from the source segment's bytes into one fMP4 segment plus its own init. */
async function encodeEdge({ ctx, piece, initRow, dir }) {
    fs.mkdirSync(dir, { recursive: true });
    const pieceFile = path.join(dir, 'in.mp4');
    fs.writeFileSync(pieceFile, await readPiece(piece.source, initRow, ctx));
    const relMs = piece.start_ms - Number(piece.source.start_ms);
    const durMs = piece.end_ms - piece.start_ms;
    const out = path.join(dir, 'out');
    fs.mkdirSync(out, { recursive: true });
    const budget = Math.min(30 * 60 * 1000, Math.max(180000, derive.budgetMs(Number(piece.source.byte_length) || 0) * 4));
    const r = await derive.ffmpeg(['-y', '-nostdin', '-v', 'error',
        ...(relMs > 0 ? ['-ss', (relMs / 1000).toFixed(3)] : []),
        '-i', pieceFile, '-t', (durMs / 1000).toFixed(3),
        '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-map_metadata', '-1',
        '-f', 'hls', '-hls_time', '3600', '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', timeline.INIT_NAME,
        '-start_number', '1', '-hls_segment_filename', path.join(out, '%06d.m4s'), path.join(out, 'index.m3u8')],
    { signal: ctx.signal, timeoutMs: budget });
    segments.aborted(ctx);
    const tail = String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
    if (!r.ok) {
        const unsupported = /Unknown encoder|not currently supported in container|could not find tag for codec|codec not supported/i.test(r.stderr);
        throw new JobError(unsupported ? 'codec_unsupported' : 'ffmpeg_failed', `ffmpeg exited ${r.code}: ${tail}`, { permanent: unsupported });
    }
    const list = derive.existing(path.join(out, 'index.m3u8')) ? segments.parsePlaylist(fs.readFileSync(path.join(out, 'index.m3u8'), 'utf8')) : [];
    const initFile = path.join(out, timeline.INIT_NAME);
    if (list.length !== 1 || !derive.existing(initFile) || !derive.existing(path.join(out, list[0].name))) {
        throw new JobError('ffmpeg_failed', `ffmpeg wrote ${list.length} segment(s), expected one edge segment: ${tail}`);
    }
    return { initFile, segFile: path.join(out, list[0].name) };
}

/**
 * Place one produced file under the clip's own content-addressed location, as publishRendition does: a previous row
 * with the same sha256 and a live location is reused (a packed one as it is), else the file is written to this node's
 * timeline and uploaded to the router's durable provider. A failed upload is recorded, not thrown: the row stays
 * local and the caller retries. Staged paths/keys are collected so a failed run can remove them.
 */
async function placeFile({ clipObj, prev, seq, name, file, contentType, target, remoteConfigured, stagedLocal, stagedRemote, failed, ctx }) {
    const vodStorage = require('./vod-storage');
    const size = fs.statSync(file).size;
    const sha = await derive.sha256File(file);
    const old = prev.get(Number(seq));
    const match = !!old && old.sha256 === sha;
    if (match && old.packed_object_id) {
        // object.pack moved these bytes into a chunk: the same bytes, so the row and its chunk stay as they are.
        return { key: old.key, local_path: old.local_path, durable_provider: old.durable_provider, packed_object_id: old.packed_object_id,
            byte_offset: old.byte_offset, byte_length: old.byte_length, sha256: sha, durability: old.durability };
    }
    const version = sha.slice(0, 12);
    const dest = timeline.localPathFor(clipObj, timeline.SOURCE, name, version);
    const key = timeline.keyFor(clipObj.id, timeline.SOURCE, name, version);
    let localPath = dest;
    let durable = match && old.durability === 'durable' ? old.durable_provider : null;
    if (match && old.local_path && derive.existing(old.local_path)) {
        localPath = old.local_path;   // the previous copy is exactly these bytes: keep it and its location
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(file, dest);
        stagedLocal.push(dest);
    }
    if (!durable && !target && remoteConfigured) failed.push(`${name}: no healthy durable provider`);
    if (!durable && target) {
        try {
            if (!vodStorage.providerAvailable(target)) throw new Error(`${target} is unavailable`);
            await vodStorage.uploadFile(target, key, localPath, contentType, { signal: ctx.signal });
            stagedRemote.push({ provider: target, key });
            durable = target;
        } catch (err) {
            if (ctx.signal.aborted) throw ctx.signal.reason || err;   // a cancelled upload is not "not durable yet"
            failed.push(`${name}: ${err.message}`);
        }
    }
    return { key, local_path: localPath, durable_provider: durable, packed_object_id: null, byte_offset: null, byte_length: size, sha256: sha, durability: durable ? 'durable' : 'local' };
}

/**
 * Insert the clip's rows in ONE transaction that first locks the named source rows FOR SHARE and aborts with a
 * retryable JobError when any is gone or any location column differs from the planned row. The lock makes a source
 * removeObject's row DELETE wait for this commit (its post-commit isNamed check then keeps the bytes); a removal or a
 * pack that committed first fails the comparison and the job re-plans. `rows` is the clip's complete row set
 * (negative-seq edge inits included); timeline.replace makes the clip's rendition exactly those rows.
 */
async function pinRows({ clipObjectId, sourceObjectId, rows, sourceRows = [], jobId = null }) {
    await db.getDb().tx(async () => {
        if (sourceRows.length) {
            const seqs = sourceRows.map((r) => Number(r.seq));
            // ORDER BY seq: the same order the packer and a source removal lock a source's rows in, so a pin cannot
            // deadlock with them on the rows it takes FOR SHARE (a deadlock is retried twice, then fails the job).
            const got = await db.all(`SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq IN (${seqs.map(() => '?').join(', ')}) ORDER BY seq FOR SHARE`,
                [sourceObjectId, timeline.SOURCE, ...seqs]);
            const bySeq = new Map(got.map((r) => [Number(r.seq), r]));
            for (const want of sourceRows) {
                const now = bySeq.get(Number(want.seq));
                if (!now || locationOf(now) !== locationOf(want)) {
                    throw new JobError('media.timeline.changed', `the source timeline changed while materializing (source seq ${want.seq}); a retry re-plans`, { retryAfterS: 60 });
                }
            }
        }
        await timeline.replace(clipObjectId, timeline.SOURCE, rows, { jobId });
    });
    return { rows: rows.length };
}

/**
 * Materialize `clip` over `vod`'s source timeline. → { ok: true, duration, end_ms } or null when the path does not
 * apply (the flag off, no job context, a source without a ready object or media timeline, an empty window). Throws
 * JobError on a failed encode/upload/pin. The bytes are placed before the pin; a throw before the commit removes
 * what was staged and leaves the clip's rows as they were.
 */
async function materialize({ job, ctx, clip, vod }) {
    // A clip that already has a file of its own never becomes a timeline clip: its recut stays a cut (F3.5).
    if (!job || !ctx || !clip || !clip.object_id || clip.file_path || !vod || !vod.object_id) return null;
    if (!config.hls.enabled || !config.hls.materialized) return null;
    const srcObj = await model.getObject(vod.object_id);
    if (!srcObj || srcObj.lifecycle_status !== 'ready') return null;
    const srcRows = await timeline.list(vod.object_id, timeline.SOURCE);
    const plan = planWindow(srcRows, Math.round((Number(clip.start_time) || 0) * 1000), Math.round((Number(clip.end_time) || 0) * 1000));
    if (!plan) return null;
    const clipObj = await model.getObject(clip.object_id);
    if (!clipObj || clipObj.app_id !== clip.app_id) return null;
    const vodStorage = require('./vod-storage');
    const dir = derive.workDir(job.id);
    const prev = new Map((await timeline.list(clip.object_id, timeline.SOURCE)).map((r) => [Number(r.seq), r]));
    const target = await timeline.durableProvider(clipObj);
    const remoteConfigured = vodStorage.REMOTE_PROVIDERS.some((p) => vodStorage.providerConfigured(p));
    const stagedRemote = [];
    const stagedLocal = [];
    const failed = [];
    let committed = false;
    try {
        const maxSeg = srcRows.reduce((m, r) => Math.max(m, Number(r.byte_length) || 0), 0);
        segments.checkDisk(4 * maxSeg + 32 * 1024 * 1024);
        const edgeSegments = new Map();   // clip seq -> placed media row fields
        const edgeInits = new Map();      // init name -> placed init row fields
        for (const [i, piece] of plan.pieces.entries()) {
            if (piece.kind === 'copy') continue;
            segments.aborted(ctx);
            const seq = i + 1;
            const made = await encodeEdge({ ctx, piece, initRow: plan.sourceInit, dir: path.join(dir, `edge-${piece.kind}-${seq}`) });
            edgeSegments.set(seq, await placeFile({ clipObj, prev, seq, name: timeline.segmentName(seq), file: made.segFile,
                contentType: 'video/iso.segment', target, remoteConfigured, stagedLocal, stagedRemote, failed, ctx }));
            edgeInits.set(piece.init, await placeFile({ clipObj, prev, seq: piece.init === timeline.HEAD_INIT ? -1 : -2, name: piece.init, file: made.initFile,
                contentType: 'video/mp4', target, remoteConfigured, stagedLocal, stagedRemote, failed, ctx }));
        }
        const rows = [];
        for (const [i, piece] of plan.pieces.entries()) {
            const seq = i + 1;
            if (piece.kind === 'copy') { rows.push(copiedRow(piece.source, seq, plan.originMs)); continue; }
            rows.push({ seq, name: timeline.segmentName(seq), start_ms: piece.start_ms - plan.originMs, end_ms: piece.end_ms - plan.originMs,
                keyframe_ms: piece.start_ms - plan.originMs, ...edgeSegments.get(seq), init_name: piece.init });
        }
        if (edgeInits.has(timeline.HEAD_INIT)) rows.push({ seq: -1, name: timeline.HEAD_INIT, start_ms: 0, end_ms: 0, keyframe_ms: null, ...edgeInits.get(timeline.HEAD_INIT), init_name: null });
        if (edgeInits.has(timeline.TAIL_INIT)) rows.push({ seq: -2, name: timeline.TAIL_INIT, start_ms: 0, end_ms: 0, keyframe_ms: null, ...edgeInits.get(timeline.TAIL_INIT), init_name: null });
        if (plan.pieces.some((p) => p.kind === 'copy') && plan.sourceInit) rows.push(copiedInitRow(plan.sourceInit));
        rows.sort((a, b) => Number(a.seq) - Number(b.seq));
        segments.aborted(ctx);
        await pinRows({ clipObjectId: clip.object_id, sourceObjectId: vod.object_id, rows, sourceRows: plan.sourceRows, jobId: job.id });
        committed = true;
        // Phase two, only once the rows are published: the edge bytes a previous attempt named that this plan does
        // not. A location any row still names — the source's, or the source's interior locations the clip's own
        // copied rows still name — is kept (F3.4), never deleted.
        const named = new Set(rows.map((r) => `${r.key}\n${r.local_path || ''}`));
        const stale = [...prev.values()].filter((old) => !named.has(`${old.key}\n${old.local_path || ''}`));
        const { failed: stuck, kept } = await timeline.deleteBytes(stale);
        if (stuck.length) console.warn(`[Materialize] ${job.id}: ${stuck.length} old edge segment(s) left behind (the storage orphan report names them), first ${stuck[0].provider}:${stuck[0].key}`);
        if (kept.length) console.warn(`[Materialize] ${job.id}: ${kept.length} old edge location(s) kept — another object's rows name them`);
        if (failed.length) throw new JobError('upload_failed', `${failed.length} edge segment(s) not durable yet (${failed[0].slice(0, 200)}); a retry uploads only those`, { retryAfterS: 600 });
        return { ok: true, duration: plan.durationMs / 1000, end_ms: plan.endMs };
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
    } finally {
        derive.cleanupWork(job.id);
    }
}

module.exports = { EDGE_MS, LOCATION_FIELDS, locationOf, planWindow, pinRows, materialize };
