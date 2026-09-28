#!/usr/bin/env node
'use strict';
/**
 * Reconcile the object model against the bytes (docs/object-model.md#reconciliation).
 *
 *   node scripts/reconcile-objects.js [--verify] [--hash] [--app live] [--json] [--out report.json]
 *
 * Default: read-only — checks local files and database consistency, writes nothing.
 * --verify  also HEADs every B2/R2 location with the storage engine's S3 client (MEDIA_B2_* / MEDIA_R2_*)
 *           and records the result on media_locations (state, size, verified_at).
 * --hash    sha256 local files of objects that carry a content hash (≤ 512 MB each).
 * Exit code 0 when clean, 1 when issues were found.
 */
const fs = require('fs');
const path = require('path');

(async () => {
    await require('../server/db/database').initDb();   // PostgreSQL (DATABASE_URL), as the service
    { const st = require('../server/vod/vod-storage'); await st.tierConfig.init(st.DEFAULTS, { log: { info() {}, warn: (m) => console.error(`[Tiers] ${m}`), error: (m) => console.error(`[Tiers] ${m}`) } }); }   // the storage policy as configured (quiet: stdout is the report)
    const args = process.argv.slice(2);
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

    const { reconcile, summarize } = require('../server/objects/reconcile');

    (async () => {
        if (has('verify')) await require('../server/vod/vod-storage').checkProviders().catch(() => {});
        const report = await reconcile({ verify: has('verify'), hash: has('hash'), appId: arg('app', null) });
        if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 2));
        console.log(has('json') ? JSON.stringify(report, null, 2) : summarize(report));
        await require('../server/db/database').close();
        process.exit(report.total_issues ? 1 : 0);
    })().catch((err) => { console.error(err); process.exit(2); });
})().catch((err) => { console.error(err); process.exit(1); });
