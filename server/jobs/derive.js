/**
 * OpenVibe.Media — job types object.split and object.remux (heavy lane)
 *
 * Both make NEW objects from a ready vod/clip (or a native video/audio object) with a stream copy
 * (ffmpeg -c copy: no re-encode). They never touch the source: its bytes, locations, visibility and
 * lifecycle stay as they are. Each output is a native object in the same tenant with the source's
 * owner, visibility `private` (the owner decides what becomes public), a verified local copy, and a
 * `derived_from` relationship to the source ({ job_id, method, part, parts, start_seconds, … }).
 *
 *   object.split  params { parts | segment_seconds, … }   one object per part, cut at keyframes (a part
 *                 can start up to one keyframe interval early, so neighbours may overlap slightly).
 *                 Progress is checkpointed per part: a retry resumes after the last finished part.
 *                 result { source_id, parts: [{ part, object_id, start_seconds, duration_seconds, size_bytes }],
 *                          oversized_parts, method: 'split' }
 *   object.remux  params {}                                one object: the whole source remuxed (seek index,
 *                 duration; MP4 +faststart). Also the source's `remux` variant.
 *                 result { source_id, object_id, size_bytes, duration_seconds, method: 'remux' }
 *
 * Refused before any work: a source that is not ready (permanent), a tenant quota the output would
 * exceed (permanent), less free disk than the source size plus MEDIA_UPLOAD_MIN_FREE_MB (retried later).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../config');
const db = require('../db/database');
const model = require('../objects/model');
const { JobError } = require('./queue');

const MB = 1024 * 1024;
const MAX_PARTS = 1000;
const MEDIA_KINDS = ['vod', 'clip'];

function isMediaObject(obj) {
    return !!obj && (MEDIA_KINDS.includes(obj.kind) || /^(video|audio)\//.test(String(obj.mime_type || '')));
}

function extFor(obj, sourcePath) {
    const fromPath = path.extname(String(sourcePath || obj.canonical_key || '')).toLowerCase();
    if (['.webm', '.mp4', '.mkv', '.mov', '.m4a', '.ogg', '.mp3'].includes(fromPath)) return fromPath === '.mov' ? '.mp4' : fromPath;
    const m = String(obj.mime_type || '');
    if (m === 'video/mp4' || m === 'audio/mp4') return '.mp4';
    if (m === 'video/x-matroska') return '.mkv';
    if (m === 'audio/mpeg') return '.mp3';
    if (m === 'audio/ogg' || m === 'video/ogg') return '.ogg';
    return '.webm';
}

function mimeFor(ext, obj) {
    return { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.m4a': 'audio/mp4', '.ogg': 'video/ogg', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg' }[ext]
        || obj.mime_type || 'application/octet-stream';
}

function existing(p) {
    try { return p && fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

/**
 * Something ffmpeg can read for this object: a local path, or a presigned R2/B2 URL.
 * Projected vods/clips resolve the way playback does; native objects through their locations.
 */
async function resolveSource(obj) {
    const vodStorage = require('../vod/vod-storage');
    const ref = model.parseLegacyRef(obj.legacy_ref);
    if (ref && (ref.kind === 'vod' || ref.kind === 'clip')) {
        const row = db.get(`SELECT * FROM ${ref.kind === 'vod' ? 'vods' : 'clips'} WHERE id = ?`, [Number(ref.id)]);
        if (!row || !row.file_path) return null;
        const local = ref.kind === 'vod'
            ? existing(vodStorage.localPathForVod(row)) || existing(row.file_path)
            : existing(row.file_path) || existing(path.join(path.resolve(config.vod.clipsPath), path.basename(row.file_path)));
        if (local) return { input: local, name: row.file_path };
        const src = await vodStorage.resolveMediaSource(row);
        return src ? { input: src.value, name: row.file_path, remote: src.kind === 'url' } : null;
    }
    const locs = model.listLocations(obj.id);
    const local = locs.find(l => l.provider === 'local' && l.state !== 'missing' && existing(l.key));
    if (local) return { input: local.key, name: obj.canonical_key || local.key };
    for (const p of ['r2', 'b2']) {
        const l = locs.find(x => x.provider === p && !['missing', 'corrupt'].includes(x.state));
        if (!l || !vodStorage.providerConfigured(p)) continue;
        const url = await vodStorage.presignGet(p, l.key, 6 * 3600).catch(() => null);
        if (url) return { input: url, name: l.key, remote: true };
    }
    return null;
}

function freeBytes(dir) {
    try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch { return Infinity; }
}

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', (c) => h.update(c));
        s.on('error', reject);
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/** ffmpeg with a deadline and the job's abort signal. Resolves { ok, code, stderr }. */
function ffmpeg(args, { signal, timeoutMs }) {
    return new Promise((resolve) => {
        let proc;
        try { proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (err) { return resolve({ ok: false, code: -1, stderr: err.message }); }
        let stderr = '';
        let done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); resolve(r); };
        const kill = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
        const onAbort = () => kill();
        const t = setTimeout(() => { stderr += '\n[timed out]'; kill(); }, timeoutMs);
        if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', onAbort, { once: true }); }
        proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
        proc.on('error', (err) => finish({ ok: false, code: -1, stderr: err.message }));
        proc.on('close', (code) => finish({ ok: code === 0, code, stderr }));
    });
}

function inputArgs(src) {
    return src.remote ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10'] : [];
}

/** Budget for one stream copy of `bytes`: ~45 s per GB, at least 3 min, at most 2 h. */
function budgetMs(bytes) {
    return Math.min(2 * 3600 * 1000, Math.max(180000, Math.round((Number(bytes) || 0) / 1e9 * 45000) + 60000));
}

function probeDuration(p) {
    return require('../vod/media-tools').probeVodInfo(p).then(i => i.duration || 0).catch(() => 0);
}

function loadSource(job) {
    const obj = model.getObject(job.object_id);
    if (!obj || obj.app_id !== job.app_id) throw new JobError('not_found', 'The source object no longer exists', { permanent: true });
    if (obj.lifecycle_status !== 'ready') throw new JobError('not_ready', `The source object is ${obj.lifecycle_status}`, { permanent: true });
    if (!isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) can be split or remuxed', { permanent: true });
    return obj;
}

function checkRoom(obj, needBytes) {
    const reserve = config.objects.uploadMinFreeMb * MB;
    const free = freeBytes(config.objects.path);
    if (free < needBytes + reserve) {
        throw new JobError('insufficient_disk', `Not enough free disk: need ${Math.ceil((needBytes + reserve) / MB)} MB, ${Math.floor(free / MB)} MB free`, { retryAfterS: 1800 });
    }
    // Outputs go to the source's namespace: every quota from there up to the tenant must have the room.
    const app = db.getApp(obj.app_id);
    const q = app ? require('../objects/namespaces').checkQuota(app, obj.namespace || db.rootNamespace(app), { bytes: needBytes, objects: 1 }) : null;
    if (q) throw new JobError('quota_exceeded', `The storage quota would be exceeded (${q.detail})`, { permanent: true });
}

function workDir(jobId) {
    const d = path.join(config.objects.path, '.jobs', jobId);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function cleanupWork(jobId) {
    try { fs.rmSync(path.join(config.objects.path, '.jobs', jobId), { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Register one finished output file as a private native object derived from `src`: create the row,
 * move the bytes under OBJECTS_PATH/<app>/<id>, verified local location, relationship; `alsoInTx`
 * (the job checkpoint) commits with it. Returns the new object id.
 */
// kind/suffix: a derived image (waveform, sprite) is an `asset` named <source>-<suffix>.<ext>; parts and remuxes keep the source's kind.
async function adopt({ src, file, ext, job, relation, metadata, variant, saveCheckpoint, checkpointFor, kind = null, suffix = null }) {
    const size = fs.statSync(file).size;
    const hash = await sha256File(file);
    const md = model.parseJson(src.metadata, {});
    const id = require('openvibe-contracts').ids.newId('media');
    const dest = path.join(config.objects.path, src.app_id, id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    try {
        saveCheckpoint(checkpointFor(id, size), () => {
            db.run(`INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, owner_app, owner_user_id, visibility, lifecycle_status,
                        mime_type, size_bytes, content_hash, canonical_provider, canonical_key, legacy_ref, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 'ready', ?, ?, ?, 'local', ?, NULL, ?)`,
            [id, src.app_id, src.namespace || db.rootNamespace(db.getApp(src.app_id) || { app_id: src.app_id }), kind || src.kind, src.owner_subject || null, src.owner_app || src.app_id, src.owner_user_id ?? null,
                mimeFor(ext, src), size, hash, dest,
                JSON.stringify({ title: md.title || null, derived_from: src.id, job_id: job.id, filename: `${src.id}${suffix ? `-${suffix}` : metadata.part ? `-part${metadata.part}` : '-remux'}${ext}`, ...metadata })]);
            model.upsertLocation(id, { provider: 'local', key: dest, state: 'present', size_bytes: size, checksum: hash, verified: true });
            model.setRelationship(id, 'derived_from', src.id, { job_id: job.id, ...relation });
            if (variant) model.setVariant(src.id, variant, id, `${job.type}@1`);
        });
    } catch (err) {
        try { fs.unlinkSync(dest); } catch { /* not moved */ }
        throw err;
    }
    return { id, size };
}

// ── object.split ─────────────────────────────────────────────

function validateSplit({ obj, params }) {
    if (!obj) throw new JobError('media.job.invalid', 'object.split needs object_id', { permanent: true });
    if (!isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) can be split', { permanent: true });
    const p = { ...(params || {}) };
    const parts = p.parts != null ? Number(p.parts) : null;
    const seg = p.segment_seconds != null ? Number(p.segment_seconds) : null;
    if (parts == null && seg == null) throw new JobError('media.job.invalid', 'object.split needs params.parts (2-1000) or params.segment_seconds', { permanent: true });
    if (parts != null && (!Number.isInteger(parts) || parts < 2 || parts > MAX_PARTS)) throw new JobError('media.job.invalid', 'params.parts must be an integer from 2 to 1000', { permanent: true });
    if (seg != null && (!Number.isFinite(seg) || seg < 1)) throw new JobError('media.job.invalid', 'params.segment_seconds must be at least 1', { permanent: true });
    return p;
}

async function runSplit(job, ctx) {
    const src = loadSource(job);
    const source = await resolveSource(src);
    if (!source) throw new JobError('media_unavailable', 'The source bytes are unavailable (no local file and no cloud copy)', { permanent: true });
    const md = model.parseJson(src.metadata, {});
    const duration = Number(md.duration_seconds) || await probeDuration(source.input);
    if (!(duration > 0)) throw new JobError('duration_unknown', 'The source duration is unknown: remux it first (object.remux)', { permanent: true });
    const parts = job.params.segment_seconds
        ? Math.min(MAX_PARTS, Math.ceil(duration / Number(job.params.segment_seconds)))
        : Math.min(MAX_PARTS, Number(job.params.parts));
    const seg = job.params.segment_seconds ? Number(job.params.segment_seconds) : Math.ceil(duration / parts);
    const cp = ctx.checkpoint && Array.isArray(ctx.checkpoint.parts) ? ctx.checkpoint : { parts: [] };
    const doneParts = new Set(cp.parts.map(p => p.part));
    const remaining = Math.max(0, (Number(src.size_bytes) || 0) - cp.parts.reduce((a, p) => a + p.size_bytes, 0));
    checkRoom(src, remaining);
    const ext = extFor(src, source.name);
    const dir = workDir(job.id);
    const maxBytes = Number(job.params.max_bytes) || require('../objects/invariant').thresholds().maxBytes;

    for (let i = 0; i < parts; i++) {
        const part = i + 1;
        const start = i * seg;
        if (start >= duration) break;
        if (doneParts.has(part)) continue;
        if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted');
        const len = Math.min(seg, duration - start);
        const out = path.join(dir, `part-${part}${ext}`);
        // A cloud source is presigned again for every part: a long split outlives one presigned URL.
        const src2 = part === 1 || !source.remote ? source : (await resolveSource(src)) || source;
        const r = await ffmpeg(['-y', '-nostdin', '-v', 'error', ...inputArgs(src2), '-ss', String(start), '-i', src2.input, '-t', String(len),
            '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(ext === '.mp4' ? ['-movflags', '+faststart'] : []), out],
        { signal: ctx.signal, timeoutMs: budgetMs((Number(src.size_bytes) || 0) / parts * 2) });
        if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted');
        if (!r.ok || !existing(out) || fs.statSync(out).size === 0) {
            try { fs.unlinkSync(out); } catch { /* none */ }
            throw new JobError('ffmpeg_failed', `part ${part}: ffmpeg exited ${r.code}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
        }
        await adopt({
            src, file: out, ext, job, variant: null,
            relation: { method: 'split', part, parts, start_seconds: start, duration_seconds: len },
            metadata: { part, parts, start_seconds: start, duration_seconds: len },
            saveCheckpoint: ctx.saveCheckpoint,
            checkpointFor: (id, size) => ({ parts: [...cp.parts, { part, object_id: id, start_seconds: start, duration_seconds: len, size_bytes: size }] }),
        });
        cp.parts = ctx.checkpoint.parts;
    }
    cleanupWork(job.id);
    const list = [...cp.parts].sort((a, b) => a.part - b.part);
    return {
        source_id: src.id, method: 'split', parts: list,
        oversized_parts: list.filter(p => p.size_bytes > maxBytes).map(p => p.part),
        source_unchanged: true,
        note: 'The parts are private objects. The source is unchanged: it stays as it is until its owner changes it.',
    };
}

// ── object.remux ─────────────────────────────────────────────

function validateRemux({ obj }) {
    if (!obj) throw new JobError('media.job.invalid', 'object.remux needs object_id', { permanent: true });
    if (!isMediaObject(obj)) throw new JobError('media.job.invalid', 'Only vod/clip objects (or video/audio objects) can be remuxed', { permanent: true });
    return {};
}

async function runRemux(job, ctx) {
    const src = loadSource(job);
    if (ctx.checkpoint && ctx.checkpoint.object_id) {      // finished before an interruption
        cleanupWork(job.id);
        return { source_id: src.id, method: 'remux', ...ctx.checkpoint, source_unchanged: true };
    }
    const source = await resolveSource(src);
    if (!source) throw new JobError('media_unavailable', 'The source bytes are unavailable (no local file and no cloud copy)', { permanent: true });
    checkRoom(src, Number(src.size_bytes) || 0);
    const ext = extFor(src, source.name);
    const out = path.join(workDir(job.id), `remux${ext}`);
    const r = await ffmpeg(['-y', '-nostdin', '-v', 'error', ...inputArgs(source), '-i', source.input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy',
        '-fflags', '+genpts', ...(ext === '.mp4' ? ['-movflags', '+faststart'] : []), out], { signal: ctx.signal, timeoutMs: budgetMs(src.size_bytes) });
    if (ctx.signal.aborted) throw ctx.signal.reason || new Error('aborted');
    if (!r.ok || !existing(out) || fs.statSync(out).size === 0) {
        cleanupWork(job.id);
        throw new JobError('ffmpeg_failed', `ffmpeg exited ${r.code}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
    const duration = await probeDuration(out);
    const made = await adopt({
        src, file: out, ext, job, variant: 'remux',
        relation: { method: 'remux', duration_seconds: duration },
        metadata: { duration_seconds: duration },
        saveCheckpoint: ctx.saveCheckpoint,
        checkpointFor: (id, size) => ({ object_id: id, size_bytes: size, duration_seconds: duration }),
    });
    cleanupWork(job.id);
    return { source_id: src.id, method: 'remux', object_id: made.id, size_bytes: made.size, duration_seconds: duration, source_unchanged: true };
}

module.exports = {
    split: { lane: 'heavy', maxAttempts: 3, timeoutMs: 6 * 3600 * 1000, needsObject: true, validate: validateSplit, run: runSplit },
    remux: { lane: 'heavy', maxAttempts: 3, timeoutMs: 3 * 3600 * 1000, needsObject: true, validate: validateRemux, run: runRemux },
    resolveSource, isMediaObject, extFor,
    // for the preview jobs (previews.js)
    loadSource, adopt, ffmpeg, inputArgs, probeDuration, workDir, cleanupWork, existing, checkRoom,
};
