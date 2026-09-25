#!/usr/bin/env node
'use strict';
/**
 * Object drift report (WS-G task 1, retiring C-75; server/objects/drift.js has the rules): every
 * projected vods/clips/files/pastes row, and each vod/clip thumbnail, whose media_object is missing,
 * not linked, or disagrees with the row on kind, visibility, lifecycle status, size, legacy ref or
 * owner/app. Prints counts per kind and up to --limit examples of each. READ-ONLY: the database is
 * opened read-only and only local files are stat'ed (paths from the service's environment:
 * VOD_PATH, CLIPS_PATH, FILES_PATH, THUMBNAILS_PATH, as the projection uses them).
 *
 *   node scripts/object-drift-report.js [--app live] [--limit 20] [--json] [--out report.json] [--db ./data/media.db]
 *
 * Exit code 0 always: it is a report (an error is printed to stderr). Zero drift across a release
 * is the signal to remove the boot backfill (server/index.js) and the finalize follow-up.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };

try {
    const dbPath = arg('db') ? path.resolve(arg('db')) : require('../server/config').db.path;
    const Database = require('better-sqlite3');
    const h = new Database(dbPath, { readonly: true, fileMustExist: true });
    const q = {
        all: (sql, params = []) => h.prepare(sql).all(...params),
        get: (sql, params = []) => h.prepare(sql).get(...params),
    };
    const { buildReport, formatReport } = require('../server/objects/drift');
    const limit = Math.max(0, parseInt(arg('limit', '20'), 10) || 0);
    const report = buildReport(q, { appId: arg('app', null), limit });
    h.close();
    if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
    console.log(has('json') ? JSON.stringify(report, null, 2) : formatReport(report));
} catch (err) {
    console.error(`object-drift-report: ${err.message}`);
}
process.exit(0);
