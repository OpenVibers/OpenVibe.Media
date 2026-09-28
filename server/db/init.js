/**
 * OpenVibe.Media — Database Initialization Script: applies migrations/ (DATABASE_URL / DATABASE_DIRECT_URL, or the
 * embedded development PGlite database).
 * Run: npm run init-db
 */
const db = require('./database');

(async () => {
    await db.initDb();
    console.log('Database migrated.');
    await db.close();
    process.exit(0);
})().catch((err) => { console.error(`init-db failed: ${err.message}`); process.exit(1); });
