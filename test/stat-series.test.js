'use strict';
// Daily stat series for an app's "over time" charts (GET /api/v1/:app/stats/series/:metric).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = path.join(os.tmpdir(), `ov-media-series-${process.pid}.db`);
process.env.DB_PATH = tmp;
const db = require('../server/db/database');
const raw = db.getDb();

const vod = raw.prepare(`INSERT INTO vods (app_id, title, is_public, is_recording, duration_seconds, created_at) VALUES (?, 't', ?, 0, ?, datetime('now', ?))`);
vod.run('live', 1, 7200, '-0 days');
vod.run('live', 1, 3600, '-2 days');
vod.run('live', 0, 3600, '-1 days');      // private: not counted
vod.run('other', 1, 3600, '-1 days');     // another app: not counted
vod.run('live', 1, 3600, '-10 days');     // before a 7-day window, inside the previous one
vod.run('live', 1, 3600, '-40 days');     // before both

const s = db.getAppStatSeries('live', 'vods', 7);
assert.strictEqual(s.points.length, 7);
assert.strictEqual(s.total, 2);
assert.strictEqual(s.before, 2);
assert.strictEqual(s.prev_total, 1);
assert.strictEqual(s.points[s.points.length - 1].value, 1);
const h = db.getAppStatSeries('live', 'hours', 7);
assert.strictEqual(h.total, 3);
assert.strictEqual(db.getAppStatSeries('live', 'nope', 7), null);
assert.strictEqual(db.getAppStatSeries('live', 'vods', 9999).points.length, 365);

for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
console.log('stat series: all checks passed');
process.exit(0);
