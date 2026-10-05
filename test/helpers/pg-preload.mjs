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
// openvibe-sdk >= 0.26 createTestDb holds a lease pg.Client (application_name *-test-lease) whose socket is not unref'd,
// so a test file that ends without process.exit() never exits. Unref it here; the lease still holds while the process lives.
// Drop this once Media pins openvibe-sdk >= 0.31.1, which unrefs the lease itself.
const pg = require(require.resolve('pg', { paths: [require.resolve('openvibe-sdk/testing')] }));
const connect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
    const r = connect.apply(this, args);
    if (String(this.connectionParameters && this.connectionParameters.application_name).endsWith('-test-lease')) this.connection.stream.unref();
    return r;
};
const t = await createTestDb({ migrations: path.join(root, 'migrations'), store: process.env.MEDIA_TEST_STORE || 'pglite', service: 'media', max: 4 });
// Tests insert rows with small explicit ids. A PostgreSQL identity would continue after them, so generated ids
// are set to start at 100000 here, clear of every id a test names.
for (const r of await t.db.prepare(`SELECT pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq FROM information_schema.columns
                                    WHERE table_schema = current_schema() AND is_identity = 'YES'`).all()) {
    if (r.seq) await t.db.prepare('SELECT setval(?::regclass, 100000)').get(r.seq);
}
globalThis.__ovMediaTestDb = t.db;
globalThis.__ovMediaTestDbClose = t.close;
