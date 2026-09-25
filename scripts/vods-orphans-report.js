#!/usr/bin/env node
'use strict';
/**
 * Orphan reports (server/vod/orphans-report.js has the rules). Read-only: they list, HEAD and read the
 * database, and write a report file. They never delete, move, copy or write an object, a file or a row.
 *
 *   node scripts/vods-orphans-report.js [--prefix vods-orphans/] [--provider b2] [--out <report.json>] [--json] [--db <media.db>]
 *
 * The B2 `vods-orphans/` prefix (hazard H3): lists the prefix (ListObjectsV2), HEADs each match's
 * canonical copy, prints one line per object (key, size, matched VOD/clip, recommendation) and the
 * totals per recommendation, and writes the full report (default <data>/reports/vods-orphans-<time>.json).
 *
 *   node scripts/vods-orphans-report.js --storage [--no-remote] [--limit 2000] [--out <report.json>] [--json] [--db <media.db>]
 *
 * The whole storage against the database (the storage.orphans.scan job, on demand): files under the data
 * directories and B2/R2 keys that no row names, copies the database records that are not there, and
 * multipart uploads left open (Media's sessions and the buckets'). --no-remote lists no bucket. Prints
 * the totals and the largest items, and writes <data>/reports/storage-orphans-<time>.json.
 *
 * B2/R2 credentials come from the environment (/etc/openvibe/media.env names). Exit 0 done, 1 error, 2 usage.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const usage = (msg) => { console.error(`vods-orphans-report: ${msg}`); process.exit(2); };
for (const flag of ['prefix', 'provider', 'out', 'db', 'limit']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
if (has('limit') && !(Number.isInteger(Number(arg('limit'))) && Number(arg('limit')) > 0)) usage('--limit must be a positive integer');
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

async function storageReport() {
    const providers = has('no-remote') ? [] : null;
    const report = await orphans.buildStorageReport({ providers, limit: has('limit') ? Number(arg('limit')) : 2000 });
    const file = orphans.writeStorageReport(report, arg('out') ? path.resolve(arg('out')) : null);
    const t = report.totals;
    log(`Storage orphan report (read-only), ${report.generated_at}`);
    for (const r of report.scope.roots) log(`  local ${r.name.padEnd(11)} ${r.dir}${r.exists ? ` (${r.files} file(s))` : ' (missing)'}`);
    for (const [p, e] of Object.entries(report.scope.providers)) log(`  ${p.padEnd(17)} ${e.listed ? `${e.bucket || ''}: ${e.keys} key(s), ${mb(e.bytes)}` : `not listed${e.error ? `: ${e.error}` : ''}`}`);
    if (has('no-remote')) log('  buckets           not listed (--no-remote)');
    log('');
    log(`Unreferenced local files: ${t.unreferenced_local.files} (${mb(t.unreferenced_local.bytes)})`);
    for (const f of report.unreferenced_local.slice(0, 25)) log(`  ${mb(f.size).padStart(11)}  ${f.root}/${f.path}${f.hint ? `  — ${f.hint}` : ''}`);
    for (const [p, x] of Object.entries(t.unreferenced_remote)) log(`Unreferenced ${p} keys: ${x.keys} (${mb(x.bytes)})`);
    for (const k of report.unreferenced_remote.slice(0, 25)) log(`  ${mb(k.size).padStart(11)}  ${k.provider}:${k.key}${k.hint ? `  — ${k.hint}` : ''}`);
    log(`Copies the database records that are not there: ${t.missing.locations}`);
    for (const m of report.missing.slice(0, 25)) log(`  ${m.object_id} ${m.legacy_ref || m.kind} ${m.provider} (recorded ${m.recorded_state})`);
    log(`Open multipart uploads: ${t.multipart_local.open} here (${t.multipart_local.expired} expired)${Object.entries(t.multipart_remote).map(([p, n]) => `, ${n} in ${p}`).join('')}`);
    log(`Expected, not listed: ${t.expected.live_thumbnails} live thumbnail(s), ${t.expected.in_flight} upload(s) in flight`);
    log('');
    log('Nothing was deleted or moved.');
    log(`Report: ${file}`);
    if (JSON_OUT) console.log(JSON.stringify({ ...report, report: file }, null, 2));
}

(async () => {
    if (has('storage')) { await storageReport(); db.close(); process.exit(0); }
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
