#!/usr/bin/env node
'use strict';

/**
 * Run the owner's rotation detector over pictures whose EXIF did not settle the orientation.
 *
 *   node scripts/orientation-detect.js [--batch 50] [--after <med_id>] [--all] [--apply]
 *
 * Dry run by default: it counts the pictures marked "orientation unknown" and spends nothing. --apply asks
 * OpenVibe.AI for each and turns a picture only above the owner's confidence (the detector's own rule) and only
 * when the owner has the feature on. --all walks every batch. It never prints metadata, storage keys or people.
 */

function parseArgs(args) {
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
    const batch = Number(arg('batch', '50'));
    const after = String(arg('after', ''));
    if (!Number.isInteger(batch) || batch < 1 || batch > 500) throw new Error('--batch must be an integer from 1 to 500');
    if (after && !/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(after)) throw new Error('--after must be a Media object id');
    return { batch, after, all: has('all'), apply: has('apply') };
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const STATUSES = ['unknown', 'turned', 'upright', 'below-confidence', 'off', 'unavailable', 'unreadable', 'errors'];

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const dbApi = require('../server/db/database');
    await dbApi.initDb();
    const config = require('../server/config');
    const model = require('../server/objects/model');
    const { createDetector } = require('../server/images/ai-orientation');
    const detector = createDetector({ config, db: dbApi });
    const totals = Object.fromEntries([['scanned', 0], ['found', 0], ...STATUSES.map((s) => [s, 0])]);
    totals.batches = 0;
    let cursor = opts.after;
    let done = false;
    try {
        do {
            const rows = await dbApi.all(`SELECT id, app_id, namespace, kind, mime_type, size_bytes, content_hash, metadata, created_at
                FROM media_objects WHERE lifecycle_status = 'ready' AND lower(mime_type) IN (?, ?, ?) AND id > ?
                ORDER BY id LIMIT ?`, [...IMAGE_TYPES, cursor, opts.batch]);
            totals.batches++;
            for (const row of rows) {
                totals.scanned++;
                cursor = row.id;
                const md = model.parseJson(row.metadata, {});
                if (md.orientation_status !== 'orientation unknown') continue;
                totals.found++;
                if (!opts.apply) continue;
                try {
                    const out = await detector.detect(row, { apply: true });
                    const key = !out.scanned ? (out.reason === 'disabled' ? 'off' : (out.reason === 'budget' ? 'off' : 'unavailable'))
                        : out.status === 'turned' ? 'turned'
                            : out.status === 'upright' ? 'upright'
                                : out.status === 'below_confidence' ? 'below-confidence'
                                    : out.status === 'unreadable' ? 'unreadable' : 'unavailable';
                    totals[key] = (totals[key] || 0) + 1;
                } catch (err) {
                    totals.errors++;
                    console.error(`orientation-detect: ${row.id}: ${String((err && err.message) || err).slice(0, 180)}`);
                }
            }
            done = rows.length < opts.batch;
            if (!opts.all) break;
        } while (!done);
        totals.done = done;
        totals.after = cursor;
        totals.mode = opts.apply ? 'apply' : 'dry-run';
        console.log(JSON.stringify(totals));
        if (totals.errors) process.exitCode = 1;
    } finally {
        await dbApi.close();
    }
}

if (require.main === module) main().catch((err) => { console.error(`orientation-detect: ${err.message}`); process.exitCode = 1; });

module.exports = { parseArgs };
