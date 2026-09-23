#!/usr/bin/env node
'use strict';
/**
 * Give every media_object that names an app-local owner (owner_app + owner_user_id) its owner's
 * canonical Network subject (owner_subject, usr_<ULID>), resolved through Network's
 * POST /internal/identity/resolve-batch (docs/object-model.md#owner-subjects). Once this has run,
 * the service's reconcile job (server/objects/owner-subject-job.js) keeps new objects filled.
 *
 *   node scripts/backfill-owner-subject.js [--db media.db] [--batch 500] [--json]
 *       Dry run (the default): asks Network, changes nothing, and prints per tenant the objects
 *       to fill, already set, unresolvable (Network does not know the owner), with no owner, and
 *       those of tenants whose user ids it has no source system for.
 *   node scripts/backfill-owner-subject.js --apply --backup <file.json> [--db media.db] [--batch 500]
 *       First takes an online backup of the database to <file>.media.db and checks it with
 *       PRAGMA integrity_check, then writes <file.json> (every row it is about to change, for
 *       --rollback). Only then fills owner_subject, <batch> rows per transaction, never over a
 *       non-null value and only while the row still has the owner it was resolved for.
 *       Refuses to overwrite either backup file. Re-running fills only what is still missing.
 *   node scripts/backfill-owner-subject.js --rollback <file.json> [--apply] [--db media.db]
 *       Clears owner_subject again on the rows the file lists that still carry exactly the subject
 *       the backfill wrote (rows changed since are left alone and counted). Without --apply it only
 *       reports what it would restore, which also verifies an applied backfill.
 *       Turn the service's reconcile job off first (MEDIA_OWNER_SUBJECT_SYNC=0 and a restart), or
 *       its next run fills the rows again.
 *
 * Network: OV_NETWORK_INTERNAL_URL (default http://127.0.0.1:4000), with a service token
 * (OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET, capability identity.subject.resolve) or else
 * INTERNAL_API_KEY: the names /etc/openvibe/media.env already uses. The database is DB_PATH.
 *
 * The database is opened directly (read-only for a dry run), not through server/db/database.js,
 * whose boot work (migrations, marking in-progress clip cuts failed) must stay with the service.
 * Exit codes: 0 done, 1 error, 2 bad usage.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const usage = (msg) => { console.error(`backfill-owner-subject: ${msg}`); process.exit(2); };

for (const flag of ['db', 'backup', 'rollback', 'batch']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
if (arg('db')) process.env.DB_PATH = path.resolve(arg('db'));

const Database = require('better-sqlite3');
const config = require('../server/config');
const ownerSubject = require('../server/objects/owner-subject');

const APPLY = has('apply');
const JSON_OUT = has('json');
const BATCH = arg('batch') ? Number(arg('batch')) : ownerSubject.DEFAULT_BATCH;
if (!Number.isInteger(BATCH) || BATCH < 1 || BATCH > 5000) usage('--batch must be an integer 1-5000');
const DB_PATH = config.db.path;
const ROLLBACK = arg('rollback') ? path.resolve(arg('rollback')) : null;
const BACKUP = arg('backup') ? path.resolve(arg('backup')) : null;
if (ROLLBACK && BACKUP) usage('--rollback and --backup do not go together');
if (APPLY && !ROLLBACK && !BACKUP) usage('--apply needs --backup <file.json> (the rollback file; the database copy goes next to it)');
if (!fs.existsSync(DB_PATH)) usage(`no database at ${DB_PATH} (set DB_PATH or pass --db)`);

const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function open({ readonly }) {
    const sqlite = new Database(DB_PATH, { readonly, fileMustExist: true });
    sqlite.pragma('busy_timeout = 15000');
    return sqlite;
}

function writePrivate(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
}

function dbCopyPath(file) {
    return file.replace(/\.json$/i, '') + '.media.db';
}

/** Online backup (better-sqlite3's page-by-page copy; the service keeps writing), then integrity_check. */
async function backupDatabase(sqlite, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    await sqlite.backup(dest);
    fs.chmodSync(dest, 0o600);
    const copy = new Database(dest, { readonly: true, fileMustExist: true });
    try {
        const check = copy.pragma('integrity_check', { simple: true });
        const objects = copy.prepare('SELECT count(*) AS n FROM media_objects').get().n;
        return { path: dest, bytes: fs.statSync(dest).size, integrity_check: check, objects };
    } finally { copy.close(); }
}

function printSummary(before, plan) {
    const apps = [...new Set([...Object.keys(before), ...Object.keys(plan.perApp)])].sort();
    log(`Database: ${DB_PATH}`);
    log(`Network:  ${config.network.internalUrl} (asked via ${plan.via || 'nothing: no owner to resolve'})`);
    log('');
    log('app                                      objects  already set  to fill  unresolvable  unsupported app  no owner');
    for (const app of apps) {
        const b = before[app] || { objects: 0, already_set: 0, no_owner: 0 };
        const p = plan.perApp[app] || { to_fill: 0, unresolvable: 0, unsupported: 0 };
        log(`${app.padEnd(40)} ${String(b.objects).padStart(7)}  ${String(b.already_set).padStart(11)}  ${String(p.to_fill).padStart(7)}  ${String(p.unresolvable).padStart(12)}  ${String(p.unsupported).padStart(15)}  ${String(b.no_owner).padStart(8)}`);
    }
    const t = plan.totals;
    log(`${'total'.padEnd(40)} ${String(t.objects).padStart(7)}  ${String(t.already_set).padStart(11)}  ${String(t.to_fill).padStart(7)}  ${String(t.unresolvable).padStart(12)}  ${String(t.unsupported).padStart(15)}  ${String(t.no_owner).padStart(8)}`);
    if (plan.unresolvableOwners.length) {
        log('');
        log(`Unresolvable owners (Network has no subject for them; their objects stay NULL): ${plan.unresolvableOwners.map(o => `${o.owner_app}:${o.owner_user_id} (${o.objects})`).join(', ')}`);
    }
    if (plan.unsupportedOwners.length) {
        log(`Owners in tenants with no known source system (left alone): ${plan.unsupportedOwners.map(o => `${o.owner_app}:${o.owner_user_id} (${o.objects})`).join(', ')}`);
    }
}

async function makePlan(sqlite) {
    const before = ownerSubject.summary(sqlite);
    const owners = ownerSubject.pendingOwners(sqlite);
    const resolver = ownerSubject.createResolver();
    const r = owners.length ? await ownerSubject.resolveOwners(owners, { resolver }) : { subjects: new Map(), unresolvable: [], unsupported: [] };
    const changes = ownerSubject.planChanges(sqlite, r.subjects, { batch: BATCH });
    const perApp = {};
    const bump = (app, k, n) => { perApp[app] = perApp[app] || { to_fill: 0, unresolvable: 0, unsupported: 0 }; perApp[app][k] += n; };
    for (const c of changes) bump(c.app_id, 'to_fill', 1);
    // Per tenant of the object (owner_app is the same as app_id for every object Media makes today).
    const countBy = (list) => {
        const m = new Map();
        for (const o of list) {
            for (const row of sqlite.prepare(`SELECT app_id, count(*) AS n FROM media_objects WHERE owner_subject IS NULL
                                              AND COALESCE(owner_app, app_id) = ? AND owner_user_id = ? GROUP BY app_id`).all(o.owner_app, o.owner_user_id)) {
                m.set(row.app_id, (m.get(row.app_id) || 0) + row.n);
            }
        }
        return m;
    };
    for (const [app, n] of countBy(r.unresolvable)) bump(app, 'unresolvable', n);
    for (const [app, n] of countBy(r.unsupported)) bump(app, 'unsupported', n);
    const totals = { objects: 0, already_set: 0, no_owner: 0, to_fill: changes.length, unresolvable: 0, unsupported: 0 };
    for (const b of Object.values(before)) { totals.objects += b.objects; totals.already_set += b.already_set; totals.no_owner += b.no_owner; }
    for (const p of Object.values(perApp)) { totals.unresolvable += p.unresolvable; totals.unsupported += p.unsupported; }
    return { before, perApp, totals, changes, unresolvableOwners: r.unresolvable, unsupportedOwners: r.unsupported, via: resolver.state.via, network_calls: resolver.state.calls, token_error: resolver.state.token_error };
}

async function backfill() {
    const sqlite = open({ readonly: !APPLY });
    try {
        const plan = await makePlan(sqlite);
        printSummary(plan.before, plan);
        if (plan.token_error && plan.via === 'internal-key') log(`(no service token: ${plan.token_error}; used INTERNAL_API_KEY)`);
        const report = { mode: APPLY ? 'apply' : 'dry-run', db: DB_PATH, network: config.network.internalUrl, via: plan.via, before: plan.before, per_app: plan.perApp, totals: plan.totals,
            unresolvable_owners: plan.unresolvableOwners, unsupported_owners: plan.unsupportedOwners };
        if (!APPLY) {
            log('');
            log('Dry run: nothing was changed. Re-run with --apply --backup <file.json> to fill.');
            if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
            return 0;
        }
        if (!plan.changes.length) {
            log('');
            log('Nothing to fill; no backup taken, nothing changed.');
            if (JSON_OUT) console.log(JSON.stringify({ ...report, applied: 0 }, null, 2));
            return 0;
        }

        const copyPath = dbCopyPath(BACKUP);
        for (const f of [BACKUP, copyPath]) if (fs.existsSync(f)) usage(`${f} already exists; pick a new --backup name`);
        log('');
        log(`Backing up ${DB_PATH} -> ${copyPath} ...`);
        const copy = await backupDatabase(sqlite, copyPath);
        if (copy.integrity_check !== 'ok') { console.error(`backup failed integrity_check: ${copy.integrity_check}; nothing changed`); return 1; }
        log(`  ${copy.bytes} bytes, integrity_check ok, ${copy.objects} objects`);
        const manifest = {
            kind: 'media.owner_subject.backfill', version: 1, created_at: new Date().toISOString(), db: DB_PATH, db_backup: copy.path,
            status: 'planned', rows: plan.changes.map(c => ({ id: c.id, app_id: c.app_id, owner_app: c.owner_app, owner_user_id: c.owner_user_id, owner_subject: c.owner_subject })),
        };
        writePrivate(BACKUP, JSON.stringify(manifest, null, 1));
        log(`Rollback file: ${BACKUP} (${manifest.rows.length} rows)`);

        const done = ownerSubject.applyChanges(sqlite, plan.changes, {
            batch: BATCH,
            onBatch: (b) => log(`  batch ${b.batch}: ${b.rows} rows (filled ${b.applied} so far, ${b.skipped} changed underneath)`),
        });
        // The file now lists exactly the rows this run changed.
        writePrivate(BACKUP, JSON.stringify({ ...manifest, status: 'applied', applied_at: new Date().toISOString(), batches: done.batches,
            skipped: done.skipped.map(c => c.id), rows: done.applied }, null, 1));
        const after = ownerSubject.summary(sqlite);
        log('');
        log(`Filled owner_subject on ${done.applied.length} object(s) in ${done.batches} batch(es); ${done.skipped.length} skipped (changed while running).`);
        log(`Now: ${Object.entries(after).map(([app, s]) => `${app} ${s.already_set}/${s.objects} set, ${s.missing} missing`).join('; ')}`);
        if (JSON_OUT) console.log(JSON.stringify({ ...report, applied: done.applied.length, skipped: done.skipped.length, batches: done.batches, after, rollback_file: BACKUP, db_backup: copy }, null, 2));
        return 0;
    } finally { sqlite.close(); }
}

function rollback() {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8')); } catch (err) { usage(`cannot read ${ROLLBACK}: ${err.message}`); }
    if (!manifest || manifest.kind !== 'media.owner_subject.backfill' || !Array.isArray(manifest.rows)) usage(`${ROLLBACK} is not an owner_subject backfill file`);
    const sqlite = open({ readonly: !APPLY });
    try {
        const r = ownerSubject.rollbackChanges(sqlite, manifest.rows, { apply: APPLY, batch: BATCH });
        log(`Database: ${DB_PATH}`);
        log(`Rollback file: ${ROLLBACK} (${manifest.status}, ${manifest.rows.length} rows, written ${manifest.applied_at || manifest.created_at})`);
        log(`${APPLY ? 'Restored' : 'Would restore'} ${r.restored} (owner_subject back to NULL); ${r.changed_since} changed since (left alone); ${r.missing} no longer exist.`);
        if (!APPLY) log('Nothing was changed. Re-run with --apply to restore.');
        if (JSON_OUT) console.log(JSON.stringify({ mode: APPLY ? 'rollback' : 'rollback-dry-run', restored: r.restored, changed_since: r.changed_since, missing: r.missing, changed_since_ids: r.rows.changed_since, missing_ids: r.rows.missing }, null, 2));
        return 0;
    } finally { sqlite.close(); }
}

(ROLLBACK ? Promise.resolve().then(rollback) : backfill())
    .then((code) => process.exit(code))
    .catch((err) => { console.error(`backfill-owner-subject: ${err.message}`); process.exit(1); });
