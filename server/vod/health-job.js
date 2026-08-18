/**
 * OpenVibe.Media — health-job: keep the VOD library healthy in the background.
 *
 * Two responsibilities, both throttled and concurrency-safe:
 *   1. SCAN finished VODs that were never health-checked (or not checked in a
 *      while) for corruption / zero-byte / bad-duration. On a problem it first
 *      tries to REPAIR from the lossless .master.mkv archive (and repairs a
 *      missing duration); only genuinely unrecoverable files are quarantined
 *      (hidden, is_public=0) — never silently deleted.
 *   2. CLEAN UP VODs quarantined as unrecoverably-broken for a grace period:
 *      one last recovery attempt, else delete the dead files + row.
 *
 * Design: a single serialized worker, at most one ffmpeg pass at a time, small
 * batches. Backs off to lighter (probe-only) work while any INGEST recording
 * is active so it never competes with live ffmpeg (the predecessor keyed this
 * off live streams; here active recordings are the equivalent signal).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');
const scanner = require('./health-scanner');

const TICK_MS = 5 * 60 * 1000;      // scan pass every 5 minutes
const SCAN_STALE_DAYS = 45;         // re-scan a healthy VOD at most this often
const SCAN_BATCH_IDLE = 3;          // VODs per pass when nothing is recording
const SCAN_BATCH_LIVE = 1;          // ...and while recording (probe-only, cheap)
const QUARANTINE_GRACE_DAYS = 21;   // clean up unrecoverable quarantined VODs after this
const CLEANUP_BATCH = 3;

let _running = false;
let _timer = null;
let _busy = false;

function _anyRecording() {
    try { return require('./recorder').activeCount() > 0; }
    catch { return false; }
}

// Scan (and, if needed, repair) a single VOD. The routine scan is PROBE-based
// (fast, non-destructive); the expensive full decode + re-encode only runs to
// REPAIR a file that already looks broken, and only while idle (`deep`).
async function _scanOne(vod, { deep }) {
    let scan = await scanner.scanVod(vod, { decode: false, repairDuration: true, quarantineBad: false });

    const broken = ['corrupt', 'zero_byte', 'missing_file', 'needs_review'].includes(scan.status)
        || (scan.issues || []).some(i => /decode_failed|probe_failed|invalid_duration/.test(i));

    if (!broken) {
        // Healthy (or duration just repaired) — record the clean scan.
        try { db.updateVodHealth(vod.id, { status: 'ok', issues: scan.issues || [] }); } catch { /* */ }
        // The lossless .master.mkv is only a finalize-time recovery fallback. This
        // VOD probed healthy and is long finished — reclaim a lingering master.
        try {
            // Only WebM recordings have a separate .master.mkv. Guard the extension:
            // for an MP4 the regex wouldn't match and `master` would resolve to the
            // VOD file itself — deleting the recording.
            const master = vod.master_file_path
                || (vod.file_path && vod.file_path.endsWith('.webm') ? vod.file_path.replace(/\.webm$/, '.master.mkv') : null);
            if (master && fs.existsSync(master)) {
                const freedMb = (fs.statSync(master).size / 1024 / 1024).toFixed(0);
                fs.unlinkSync(master);
                if (vod.master_file_path) { try { db.run('UPDATE vods SET master_file_path = NULL WHERE id = ?', [vod.id]); } catch { /* */ } }
                console.log(`[VOD-Health] Reclaimed orphaned master for vod ${vod.id} (${freedMb}MB)`);
            }
        } catch { /* */ }
        return { id: vod.id, status: 'ok' };
    }

    // Broken but recordings are active → defer the heavy recovery/quarantine to
    // the next idle pass. Don't stamp last_health_scan_at, so it stays first in
    // the queue and is handled promptly once idle.
    if (!deep) return { id: vod.id, status: 'deferred' };

    // Broken → try to rebuild from the lossless master before quarantining.
    let recovered = false;
    if (scan.status !== 'missing_file') {
        try {
            const r = await scanner.recoverFromMaster(vod);
            if (r.recovered) {
                // Re-scan the rebuilt file to confirm it's actually good now.
                const fresh = db.getVodById(vod.id) || vod;
                const rescan = await scanner.scanVod(fresh, { decode: deep, repairDuration: true, quarantineBad: false });
                recovered = !['corrupt', 'zero_byte', 'missing_file'].includes(rescan.status)
                    && !(rescan.issues || []).some(i => /decode_failed|probe_failed/.test(i));
                if (recovered) {
                    console.log(`[VOD-Health] Recovered vod ${vod.id} from master (${Math.round(r.duration)}s)`);
                    return { id: vod.id, status: 'recovered' };
                }
            }
        } catch (e) { console.warn(`[VOD-Health] master recovery error for vod ${vod.id}:`, e.message); }
    }

    // Still broken → quarantine (hide, keep the file for possible manual recovery).
    // 'needs_review' (e.g. very short) is flagged but NOT hidden — it may be watchable.
    const terminal = ['corrupt', 'zero_byte', 'missing_file'].includes(scan.status);
    try {
        db.updateVodHealth(vod.id, {
            status: scan.status,
            issues: scan.issues || [],
            probeDuration: scan.probe ? scan.probe.duration : undefined,
            probeFormat: scan.probe ? scan.probe.format : undefined,
            quarantine: terminal,           // only hide genuinely-broken files
            keepPublic: !terminal,
        });
    } catch { /* */ }
    if (terminal) console.warn(`[VOD-Health] Quarantined vod ${vod.id} — ${scan.status} (${(scan.issues || []).slice(0, 3).join(', ')})`);
    return { id: vod.id, status: scan.status };
}

async function _scanPass(deep) {
    const limit = deep ? SCAN_BATCH_IDLE : SCAN_BATCH_LIVE;
    let vods = [];
    try { vods = db.getVodsNeedingHealthScan({ staleDays: SCAN_STALE_DAYS, limit }); } catch { return; }
    for (const vod of vods) {
        try { await _scanOne(vod, { deep }); }
        catch (e) { console.warn(`[VOD-Health] scan error for vod ${vod.id}:`, e.message); }
    }
}

// Delete a VOD's files everywhere + its DB row. Mirrors the manual delete route.
function _hardDeleteVod(vod) {
    try {
        if (vod.file_path) {
            try { require('./vod-storage').deleteVodObjects(vod).catch(() => {}); } catch { /* */ }
            // Local file + sidecars (.seekable.webm / .seekable.mp4, .master.mkv).
            for (const p of [vod.file_path, vod.file_path.replace(/\.webm$/, '.seekable.webm'), vod.file_path.replace(/\.mp4$/, '.seekable.mp4'), vod.file_path.replace(/\.webm$/, '.master.mkv'), vod.master_file_path].filter(Boolean)) {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* */ }
            }
        }
        db.run('DELETE FROM vods WHERE id = ?', [vod.id]);
        return true;
    } catch (e) {
        console.warn(`[VOD-Health] cleanup delete failed for vod ${vod.id}:`, e.message);
        return false;
    }
}

async function _cleanupPass(deep) {
    let vods = [];
    try { vods = db.getQuarantinedVodsForCleanup({ graceDays: QUARANTINE_GRACE_DAYS, limit: CLEANUP_BATCH }); } catch { return; }
    for (const vod of vods) {
        // One last recovery attempt before deleting — the master may have survived
        // even if the served file didn't. If it recovers, un-quarantine and keep it.
        if (deep && vod.file_path && vod.health_status !== 'missing_file') {
            try {
                const r = await scanner.recoverFromMaster(vod);
                if (r.recovered) {
                    const fresh = db.getVodById(vod.id) || vod;
                    const rescan = await scanner.scanVod(fresh, { decode: true, repairDuration: true, quarantineBad: false });
                    if (!['corrupt', 'zero_byte', 'missing_file'].includes(rescan.status)) {
                        db.run("UPDATE vods SET quarantined_at = NULL, health_status = 'ok' WHERE id = ?", [vod.id]);
                        console.log(`[VOD-Health] Cleanup recovered vod ${vod.id} from master — un-quarantined`);
                        continue;
                    }
                }
            } catch { /* fall through to delete */ }
        }
        if (_hardDeleteVod(vod)) {
            console.log(`[VOD-Health] Cleaned up unrecoverable vod ${vod.id} (quarantined ${vod.health_status}, ${vod.quarantined_at})`);
        }
    }
}

// Filesystem sweep for orphaned .master.mkv files: reclaim masters whose VOD is
// gone or finished-and-healthy. PROTECTS masters that are still needed — any
// recording, and any broken/quarantined VOD whose master is a recovery source —
// plus a 30-min mtime grace so a just-finished finalize is never raced.
function _masterSweep() {
    let dir, files;
    try {
        dir = path.resolve(config.vod.path);
        files = fs.readdirSync(dir).filter(f => f.endsWith('.master.mkv'));
    } catch { return; }
    if (!files.length) return;

    const protectedNames = new Set();
    try {
        const rows = db.all(`SELECT file_path, master_file_path FROM vods
            WHERE COALESCE(is_recording,0)=1
               OR quarantined_at IS NOT NULL
               OR health_status IN ('corrupt','zero_byte','needs_review')`);
        for (const v of rows) {
            if (v.master_file_path) protectedNames.add(path.basename(v.master_file_path));
            if (v.file_path) protectedNames.add(path.basename(v.file_path.replace(/\.webm$/, '.master.mkv')));
        }
    } catch { /* on error, protect nothing extra — the mtime guard still applies */ }
    // Belt-and-suspenders: never touch a master an active recording holds right now.
    try {
        const rec = require('./recorder');
        for (const [, r] of (rec.activeRecordings || new Map())) if (r && r.masterFilePath) protectedNames.add(path.basename(r.masterFilePath));
    } catch { /* */ }

    const now = Date.now();
    let n = 0, freed = 0;
    for (const f of files) {
        if (protectedNames.has(f)) continue;
        const fp = path.join(dir, f);
        try {
            const st = fs.statSync(fp);
            if (now - st.mtimeMs < 30 * 60 * 1000) continue;   // too fresh — finalize may still need it
            fs.unlinkSync(fp);
            freed += st.size; n++;
            if (n >= 25) break;                                 // cap per sweep
        } catch { /* */ }
    }
    if (n) console.log(`[VOD-Health] Master sweep: removed ${n} orphaned master(s), freed ${(freed / 1024 / 1024).toFixed(0)}MB`);
}

async function _tick() {
    if (_busy) return;
    _busy = true;
    try {
        const deep = !_anyRecording();     // full decode + recovery only while idle
        await _scanPass(deep);
        if (deep) { await _cleanupPass(deep); _masterSweep(); }
    } catch (e) {
        console.warn('[VOD-Health] tick error:', e.message);
    } finally {
        _busy = false;
    }
}

// One boot-time sweep for 0:00 ghost VODs that older failure paths marked
// ready+public (finalize crash fallbacks, killed processes). Rows with no
// media at all are deleted; short-but-nonempty ones are quarantined.
function sweepJunkVods() {
    try {
        const fs = require('fs');
        const rows = db.all(`SELECT id, file_path, file_size, duration_seconds FROM vods
            WHERE is_recording = 0 AND is_public = 1
              AND COALESCE(duration_seconds, 0) < 3
              AND COALESCE(file_size, 0) < 10000000
              AND (storage_provider IS NULL OR storage_provider = 'local')
              AND COALESCE(health_status, 'unknown') IN ('unknown', '')`);
        let deleted = 0, quarantined = 0;
        for (const v of rows) {
            const hasFile = v.file_path && fs.existsSync(v.file_path) && (() => { try { return fs.statSync(v.file_path).size > 0; } catch { return false; } })();
            if (!hasFile) {
                try { if (v.file_path && fs.existsSync(v.file_path)) fs.unlinkSync(v.file_path); } catch { /* */ }
                db.run('DELETE FROM vods WHERE id = ?', [v.id]);
                deleted++;
            } else {
                db.run(`UPDATE vods SET health_status = 'needs_review', health_issues_json = ?, quarantined_at = datetime('now'), is_public = 0 WHERE id = ?`,
                    [JSON.stringify(['short_duration']), v.id]);
                quarantined++;
            }
        }
        if (deleted || quarantined) console.log(`[VOD-Health] Junk sweep: deleted ${deleted} empty VODs, quarantined ${quarantined} short ones`);
    } catch (e) { console.warn('[VOD-Health] junk sweep error:', e.message); }
}

function start() {
    if (_running) return;
    _running = true;
    sweepJunkVods();
    // First pass shortly after boot (idle window), then on the interval.
    const first = setTimeout(() => { _tick().catch(() => {}); }, 90 * 1000);
    if (first.unref) first.unref();
    _timer = setInterval(() => { _tick().catch(() => {}); }, TICK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[VOD] Health job started (scan + master-recovery + quarantine cleanup)');
}

function stop() {
    _running = false;
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, _tick };
