#!/usr/bin/env node
'use strict';
/**
 * VOD duration reconciliation, for the operator (server/vod/duration-reconcile.js has the rules; the
 * service runs the same thing as the job vod.duration.reconcile).
 *
 *   node scripts/vod-duration-reconcile.js [--app live] [--batch 50] [--after <vod id>] [--all] [--ids 1,2,3]
 *                                          [--confirm-remote] [--out <report.json>] [--json]
 *       Dry run (the default): measures each finished VOD (local file, or the B2/R2 copy with ffprobe
 *       over a presigned URL, ranged reads), classifies it (ok, mismatch, wrong, missing, unmeasurable,
 *       skipped) and writes the report (default <data>/reports/duration-reconcile-…json). Changes
 *       nothing. One batch from --after (default 0); --all walks every batch to the end.
 *       Values that would be repaired are confirmed first (local: a stream-copy pass over the
 *       packets; remote: the container must agree with its streams, or --confirm-remote reads the
 *       whole copy, which is B2/R2 egress).
 *   node scripts/vod-duration-reconcile.js --apply --backup <file.json> [same selection]
 *       First an online backup of the database to <file>.media.db (checked with integrity_check),
 *       then repairs the confirmed wrong/missing values (only rows still holding the value read);
 *       <file.json> is the report, which lists every repair with its old values (the rollback file).
 *       Refuses to overwrite either file.
 *   node scripts/vod-duration-reconcile.js --rollback <file.json> [--apply]
 *       Restores the old values of the repairs the file lists, where the row still holds what the
 *       repair wrote. Without --apply it only reports what it would restore.
 *   (every command takes --db <media.db>; the database is DB_PATH otherwise)
 *
 * B2/R2 credentials come from the environment (the service's /etc/openvibe/media.env names).
 * Exit codes: 0 done, 1 error, 2 bad usage.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const usage = (msg) => { console.error(`vod-duration-reconcile: ${msg}`); process.exit(2); };
for (const flag of ['db', 'backup', 'rollback', 'batch', 'after', 'ids', 'app', 'out']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
if (arg('db')) process.env.DB_PATH = path.resolve(arg('db'));

const APPLY = has('apply');
const JSON_OUT = has('json');
const BACKUP = arg('backup') ? path.resolve(arg('backup')) : null;
const ROLLBACK = arg('rollback') ? path.resolve(arg('rollback')) : null;
const BATCH = arg('batch') ? Number(arg('batch')) : 50;
const AFTER = arg('after') ? Number(arg('after')) : 0;
const IDS = arg('ids') ? arg('ids').split(',').map(Number) : null;
if (!Number.isInteger(BATCH) || BATCH < 1 || BATCH > 200) usage('--batch must be an integer 1-200');
if (!Number.isInteger(AFTER) || AFTER < 0) usage('--after must be a vod id');
if (IDS && IDS.some(n => !Number.isInteger(n) || n < 1)) usage('--ids must be a comma list of vod ids');
if (ROLLBACK && BACKUP) usage('--rollback and --backup do not go together');
if (APPLY && !ROLLBACK && !BACKUP) usage('--apply needs --backup <file.json> (the rollback file; the database copy goes next to it)');

const config = require('../server/config');
if (!fs.existsSync(config.db.path)) usage(`no database at ${config.db.path} (set DB_PATH or pass --db)`);
const db = require('../server/db/database');
const reconcile = require('../server/vod/duration-reconcile');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function writePrivate(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
}

async function backupDatabase(dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    await db.getDb().backup(dest);
    fs.chmodSync(dest, 0o600);
    const Database = require('better-sqlite3');
    const copy = new Database(dest, { readonly: true, fileMustExist: true });
    try { return { path: dest, bytes: fs.statSync(dest).size, integrity_check: copy.pragma('integrity_check', { simple: true }), vods: copy.prepare('SELECT count(*) AS n FROM vods').get().n }; } finally { copy.close(); }
}

const fmt = (s) => (s == null ? '-' : `${Math.round(s)}s`);
function printRow(r) {
    if (r.verdict === 'ok') return;
    log(`  vod ${String(r.vod_id).padStart(6)}  ${String(r.where || '-').padEnd(5)} stored ${fmt(r.stored).padStart(8)} (${r.stored_source || '?'})  measured ${fmt(r.measured).padStart(8)} (${r.measured_source || '-'})  ${r.verdict.padEnd(12)} ${r.action}${r.note ? `  [${r.note}]` : ''}`);
}

async function main() {
    if (ROLLBACK) {
        let rep;
        try { rep = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8')); } catch (err) { usage(`cannot read ${ROLLBACK}: ${err.message}`); }
        if (!rep || rep.kind !== 'media.vod.duration_reconcile' || !Array.isArray(rep.rows)) usage(`${ROLLBACK} is not a duration reconcile report`);
        const out = reconcile.rollback(rep.rows, { apply: APPLY });
        log(APPLY ? `Restored ${out.restored} VOD duration(s); ${out.changed_since} changed since (left alone).`
            : `Would restore ${out.would_restore} VOD duration(s); ${out.changed_since} changed since. Re-run with --apply to restore.`);
        if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
        return 0;
    }
    let dbCopy = null;
    if (APPLY) {
        const copyPath = BACKUP.replace(/\.json$/i, '') + '.media.db';
        for (const f of [BACKUP, copyPath]) if (fs.existsSync(f)) usage(`${f} already exists; pick a new --backup name`);
        log(`Backing up ${config.db.path} -> ${copyPath} ...`);
        dbCopy = await backupDatabase(copyPath);
        if (dbCopy.integrity_check !== 'ok') { console.error(`backup failed integrity_check: ${dbCopy.integrity_check}; nothing changed`); return 1; }
        log(`  ${dbCopy.bytes} bytes, integrity_check ok, ${dbCopy.vods} vods`);
    }
    const all = { kind: 'media.vod.duration_reconcile', version: 1, run_at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', app_id: arg('app') || null,
        thresholds: reconcile.THRESHOLDS, confirm_remote: has('confirm-remote'), batches: 0, range: { after_id: IDS ? null : AFTER, last_id: null, done: false }, counts: null, rows: [], db_backup: dbCopy };
    let after = AFTER;
    log(`${APPLY ? 'Reconciling' : 'Dry run over'} VOD durations in ${config.db.path}${all.app_id ? ` (app ${all.app_id})` : ''}${IDS ? `, vods ${IDS.join(',')}` : `, from vod id > ${AFTER}, batches of ${BATCH}`}${has('all') ? ', every batch' : ''}`);
    for (;;) {
        const rep = await reconcile.reconcileBatch({ appId: all.app_id, afterId: after, limit: IDS ? Math.min(200, IDS.length) : BATCH, ids: IDS, apply: APPLY, confirmRemote: has('confirm-remote'), onRow: printRow });
        all.batches++;
        all.rows.push(...rep.rows);
        if (!all.counts) all.counts = { ...rep.counts };
        else for (const k of Object.keys(rep.counts)) all.counts[k] += rep.counts[k];
        all.range.last_id = rep.range.last_id ?? all.range.last_id;
        all.range.done = rep.range.done;
        if (APPLY) writePrivate(BACKUP, JSON.stringify(all, null, 1));       // the rollback file is current after every batch
        if (IDS || rep.range.done || !has('all')) break;
        after = rep.range.last_id;
    }
    const file = APPLY ? BACKUP : (arg('out') ? path.resolve(arg('out')) : null);
    const written = APPLY ? file : reconcile.writeReport(all, file);
    const c = all.counts;
    log('');
    log(`Checked ${c.checked} (${c.remote} remote): ok ${c.ok}, mismatch ${c.mismatch}, wrong ${c.wrong}, missing ${c.missing}, unmeasurable ${c.unmeasurable}, skipped ${c.skipped}.`);
    log(APPLY ? `Repaired ${c.repaired}; ${c.unconfirmed} unconfirmed (not written); ${c.changed_since} changed while running.`
        : `Would repair ${c.would_repair}; ${c.unconfirmed} unconfirmed (would not be written). Nothing changed.`);
    if (!all.range.done && !IDS) log(`More to check: next run --after ${all.range.last_id} (or --all).`);
    log(`Report: ${written}`);
    if (JSON_OUT) console.log(JSON.stringify({ ...all, rows: undefined, report: written }, null, 2));
    return 0;
}

main().then((code) => { db.close(); process.exit(code); }).catch((err) => { console.error(err); process.exit(1); });
