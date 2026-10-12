/** Local CMAF cache. Durable timeline rows remain authoritative after their local copy is evicted. */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const timeline = require('./timeline');

let evictions = 0;
let sweeping = false;

function freeBytes() {
    try {
        const st = fs.statfsSync(config.objects.path);
        return Number(st.bavail) * Number(st.bsize);
    } catch { return 0; } // Unknown free space must not authorize another local copy.
}

function files() {
    const root = timeline.localRoot();
    const out = [];
    function visit(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) {
                try { const st = fs.statSync(file); out.push({ path: file, size: st.size, servedAt: st.mtimeMs }); }
                catch { /* disappeared while scanning */ }
            }
        }
    }
    visit(root);
    return out;
}

// status() walks every local timeline file, so readiness and /metrics read a copy at most 30 s old; a write decision
// (shouldKeepLocal) and the sweep read it fresh, and a sweep that removed files drops the copy.
const STATUS_TTL_MS = 30_000;
let memo = null;
function status({ fresh = false } = {}) {
    const now = Date.now();
    // Only the measured numbers are kept; the budget and the floor are read from config on every call.
    if (fresh || !memo || now - memo.at >= STATUS_TTL_MS) memo = { at: now, bytes: files().reduce((n, f) => n + f.size, 0), free: freeBytes() };
    return { bytes: memo.bytes, max_bytes: config.hls.localMaxBytes, free_bytes: memo.free, min_free_bytes: config.hls.localMinFreeBytes };
}

function shouldKeepLocal() {
    const s = status({ fresh: true });
    return s.max_bytes > 0 && s.bytes < s.max_bytes && s.free_bytes >= s.min_free_bytes;
}

// mtime is explicitly maintained on a local read. atime is mount-option dependent; mtime is portable and survives
// process restarts. No database write is needed for each segment request. The sweep sorts one entry per physical file.
function served(file, now = Date.now()) {
    try { fs.utimesSync(file, now / 1000, now / 1000); } catch { /* an eviction may have just unlinked it */ }
}

async function sweep() {
    if (sweeping) return { skipped: true };
    sweeping = true;
    try {
        const entries = files().sort((a, b) => a.servedAt - b.servedAt);
        let bytes = entries.reduce((n, f) => n + f.size, 0);
        let free = freeBytes();
        let removed = 0;
        for (const file of entries) {
            if (bytes <= config.hls.localMaxBytes && free >= config.hls.localMinFreeBytes) break;
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
        if (removed) memo = null;
        return { removed, ...status({ fresh: true }) };
    } finally { sweeping = false; }
}

module.exports = { status, freeBytes, shouldKeepLocal, served, sweep, evictions: () => evictions };
