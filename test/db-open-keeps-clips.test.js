'use strict';

// Opening the database (what every script and the service do through getDb()) must not touch a
// clip that is being cut: only the server's own boot (vod/clip-jobs.start()) recovers clips a
// restart left 'processing'. A backfill run on the host used to fail the clip being cut under it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-dbopen-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
for (const [k, n] of [['VOD_PATH', 'vods'], ['CLIPS_PATH', 'clips'], ['FILES_PATH', 'files'], ['THUMBNAILS_PATH', 'thumbnails'], ['PASTES_PATH', 'pastes'], ['OBJECTS_PATH', 'objects']]) process.env[k] = dir(n);
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
console.log = () => {};

const Database = require('better-sqlite3');
const db = require('../server/db/database');
db.getDb();
db.run("INSERT INTO clips (id, app_id, vod_id, title, status) VALUES (41, 'live', 1, 'being cut', 'processing')");

// A second process opening the same file (a script on the host) goes through getDb() too.
const other = require('child_process').spawnSync(process.execPath, ['-e', `
    process.env.DB_PATH = ${JSON.stringify(process.env.DB_PATH)};
    ${['VOD_PATH', 'CLIPS_PATH', 'FILES_PATH', 'THUMBNAILS_PATH', 'PASTES_PATH', 'OBJECTS_PATH', 'MEDIA_PUBLIC_URL'].map(k => `process.env.${k} = ${JSON.stringify(process.env[k])};`).join('\n')}
    console.log = () => {};
    require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db', 'database'))}).getDb();
`], { encoding: 'utf8' });
assert.strictEqual(other.status, 0, other.stderr);

const raw = new Database(process.env.DB_PATH, { readonly: true });
assert.strictEqual(raw.prepare('SELECT status FROM clips WHERE id = 41').get().status, 'processing', 'opening the database leaves a clip being cut alone');
raw.close();

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write('db open keeps clips: all checks passed\n');
