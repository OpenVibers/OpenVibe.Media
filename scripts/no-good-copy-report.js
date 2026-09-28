#!/usr/bin/env node
'use strict';
/**
 * List every ready object that has no good copy anywhere (docs/object-model.md#scheduled-verification),
 * with its owner, the rows that reference it, its locations and their verified states, so an operator
 * can decide what to do with each one. READ-ONLY: the database is opened read-only and nothing is
 * deleted, moved or re-projected.
 *
 *   node scripts/no-good-copy-report.js [--app live] [--json] [--out report.json]
 *
 * Exit code 0 when there are none, 1 when some were found, 2 on error.
 */
const fs = require('fs');
const path = require('path');

(async () => {
    await require('../server/db/database').initDb();   // PostgreSQL (DATABASE_URL), as the service
    const args = process.argv.slice(2);
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

    try {
        // Read-only: the report runs in a READ ONLY transaction (PostgreSQL refuses any write inside it).
        const { buildReport, formatReport } = require('../server/objects/copy-report');
        const d = require('../server/db/database').getDb();
        const q = {
            all: async (sql, params = []) => await d.prepare(sql).all(...params),
            get: async (sql, params = []) => await d.prepare(sql).get(...params),
        };
        const report = await d.tx(async (t) => {
            await t.query('SET TRANSACTION READ ONLY');
            return await buildReport(q, { appId: arg('app', null) });
        });
        if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
        console.log(has('json') ? JSON.stringify(report, null, 2) : formatReport(report));
        process.exit(report.count ? 1 : 0);
    } catch (err) {
        console.error(err.message);
        process.exit(2);
    }
})().catch((err) => { console.error(err); process.exit(1); });
