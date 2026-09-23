#!/usr/bin/env node
'use strict';
/**
 * List every ready object that has no good copy anywhere (docs/object-model.md#scheduled-verification),
 * with its owner, the rows that reference it, its locations and their verified states, so an operator
 * can decide what to do with each one. READ-ONLY: the database is opened read-only and nothing is
 * deleted, moved or re-projected.
 *
 *   node scripts/no-good-copy-report.js [--app live] [--json] [--out report.json] [--db ./data/media.db]
 *
 * Exit code 0 when there are none, 1 when some were found, 2 on error.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

try {
    const dbPath = arg('db') ? path.resolve(arg('db')) : require('../server/config').db.path;
    const Database = require('better-sqlite3');
    const h = new Database(dbPath, { readonly: true, fileMustExist: true });
    const q = {
        all: (sql, params = []) => h.prepare(sql).all(...params),
        get: (sql, params = []) => h.prepare(sql).get(...params),
    };
    const { buildReport, formatReport } = require('../server/objects/copy-report');
    const report = buildReport(q, { appId: arg('app', null) });
    h.close();
    if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
    console.log(has('json') ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exit(report.count ? 1 : 0);
} catch (err) {
    console.error(err.message);
    process.exit(2);
}
