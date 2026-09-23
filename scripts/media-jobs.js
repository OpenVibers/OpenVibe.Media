#!/usr/bin/env node
'use strict';
/**
 * Media jobs, for the operator (docs/object-model.md#jobs). Works on the service's database directly;
 * the running service's worker picks up approved jobs on its next poll. When the service's Events
 * outbox is on (the event_outbox table exists), every state change made here queues its
 * media.job.* event there too, in the same transaction, and the service relays it.
 *
 *   node scripts/media-jobs.js list [--status proposed] [--type object.split] [--app live] [--limit 50] [--json]
 *   node scripts/media-jobs.js show <job id> [--json]
 *   node scripts/media-jobs.js scan [--app live] [--apply] [--json]
 *        the size-invariant validator; a dry run unless --apply (which records violations and proposals)
 *   node scripts/media-jobs.js approve <job id>... [--by <who>]       proposed -> queued
 *   node scripts/media-jobs.js cancel <job id>... [--by <who>] [--reason <text>]
 *   (every command takes --db ./data/media.db)
 *
 * Nothing here runs a job. Exit 0 on success, 1 when a named job could not be decided, 2 on usage errors.
 */
const path = require('path');

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const VALUE_FLAGS = ['status', 'type', 'app', 'limit', 'by', 'reason', 'db'];
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(String(args[i - 1]).replace(/^--/, ''))));
if (arg('db')) process.env.DB_PATH = path.resolve(arg('db'));

const db = require('../server/db/database');
const events = require('../server/events');
const queue = require('../server/jobs/queue');
const scan = require('../server/jobs/invariant-scan');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: media-jobs.js list|show|scan|approve|cancel … (see the header of this file)');
    process.exit(2);
}

function line(j) {
    const size = j.params && j.params.source_size_bytes ? ` ${(j.params.source_size_bytes / 1048576).toFixed(0)} MB` : '';
    return `${j.id}  ${j.status.padEnd(9)} ${j.type.padEnd(20)} ${j.app_id.padEnd(8)} ${j.object_id || '-'}${size}${j.error ? `  (${j.error})` : ''}`;
}

(async () => {
    const [cmd, ...ids] = positional;
    const by = arg('by', `operator:${require('os').userInfo().username}`);
    events.initWriter();
    let exit = 0;
    if (cmd === 'list') {
        const apps = arg('app') ? [arg('app')] : db.all('SELECT DISTINCT app_id FROM media_jobs ORDER BY app_id').map(r => r.app_id);
        const out = [];
        for (const a of apps) out.push(...queue.list(a, { status: arg('status'), type: arg('type'), limit: arg('limit', 50) }).jobs.map(queue.jobPublic));
        console.log(has('json') ? JSON.stringify({ jobs: out, counts: queue.counts() }, null, 2) : [...out.map(line), `counts: ${JSON.stringify(queue.counts())}`].join('\n'));
    } else if (cmd === 'show') {
        const j = queue.jobPublic(queue.get(ids[0]));
        if (!j) usage(`no job ${ids[0]}`);
        console.log(JSON.stringify(j, null, 2));
    } else if (cmd === 'scan') {
        const apps = arg('app') ? [arg('app')] : db.all("SELECT DISTINCT app_id FROM media_objects WHERE kind IN ('vod', 'clip') ORDER BY app_id").map(r => r.app_id);
        const reports = {};
        for (const a of apps) reports[a] = scan.scanTenant(a, { dryRun: !has('apply') });
        if (has('json')) console.log(JSON.stringify(reports, null, 2));
        else {
            for (const [a, r] of Object.entries(reports)) {
                console.log(`${a}: ${r.violations} public object(s) over ${(r.thresholds.maxBytes / 1048576).toFixed(0)} MB; ${r.dry_run ? 'would propose' : 'proposed'} ${r.proposed}, already proposed ${r.already_proposed}, ${r.dry_run ? 'would withdraw' : 'withdrawn'} ${r.withdrawn} ${JSON.stringify(r.by_type)}`);
            }
            if (!has('apply')) console.log('(dry run: nothing recorded; --apply records the violations and the proposals)');
        }
    } else if (cmd === 'approve' || cmd === 'cancel') {
        if (!ids.length) usage(`${cmd}: name at least one job`);
        for (const id of ids) {
            const j = queue.get(id);
            if (!j) { console.error(`${id}: no such job`); exit = 1; continue; }
            if (cmd === 'approve') {
                const out = queue.approve(id, { by });
                if (out) console.log(`${id}: queued`); else { console.error(`${id}: is ${j.status}, not a proposal`); exit = 1; }
            } else {
                const out = queue.cancel(id, { by, reason: arg('reason', null) });
                if (out.finished) { console.error(`${id}: already ${out.job.status}`); exit = 1; } else console.log(`${id}: ${out.pending ? 'cancel requested (running)' : 'cancelled'}`);
            }
        }
    } else usage(cmd ? `unknown command ${cmd}` : null);
    db.close();
    process.exit(exit);
})().catch((err) => { console.error(err); process.exit(1); });
