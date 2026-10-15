'use strict';
// Leftover job work directories (server/jobs/derive.js sweepWork, run at worker start and hourly): a process killed
// mid-job never reaches the handler's own cleanup, and on 2026-10-15 four such directories held 12.8 GB. The sweep
// removes OBJECTS_PATH/.jobs/<id> when the job finished (succeeded, failed, cancelled) or no longer exists and nothing
// wrote to it for an hour; a queued or running job's directory, a fresh one and anything not named like a job stay.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-sweep-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    for (const [k, n] of [['VOD_PATH', 'vods'], ['CLIPS_PATH', 'clips'], ['FILES_PATH', 'files'], ['THUMBNAILS_PATH', 'thumbnails'], ['PASTES_PATH', 'pastes'], ['OBJECTS_PATH', 'objects']]) process.env[k] = dir(n);
    try {
        const db = require('../server/db/database');
        await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
        const derive = require('../server/jobs/derive');
        const jobs = path.join(process.env.OBJECTS_PATH, '.jobs');
        const id = (n) => `mjob_01M4RDBWXB2ANQJP3W6N1TF7${String(n).padStart(2, '0').replace(/[ILOU]/g, 'A')}`;
        const make = (name, { ageMs = 2 * 3600 * 1000, bytes = 1024 } = {}) => {
            const d = path.join(jobs, name);
            fs.mkdirSync(path.join(d, 'out'), { recursive: true });
            fs.writeFileSync(path.join(d, 'out', '000001.m4s'), Buffer.alloc(bytes));
            const t = (Date.now() - ageMs) / 1000;
            fs.utimesSync(d, t, t);
            return d;
        };
        const job = async (n, status) => db.run(`INSERT INTO media_jobs (id, app_id, job_type, status, params, created_at, updated_at) VALUES (?, 'live', 'object.cmaf', ?, '{}', ov_now(), ov_now())`, [id(n), status]);
        await job(1, 'failed');
        await job(2, 'succeeded');
        await job(3, 'cancelled');
        await job(4, 'queued');
        await job(5, 'running');
        await job(6, 'failed');
        for (const n of [1, 2, 3, 4, 5]) make(id(n), { bytes: 4096 });
        make(id(6), { ageMs: 60 * 1000 });          // failed a minute ago: not yet
        make(id(7));                                  // no job row at all: vanished
        make('not-a-job');                            // not named like a job: never touched

        const r = await derive.sweepWork();
        assert.deepStrictEqual(r.removed.sort(), [id(1), id(2), id(3), id(7)].sort());
        assert.strictEqual(r.bytes, 4096 * 3 + 1024);
        const left = fs.readdirSync(jobs).sort();
        assert.deepStrictEqual(left, [id(4), id(5), id(6), 'not-a-job'].sort(), 'queued, running, fresh and foreign stay');
        assert.deepStrictEqual((await derive.sweepWork()).removed, [], 'a second sweep finds nothing');

        const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'jobs', 'worker.js'), 'utf8');
        assert.match(src, /recoverInterrupted\(\{ all: true[\s\S]{0,400}await sweepWorkDirs\(\);/, 'the worker sweeps at start');
        assert.match(src, /lastSweepAt > 3600 \* 1000\) \{\s*lastSweepAt = now;\s*await sweepWorkDirs\(\);/, 'and hourly');
        console.log('jobs-work-sweep: ok');
        await db.close();
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
