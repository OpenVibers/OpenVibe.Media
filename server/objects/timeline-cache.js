/** Local CMAF cache. Durable timeline rows remain authoritative after their local copy is evicted. */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const timeline = require('./timeline');

let evictions = 0;
let orphansRemoved = 0;
let sweeping = false;
// A cut stages its segments here and names them in one commit at the end (jobs/segments.js publishRendition); a failure
// before that commit removes them again, but a process that dies there (a restart, a killed worker) leaves files no row
// names. They are removed once older than any cut can run (a heavy job's limit is 13 h) and their object has no job
// queued or running. Before this, the sweep skipped them for good: VOD 5726's three failed cuts on 2026-10-15 left 7 GB.
const ORPHAN_AGE_MS = 24 * 3600 * 1000;

function freeBytes() {
    try {
        const st = fs.statfsSync(config.objects.path);
        return Number(st.bavail) * Number(st.bsize);
    } catch { return 0; } // Unknown free space must not authorize another local copy.
}

// An emptied directory (its files evicted or swept) older than this is removed by the sweep. Evictions used to leave
// every <app>/<object>/<rendition>/<version> directory behind: 193,900 directories for 1,080 files on 2026-10-17, and
// walking them took 1.9 s of the event loop on every /metrics scrape (every 30 s).
const EMPTY_DIR_AGE_MS = 3600 * 1000;

/** Every local timeline file, read without blocking the event loop. `prune`: remove emptied directories on the way. */
async function files({ prune = false, now = Date.now() } = {}) {
    const root = timeline.localRoot();
    const out = [];
    async function visit(dir, depth) {
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 1; }
        // Its age from before this walk removed anything inside it (a removal touches the parent's mtime).
        let touched = null;
        if (prune && depth >= 2) { try { touched = (await fs.promises.stat(dir)).mtimeMs; } catch { /* gone */ } }
        let left = 0;
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) { left += await visit(file, depth + 1); continue; }
            left++;
            if (!entry.isFile()) continue;
            try { const st = await fs.promises.stat(file); out.push({ path: file, size: st.size, servedAt: st.mtimeMs }); }
            catch { /* disappeared while scanning */ }
        }
        // <root> and <root>/<app> stay; below them an empty directory nothing has touched for an hour goes (a cut
        // writing into a new one is minutes old).
        if (!left && touched !== null && now - touched >= EMPTY_DIR_AGE_MS) {
            try { await fs.promises.rmdir(dir); return 0; } catch { /* written to meanwhile */ }
        }
        return 1;   // still there: it counts in its parent
    }
    await visit(root, 0);
    return out;
}

// status() is synchronous (readiness, /metrics) and never walks: it answers with the last measurement and starts a new
// one in the background once that is 30 s old. refresh() measures now; the sweep leaves its own count behind.
const STATUS_TTL_MS = 30_000;
let memo = null;
let measuring = null;
function refresh() {
    if (!measuring) {
        measuring = files().then((list) => { memo = { at: Date.now(), bytes: list.reduce((n, f) => n + f.size, 0) }; return status(); })
            .finally(() => { measuring = null; });
    }
    return measuring;
}
function status() {
    if (!memo || Date.now() - memo.at >= STATUS_TTL_MS) refresh().catch(() => {});
    return { bytes: memo ? memo.bytes : 0, max_bytes: config.hls.localMaxBytes, free_bytes: freeBytes(), min_free_bytes: config.hls.localMinFreeBytes, ...(memo ? {} : { measuring: true }) };
}

async function shouldKeepLocal() {
    const s = await refresh();
    return s.max_bytes > 0 && s.bytes < s.max_bytes && s.free_bytes >= s.min_free_bytes;
}

// mtime is explicitly maintained on a local read. atime is mount-option dependent; mtime is portable and survives
// process restarts. No database write is needed for each segment request. The sweep sorts one entry per physical file.
function served(file, now = Date.now()) {
    try { fs.utimesSync(file, now / 1000, now / 1000); } catch { /* an eviction may have just unlinked it */ }
}

/** The object a timeline file belongs to: <root>/<app>/<object>/<rendition>/[<version>/]<name>, or null. */
function objectOf(file) {
    const parts = path.relative(timeline.localRoot(), file).split(path.sep);
    return parts.length >= 4 && !parts.includes('..') ? parts[1] : null;
}

/** Remove the unnamed files that are old enough and whose object is idle. Returns the files that remain. */
async function sweepOrphans(entries, now) {
    const keep = [];
    const idle = new Map();
    for (const file of entries) {
        const object = objectOf(file.path);
        if (!object || now - file.servedAt < ORPHAN_AGE_MS) { keep.push(file); continue; }
        if (await db.get('SELECT 1 AS named FROM media_timeline WHERE local_path = ? LIMIT 1', [file.path])) { keep.push(file); continue; }
        if (!idle.has(object)) idle.set(object, !(await db.get("SELECT 1 AS busy FROM media_jobs WHERE object_id = ? AND status IN ('queued', 'running') LIMIT 1", [object])));
        if (!idle.get(object)) { keep.push(file); continue; }
        try { fs.unlinkSync(file.path); orphansRemoved++; } catch { keep.push(file); }
    }
    return keep;
}

// One drain for the whole disk (2026-10-31). Under disk pressure the VOD sweep drains to its targets (≤60% and ≥40 GB
// free), but this cache kept only its own budget (MEDIA_TIMELINE_LOCAL_MAX_BYTES / _MIN_FREE_BYTES). On 2026-10-31 the
// disk sat at 80% with 10 GB of segments here, all with verified durable copies, while the VOD sweep found nothing it
// may move (recordings stay local for a day). Now, while the VOD storage says the disk needs a drain, the cache gives
// way too: durable segments go, least recently served first, until the drain is satisfied. A segment served in the
// last hour stays (someone is watching it); a segment with no verified durable copy never goes.
const HOT_MS = 3600 * 1000;
function diskPressure() {
    try {
        const vs = require('../vod/vod-storage');
        const settings = vs.getSettings();
        const disk = () => vs.diskUsage(config.objects.path);
        return { draining: vs.needsDrain(disk(), settings), satisfied: () => vs.drainSatisfied(disk(), settings) };
    } catch { return { draining: false, satisfied: () => true }; }   // no pressure reading: the budget alone decides
}

async function sweep({ now = Date.now() } = {}) {
    if (sweeping) return { skipped: true };
    sweeping = true;
    try {
        const before = orphansRemoved;
        const entries = (await sweepOrphans(await files({ prune: true, now }), now)).sort((a, b) => a.servedAt - b.servedAt);
        const orphans = orphansRemoved - before;
        let bytes = entries.reduce((n, f) => n + f.size, 0);
        let free = freeBytes();
        let removed = 0;
        const pressure = diskPressure();
        for (const file of entries) {
            if (bytes <= config.hls.localMaxBytes && free >= config.hls.localMinFreeBytes) {
                // Within the cache's own budget: only the disk's drain can still ask for room, and only from files
                // nobody has watched in the last hour (the list is oldest first, so the rest are newer still).
                if (!pressure.draining || pressure.satisfied() || now - file.servedAt < HOT_MS) break;
            }
            // A path can be shared by source, clip and multiple packed rows. All must name a verified durable
            // provider before the path can go. The row's durable state is set only after size+sha readback.
            const rows = await db.all('SELECT durability, durable_provider, key, sha256, packed_object_id, byte_offset, byte_length FROM media_timeline WHERE local_path = ?', [file.path]);
            if (!rows.length || rows.some((r) => r.durability !== 'durable' || !r.durable_provider)) continue;
            // Existing timelines predate the cache and may have been marked durable after a size-only upload.
            // Read back every distinct immutable key before evicting, including the complete packed chunk.
            const copies = new Map();
            for (const r of rows) {
                const id = `${r.durable_provider}\n${r.key}`;
                const expected = r.packed_object_id || r.sha256;
                if (copies.has(id)) continue;
                const back = await require('../vod/vod-storage').sha256Object(r.durable_provider, r.key).catch(() => null);
                copies.set(id, !!back && back.sha256 === expected && Number(back.size) === file.size);
            }
            if ([...copies.values()].some((ok) => !ok)) continue;
            await db.getDb().tx(async () => {
                const current = await db.all('SELECT durability, durable_provider FROM media_timeline WHERE local_path = ? FOR UPDATE', [file.path]);
                if (!current.length || current.some((r) => r.durability !== 'durable' || !r.durable_provider)) return;
                // Keep the unlink and location change in the same transaction. A failed unlink rolls back the
                // UPDATE; readers already tolerate a missing local file and use the durable location.
                fs.unlinkSync(file.path);
                await db.run('UPDATE media_timeline SET local_path = NULL, updated_at = ov_now() WHERE local_path = ?', [file.path]);
                removed++;
                evictions++;
                bytes -= file.size;
            });
            free = freeBytes();
        }
        memo = { at: Date.now(), bytes };   // what is left, counted by this walk
        return { removed, orphans, draining: pressure.draining, ...status() };
    } finally { sweeping = false; }
}

module.exports = { status, refresh, freeBytes, shouldKeepLocal, served, sweep, evictions: () => evictions, orphansRemoved: () => orphansRemoved, ORPHAN_AGE_MS };
