#!/usr/bin/env node
'use strict';
/**
 * Export which media object (med_…) stands behind each legacy reference, for services that still store
 * `legacy:<app>:<kind>:<id>` refs and move to object ids (C-24: OpenVibe.Community's screenshot pastes,
 * scripts/migrate-screenshot-refs.js there).
 *
 *   node scripts/export-legacy-refs.js --prefix legacy:live:paste: --out /tmp/refs.json [--db ./data/media.db]
 *
 * Read-only (opens the database readonly). Output: { generated_at, prefix, count, objects: [{ legacy_ref, id,
 * kind, lifecycle_status }] } ordered by legacy_ref. Deleted objects are included with their status, so the
 * consumer can tell "gone" from "never existed".
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const prefix = arg('prefix');
const out = arg('out');
const dbPath = path.resolve(arg('db', process.env.DB_PATH || './data/media.db'));
if (!prefix || !/^legacy:[a-z0-9_-]+:/.test(prefix) || !out) { console.error('usage: export-legacy-refs.js --prefix legacy:<app>:<kind>: --out <file> [--db path]'); process.exit(2); }

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const objects = db.prepare(`SELECT legacy_ref, id, kind, lifecycle_status FROM media_objects
                            WHERE legacy_ref >= ? AND legacy_ref < ? ORDER BY legacy_ref`).all(prefix, `${prefix}￿`);
fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), prefix, count: objects.length, objects }, null, 1));
console.log(`[export-legacy-refs] ${objects.length} object(s) under ${prefix} → ${out}`);
