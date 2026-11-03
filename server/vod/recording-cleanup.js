'use strict';
/**
 * OpenVibe.Media — automatic clean-up of recording files nothing uses (the owner, 2026-11-03: "all this should be taken
 * care of automatically"). The storage orphan report (orphans-report.js) only lists; this deletes the cases that are
 * certain, and keeps everything else:
 *
 *   row_gone    a recording file (the local VOD directory; B2 and R2 under vods/ and live.vods/) whose VOD id, read from
 *               its name, has no vods row any more. The VOD was deleted and a copy stayed behind: a remote delete that
 *               failed, or an older layout's copy the delete never knew about (2026-11-03: 31 such files, 18 GB, the
 *               newest from August). Deleted unless an object for that VOD is under a retention hold.
 *   duplicate   a B2/R2 key that no row or location names, for a VOD that still exists, when that VOD's own copy (its
 *               key on the same provider, else on the other, else its local file) is there with the same size. Local
 *               files are never treated as duplicates (a recording in progress writes beside its row).
 *
 * Both wait out a grace period (7 days) from the file's last change. Kept: a name with no VOD id, a copy whose size
 * differs from the VOD's, anything held, and every other prefix of the bucket (vods-orphans/ is parked for review; the
 * backups share the bucket and are never listed here).
 *
 *   run({ dryRun, graceDays, now }) → { checked, deleted: { row_gone, duplicate }, bytes, kept: {…}, failed, items }
 *
 * Job storage.recordings.cleanup (server/jobs/recording-cleanup.js) runs it daily.
 */
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');

const PREFIXES = ['vods/', 'live.vods/'];
const GRACE_DAYS = 7;

const storage = () => require('./vod-storage');
// The remote providers vod-storage knows (B2 and R2 today); placement decides their order elsewhere.
const providers = () => storage().REMOTE_PROVIDERS;

/** The VOD id a recording file's name carries: vod-<app>-<id>-<ms>, vod-<id>-<ms>, media-<app>-vod-<id>. */
function vodIdOf(key) {
    const name = path.basename(String(key || ''));
    let m = /^vod-(?:[a-z][a-z0-9._]*-)?(\d+)-\d{10,}(?:\.|$)/i.exec(name);
    if (!m) m = /^media-[a-z0-9._]+-vod-(\d+)\./i.exec(name);
    return m ? Number(m[1]) : null;
}

async function heldVod(id) {
    const rows = await db.all('SELECT id FROM media_objects WHERE legacy_ref LIKE ?', [`legacy:%:vod:${id}`]);
    const model = require('../objects/model');
    for (const r of rows) if (await model.isHeld(r.id)) return true;
    const row = await db.get('SELECT * FROM vods WHERE id = ?', [id]);
    return !!(row && await model.isHeldRow(row));
}

/** The size of a VOD's own copy: its key on `provider`, then on the other provider, then its local file; null if none. */
async function ownCopySize(vod, provider) {
    const key = storage().keyForVod(vod);
    for (const p of [provider, ...providers().filter((x) => x !== provider)]) {
        if (!storage().providerConfigured(p)) continue;
        const h = await storage().headObject(p, key).catch(() => null);
        if (h) return Number(h.size);
    }
    try { return fs.statSync(storage().localPathForVod(vod)).size; } catch { return null; }
}

async function run({ dryRun = false, graceDays = GRACE_DAYS, now = Date.now() } = {}) {
    const cutoff = now - Math.max(0, graceDays) * 86400 * 1000;
    const vods = new Map((await db.all('SELECT * FROM vods')).map((v) => [Number(v.id), v]));
    const named = new Set();
    for (const v of vods.values()) {
        if (v.storage_key) named.add(v.storage_key);
        if (v.file_path) named.add('vods/' + path.basename(v.file_path));
    }
    for (const r of await db.all("SELECT key FROM media_locations WHERE provider IN ('b2', 'r2')")) named.add(r.key);
    const localNamed = new Set();
    for (const v of vods.values()) for (const f of [v.file_path, v.master_file_path]) if (f) localNamed.add(path.basename(f));

    const out = { dry_run: !!dryRun, checked: 0, deleted: { row_gone: 0, duplicate: 0 }, bytes: 0, failed: 0,
        kept: { young: 0, no_vod_id: 0, held: 0, size_differs: 0, no_own_copy: 0 }, items: [] };
    const heldCache = new Map();
    const isHeld = async (id) => { if (!heldCache.has(id)) heldCache.set(id, await heldVod(id)); return heldCache.get(id); };
    const remove = async (where, key, size, reason) => {
        out.items.push({ where, key, size, reason });
        if (dryRun) { out.deleted[reason]++; out.bytes += size; return; }
        let ok;
        if (where === 'local') { try { fs.unlinkSync(key); ok = true; } catch (err) { ok = err.code === 'ENOENT'; } }
        else ok = await storage().deleteObject(where, key);
        if (ok) { out.deleted[reason]++; out.bytes += size; } else out.failed++;
    };

    // Remote: only the recording prefixes; every other key in the bucket is out of scope.
    for (const provider of providers()) {
        if (!storage().providerConfigured(provider)) continue;
        for (const prefix of PREFIXES) {
            let list = [];
            try { list = await storage().listObjects(provider, prefix); } catch (err) { console.warn(`[Cleanup] list ${provider}:${prefix}: ${err.message}`); continue; }
            for (const o of list) {
                out.checked++;
                if (named.has(o.key)) continue;
                const id = vodIdOf(o.key);
                if (id == null) { out.kept.no_vod_id++; continue; }
                if (o.last_modified && Date.parse(o.last_modified) > cutoff) { out.kept.young++; continue; }
                if (await isHeld(id)) { out.kept.held++; continue; }
                const vod = vods.get(id);
                if (!vod) { await remove(provider, o.key, o.size, 'row_gone'); continue; }
                const own = await ownCopySize(vod, provider);
                if (own == null) { out.kept.no_own_copy++; continue; }
                if (own !== o.size) { out.kept.size_differs++; continue; }
                await remove(provider, o.key, o.size, 'duplicate');
            }
        }
    }

    // Local: the VOD directory's own files whose VOD is gone (never a duplicate: a recording in progress writes here).
    const dir = path.resolve(config.vod.path);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { /* no directory */ }
    for (const name of names) {
        out.checked++;
        if (localNamed.has(name)) continue;
        const id = vodIdOf(name);
        if (id == null) { out.kept.no_vod_id++; continue; }
        if (vods.has(id)) continue;
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (st.mtimeMs > cutoff) { out.kept.young++; continue; }
        if (await isHeld(id)) { out.kept.held++; continue; }
        await remove('local', file, st.size, 'row_gone');
    }
    return out;
}

/** One line for the log. */
function summarize(r) {
    const gb = (r.bytes / 1e9).toFixed(2);
    const kept = Object.entries(r.kept).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ') || 'nothing';
    return `${r.dry_run ? 'would delete' : 'deleted'} ${r.deleted.row_gone} file(s) of deleted VODs and ${r.deleted.duplicate} duplicate(s), ${gb} GB; kept ${kept}${r.failed ? `; ${r.failed} delete(s) failed` : ''} (${r.checked} checked)`;
}

module.exports = { run, summarize, vodIdOf, PREFIXES, GRACE_DAYS };
