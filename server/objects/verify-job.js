/**
 * OpenVibe.Media — scheduled copy verification (docs/object-model.md#scheduled-verification).
 *
 * Every MEDIA_VERIFY_INTERVAL_MIN minutes one run takes the MEDIA_VERIFY_BATCH ready objects that
 * were verified least recently (never-verified first), so every object is covered over time, and
 * for each one:
 *   - checks every copy: local = the file exists (size, and sha256 when the object carries a hash
 *     and the file is ≤ MEDIA_VERIFY_HASH_MAX_MB); B2/R2 = a HEAD with the right size. The verdict
 *     (present / missing / corrupt) is written to media_locations, exactly as
 *     `reconcile-objects.js --verify` would. An unconfigured provider is unverifiable, never missing;
 *   - restores a MISSING B2/R2 copy by uploading a verified-good local copy to the same key
 *     (at most MEDIA_VERIFY_MAX_REUPLOADS per run). A corrupt remote copy is only overwritten when
 *     MEDIA_VERIFY_REPAIR_CORRUPT=1;
 *   - records the outcome in media_verifications (one row per object) and the run in media_verify_runs.
 *
 * It NEVER deletes anything: no file unlink, no remote delete, no row delete. Objects with no good
 * copy anywhere are only counted (media_objects_no_good_copy on /metrics, the optional
 * `object_copies` readiness check) and listed by scripts/no-good-copy-report.js for an operator.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');
const copyReport = require('./copy-report');

const MB = 1024 * 1024;
const REMOTE = ['b2', 'r2'];

let _timer = null, _startTimer = null, _busy = false;

const nowIso = () => new Date().toISOString();

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', d => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

/** Real provider HEAD: undefined when the provider is not configured here, null on 404. */
async function defaultHead(provider, key) {
    return require('./reconcile').defaultHead(provider, key);
}

/** Real re-upload through the storage engine (it HEADs afterwards and throws on a size mismatch). */
async function defaultUpload(provider, key, filePath, contentType, loc) {
    const vs = require('../vod/vod-storage');
    if (!vs.providerConfigured(provider)) return undefined;
    if (loc && loc.bucket && vs.bucketFor(provider) && loc.bucket !== vs.bucketFor(provider)) {
        throw new Error(`location is in bucket ${loc.bucket}, the configured ${provider} bucket is ${vs.bucketFor(provider)}`);
    }
    return vs.uploadFile(provider, key, filePath, contentType || 'application/octet-stream');
}

/** Write a verdict only if the location still points where it did when we looked (a tier move may have re-projected it). */
function writeState(loc, state, size) {
    db.run(`UPDATE media_locations SET state = ?, size_bytes = COALESCE(?, size_bytes), verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND key = ?`, [state, size ?? null, loc.id, loc.key]);
}

/**
 * Verify one object's copies and restore missing remote ones from a good local copy.
 * Returns { status, good_providers, locations: [...], reuploads: [...] }.
 */
async function verifyObject(obj, opts) {
    const { head, upload, hashMaxBytes, repairCorrupt, budget } = opts;
    const expected = Number(obj.size_bytes) || 0;
    const locs = db.all('SELECT * FROM media_locations WHERE object_id = ? ORDER BY id', [obj.id]);
    const results = [];
    let goodLocal = null;

    for (const loc of locs) {
        const r = { provider: loc.provider, key: loc.key, before: loc.state, state: loc.state, size_bytes: null, note: null };
        results.push(r);
        if (loc.provider === 'local') {
            let st = null;
            try { const s = fs.statSync(loc.key); if (s.isFile()) st = s; } catch { /* missing */ }
            if (!st) { r.state = 'missing'; writeState(loc, 'missing', null); continue; }
            r.size_bytes = st.size;
            // Same rule as reconcile: a local size that differs from the recorded size is reported, not
            // condemned (recordings and remuxes change it) — but such a file is never used as a re-upload source.
            let state = 'present';
            let sizeOk = !expected || st.size === expected;
            if (!sizeOk) r.note = `size ${st.size} ≠ expected ${expected}`;
            let hashOk = null;
            if (obj.content_hash && st.size <= hashMaxBytes) {
                const actual = await sha256File(loc.key).catch(() => null);
                if (actual) {
                    hashOk = actual === obj.content_hash;
                    if (!hashOk) { state = 'corrupt'; r.note = 'sha256 mismatch'; }
                }
            }
            r.state = state;
            writeState(loc, state, st.size);
            if (state === 'present' && sizeOk && hashOk !== false) goodLocal = loc;
            continue;
        }
        // b2 / r2
        let h;
        try { h = await head(loc.provider, loc.key, loc.bucket); }
        catch (err) { r.state = loc.state; r.note = `unverifiable: ${err.message}`; r.unverifiable = true; continue; }
        if (h === undefined) { r.state = loc.state; r.note = 'unverifiable: provider not configured'; r.unverifiable = true; continue; }
        if (!h) { r.state = 'missing'; writeState(loc, 'missing', null); continue; }
        r.size_bytes = Number(h.size);
        const state = expected && Number(h.size) !== expected ? 'corrupt' : 'present';
        if (state === 'corrupt') r.note = `size ${h.size} ≠ expected ${expected}`;
        r.state = state;
        writeState(loc, state, Number(h.size));
    }

    // Restore missing (and, when allowed, corrupt) remote copies from a verified-good local copy.
    const reuploads = [];
    if (goodLocal) {
        for (const loc of locs) {
            if (!REMOTE.includes(loc.provider)) continue;
            const r = results.find(x => x.provider === loc.provider);
            const want = r.state === 'missing' || (repairCorrupt && r.state === 'corrupt');
            if (!want) continue;
            if (budget.left <= 0) { reuploads.push({ provider: loc.provider, key: loc.key, ok: false, error: 'deferred: re-upload budget for this run used up' }); continue; }
            budget.left--;
            try {
                const out = await upload(loc.provider, loc.key, goodLocal.key, obj.mime_type, loc);
                if (out === undefined) { reuploads.push({ provider: loc.provider, key: loc.key, ok: false, error: 'provider not configured' }); continue; }
                const size = Number(out && out.size) || fs.statSync(goodLocal.key).size;
                writeState(loc, 'present', size);
                r.state = 'present'; r.size_bytes = size; r.note = `re-uploaded from ${goodLocal.key}`;
                reuploads.push({ provider: loc.provider, key: loc.key, ok: true, size_bytes: size, from: goodLocal.key });
            } catch (err) {
                reuploads.push({ provider: loc.provider, key: loc.key, ok: false, error: err.message });
            }
        }
    }

    const good = results.filter(x => x.state === 'present').map(x => x.provider);
    const unknown = results.some(x => x.unverifiable || x.state === 'pending');
    const status = good.length ? 'good' : unknown ? 'unverifiable' : 'no_good_copy';
    return { status, good_providers: good, locations: results, reuploads };
}

/** One bounded run. Deps are injectable for tests: head(provider, key), upload(provider, key, file, mime, loc). */
async function runOnce({ batch = config.verify.batch, head = defaultHead, upload = defaultUpload,
    hashMaxBytes = config.verify.hashMaxMb * MB, maxReuploads = config.verify.maxReuploads, repairCorrupt = config.verify.repairCorrupt } = {}) {
    if (_busy) return { skipped: 'busy' };
    _busy = true;
    const summary = { started_at: nowIso(), finished_at: null, objects_checked: 0, locations_checked: 0, good: 0, no_good_copy: 0, unverifiable: 0,
        reuploaded: 0, reupload_failed: 0, no_good_copy_total: null, error: null, objects: [] };
    let runId = null;
    try {
        runId = db.run('INSERT INTO media_verify_runs (started_at) VALUES (?)', [summary.started_at]).lastInsertRowid;
        const n = Math.max(1, Number(batch) || 1);
        const objects = db.all(`SELECT o.* FROM media_objects o LEFT JOIN media_verifications v ON v.object_id = o.id
                                WHERE o.lifecycle_status = 'ready'
                                ORDER BY (v.verified_at IS NOT NULL), v.verified_at, o.id LIMIT ?`, [n]);
        const budget = { left: Math.max(0, Number(maxReuploads) || 0) };
        for (const obj of objects) {
            let res;
            try { res = await verifyObject(obj, { head, upload, hashMaxBytes, repairCorrupt, budget }); }
            catch (err) { res = { status: 'unverifiable', good_providers: [], locations: [], reuploads: [], error: err.message }; }
            summary.objects_checked++;
            summary.locations_checked += res.locations.length;
            summary[res.status]++;
            for (const u of res.reuploads) { if (u.ok) summary.reuploaded++; else if (!/^deferred/.test(u.error || '')) summary.reupload_failed++; }
            db.run(`INSERT INTO media_verifications (object_id, verified_at, status, good_providers, detail, run_id) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(object_id) DO UPDATE SET verified_at = excluded.verified_at, status = excluded.status,
                        good_providers = excluded.good_providers, detail = excluded.detail, run_id = excluded.run_id`,
            [obj.id, nowIso(), res.status, res.good_providers.join(',') || null,
                JSON.stringify({ locations: res.locations, reuploads: res.reuploads, error: res.error || undefined }), runId]);
            summary.objects.push({ object_id: obj.id, status: res.status, reuploads: res.reuploads.length });
            if (res.status === 'no_good_copy') console.warn(`[Verify] ${obj.id} (${obj.legacy_ref || obj.kind}) has no good copy — see scripts/no-good-copy-report.js`);
            for (const u of res.reuploads) {
                if (u.ok) console.log(`[Verify] ${obj.id}: restored ${u.provider}:${u.key} from the local copy`);
                else if (!/^deferred/.test(u.error || '')) console.warn(`[Verify] ${obj.id}: re-upload to ${u.provider} failed: ${u.error}`);
            }
        }
    } catch (err) {
        summary.error = err.message;
        console.warn('[Verify] run failed:', err.message);
    } finally {
        summary.finished_at = nowIso();
        try { summary.no_good_copy_total = copyReport.countNoGoodCopy(db); } catch { /* */ }
        if (runId != null) {
            try {
                db.run(`UPDATE media_verify_runs SET finished_at = ?, objects_checked = ?, locations_checked = ?, good = ?, no_good_copy = ?, unverifiable = ?,
                        reuploaded = ?, reupload_failed = ?, no_good_copy_total = ?, error = ? WHERE id = ?`,
                [summary.finished_at, summary.objects_checked, summary.locations_checked, summary.good, summary.no_good_copy, summary.unverifiable,
                    summary.reuploaded, summary.reupload_failed, summary.no_good_copy_total, summary.error, runId]);
            } catch { /* */ }
        }
        summary.run_id = runId;
        _busy = false;
    }
    if (summary.no_good_copy || summary.reuploaded || summary.reupload_failed) {
        console.log(`[Verify] run ${runId}: ${summary.objects_checked} object(s), ${summary.good} good, ${summary.no_good_copy} no good copy, `
            + `${summary.unverifiable} unverifiable, ${summary.reuploaded} restored, ${summary.reupload_failed} restore failed; `
            + `${summary.no_good_copy_total} ready object(s) with no good copy in total`);
    }
    return summary;
}

/** Last finished run and the current no-good-copy count (readiness detail, operators). */
function status() {
    const last = db.get('SELECT * FROM media_verify_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
    return {
        enabled: !!config.verify.enabled,
        running: !!_timer,
        no_good_copy: copyReport.countNoGoodCopy(db),
        verified_objects: db.get('SELECT COUNT(*) AS n FROM media_verifications').n,
        last_run: last ? { id: last.id, finished_at: last.finished_at, objects_checked: last.objects_checked, no_good_copy: last.no_good_copy,
            reuploaded: last.reuploaded, reupload_failed: last.reupload_failed, error: last.error || null } : null,
    };
}

function start({ initialDelayMs = 2 * 60 * 1000 } = {}) {
    if (!config.verify.enabled) { console.log('[Verify] scheduled copy verification disabled (MEDIA_VERIFY_ENABLED=0)'); return false; }
    if (_timer || _startTimer) return true;
    const tick = () => { runOnce().catch((err) => console.warn('[Verify] run error:', err.message)); };
    const intervalMs = Math.max(1, config.verify.intervalMin) * 60 * 1000;
    _startTimer = setTimeout(() => {
        _startTimer = null;
        tick();
        _timer = setInterval(tick, intervalMs);
        if (_timer.unref) _timer.unref();
    }, initialDelayMs);
    if (_startTimer.unref) _startTimer.unref();
    return true;
}

function stop() {
    if (_startTimer) { clearTimeout(_startTimer); _startTimer = null; }
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { runOnce, verifyObject, status, start, stop };
