'use strict';
// A recording leaves the recorder when its ffmpeg ends. On 2026-09-28 the PostgreSQL switch made the
// registration async and the RTMP/RTP starters did not await it: the exit listener was attached to a
// Promise, so every recording stayed "in progress" after ffmpeg ended (15 of them, holding every deploy),
// and none was finalized. Here ffmpeg is a stand-in process: it exits normally, and it exits before the
// row write finishes; both times the recording leaves the active set.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-rec-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
});
delete process.env.MEDIA_RTMP_PULL_ALLOW;

// ffmpeg stand-in, installed before the recorder takes its reference to spawn.
const cp = require('child_process');
const spawned = [];
let exitAtOnce = false;
cp.spawn = () => {
    const p = new EventEmitter();
    p.stderr = new EventEmitter(); p.stdout = new EventEmitter(); p.killed = false;
    p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', 0, null)); return true; };
    if (exitAtOnce) setImmediate(() => p.emit('exit', 1, null));
    spawned.push(p);
    return p;
};

(async () => {
    const recorder = require('../server/vod/recorder');
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-rec-test' });
    const settled = async () => { for (let i = 0; i < 100 && recorder.activeCount(); i++) await new Promise((res) => setTimeout(res, 10)); };
    const newVod = async () => db.getVodById(Number((await db.createVod({ app_id: 'live', title: 'x' })).lastInsertRowid));

    const a = await newVod();
    const r = await recorder.startRtmp(a, 'rtmp://127.0.0.1:1935/live/k');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(recorder.activeCount(), 1);
    assert.strictEqual((await db.getVodById(a.id)).is_recording, 1, 'the row says so once start returns');
    assert.strictEqual(spawned.length, 1, 'the stand-in ran'); assert.strictEqual(recorder.stopRecording(a.id), true);
    await settled();
    assert.strictEqual(recorder.activeCount(), 0, 'ffmpeg ended: the recording is no longer in progress');
    console.log('✅ a stopped recording leaves the active set when ffmpeg exits');

    exitAtOnce = true;
    const b = await newVod();
    assert.strictEqual((await recorder.startRtmp(b, 'rtmp://127.0.0.1:1935/live/k')).ok, true);
    await settled();
    assert.strictEqual(recorder.activeCount(), 0, 'an ffmpeg that dies at once is caught too');
    console.log('✅ an ffmpeg that exits while the row is being written is caught');

    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ recorder lifecycle tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
