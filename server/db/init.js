/**
 * OpenVibe.Media — Database Initialization Script
 * Run: npm run init-db
 */
const db = require('./database');

db.getDb();
console.log(`Database initialized at: ${require('../config').db.path}`);
db.close();
process.exit(0);
