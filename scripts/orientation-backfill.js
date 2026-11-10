#!/usr/bin/env node
'use strict';

/**
 * Repair stored image orientation and mark images whose source carries no orientation data.
 *
 *   node scripts/orientation-backfill.js [--batch 50] [--after <med_id>] [--before 'YYYY-MM-DD HH:MM:SS'] [--all] [--apply]
 *
 * Dry run by default. --all walks every batch; --apply persists one batch, or all batches with --all.
 * It never calls an AI provider and never prints object metadata or storage URLs.
 */

function parseArgs(args) {
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
    const batch = Number(arg('batch', '50'));
    const after = String(arg('after', ''));
    const before = String(arg('before', require('../server/objects/orientation-backfill').CUTOVER));
    if (!Number.isInteger(batch) || batch < 1 || batch > 200) throw new Error('--batch must be an integer from 1 to 200');
    if (after && !/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(after)) throw new Error('--after must be a Media object id');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(before)) throw new Error('--before must be YYYY-MM-DD HH:MM:SS');
    return { batch, after, before, all: has('all'), apply: has('apply') };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const dbApi = require('../server/db/database');
    await dbApi.initDb();
    const db = {
        all: dbApi.all,
        run: dbApi.run,
        getApp: dbApi.getApp,
    };
    const { runBatch } = require('../server/objects/orientation-backfill');
    const variants = require('../server/thumbnails/variants').createVariants({
        dir: require('../server/config').thumbnails.variants.objectsPath,
        maxBytes: require('../server/config').thumbnails.variants.maxBytes,
        concurrency: 1,
    });
    const totals = { scanned: 0, already_classified: 0, normalize: 0, orientation_unknown: 0, no_exif: 0, unsupported: 0, unreadable: 0, changed: 0, variant_errors: 0, errors: 0, batches: 0, after: opts.after, before: opts.before };
    let cursor = opts.after;
    let done = false;
    try {
        do {
            const result = await runBatch({ db, after: cursor, batch: opts.batch, apply: opts.apply, before: opts.before, variants });
            for (const key of ['scanned', 'already_classified', 'normalize', 'orientation_unknown', 'no_exif', 'unsupported', 'unreadable', 'changed', 'variant_errors', 'errors']) totals[key] += result[key];
            totals.batches++;
            cursor = result.next_after;
            totals.after = cursor;
            done = result.done;
            if (!opts.all || result.done) break;
        } while (true);
        totals.done = done;
        totals.mode = opts.apply ? 'apply' : 'dry-run';
        console.log(JSON.stringify(totals));
        if (totals.errors) process.exitCode = 1;
    } finally {
        await dbApi.close();
    }
}

if (require.main === module) main().catch((err) => { console.error(`orientation-backfill: ${err.message}`); process.exitCode = 1; });

module.exports = { parseArgs };
