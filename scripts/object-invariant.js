#!/usr/bin/env node
'use strict';
/**
 * Public object-size invariant report (roadmap W4 deliverable 5; docs/object-model.md#public-object-size-invariant).
 * Lists public/unlisted ready VOD and clip objects above MEDIA_PUBLIC_OBJECT_TARGET_MB (256), flags
 * those above MEDIA_PUBLIC_OBJECT_WARN_MB (384) and MEDIA_PUBLIC_OBJECT_MAX_MB (500), and records
 * warn/violation rows in media_invariant_violations (resolving rows that no longer apply).
 * Nothing is re-encoded.
 *
 *   node scripts/object-invariant.js [--dry-run] [--app live] [--json] [--db ./data/media.db]
 */
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
if (arg('db')) process.env.DB_PATH = path.resolve(arg('db'));

const { scan, MB } = require('../server/objects/invariant');
const report = scan({ record: !has('dry-run'), appId: arg('app', null) });
if (has('json')) console.log(JSON.stringify(report, null, 2));
else {
    const t = report.thresholds;
    console.log(`public playback objects — target ${t.targetBytes / MB} MB, warn ${t.warnBytes / MB} MB, max ${t.maxBytes / MB} MB${has('dry-run') ? ' (dry run)' : ''}`);
    console.log(`  ok ${report.counts.ok}, above target ${report.counts.above_target}, warn ${report.counts.warn}, violation ${report.counts.violation}`);
    for (const o of report.objects.slice(0, 50)) {
        console.log(`  ${o.level.padEnd(12)} ${(o.size_bytes / MB).toFixed(0).padStart(6)} MB  ${o.object_id}  ${o.legacy_ref || ''}`);
    }
    if (report.objects.length > 50) console.log(`  … ${report.objects.length - 50} more (use --json)`);
}
require('../server/db/database').close();
process.exit(0);
