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
 * Retire one or more of those objects instead (scripts/no-good-copy-report.js --retire):
 *
 *   node scripts/no-good-copy-report.js --retire <med_id> [--retire <med_id> ...] [--apply]
 *
 * The dry run (no --apply) prints what it would do and changes nothing. Only an object that is in the
 * report, not public and under 1 MiB is retired, through the ordinary soft delete (bytes kept for the
 * retention period, media.object.deleted queued, restorable) with its v1 VOD/clip row hidden. Anything
 * else is refused with the reason and nothing is changed.
 *
 * Exit code: 0 when the report found none (or every named object can be / was retired), 1 when the
 * report found some (or one named object was refused), 2 on error.
 */
const fs = require('fs');

(async () => {
    await require('../server/db/database').initDb();   // PostgreSQL (DATABASE_URL), as the service
    const args = process.argv.slice(2);
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
    const retireIds = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--retire') continue;
        const value = args[i + 1];
        if (!value || value.startsWith('--')) { retireIds.push(''); continue; }
        retireIds.push(...String(value).split(','));
    }

    try {
        // ── Retire named objects (the one write path of this script) ──
        if (retireIds.length) {
            const { assess, describe, retire } = require('../server/objects/retire');
            const ids = [...new Set(retireIds.map((s) => s.trim()).filter(Boolean))];
            if (!ids.length) {
                console.error('--retire needs one or more med_… object ids');
                process.exit(2);
            }
            const plans = [];
            for (const id of ids) plans.push(await assess(id));
            const refused = plans.filter((p) => !p.ok);
            if (refused.length) {
                for (const p of refused) console.log(`${p.id} — refused: ${p.reason}`);
                console.log('Nothing was changed.');
                process.exit(1);
            }
            if (!has('apply')) {
                for (const p of plans) console.log(`${describe(p)}\n  dry run: nothing was changed; re-run with --apply to retire it\n`);
                process.exit(0);
            }
            const done = await retire(plans);
            for (const d of done) {
                console.log(`${d.id}  retired: ${d.lifecycle_status}; retention until ${d.retention_until || `the end of the ${require('../server/config').objects.retentionDays}-day period`}; restorable`);
            }
            process.exit(0);
        }
        if (has('apply')) {
            console.error('--apply only goes with --retire <med_id>');
            process.exit(2);
        }

        // ── Report (read-only: the report runs in a READ ONLY transaction, PostgreSQL refuses any write) ──
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
