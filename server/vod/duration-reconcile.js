/**
 * OpenVibe.Media — VOD duration reconciliation (job vod.duration.reconcile; scripts/vod-duration-reconcile.js)
 *
 * Compares each finished VOD's stored duration with a measurement of its real file, in bounded
 * batches walked by id, and repairs the values that are clearly wrong. Offloaded VODs are measured
 * where they are: ffprobe reads the B2/R2 copy through a presigned HTTPS URL with ranged requests
 * (the file is not downloaded). Every run writes a report.
 *
 * Verdicts (stored vs measured, seconds):
 *   ok            |diff| <= 2
 *   mismatch      a small difference (reported, left alone)
 *   wrong         |diff| > 60 AND > 2% of the measured length: repairable
 *   missing       nothing stored (<= 0) but the file measures: repairable
 *   unmeasurable  no measurement (the file is unreadable, or neither copy can be reached)
 *   skipped       nothing to measure (zero_byte / missing_file health, no file)
 *
 * A repair needs a confirmed measurement: a local file's probe must agree with a stream-copy pass
 * over its packets (or the packets are used, source remux, when the header lies); a remote copy's
 * container duration must agree with its own streams' durations (--confirm-remote reads the whole
 * remote file instead). An unconfirmed value is reported, never written. A repair writes
 * duration_seconds, probe_duration_seconds and duration_source only if the row still holds the value
 * that was read, and re-projects the VOD's object.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');
const tools = require('./media-tools');

const THRESHOLDS = Object.freeze({ mismatchS: 2, wrongAbsS: 60, wrongRel: 0.02, agreeAbsS: 5, agreeRel: 0.01, streamsAgreeRel: 0.05 });
const MAX_BATCH = 200;

const vodStorage = () => require('./vod-storage');

function classify(stored, measured, t = THRESHOLDS) {
    const s = Number(stored) || 0;
    if (!(measured > 0)) return 'unmeasurable';
    if (s <= 0) return 'missing';
    const diff = Math.abs(s - measured);
    if (diff <= t.mismatchS) return 'ok';
    if (diff > t.wrongAbsS && diff > t.wrongRel * measured) return 'wrong';
    return 'mismatch';
}

const agree = (a, b, t = THRESHOLDS) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(t.agreeAbsS, t.agreeRel * Math.max(a, b));

/** The longest stream duration ffprobe reported (0 when none). */
function streamsDuration(streams) {
    let max = 0;
    for (const st of streams || []) { const d = parseFloat(st && st.duration); if (Number.isFinite(d) && d > max) max = d; }
    return max;
}

/**
 * Where to read a VOD from: { kind: 'file', value, where: 'local' } or { kind: 'url', value,
 * where: 'b2' | 'r2' } (a presigned GET: ffprobe range-reads it), or null.
 */
async function sourceFor(vod) {
    const vs = vodStorage();
    const local = vs.localPathForVod(vod);
    if (fs.existsSync(local)) return { kind: 'file', value: local, where: 'local' };
    if (vod.file_path && fs.existsSync(vod.file_path)) return { kind: 'file', value: vod.file_path, where: 'local' };
    if (vs.isRemote(vod)) {
        const plan = await vs.resolvePlayback(vod);
        if (plan && plan.kind === 'redirect') return { kind: 'url', value: plan.url, where: plan.provider };
        if (plan && plan.kind === 'file') return { kind: 'file', value: plan.path, where: 'local' };
    }
    return null;
}

/**
 * Measure one VOD. Returns { where, seconds, source: probe|remux|null, confirmed, note }.
 * `confirm` runs the second, independent measurement (only needed when a repair is on the table).
 */
async function measure(vod, { confirm = false, confirmRemote = false, probeTimeoutMs } = {}) {
    const src = await sourceFor(vod);
    if (!src) return { where: null, seconds: 0, source: null, confirmed: false, note: 'no local file and no reachable remote copy' };
    const remote = src.kind === 'url';
    const probe = await tools.probeDuration(src.value, { timeoutMs: probeTimeoutMs || (remote ? 60000 : 20000) });
    const out = { where: src.where, seconds: probe.seconds || 0, source: probe.seconds > 0 ? 'probe' : null, confirmed: false, note: null };
    if (!probe.ok) { out.note = `ffprobe: ${probe.error}`; }
    if (!confirm) return out;
    if (!remote || confirmRemote) {
        // Read every packet: the media's real length, independent of the container header.
        const packets = await tools.streamCopyDuration(src.value);
        if (!packets.ok) {
            out.note = `${out.note ? `${out.note}; ` : ''}stream-copy pass: ${packets.error}`;
            return out;
        }
        if (out.seconds > 0 && agree(out.seconds, packets.seconds)) { out.confirmed = true; return out; }
        // The header disagrees with (or lacks) the packet timeline: the packets are the truth.
        out.note = out.seconds > 0 ? `container says ${out.seconds.toFixed(1)} s, packets ${packets.seconds.toFixed(1)} s: packets used` : 'no container duration: packets used';
        out.seconds = packets.seconds;
        out.source = 'remux';
        out.confirmed = true;
        return out;
    }
    // Remote, no full read: the container's duration must agree with its own streams'.
    const sd = streamsDuration(probe.streams);
    if (out.seconds > 0 && sd > 0 && Math.abs(out.seconds - sd) <= Math.max(THRESHOLDS.agreeAbsS, THRESHOLDS.streamsAgreeRel * out.seconds)) {
        out.confirmed = true;
    } else {
        out.note = `${out.note ? `${out.note}; ` : ''}remote container ${out.seconds.toFixed(1)} s vs streams ${sd.toFixed(1)} s: not confirmed (--confirm-remote reads the whole copy)`;
    }
    return out;
}

function reportsDir() {
    return path.join(path.dirname(config.db.path), 'reports');
}

function writeReport(report, file = null) {
    const out = file || path.join(reportsDir(), `duration-reconcile-${report.app_id || 'all'}-${report.run_at.replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    return out;
}

/** Write one repair (only if the row still has the value we read). Returns true when it changed. */
function applyRepair(row) {
    // The row and its object in one transaction (the object only when the row changed).
    return db.withObject('vod', (r) => (r.changes > 0 ? row.vod_id : null), () => db.run(`UPDATE vods SET duration_seconds = ?, probe_duration_seconds = ?, duration_source = ?
                            WHERE id = ? AND COALESCE(duration_seconds, 0) = ? AND COALESCE(duration_source, '') = ? AND COALESCE(is_recording, 0) = 0`,
    [Math.round(row.measured), row.measured, row.measured_source, row.vod_id, row.stored, row.stored_source || ''])).changes > 0;
}

/** Undo repairs listed in a report (only rows that still hold what the repair wrote). */
function rollback(rows, { apply = false } = {}) {
    const out = { restored: 0, would_restore: 0, changed_since: 0 };
    for (const r of rows || []) {
        if (r.action !== 'repaired') continue;
        const cur = db.get('SELECT duration_seconds, duration_source FROM vods WHERE id = ?', [r.vod_id]);
        if (!cur || Number(cur.duration_seconds) !== Math.round(r.measured) || (cur.duration_source || '') !== (r.measured_source || '')) { out.changed_since++; continue; }
        if (!apply) { out.would_restore++; continue; }
        db.withObject('vod', r.vod_id, () => db.run('UPDATE vods SET duration_seconds = ?, probe_duration_seconds = ?, duration_source = ? WHERE id = ?',
            [r.stored, r.stored_probe ?? r.stored, r.stored_source || null, r.vod_id]));
        out.restored++;
    }
    return out;
}

/**
 * Reconcile one bounded batch. opts: appId (null = every tenant), afterId (id cursor), limit
 * (1-200), ids (exactly these VODs), apply, confirmRemote, onRow(row).
 * Returns the report: { run_at, mode, app_id, thresholds, range, counts, rows }.
 */
async function reconcileBatch({ appId = null, afterId = 0, limit = 50, ids = null, apply = false, confirmRemote = false, onRow = null, signal = null } = {}) {
    const n = Math.min(MAX_BATCH, Math.max(1, Number(limit) || 50));
    const conds = ['COALESCE(is_recording, 0) = 0', 'COALESCE(clips_only, 0) = 0', 'file_path IS NOT NULL'];
    const params = [];
    if (appId) { conds.push('app_id = ?'); params.push(appId); }
    if (ids && ids.length) { conds.push(`id IN (${ids.map(() => '?').join(', ')})`); params.push(...ids.map(Number)); } else { conds.push('id > ?'); params.push(Number(afterId) || 0); }
    const vods = db.all(`SELECT * FROM vods WHERE ${conds.join(' AND ')} ORDER BY id LIMIT ?`, [...params, n]);
    const report = {
        kind: 'media.vod.duration_reconcile', version: 1, run_at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run',
        app_id: appId, thresholds: THRESHOLDS, confirm_remote: !!confirmRemote,
        range: { after_id: ids ? null : Number(afterId) || 0, last_id: vods.length ? vods[vods.length - 1].id : null, limit: n, done: vods.length < n },
        counts: { checked: 0, ok: 0, mismatch: 0, wrong: 0, missing: 0, unmeasurable: 0, skipped: 0, repaired: 0, would_repair: 0, unconfirmed: 0, changed_since: 0, remote: 0 },
        rows: [],
    };
    for (const vod of vods) {
        if (signal && signal.aborted) break;
        report.counts.checked++;
        const stored = Number(vod.duration_seconds) || 0;
        const row = {
            vod_id: vod.id, app_id: vod.app_id, storage_provider: vod.storage_provider || 'local', health_status: vod.health_status || null,
            stored, stored_probe: Number(vod.probe_duration_seconds) || 0, stored_source: vod.duration_source || null,
            where: null, measured: 0, measured_source: null, diff: null, verdict: null, confirmed: false, action: 'none', note: null,
        };
        if (['zero_byte', 'missing_file'].includes(vod.health_status)) {
            row.verdict = 'skipped'; row.note = `health ${vod.health_status}`;
        } else {
            let m = await measure(vod);
            row.where = m.where;
            if (m.where && m.where !== 'local') report.counts.remote++;
            let verdict = classify(stored, m.seconds);
            if (verdict === 'wrong' || verdict === 'missing') {
                m = await measure(vod, { confirm: true, confirmRemote });
                verdict = classify(stored, m.seconds);
            }
            Object.assign(row, { measured: m.seconds ? Number(m.seconds.toFixed(3)) : 0, measured_source: m.source, confirmed: m.confirmed, note: m.note, verdict });
            row.diff = m.seconds > 0 ? Number((m.seconds - stored).toFixed(3)) : null;
            if (verdict === 'wrong' || verdict === 'missing') {
                if (!m.confirmed) { row.action = 'unconfirmed'; report.counts.unconfirmed++; }
                else if (!apply) { row.action = 'would_repair'; report.counts.would_repair++; }
                else if (applyRepair(row)) { row.action = 'repaired'; report.counts.repaired++; }
                else { row.action = 'changed_since'; report.counts.changed_since++; }
            }
        }
        report.counts[row.verdict]++;
        report.rows.push(row);
        if (onRow) onRow(row);
    }
    return report;
}

module.exports = { THRESHOLDS, MAX_BATCH, classify, agree, streamsDuration, sourceFor, measure, reconcileBatch, applyRepair, rollback, writeReport, reportsDir };
