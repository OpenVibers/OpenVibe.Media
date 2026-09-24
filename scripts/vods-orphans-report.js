#!/usr/bin/env node
'use strict';
/**
 * Report on the B2 `vods-orphans/` prefix (hazard H3). Read-only: it lists the prefix (ListObjectsV2),
 * HEADs each match's canonical copy, reads the database, and writes a report. It never deletes, moves,
 * copies or writes an object or a row (server/vod/orphans-report.js has the rules).
 *
 *   node scripts/vods-orphans-report.js [--prefix vods-orphans/] [--provider b2] [--out <report.json>] [--json] [--db <media.db>]
 *
 * Prints one line per object (key, size, matched VOD/clip, recommendation) and the totals per
 * recommendation, and writes the full report (default <data>/reports/vods-orphans-<time>.json).
 * B2 credentials come from the environment (/etc/openvibe/media.env names). Exit 0 done, 1 error, 2 usage.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const usage = (msg) => { console.error(`vods-orphans-report: ${msg}`); process.exit(2); };
for (const flag of ['prefix', 'provider', 'out', 'db']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
if (arg('db')) process.env.DB_PATH = path.resolve(arg('db'));
const provider = arg('provider') || 'b2';
if (!['b2', 'r2'].includes(provider)) usage('--provider must be b2 or r2');

const config = require('../server/config');
if (!fs.existsSync(config.db.path)) usage(`no database at ${config.db.path} (set DB_PATH or pass --db)`);
const db = require('../server/db/database');
const vodStorage = require('../server/vod/vod-storage');
const orphans = require('../server/vod/orphans-report');
const JSON_OUT = has('json');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

(async () => {
    if (!vodStorage.providerConfigured(provider)) usage(`${provider} is not configured (MEDIA_${provider.toUpperCase()}_* not in the environment)`);
    const report = await orphans.buildReport({ provider, prefix: arg('prefix') || orphans.PREFIX });
    const file = arg('out') ? path.resolve(arg('out')) : path.join(path.dirname(config.db.path), 'reports', `vods-orphans-${report.generated_at.replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    log(`${report.provider}://${report.bucket}/${report.prefix}: ${report.totals.objects} object(s), ${report.totals.gb} GB (read-only report)`);
    log('');
    for (const o of report.objects) {
        const m = o.match ? `${o.match.kind} ${o.match.id}${o.match.row === 'gone' ? ' (row gone)' : ''}` : '-';
        log(`  ${o.key.padEnd(60)} ${mb(o.size).padStart(11)}  ${m.padEnd(22)} ${o.recommendation.padEnd(20)} ${o.reason}`);
    }
    log('');
    for (const [rec, t] of Object.entries(report.by_recommendation)) if (t.objects) log(`  ${rec.padEnd(22)} ${String(t.objects).padStart(4)} object(s)  ${mb(t.bytes).padStart(12)}`);
    log('');
    log('Nothing was deleted or moved. delete_* rows are candidates for the owner; keep_only_copy rows are recordings whose only copy is here.');
    log(`Report: ${file}`);
    if (JSON_OUT) console.log(JSON.stringify({ ...report, report: file }, null, 2));
    db.close();
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
