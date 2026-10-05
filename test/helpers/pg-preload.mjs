// Loaded with `node --import` into every test process (test/run.js): one migrated database for the process (ADR-035),
// PGlite by default or, with MEDIA_TEST_STORE=pg (npm run test:pg), the PostgreSQL + PgBouncer containers with roles
// and a schema of its own. server/db/database.js getDb() takes it on first use, so test files open no database
// themselves; the process ends with the test (a container schema is dropped by `scripts/test-services.sh down`).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createTestDb } = require('openvibe-sdk/testing');
// openvibe-sdk >= 0.31.1 unrefs createTestDb's lease pg.Client itself (MEDIA_TEST_STORE=pg), so a test file that
// ends without process.exit() exits. On PGlite, openvibe-sdk >= 0.29 reuses a migrated snapshot (OV_TEST_SNAPSHOT=0
// opts out) and loadDataDir starts PGlite's Emscripten alarm — a ref'd setTimeout the wasm runtime keeps
// rescheduling — which holds the event loop open the same way (a pure test, or a harness that exits only on
// failure, would never exit and the per-file runner would time it out). Unref the timers PGlite's own wasm
// schedules; every other timer a test sets stays ref'd.
const realSetTimeout = globalThis.setTimeout, realSetInterval = globalThis.setInterval;
const fromPglite = () => { const s = new Error().stack; return !!s && s.includes('@electric-sql/pglite'); };
globalThis.setTimeout = function (...a) { const h = realSetTimeout.apply(this, a); if (fromPglite()) { try { h.unref?.(); } catch { /* already gone */ } } return h; };
globalThis.setInterval = function (...a) { const h = realSetInterval.apply(this, a); if (fromPglite()) { try { h.unref?.(); } catch { /* already gone */ } } return h; };
// A ref'd keep-alive while the snapshot loads/builds: an unref'd setup timer must still fire.
const keepAlive = realSetInterval(() => {}, 1000);
const t = await createTestDb({ migrations: path.join(root, 'migrations'), store: process.env.MEDIA_TEST_STORE || 'pglite', service: 'media', max: 4 });
clearInterval(keepAlive);
// Tests insert rows with small explicit ids. A PostgreSQL identity would continue after them, so generated ids
// are set to start at 100000 here, clear of every id a test names.
for (const r of await t.db.prepare(`SELECT pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq FROM information_schema.columns
                                    WHERE table_schema = current_schema() AND is_identity = 'YES'`).all()) {
    if (r.seq) await t.db.prepare('SELECT setval(?::regclass, 100000)').get(r.seq);
}
globalThis.__ovMediaTestDb = t.db;
globalThis.__ovMediaTestDbClose = t.close;
