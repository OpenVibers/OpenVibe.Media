#!/usr/bin/env node
'use strict';
/**
 * Project every existing vod, clip, file, screenshot/avatar paste and thumbnail onto the canonical
 * object model (media_objects + media_locations; docs/object-model.md). Idempotent — re-runs update
 * in place. Never moves or deletes bytes and never calls B2/R2 (remote copies stay 'pending' until
 * scripts/reconcile-objects.js --verify).
 *
 *   node scripts/backfill-objects.js [--dry-run] [--only-missing] [--json] [--out report.json] [--db ./data/media.db]
 *
 * The service runs the --only-missing form itself shortly after boot. The run is one transaction
 * (a dry run rolls it back), so it holds SQLite's write lock for its duration — seconds, typically.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
if (arg('db')) process.env.DB_PATH = path.resolve(arg('db'));

const { backfill, summarize } = require('../server/objects/backfill');
const report = backfill({ dryRun: has('dry-run'), onlyMissing: has('only-missing') });
if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
if (has('json')) console.log(JSON.stringify(report, null, 2));
else {
    console.log(summarize(report));
    const reasons = {};
    for (const s of report.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    for (const [r, n] of Object.entries(reasons)) console.log(`  skipped ${n}: ${r}`);
    for (const e of report.errors.slice(0, 20)) console.log(`  error ${e.table} ${e.id}: ${e.error}`);
}
require('../server/db/database').close();
process.exit(report.errors.length ? 1 : 0);
