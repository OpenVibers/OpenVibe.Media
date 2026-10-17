'use strict';
// Timeline files no row names: a cut stages its segments and names them in one commit; a process that dies before that
// commit leaves them (VOD 5726's three failed cuts on 2026-10-15 left 7 GB, and the cache sweep skipped them for good).
// The sweep now removes them once they are older than any cut can run and their object has no job queued or running.
// Named files, recent files and the files of a busy object stay.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-timeline-orphans-'));
    process.env.OBJECTS_PATH = root;
    process.env.MEDIA_HLS_ENABLED = '1';
    process.env.MEDIA_TIMELINE_LOCAL_MAX_BYTES = String(1024 ** 3);
    process.env.MEDIA_TIMELINE_LOCAL_MIN_FREE_BYTES = '0';
    const db = require('../server/db/database');
    const timeline = require('../server/objects/timeline');
    const cache = require('../server/objects/timeline-cache');
    const now = Date.parse('2026-10-17T03:00:00Z');
    const DAY = 24 * 3600 * 1000;

    const write = (obj, name, data, atMs) => {
        const bytes = Buffer.from(data);
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        const file = timeline.localPathFor(obj, 'source', name, sha.slice(0, 12));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        fs.utimesSync(file, atMs / 1000, atMs / 1000);
        return { file, bytes, sha };
    };
    try {
        const dead = { app_id: 'live', id: 'med_dead' };
        const named = { app_id: 'live', id: 'med_named' };
        const busy = { app_id: 'live', id: 'med_busy' };

        // A cut that died before its commit, two days ago: nothing names these.
        const lost = [write(dead, '000001.m4s', 'lost-1', now - 2 * DAY), write(dead, '000002.m4s', 'lost-2', now - 2 * DAY)];
        // The same object's newer staging (a cut running right now could be writing these): too recent to judge.
        const fresh = write(dead, '000003.m4s', 'fresh', now - 3600 * 1000);
        // An old file a row still names: the cache's own business, never an orphan.
        const kept = write(named, '000001.m4s', 'kept', now - 3 * DAY);
        await timeline.replace(named.id, 'source', [{ seq: 1, name: '000001.m4s', start_ms: 0, end_ms: 1000, key: `${named.id}/source/${kept.sha.slice(0, 12)}/000001.m4s`,
            local_path: kept.file, durable_provider: null, packed_object_id: null, byte_offset: null, byte_length: kept.bytes.length, sha256: kept.sha, durability: 'local' }]);
        // An old unnamed file whose object has a cut queued: left for that cut.
        const waiting = write(busy, '000001.m4s', 'waiting', now - 2 * DAY);
        await db.run("INSERT INTO media_jobs (id, app_id, object_id, job_type, status) VALUES ('job_busy', 'live', ?, 'object.cmaf', 'queued')", [busy.id]);
        // A finished job does not hold anything back.
        await db.run("INSERT INTO media_jobs (id, app_id, object_id, job_type, status) VALUES ('job_dead', 'live', ?, 'object.cmaf', 'failed')", [dead.id]);

        const out = await cache.sweep({ now });
        assert.strictEqual(out.orphans, 2, JSON.stringify(out));
        assert.ok(lost.every((f) => !fs.existsSync(f.file)), 'the dead cut\'s files are gone');
        assert.ok(fs.existsSync(fresh.file), 'a recent file stays (a cut may be staging it)');
        assert.ok(fs.existsSync(kept.file), 'a named file stays');
        assert.ok(fs.existsSync(waiting.file), 'a busy object\'s file stays');
        assert.strictEqual(cache.orphansRemoved(), 2);
        assert.strictEqual((await cache.refresh()).bytes, fresh.bytes.length + kept.bytes.length + waiting.bytes.length, 'the cache counts what is left');

        // The queued cut finishes (and fails): the next sweep takes its object's leftover too.
        await db.run("UPDATE media_jobs SET status = 'failed' WHERE id = 'job_busy'");
        assert.strictEqual((await cache.sweep({ now })).orphans, 1);
        assert.ok(!fs.existsSync(waiting.file));
        console.log('timeline orphans: all checks passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
