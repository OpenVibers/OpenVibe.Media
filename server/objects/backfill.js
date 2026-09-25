/**
 * OpenVibe.Media — object backfill
 *
 * One media_object (+ locations, relationships, thumbnail variant) per existing
 * vod, clip, file, screenshot/avatar paste and vod/clip thumbnail, derived by the
 * same sync functions every write uses (model.withObject). Idempotent: objects are keyed by their
 * legacy ref, so a re-run updates in place and creates nothing new.
 *
 * Never touches bytes and never calls B2/R2: local copies are 'present' when the
 * file exists on disk and 'missing' when it does not; remote copies stay 'pending'
 * until `scripts/reconcile-objects.js --verify` HEADs them.
 *
 * Runs in one transaction; dryRun rolls it back and only reports.
 */
'use strict';

const db = require('../db/database');
const model = require('./model');

const SETTING_KEY = 'objects.backfill.last_report';

function emptyCounts() {
    return { seen: 0, created: 0, updated: 0, skipped: 0 };
}

function backfill({ dryRun = false, onlyMissing = false } = {}) {
    const report = {
        started_at: new Date().toISOString(), dry_run: !!dryRun, only_missing: !!onlyMissing,
        counts: { vod: emptyCounts(), clip: emptyCounts(), file: emptyCounts(), screenshot: emptyCounts(), avatar: emptyCounts(), thumbnail: emptyCounts() },
        locations: { present: 0, missing: 0, pending: 0 },
        skipped: [],
        errors: [],
    };
    const where = onlyMissing ? ' WHERE object_id IS NULL' : '';

    const tally = (kind, table, id, r) => {
        const c = report.counts[kind];
        c.seen++;
        if (!r) return;
        if (r.skipped) { c.skipped++; report.skipped.push({ table, id, reason: r.skipped }); return; }
        c[r.created ? 'created' : 'updated']++;
        for (const s of r.locations || []) if (s in report.locations) report.locations[s]++;
    };
    const thumb = (table, id, r) => {
        if (!r || !r.thumbnail) return;
        tally('thumbnail', `${table}.thumbnail_url`, id, r.thumbnail);
    };
    const d = db.getDb();
    // One savepoint per row: a row that fails leaves nothing half-written behind.
    const each = (table, sql, fn) => {
        const one = d.transaction(fn);
        for (const row of db.all(sql)) {
            try { one(row); } catch (err) { report.errors.push({ table, id: row.id ?? row.key, error: err.message }); }
        }
    };

    d.exec('BEGIN');
    try {
        // VODs before clips, so clip_of can point at the vod's object.
        each('vods', `SELECT * FROM vods${where} ORDER BY id`, (row) => {
            const r = model.syncVod(row);
            tally('vod', 'vods', row.id, r);
            thumb('vods', row.id, r);
        });
        each('clips', `SELECT * FROM clips${where} ORDER BY id`, (row) => {
            const r = model.syncClip(row);
            tally('clip', 'clips', row.id, r);
            thumb('clips', row.id, r);
        });
        each('files', `SELECT * FROM files${where} ORDER BY created_at, key`, (row) => {
            tally('file', 'files', row.key, model.syncFile(row));
        });
        each('pastes', `SELECT * FROM pastes${where ? where + ' AND' : ' WHERE'} type = 'screenshot' ORDER BY id`, (row) => {
            const r = model.syncPaste(row);
            const kind = (r && r.kind) || (String(row.metadata || '').includes('"kind":"avatar"') ? 'avatar' : 'screenshot');
            tally(kind, 'pastes', row.id, r);
        });
        if (dryRun) d.exec('ROLLBACK'); else d.exec('COMMIT');
    } catch (err) {
        try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
    }

    report.finished_at = new Date().toISOString();
    report.totals = Object.values(report.counts).reduce((t, c) => {
        for (const k of Object.keys(t)) t[k] += c[k];
        return t;
    }, emptyCounts());
    if (!dryRun && (!onlyMissing || report.totals.created || report.totals.updated)) {
        // Keep the latest report (skipped rows capped) for operators: media_settings.objects.backfill.last_report.
        const stored = { ...report, skipped: report.skipped.slice(0, 500), skipped_truncated: report.skipped.length > 500 };
        db.run(`INSERT INTO media_settings (key, value, description, type) VALUES (?, ?, 'Last object backfill report', 'json')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`, [SETTING_KEY, JSON.stringify(stored)]);
    }
    return report;
}

function lastReport() {
    const row = db.get('SELECT value FROM media_settings WHERE key = ?', [SETTING_KEY]);
    return row ? model.parseJson(row.value, null) : null;
}

function summarize(report) {
    const parts = Object.entries(report.counts).filter(([, c]) => c.seen)
        .map(([k, c]) => `${k} ${c.created}+/${c.updated}~/${c.skipped} skipped`);
    return `${report.dry_run ? '[dry run] ' : ''}${parts.join(', ') || 'nothing to do'}; locations present ${report.locations.present}, `
        + `missing ${report.locations.missing}, pending ${report.locations.pending}${report.errors.length ? `; ${report.errors.length} error(s)` : ''}`;
}

module.exports = { backfill, lastReport, summarize, SETTING_KEY };
