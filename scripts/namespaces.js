#!/usr/bin/env node
'use strict';
/**
 * Namespaces for the operator (roadmap WS-G task 2; server/objects/namespaces.js). Lists every
 * namespace with its owner, quota and usage, and sets a namespace's quotas and policy.
 *
 *   node scripts/namespaces.js [--app <tenant>] [--json]            list (usage counted from the rows now)
 *   node scripts/namespaces.js --set <namespace> [--quota-bytes <n>|inherit] [--quota-objects <n>|none]
 *                              [--policy '<json>'] [--dry-run]
 *
 * --quota-bytes: 0 is no limit; `inherit` clears it (a root then takes its tenant's apps.quota_bytes,
 * a child has none of its own). --quota-objects: 0 or `none` is no limit. --policy replaces the
 * namespace's own policy (kinds, visibilities, max_object_bytes, strict_verbs; children inherit it,
 * key by key). Listing refreshes the usage snapshot; nothing else is written without --set.
 */
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] != null && !args[i + 1].startsWith('--') ? args[i + 1] : dflt; };

function fail(msg) { console.error(`namespaces: ${msg}`); process.exit(1); }
const human = (b) => (b == null ? '-' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${b} B`);

try {
    const db = require('../server/db/database');
    const namespaces = require('../server/objects/namespaces');

    if (arg('set')) {
        const row = namespaces.get(arg('set'));
        if (!row) fail(`no namespace ${arg('set')}`);
        const sets = {};
        if (arg('quota-bytes') != null) {
            const v = arg('quota-bytes');
            if (v === 'inherit') sets.quota_bytes = null;
            else if (/^\d+$/.test(v)) sets.quota_bytes = Number(v);
            else fail('--quota-bytes takes a whole number of bytes or `inherit`');
        }
        if (arg('quota-objects') != null) {
            const v = arg('quota-objects');
            if (v === 'none') sets.quota_objects = null;
            else if (/^\d+$/.test(v)) sets.quota_objects = Number(v) || null;
            else fail('--quota-objects takes a whole number or `none`');
        }
        if (arg('policy') != null) {
            let p;
            try { p = JSON.parse(arg('policy')); } catch { fail('--policy must be JSON'); }
            const v = namespaces.validatePolicy(p);
            if (v.error) fail(v.error);
            sets.policy = JSON.stringify(v.policy);
        }
        if (!Object.keys(sets).length) fail('--set needs --quota-bytes, --quota-objects or --policy');
        console.log(`${row.namespace}: ${Object.entries(sets).map(([k, v]) => `${k} ${row[k] ?? 'NULL'} -> ${v ?? 'NULL'}`).join(', ')}${has('dry-run') ? ' (dry run)' : ''}`);
        if (!has('dry-run')) {
            db.run(`UPDATE media_namespaces SET ${Object.keys(sets).map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE namespace = ?`, [...Object.values(sets), row.namespace]);
        }
        process.exit(0);
    }

    const rows = arg('app') ? namespaces.listForTenant(arg('app')) : db.all('SELECT * FROM media_namespaces ORDER BY app_id, namespace');
    const apps = new Map();
    const out = rows.map((row) => {
        if (!apps.has(row.app_id)) apps.set(row.app_id, db.getApp(row.app_id) || { app_id: row.app_id });
        const app = apps.get(row.app_id);
        return { app_id: row.app_id, ...namespaces.publicShape(app, row, namespaces.reconcile(app, row.namespace)) };
    });
    if (has('json')) { console.log(JSON.stringify({ namespaces: out }, null, 2)); process.exit(0); }
    for (const n of out) {
        const u = n.usage;
        console.log(`${n.namespace}  [${n.app_id}${n.root ? ', root' : ''}] ${n.owner}`
            + `  used ${human(u.used_bytes)} / ${n.quota.bytes ? human(n.quota.bytes) : 'no limit'}${n.quota.bytes_from === 'tenant' ? ' (tenant)' : ''}`
            + `, ${u.used_objects} object(s)${n.quota.objects ? ` / ${n.quota.objects}` : ''}`
            + (u.reserved_objects ? `, ${u.reserved_objects} upload(s) reserving ${human(u.reserved_bytes)}` : '')
            + (Object.keys(n.policy).length ? `  policy ${JSON.stringify(n.policy)}` : ''));
    }
    if (!out.length) console.log('no namespaces');
} catch (err) {
    fail(err.message);
}
