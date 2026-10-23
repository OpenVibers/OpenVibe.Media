'use strict';
// The recorder's last resort (recorder._stopLargestForDisk via checkDisk): under VOD_DISK_STOP_GB free (default 3),
// the largest running recording is stopped, one per check, because running recordings keep writing under 'critical'
// and a full disk stops PostgreSQL and every service. Above the floor (critical or not) nothing running is stopped.
// ffmpeg is a stand-in process, as in recorder-lifecycle.test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-floor-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
});
delete process.env.MEDIA_RTMP_PULL_ALLOW;
delete process.env.VOD_DISK_STOP_GB;

const cp = require('child_process');
cp.spawn = () => {
    const p = new EventEmitter();
    p.stderr = new EventEmitter(); p.stdout = new EventEmitter(); p.killed = false;
    p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', 0, null)); return true; };
    return p;
};

const GiB = 1024 * 1024 * 1024;

(async () => {
    console.error = () => {}; console.warn = () => {};
    const recorder = require('../server/vod/recorder');
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-floor-test' });
    const newVod = async () => db.getVodById(Number((await db.createVod({ app_id: 'live', title: 'x' })).lastInsertRowid));
    const settled = async (n) => { for (let i = 0; i < 100 && recorder.activeCount() > n; i++) await new Promise((res) => setTimeout(res, 10)); };

    const small = await newVod();
    const big = await newVod();
    const rs = await recorder.startRtmp(small, 'rtmp://127.0.0.1:1935/live/a');
    const rb = await recorder.startRtmp(big, 'rtmp://127.0.0.1:1935/live/b');
    fs.writeFileSync(rs.filePath, Buffer.alloc(1000));
    fs.writeFileSync(rb.filePath, Buffer.alloc(5000));
    assert.strictEqual(recorder.activeCount(), 2);

    let free = 4 * GiB;   // critical (under 5), above the 3 GB floor
    recorder._freeBytes = () => free;
    recorder.checkDisk();
    await settled(2);
    assert.strictEqual(recorder.activeCount(), 2, 'critical alone stops nothing that is running');

    free = 2 * GiB;
    recorder.checkDisk();
    await settled(1);
    assert.strictEqual(recorder.activeCount(), 1, 'under the floor: one recording stopped');
    assert.ok(!recorder.activeRecordings.has(big.id) && recorder.activeRecordings.has(small.id), 'the largest went, the smaller keeps recording');

    recorder.checkDisk();   // still under the floor on the next check: the next largest
    await settled(0);
    assert.strictEqual(recorder.activeCount(), 0);
    assert.strictEqual(recorder._stopLargestForDisk(free), null, 'nothing left to stop');

    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('recorder-disk-floor: ok');
    process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
