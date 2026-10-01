'use strict';
// Regression (server/jobs/queue.js waitFor): the waiter resolved with
// `row || await get(id)` inside its timer/event callback. When that read failed
// after the timeout had passed (the connection dropped), the callback rejected:
// an unhandled rejection from the setTimeout listener, and a waiter that never
// settled (the thumbnail route waits on it). The callback now catches, logs and
// resolves with what it has, so the loop and the process live on.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-waitguard-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.MEDIA_JOBS_POLL_MS = '50';
    process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    (async () => {
        const db = require('../server/db/database');
        const queue = require('../server/jobs/queue');

        // A running job nothing finishes: the waiter times out and reads its state.
        await db.run(`INSERT INTO media_jobs (id, app_id, job_type, status, attempts, max_attempts, lease_until, lease_token)
                      VALUES ('mjob_waitguard', 'live', 'test.waitguard', 'running', 1, 3, datetime('now', '+1 hour'), NULL)`);

        // The waiter's first read (the job is running) passes; every later read of
        // that job fails, as when the connection drops between the timeout and the read.
        const origGet = db.get;
        let reads = 0;
        db.get = async (sql, params) => {
            if (params && params[0] === 'mjob_waitguard' && ++reads > 1) throw new Error('connection lost');
            return origGet.call(db, sql, params);
        };

        const rejections = [];
        const onRejection = (err) => rejections.push(err);
        process.on('unhandledRejection', onRejection);
        const warnings = [];
        const warn = console.warn;
        console.warn = (...a) => { warnings.push(a.join(' ')); };

        let settled = 'HUNG';
        queue.waitFor('mjob_waitguard', 60).then((row) => { settled = row; }, (err) => { settled = err; });
        await sleep(300);   // the 60 ms timeout fires inside this; the read it does fails

        console.warn = warn;
        db.get = origGet;
        process.off('unhandledRejection', onRejection);

        assert.strictEqual(settled, null, 'the wait settles with what it has when the final read fails');
        assert.strictEqual(rejections.length, 0, `a rejection escaped the timer callback: ${rejections[0] && rejections[0].message}`);
        assert.ok(warnings.some((w) => w.includes('mjob_waitguard') && w.includes('connection lost')), `the failed read is logged: ${warnings.join('\n')}`);

        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('✅ jobs wait guard: a failing final read settles the wait (logged) instead of an unhandled rejection');
        console.log('jobs wait guard: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
