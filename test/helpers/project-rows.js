/**
 * OpenVibe.Media — test-only legacy row projection
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

const db = require('../../server/db/database');
const model = require('../../server/objects/model');

function emptyCounts() {
    return { seen: 0, created: 0, updated: 0, skipped: 0 };
}

async function projectRows({ dryRun = false, onlyMissing = false } = {}) {
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
    // One savepoint per row (a nested transaction): a row that fails leaves nothing half-written behind.
    const each = async (table, sql, fn) => {
        for (const row of await db.all(sql)) {
            try { await d.tx(async () => { await fn(row); }); } catch (err) { report.errors.push({ table, id: row.id ?? row.key, error: err.message }); }
        }
    };

    // One transaction for the run; a dry run rolls it back at the end.
    const DRY = Symbol('dry run');
    try {
        await d.tx(async () => {
        // VODs before clips, so clip_of can point at the vod's object.
        await each('vods', `SELECT * FROM vods${where} ORDER BY id`, async (row) => {
            const r = await model.syncVod(row);
            tally('vod', 'vods', row.id, r);
            thumb('vods', row.id, r);
        });
        await each('clips', `SELECT * FROM clips${where} ORDER BY id`, async (row) => {
            const r = await model.syncClip(row);
            tally('clip', 'clips', row.id, r);
            thumb('clips', row.id, r);
        });
        await each('files', `SELECT * FROM files${where} ORDER BY created_at, key`, async (row) => {
            tally('file', 'files', row.key, await model.syncFile(row));
        });
        await each('pastes', `SELECT * FROM pastes${where ? where + ' AND' : ' WHERE'} type = 'screenshot' ORDER BY id`, async (row) => {
            const r = await model.syncPaste(row);
            const kind = (r && r.kind) || (String(row.metadata || '').includes('"kind":"avatar"') ? 'avatar' : 'screenshot');
            tally(kind, 'pastes', row.id, r);
        });
        if (dryRun) throw DRY;
        });
    } catch (err) {
        if (err !== DRY) throw err;
    }

    report.finished_at = new Date().toISOString();
    report.totals = Object.values(report.counts).reduce((t, c) => {
        for (const k of Object.keys(t)) t[k] += c[k];
        return t;
    }, emptyCounts());
    return report;
}

function summarize(report) {
    const parts = Object.entries(report.counts).filter(([, c]) => c.seen)
        .map(([k, c]) => `${k} ${c.created}+/${c.updated}~/${c.skipped} skipped`);
    return `${report.dry_run ? '[dry run] ' : ''}${parts.join(', ') || 'nothing to do'}; locations present ${report.locations.present}, `
        + `missing ${report.locations.missing}, pending ${report.locations.pending}${report.errors.length ? `; ${report.errors.length} error(s)` : ''}`;
}

module.exports = { projectRows, summarize };
