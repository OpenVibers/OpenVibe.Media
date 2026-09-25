/**
 * OpenVibe.Media — orphan reports. Report only: they list, match and recommend; they never delete,
 * move or write a file, a bucket object or a row.
 *
 *   buildReport()         the B2 `vods-orphans/` prefix (hazard H3: 55 objects, 14.5 GB on 2026-09-21)
 *   buildStorageReport()  the whole storage against the database (roadmap WS-G task 8): files and keys
 *                         no row names, copies the database records that are not there, and multipart
 *                         uploads left open (Media's own and the buckets'). The storage.orphans.scan job
 *                         runs it monthly; scripts/vods-orphans-report.js --storage on demand.
 *
 * ── The vods-orphans/ prefix ──
 *
 * Each object under the prefix is matched to a VOD or clip by its file name (the basename of
 * vods.file_path / storage_key, clips.file_path; else the vod-<app>-<id>-<ms>.<ext> name the
 * recorder gives recordings), and checked against that row's canonical copy (HEAD vods/<basename>
 * on the same provider), its R2 copy and its local file. Recommendations:
 *
 *   keep_only_copy        the row exists and no canonical, R2 or local copy does: this IS the recording
 *                         (restore it to its canonical key; never delete)
 *   keep_until_offloaded  no canonical copy yet, but the local file has the same size
 *   delete_duplicate      the canonical copy exists with the same size
 *   review_size_differs   a copy exists but with another size (keep until someone compares them)
 *   delete_row_gone       the name points at a VOD/clip id whose row no longer exists (deleted); its
 *                         object says when, if the model saw it
 *   review_row_mismatch   the id exists but its row points at another file
 *   review_unknown        the name matches nothing
 * `delete_*` are candidates for the owner to approve, never acted on here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');

const PREFIX = 'vods-orphans/';
const RECOMMENDATIONS = ['keep_only_copy', 'keep_until_offloaded', 'delete_duplicate', 'review_size_differs', 'delete_row_gone', 'review_row_mismatch', 'review_unknown'];

const vodStorage = () => require('./vod-storage');

/** vod-<app>-<id>-<epoch ms>.<ext> (+ .master.mkv) → { app, id, recorded_at } or null. */
function parseRecordingName(base) {
    const m = /^vod-(.+)-(\d+)-(\d{12,14})(?:\.master)?\.[a-z0-9]+$/i.exec(String(base || ''));
    if (!m) return null;
    return { app: m[1], id: Number(m[2]), recorded_at: new Date(Number(m[3])).toISOString() };
}

function rowByBasename(base) {
    const vod = db.getVodByFileBasename(base);
    if (vod) return { kind: 'vod', row: vod };
    const byKey = db.all('SELECT * FROM vods WHERE storage_key LIKE ?', [`%${base}`]).find(r => path.basename(r.storage_key || '') === base);
    if (byKey) return { kind: 'vod', row: byKey };
    const clip = db.getClipByFileBasename(base);
    if (clip) return { kind: 'clip', row: clip };
    return null;
}

function objectFor(kind, app, id) {
    try { return db.get('SELECT id, lifecycle_status, deleted_at FROM media_objects WHERE legacy_ref = ?', [`legacy:${app}:${kind}:${id}`]); } catch { return null; }
}

async function head(provider, key) {
    const vs = vodStorage();
    if (!vs.providerConfigured(provider)) return { configured: false };
    try { const h = await vs.headObject(provider, key); return h ? { configured: true, size: Number(h.size) } : { configured: true, size: null }; } catch (err) { return { configured: true, error: err.message }; }
}

function localSize(row) {
    const vs = vodStorage();
    for (const p of [vs.localPathForVod(row), row.file_path].filter(Boolean)) {
        try { const st = fs.statSync(p); if (st.isFile()) return st.size; } catch { /* next */ }
    }
    return null;
}

/** One orphan object → its row, the copies that exist, and a recommendation. */
async function assess(obj, { provider = 'b2' } = {}) {
    const vs = vodStorage();
    const base = path.basename(obj.key);
    const parsed = parseRecordingName(base);
    const out = { key: obj.key, size: obj.size, last_modified: obj.last_modified, name: parsed, match: null, copies: {}, recommendation: null, reason: null };
    const found = rowByBasename(base);
    if (!found) {
        if (parsed) {
            const byId = db.get('SELECT * FROM vods WHERE id = ? AND app_id = ?', [parsed.id, parsed.app]);
            if (byId) {
                out.match = { kind: 'vod', id: byId.id, app_id: byId.app_id, file: path.basename(byId.file_path || ''), storage_provider: byId.storage_provider || 'local' };
                out.recommendation = 'review_row_mismatch';
                out.reason = `vod ${byId.id} exists but points at ${out.match.file || 'no file'}`;
                return out;
            }
            const o = objectFor('vod', parsed.app, parsed.id);
            out.match = { kind: 'vod', id: parsed.id, app_id: parsed.app, row: 'gone', object: o ? { id: o.id, lifecycle_status: o.lifecycle_status, deleted_at: o.deleted_at } : null };
            out.recommendation = 'delete_row_gone';
            out.reason = `vod ${parsed.id} (${parsed.app}) no longer exists${o && o.deleted_at ? ` (deleted ${o.deleted_at})` : ''}; recorded ${parsed.recorded_at}`;
            return out;
        }
        out.recommendation = 'review_unknown';
        out.reason = 'the name matches no VOD or clip';
        return out;
    }
    const { kind, row } = found;
    const canonicalKey = vs.keyForVod(row);
    out.match = { kind, id: row.id, app_id: row.app_id, storage_provider: row.storage_provider || 'local', canonical_key: canonicalKey, health_status: row.health_status || null,
        is_public: row.is_public, visibility: row.visibility || null, duration_seconds: row.duration_seconds || 0 };
    if (canonicalKey === obj.key) {
        // The row's storage_key points into the orphan prefix: this object is its canonical copy.
        out.recommendation = 'keep_only_copy';
        out.reason = `${kind} ${row.id}'s storage_key is this object: it is the canonical copy (never delete)`;
        return out;
    }
    out.copies.canonical = await head(provider, canonicalKey);
    if ((row.storage_provider || 'local') === 'r2') out.copies.r2 = await head('r2', canonicalKey);
    out.copies.local = localSize(row);
    const sizes = [out.copies.canonical && out.copies.canonical.size, out.copies.r2 && out.copies.r2.size].filter(s => s != null);
    if (sizes.includes(obj.size)) {
        out.recommendation = 'delete_duplicate';
        out.reason = `${kind} ${row.id}'s canonical copy ${canonicalKey} exists with the same size`;
    } else if (sizes.length || (out.copies.local != null && out.copies.local !== obj.size)) {
        out.recommendation = 'review_size_differs';
        out.reason = `${kind} ${row.id} has a copy of another size (${[...sizes, out.copies.local].filter(s => s != null).join(', ')} vs ${obj.size} bytes)`;
    } else if (out.copies.local === obj.size) {
        out.recommendation = 'keep_until_offloaded';
        out.reason = `${kind} ${row.id} is still local (same size); the orphan is redundant once it is offloaded to ${canonicalKey}`;
    } else {
        out.recommendation = 'keep_only_copy';
        out.reason = `the only copy of ${kind} ${row.id}: restore it to ${canonicalKey} (never delete)`;
    }
    return out;
}

/** The whole report: { prefix, provider, bucket, generated_at, totals, by_recommendation, objects }. */
async function buildReport({ provider = 'b2', prefix = PREFIX, list = null } = {}) {
    const vs = vodStorage();
    const objects = list || await vs.listObjects(provider, prefix);
    const rows = [];
    for (const o of objects) rows.push(await assess(o, { provider }));
    const by = Object.fromEntries(RECOMMENDATIONS.map(r => [r, { objects: 0, bytes: 0 }]));
    let bytes = 0;
    for (const r of rows) { by[r.recommendation].objects++; by[r.recommendation].bytes += r.size; bytes += r.size; }
    return {
        kind: 'media.vods_orphans.report', version: 1, generated_at: new Date().toISOString(), provider, bucket: vs.bucketFor(provider), prefix,
        read_only: true, totals: { objects: rows.length, bytes, gb: Number((bytes / 1e9).toFixed(2)) }, by_recommendation: by, objects: rows,
        note: 'Report only: nothing was deleted, moved or written. delete_* rows are candidates for the owner to approve.',
    };
}

// ═══════════════════════════════════════════════════════════════
// The whole storage against the database (WS-G task 8)
// ═══════════════════════════════════════════════════════════════
//
//   unreferenced_local   files under the data directories that no row names (media_locations, vods,
//                        clips, files, pastes, assets, open upload sessions, unfinished jobs). A file whose
//                        only row is a deleted object's location counts (its bytes outlived the object),
//                        unless the object is a native one still inside its retention period, or held.
//   unreferenced_remote  B2/R2 keys that no media_locations row or vods/clips row names
//   missing              copies the database records for objects that are not deleted, whose bytes are not
//                        there: no local file, or a key absent from its bucket's listing
//   multipart_local      Media's own upload sessions still open (media_uploads active/completing), expired
//                        ones flagged; part directories no open session owns are unreferenced_local
//   multipart_remote     multipart uploads the buckets still hold open (ListMultipartUploads)
//
// Expected files that no row names are counted, not listed: live thumbnails (stream-<app>-<id>.jpg,
// refreshed in place while a stream is live) and upload temps / partial downloads younger than an hour.
// A provider that is not configured, or whose listing fails, is reported as not listed; nothing is
// concluded about its keys.

const STORAGE_SECTIONS = ['unreferenced_local', 'unreferenced_remote', 'missing', 'multipart_local', 'multipart_remote'];
const IN_FLIGHT_MS = 60 * 60 * 1000;
const MAX_WALK = 1000000;

function localRoots() {
    const seen = new Set();
    return [
        ['vods', config.vod.path], ['clips', config.vod.clipsPath], ['thumbnails', config.thumbnails.path], ['files', config.files.path],
        ['pastes', config.pastes.path], ['objects', config.objects.path], ['assets', config.assets.path],
    ].map(([name, dir]) => ({ name, dir: path.resolve(dir) })).filter(r => (seen.has(r.dir) ? false : seen.add(r.dir)));
}

/** Every regular file under one root. Symlinks are not followed; a root nested inside it is walked on its own. */
function walkRoot(root, rootDirs, out) {
    const stack = [root.dir];
    let seen = 0;
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!rootDirs.has(p)) stack.push(p); continue; }
            if (!e.isFile()) continue;
            if (out.files.length >= MAX_WALK) { out.truncated = true; return seen; }
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            out.files.push({ root: root.name, abs: p, path: path.relative(root.dir, p), size: st.size, mtimeMs: st.mtimeMs });
            seen++;
        }
    }
    return seen;
}

/** A location keeps its bytes wanted: its object exists and is not deleted, or is a native object inside its retention, or is held. */
function locationWanted(l) {
    if (!l.object_id) return false;
    return l.lifecycle_status !== 'deleted' || (!l.legacy_ref && !l.purged) || !!l.held;
}

const LOCATION_ROWS = `SELECT l.provider, l.bucket, l.key, o.id AS object_id, o.lifecycle_status, o.legacy_ref,
        CASE WHEN json_valid(o.metadata) THEN json_extract(o.metadata, '$.purged_at') END AS purged,
        ${db.heldSql('o.id')} AS held
    FROM media_locations l LEFT JOIN media_objects o ON o.id = l.object_id`;

const sidecarsOf = (p) => [p.replace(/\.webm$/, '.seekable.webm'), p.replace(/\.mp4$/, '.seekable.mp4'), p.replace(/\.webm$/, '.master.mkv')].filter(x => x !== p);

/** What the database names on local disk: { wanted: Set(abs path), deleted: Map(abs path → location), segmentBases, sessions, jobs }. */
function localReferences() {
    const vs = vodStorage();
    const model = require('../objects/model');
    const wanted = new Set();
    const add = (p) => { if (p) wanted.add(path.resolve(String(p))); };
    const deleted = new Map();
    for (const l of db.all(`${LOCATION_ROWS} WHERE l.provider = 'local'`)) {
        if (locationWanted(l)) add(l.key); else deleted.set(path.resolve(String(l.key)), l);
    }
    const thumb = (u) => { const name = model.thumbFileFromUrl(u); if (name) add(path.join(config.thumbnails.path, name)); };
    const segmentBases = new Set();      // browser-chunk segments <base>.seg-<n>-<ms>.webm belong to <base>.webm
    for (const v of db.all('SELECT id, file_path, master_file_path, thumbnail_url FROM vods')) {
        if (v.file_path) {
            for (const f of [v.file_path, vs.localPathForVod(v)]) {
                add(f);
                for (const x of sidecarsOf(path.resolve(f))) add(x);
                segmentBases.add(path.join(path.dirname(path.resolve(f)), path.basename(f).replace(/\.webm$/, '')));
            }
        }
        add(v.master_file_path);
        thumb(v.thumbnail_url);
    }
    for (const c of db.all('SELECT file_path, thumbnail_url FROM clips')) {
        if (c.file_path) { add(c.file_path); add(path.join(config.vod.clipsPath, path.basename(c.file_path))); }
        thumb(c.thumbnail_url);
    }
    for (const f of db.all('SELECT key, app_id FROM files')) add(path.join(config.files.path, f.app_id, f.key));
    for (const p of db.all('SELECT screenshot_path FROM pastes WHERE screenshot_path IS NOT NULL')) add(p.screenshot_path);
    for (const a of db.all('SELECT file_path FROM assets WHERE file_path IS NOT NULL')) add(a.file_path);
    const sessions = new Set(db.all("SELECT id FROM media_uploads WHERE status IN ('active', 'completing')").map(r => r.id));
    const jobs = new Set(db.all("SELECT id FROM media_jobs WHERE status IN ('queued', 'running')").map(r => r.id));
    return { wanted, deleted, segmentBases, sessions, jobs };
}

/** Is this local file named by the database (or one of the expected kinds)? 'wanted' | 'live_thumbnail' | 'in_flight' | null. */
function classifyLocal(f, refs, now) {
    if (refs.wanted.has(f.abs)) return 'wanted';
    const base = path.basename(f.abs);
    const seg = /^(.+)\.seg-\d+-\d+\.webm$/.exec(base);
    if (seg && refs.segmentBases.has(path.join(path.dirname(f.abs), seg[1]))) return 'wanted';
    const [top, sub] = f.path.split(path.sep);
    if (f.root === 'objects' && top === '.parts' && refs.sessions.has(sub)) return 'wanted';
    if (f.root === 'objects' && top === '.jobs' && refs.jobs.has(sub)) return 'wanted';
    if (f.root === 'thumbnails' && /^stream-.+\.jpg$/.test(base)) return 'live_thumbnail';
    const transient = (f.root === 'objects' && top === '.tmp') || base.endsWith('.download') || (f.root === 'objects' && top === '.parts');
    if (transient && now - f.mtimeMs < IN_FLIGHT_MS) return 'in_flight';
    return null;
}

/** A recorder-style name (vod-<app>-<id>-<ms>.<ext>): whose recording, and does its row still exist? */
function recordingNameHint(base) {
    const parsed = parseRecordingName(base);
    if (!parsed) return null;
    const row = db.get('SELECT id, file_path FROM vods WHERE id = ? AND app_id = ?', [parsed.id, parsed.app]);
    if (!row) return `a recording of vod ${parsed.id} (${parsed.app}), whose row is gone`;
    return `named for vod ${parsed.id} (${parsed.app}), whose row points at ${path.basename(row.file_path || '') || 'no file'}`;
}

function localHint(f, refs) {
    const base = path.basename(f.abs);
    const del = refs.deleted.get(f.abs);
    if (del) return del.object_id ? `bytes of deleted object ${del.object_id}${del.legacy_ref ? ` (${del.legacy_ref})` : ''}` : 'named only by a location row whose object does not exist';
    if (f.root === 'objects') {
        const [top, sub] = f.path.split(path.sep);
        if (top === '.parts') {
            const s = db.get('SELECT status FROM media_uploads WHERE id = ?', [sub]);
            return s ? `parts of multipart upload ${sub} (${s.status})` : `parts of multipart upload ${sub}, which has no session`;
        }
        if (top === '.jobs') {
            const j = db.get('SELECT status FROM media_jobs WHERE id = ?', [sub]);
            return j ? `work files of job ${sub} (${j.status})` : `work files of job ${sub}, which does not exist`;
        }
        if (top === '.tmp') return 'an upload that never finished (temp file)';
        const o = db.get('SELECT id, lifecycle_status FROM media_objects WHERE id = ?', [base]);
        return o ? `named for object ${o.id} (${o.lifecycle_status}), which records no local copy here` : `named for object ${base}, which does not exist`;
    }
    if (base.endsWith('.download')) return 'a restore download that never finished';
    if (/\.seekable\.(webm|mp4)$/.test(base)) return 'a DVR sidecar no VOD row names';
    if (/\.master\.mkv$/.test(base)) return recordingNameHint(base.replace(/\.master\.mkv$/, '.webm')) || 'a master archive no VOD row names';
    return recordingNameHint(base);
}

/** What the database names in one provider's bucket: { wanted: Set(key), deleted: Map(key → location), rows: Map(key → row) }. */
function remoteReferences(provider) {
    const vs = vodStorage();
    const bucket = vs.bucketFor(provider);
    const wanted = new Set();
    const deleted = new Map();
    for (const l of db.all(`${LOCATION_ROWS} WHERE l.provider = ?`, [provider])) {
        if (l.bucket && bucket && l.bucket !== bucket) continue;     // a copy recorded in another bucket
        if (locationWanted(l)) wanted.add(l.key); else deleted.set(l.key, l);
    }
    const rows = new Map();   // every key a vods/clips row points at, with the row (stale R2 copies are recognised by it)
    for (const table of ['vods', 'clips']) {
        for (const r of db.all(`SELECT id, file_path, storage_provider, storage_key FROM ${table} WHERE COALESCE(file_path, '') != ''`)) {
            const p = vs.providerOf(r);
            if (p === 'local' && !r.storage_key) continue;
            const key = vs.keyForVod(r);
            rows.set(key, { kind: table === 'vods' ? 'vod' : 'clip', id: r.id, provider: p });
            if (provider === 'b2' || p === 'r2') wanted.add(key);
        }
    }
    return { wanted, deleted, rows };
}

function remoteHint(provider, key, refs) {
    if (key.startsWith(PREFIX)) return `parked in ${PREFIX}: scripts/vods-orphans-report.js says what each one is`;
    const del = refs.deleted.get(key);
    if (del) return del.object_id ? `copy of deleted object ${del.object_id}${del.legacy_ref ? ` (${del.legacy_ref})` : ''}` : 'named only by a location row whose object does not exist';
    const row = refs.rows.get(key);
    if (row && provider === 'r2') return `an R2 copy of ${row.kind} ${row.id}, which is served from ${row.provider}`;
    const shot = /paste-screenshot-(\d+)\.[a-z0-9]+$/i.exec(key);
    if (shot) return db.get('SELECT 1 AS x FROM pastes WHERE id = ?', [Number(shot[1])]) ? `a legacy screenshot of paste ${shot[1]}` : `a legacy screenshot of paste ${shot[1]}, whose row is gone`;
    return recordingNameHint(path.basename(key));
}

/**
 * The storage report. Options (all injectable for tests):
 *   providers    which buckets to list (default: the configured ones of b2, r2)
 *   list         (provider) → [{ key, size, last_modified }]     default: every key (ListObjectsV2)
 *   listUploads  (provider) → [{ key, upload_id, initiated }]   default: ListMultipartUploads
 *   limit        items listed per section (totals always count everything), default 2000
 */
async function buildStorageReport({ providers = null, list = null, listUploads = null, limit = 2000, now = Date.now() } = {}) {
    const vs = vodStorage();
    const provs = providers || ['b2', 'r2'].filter(p => vs.providerConfigured(p));
    const lister = list || ((p) => vs.listObjects(p, ''));
    const uploadLister = listUploads || ((p) => vs.listMultipartUploads(p));
    const cap = Math.max(1, Number(limit) || 2000);
    const report = {
        kind: 'media.storage_orphans.report', version: 1, generated_at: new Date(now).toISOString(), read_only: true,
        scope: { roots: [], providers: {}, walk_truncated: false },
        totals: {
            unreferenced_local: { files: 0, bytes: 0, by_root: {} }, unreferenced_remote: {},
            missing: { locations: 0, by_provider: {} }, multipart_local: { open: 0, expired: 0 }, multipart_remote: {},
            expected: { live_thumbnails: 0, in_flight: 0 },
        },
        truncated: {},
        note: 'Report only: nothing was deleted, moved or written. Each item is for an operator to look at.',
    };
    for (const k of STORAGE_SECTIONS) { report[k] = []; report.truncated[k] = false; }
    const push = (section, item) => { if (report[section].length < cap) report[section].push(item); else report.truncated[section] = true; };

    // ── Local disk ──
    const roots = localRoots();
    const rootDirs = new Set(roots.map(r => r.dir));
    const walked = { files: [], truncated: false };
    for (const root of roots) {
        const exists = fs.existsSync(root.dir);
        const files = exists ? walkRoot(root, rootDirs, walked) : 0;
        report.scope.roots.push({ name: root.name, dir: root.dir, exists, files });
    }
    report.scope.walk_truncated = walked.truncated;
    const lrefs = localReferences();
    const orphanLocal = [];
    for (const f of walked.files) {
        const c = classifyLocal(f, lrefs, now);
        if (c === 'wanted') continue;
        if (c === 'live_thumbnail') { report.totals.expected.live_thumbnails++; continue; }
        if (c === 'in_flight') { report.totals.expected.in_flight++; continue; }
        orphanLocal.push(f);
        const t = report.totals.unreferenced_local;
        t.files++; t.bytes += f.size;
        t.by_root[f.root] = t.by_root[f.root] || { files: 0, bytes: 0 };
        t.by_root[f.root].files++; t.by_root[f.root].bytes += f.size;
    }
    orphanLocal.sort((a, b) => b.size - a.size);
    for (const f of orphanLocal.slice(0, cap)) push('unreferenced_local', { root: f.root, path: f.path, size: f.size, modified: new Date(f.mtimeMs).toISOString(), hint: localHint(f, lrefs) });
    if (orphanLocal.length > cap) report.truncated.unreferenced_local = true;

    // ── Buckets ──
    const listed = new Map();   // provider → Map(key → size)
    for (const p of provs) {
        const entry = { configured: vs.providerConfigured(p), bucket: vs.bucketFor(p), listed: false };
        report.scope.providers[p] = entry;
        let keys;
        try { keys = await lister(p); } catch (err) { entry.error = err.message; continue; }
        entry.listed = true;
        entry.keys = keys.length;
        entry.bytes = keys.reduce((n, k) => n + (Number(k.size) || 0), 0);
        listed.set(p, new Map(keys.map(k => [k.key, k])));
        const rrefs = remoteReferences(p);
        const orphans = keys.filter(k => !rrefs.wanted.has(k.key)).sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
        report.totals.unreferenced_remote[p] = { keys: orphans.length, bytes: orphans.reduce((n, k) => n + (Number(k.size) || 0), 0) };
        for (const k of orphans.slice(0, cap)) push('unreferenced_remote', { provider: p, key: k.key, size: Number(k.size) || 0, last_modified: k.last_modified || null, hint: remoteHint(p, k.key, rrefs) });
        if (orphans.length > cap) report.truncated.unreferenced_remote = true;
        let uploads = [];
        try { uploads = await uploadLister(p); } catch (err) { entry.multipart_error = err.message; }
        report.totals.multipart_remote[p] = uploads.length;
        for (const u of uploads) push('multipart_remote', { provider: p, key: u.key, upload_id: u.upload_id, initiated: u.initiated || null, key_named_by_a_row: rrefs.wanted.has(u.key) });
    }

    // ── Copies the database records whose bytes are not there ──
    for (const l of db.all(`SELECT l.provider, l.bucket, l.key, l.state, l.verified_at, o.id AS object_id, o.app_id, o.kind, o.legacy_ref, o.lifecycle_status
                            FROM media_locations l JOIN media_objects o ON o.id = l.object_id WHERE o.lifecycle_status != 'deleted' ORDER BY l.id`)) {
        let there;
        if (l.provider === 'local') {
            try { there = fs.statSync(l.key).isFile(); } catch { there = false; }
        } else {
            const keys = listed.get(l.provider);
            if (!keys) continue;                                         // not listed: nothing is known
            if (l.bucket && vs.bucketFor(l.provider) && l.bucket !== vs.bucketFor(l.provider)) continue;
            there = keys.has(l.key);
        }
        if (there) continue;
        report.totals.missing.locations++;
        report.totals.missing.by_provider[l.provider] = (report.totals.missing.by_provider[l.provider] || 0) + 1;
        push('missing', { object_id: l.object_id, app_id: l.app_id, kind: l.kind, legacy_ref: l.legacy_ref || null, lifecycle_status: l.lifecycle_status,
            provider: l.provider, key: l.key, recorded_state: l.state, verified_at: l.verified_at || null });
    }

    // ── Media's own multipart sessions still open ──
    for (const u of db.all(`SELECT u.*, (SELECT COUNT(*) FROM media_upload_parts p WHERE p.upload_id = u.id) AS parts_received,
                                   (SELECT COALESCE(SUM(p.size_bytes), 0) FROM media_upload_parts p WHERE p.upload_id = u.id) AS bytes_received,
                                   (u.expires_at < datetime('now')) AS expired
                            FROM media_uploads u WHERE u.status IN ('active', 'completing') ORDER BY u.created_at`)) {
        report.totals.multipart_local.open++;
        if (u.expired) report.totals.multipart_local.expired++;
        push('multipart_local', { upload_id: u.id, object_id: u.object_id, app_id: u.app_id, status: u.status, parts_received: u.parts_received,
            parts_expected: u.parts_expected, bytes_received: u.bytes_received, total_size: u.total_size, created_at: u.created_at, expires_at: u.expires_at, expired: !!u.expired });
    }
    return report;
}

function reportsDir() {
    return path.join(path.dirname(config.db.path), 'reports');
}

/** Write a storage report as JSON (default <data>/reports/storage-orphans-<time>.json). Returns the path. */
function writeStorageReport(report, file = null) {
    const out = file || path.join(reportsDir(), `storage-orphans-${report.generated_at.replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    return out;
}

/** One line per section for logs and the job result. */
function summarizeStorage(report) {
    const t = report.totals;
    const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
    const remote = Object.entries(t.unreferenced_remote).map(([p, x]) => `${p} ${x.keys} key(s) ${mb(x.bytes)}`).join(', ') || 'no bucket listed';
    return `unreferenced local ${t.unreferenced_local.files} file(s) ${mb(t.unreferenced_local.bytes)}; unreferenced remote: ${remote}; `
        + `missing copies ${t.missing.locations}; open multipart: ${t.multipart_local.open} here (${t.multipart_local.expired} expired), `
        + `${Object.entries(t.multipart_remote).map(([p, n]) => `${n} in ${p}`).join(', ') || 'buckets not listed'}`;
}

module.exports = {
    PREFIX, RECOMMENDATIONS, parseRecordingName, assess, buildReport,
    STORAGE_SECTIONS, buildStorageReport, writeStorageReport, summarizeStorage, localRoots,
};
