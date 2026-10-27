'use strict';
// An app's stats (GET /api/v1/:app/stats, db.getAppStats): the home page counters and their rolling windows. Hours
// archived over a window used to be an un-awaited async function, so the JSON answered `hours: {}` and Live's
// "Hours archived" never showed a change; each window also carries `pw`, the seven days before the last seven.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-app-stats-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
    });
    const db = require('../server/db/database');
    const d = db.getDb();
    const V = d.prepare(`INSERT INTO vods (id, app_id, file_path, file_size, duration_seconds, visibility, is_public, storage_provider, created_at) OVERRIDING SYSTEM VALUE
                         VALUES (?, 'live', ?, 100, ?, 'public', 1, 'local', datetime('now', ?))`);
    // Two hours today, three hours ten days ago, one an hour long 40 days ago.
    await V.run(9101, '/x/9101.webm', 7200, '-1 hours');
    await V.run(9102, '/x/9102.webm', 10800, '-10 days');
    await V.run(9103, '/x/9103.webm', 3600, '-40 days');

    const s = JSON.parse(JSON.stringify(await db.getAppStats('live')));
    assert.strictEqual(Number(s.vods), 3);
    assert.deepStrictEqual(s.recent.hours, { d: 2, w: 2, m: 5, pw: 3 }, 'hours archived answer every window, as numbers');
    assert.deepStrictEqual(s.recent.vods, { d: 1, w: 1, m: 2, pw: 1 });
    assert.deepStrictEqual(s.recent.clips, { d: 0, w: 0, m: 0, pw: 0 });
    console.log('  ✓ an app\'s stats answer hours archived per window, and the week before');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
