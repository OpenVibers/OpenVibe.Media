'use strict';
// H15 repair (WS-G task 7): the plan for each object with no good copy, and its writes and rollback.
const assert = require('assert');
const Database = require('better-sqlite3');
const { plan, apply, rollback, judgeProbe } = require('../server/objects/h15-repair');

const good = { duration: 1721.9, streams: ['vp8', 'opus'], errorLines: Array(4700).fill('[null @ 0x1] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 5 >= 5').concat(['[opus @ 0x2] Error parsing Opus packet header.']) };
const vod = (over = {}) => ({ object_id: 'med_1', kind: 'vod', size_bytes: 13631488, content_hash: null, legacy_ref: 'legacy:live:vod:1277', locations: [{ provider: 'b2', key: 'vods/a.webm', state: 'corrupt', size_bytes: 14609471 }], ...over });

// ── The verdict on a decoded copy ──
assert.strictEqual(judgeProbe(good).ok, true, 'timestamp warnings of a live recording do not condemn it');
assert.strictEqual(judgeProbe({ duration: 0.6, streams: ['vp8'], errorLines: [] }).fragment, true);
assert.strictEqual(judgeProbe({ error: 'Invalid data found' }).ok, false);
assert.strictEqual(judgeProbe({ duration: 400, streams: ['vp8'], errorLines: Array(9).fill('[vp8 @ 1] Truncated packet') }).ok, false, 'real decode errors do');
assert.strictEqual(judgeProbe({ duration: 400, streams: [], errorLines: [] }).ok, false);

// ── The plan ──
assert.strictEqual(plan(vod(), { b2: good }).action, 'rebaseline');
assert.match(plan(vod(), { b2: good }).reason, /only its size differed/);
assert.strictEqual(plan(vod(), { b2: { duration: 0.6, streams: ['vp8'], errorLines: [] } }).action, 'failed_recording');
assert.strictEqual(plan(vod(), { b2: { error: 'moov atom not found' } }).action, 'lost');
assert.strictEqual(plan(vod({ content_hash: 'abc' }), { b2: good }).action, 'lost', 'a recorded hash that disagrees is real corruption: never rebaselined');
const shot = { object_id: 'med_2', kind: 'screenshot', size_bytes: 0, content_hash: null, locations: [{ provider: 'local', key: '/data/pastes/screenshots/ai-moment-vod1691-32230.jpg', state: 'missing' }] };
assert.deepStrictEqual((({ action, source_vod, offset }) => ({ action, source_vod, offset }))(plan(shot)), { action: 'regenerate', source_vod: 1691, offset: 32230 });
assert.strictEqual(plan({ ...shot, locations: [{ provider: 'local', key: '/x/other.jpg', state: 'missing' }] }).action, 'lost');

// ── Writes, only while the row holds what was read, and their rollback ──
const h = new Database(':memory:');
h.exec(`CREATE TABLE media_objects (id TEXT PRIMARY KEY, size_bytes INTEGER, content_hash TEXT, lifecycle_status TEXT, updated_at TEXT);
        CREATE TABLE media_locations (id INTEGER PRIMARY KEY, object_id TEXT, provider TEXT, key TEXT, state TEXT, size_bytes INTEGER, verified_at TEXT, updated_at TEXT);`);
h.prepare("INSERT INTO media_objects VALUES ('med_1', 13631488, NULL, 'ready', NULL), ('med_3', 262144, NULL, 'ready', NULL), ('med_2', 0, NULL, 'ready', NULL)").run();
h.prepare("INSERT INTO media_locations (object_id, provider, key, state, size_bytes) VALUES ('med_1', 'b2', 'vods/a.webm', 'corrupt', 14609471), ('med_3', 'b2', 'vods/b.webm', 'corrupt', 218283), ('med_2', 'local', '/x.jpg', 'missing', NULL)").run();

const c1 = apply(h, plan(vod(), { b2: good }), { size: 14609471, sha256: 'f'.repeat(64) });
assert.deepStrictEqual(c1.old, { size_bytes: 13631488, content_hash: null, location_state: 'corrupt', location_size: 14609471 });
assert.deepStrictEqual(h.prepare("SELECT size_bytes, content_hash FROM media_objects WHERE id = 'med_1'").get(), { size_bytes: 14609471, content_hash: 'f'.repeat(64) });
assert.strictEqual(h.prepare("SELECT state FROM media_locations WHERE object_id = 'med_1'").get().state, 'present');
assert.match(apply(h, plan(vod(), { b2: good }), { size: 1, sha256: 'e'.repeat(64) }).skipped, /changed since/, 'a second run finds the row moved on');

const c3 = apply(h, { object_id: 'med_3', action: 'failed_recording', provider: 'b2' });
assert.strictEqual(h.prepare("SELECT lifecycle_status FROM media_objects WHERE id = 'med_3'").get().lifecycle_status, 'failed');

const c2 = apply(h, plan(shot), { size: 5120, sha256: 'a'.repeat(64) });
assert.strictEqual(c2.new.location_state, 'present');
assert.strictEqual(h.prepare("SELECT state FROM media_locations WHERE object_id = 'med_2'").get().state, 'present');

for (const c of [c1, c2, c3]) assert.strictEqual(rollback(h, c).restored, true);
assert.deepStrictEqual(h.prepare("SELECT size_bytes, content_hash, lifecycle_status FROM media_objects WHERE id = 'med_1'").get(), { size_bytes: 13631488, content_hash: null, lifecycle_status: 'ready' });
assert.strictEqual(h.prepare("SELECT state FROM media_locations WHERE object_id = 'med_1'").get().state, 'corrupt');
assert.strictEqual(h.prepare("SELECT lifecycle_status FROM media_objects WHERE id = 'med_3'").get().lifecycle_status, 'ready');
assert.strictEqual(rollback(h, c1).skipped, 'the row changed since', 'rolling back twice changes nothing');

console.log('h15 repair: all checks passed');
