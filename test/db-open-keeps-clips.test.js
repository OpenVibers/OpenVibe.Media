'use strict';

// Opening the database (what every script and the service do through getDb()) must not touch a
// clip that is being cut: only the server's own boot (vod/clip-jobs.start()) recovers clips a
// restart left 'processing'. A backfill run on the host used to fail the clip being cut under it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-dbopen-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.DB_PATH = path.join(tmp, 'media.db');
    for (const [k, n] of [['VOD_PATH', 'vods'], ['CLIPS_PATH', 'clips'], ['FILES_PATH', 'files'], ['THUMBNAILS_PATH', 'thumbnails'], ['PASTES_PATH', 'pastes'], ['OBJECTS_PATH', 'objects']]) process.env[k] = dir(n);
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    console.log = () => {};

    const db = require('../server/db/database');
    await db.initDb();
    await db.run("INSERT INTO clips (id, app_id, vod_id, title, status) OVERRIDING SYSTEM VALUE VALUES (41, 'live', 1, 'being cut', 'processing')");

    // Another opening of the database (a script on the host goes through initDb() too) changes no row.
    await db.close();
    await db.initDb();
    assert.strictEqual((await db.get('SELECT status FROM clips WHERE id = 41')).status, 'processing', 'opening the database leaves a clip being cut alone');

    fs.rmSync(tmp, { recursive: true, force: true });
    process.stdout.write('db open keeps clips: all checks passed\n');
})().catch((err) => { console.error(err); process.exit(1); });
