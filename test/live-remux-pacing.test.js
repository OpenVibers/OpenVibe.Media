'use strict';
// The live DVR snapshot and the big-file deletes stay off the event loop. On 2026-10-13 a 4-hour
// recording (8 GB) froze Media for up to 14 s at a time and Prometheus marked it down: every 60 s the
// live remux copied the whole file, a flat 30 s kill cut each pass short and dropped its guard while
// ffmpeg still ran (so the next tick started another full copy), and the abandoned multi-GB temp file
// was freed with unlinkSync. Here ffmpeg is a stand-in process the test ends by hand.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-live-remux-'));

// ffmpeg stand-in, installed before media-tools takes its reference to spawn.
const cp = require('child_process');
const spawned = [];
cp.spawn = (cmd, args) => {
    const p = new EventEmitter();
    p.stderr = new EventEmitter(); p.stdout = new EventEmitter(); p.pid = 999999999;   // no such process: the renice of the pass fails quietly, and never touches the test p.killedWith = null;
    p.args = args;
    p.kill = (sig) => { p.killedWith = sig || 'SIGTERM'; setImmediate(() => p.emit('close', null, sig)); return true; };
    // "Finish" the pass: write its output (the last argument) and exit 0.
    p.finish = () => { fs.writeFileSync(args[args.length - 1], 'snapshot'); p.emit('close', 0, null); };
    spawned.push(p);
    return p;
};

const tools = require('../server/vod/media-tools');
// Wait (up to 2 s) for a condition: a pass stats the file and the disk before it spawns.
const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((res) => setTimeout(res, 5)); return cond(); };
// A roomy disk unless a section says otherwise (~100 GB, 41 GB free), so the result does not depend on the machine.
const realStatfs = fs.promises.statfs;
const roomy = async () => ({ bsize: 4096, blocks: 25e6, bfree: 10e6, bavail: 10e6 });
fs.promises.statfs = roomy;

(async () => {
    const rec = path.join(tmp, 'vod-live-1-1.mp4');
    fs.writeFileSync(rec, Buffer.alloc(4096));
    const sidecar = tools.seekableSidecarPath(rec);
    const tmpOut = rec + '.live-remux.tmp.mp4';

    // 1) One pass at a time: a second call while ffmpeg runs starts nothing.
    const first = tools.remuxForLiveSeeking(rec);
    assert.ok(await until(() => spawned.length === 1), 'the first call starts one pass');
    assert.strictEqual(await tools.remuxForLiveSeeking(rec), false, 'a call while the pass runs does nothing');
    assert.strictEqual(spawned.length, 1, 'no second ffmpeg on the same recording');
    assert.strictEqual(spawned[0].args[spawned[0].args.length - 1], tmpOut, 'the pass writes the temp file');
    assert.ok(spawned[0].args.includes('+faststart'), 'an MP4 snapshot is written with faststart');

    // 2) The pass is not cut short at 30 s: its budget scales with the file, and it ends when ffmpeg ends.
    assert.strictEqual(tools.remuxBudgetMs(1e6), 180000, 'a small file gets the 3 min floor');
    assert.strictEqual(tools.remuxBudgetMs(8e9), 8 * 45000 + 60000, 'an 8 GB file gets ~45 s per GB');
    assert.strictEqual(tools.remuxBudgetMs(500e9), 45 * 60000, 'the ceiling is 45 min');
    spawned[0].finish();
    assert.strictEqual(await first, true, 'a finished pass replaces the snapshot');
    assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), 'snapshot');
    assert.ok(!fs.existsSync(tmpOut), 'the temp file became the snapshot');

    // 3) Paced: the next pass waits 9x as long as the last took, so an immediate call does nothing;
    //    once that window has passed (however long the pass above took here), a new pass starts.
    assert.strictEqual(await tools.remuxForLiveSeeking(rec), false, 'a call inside the pacing window does nothing');
    assert.strictEqual(spawned.length, 1);
    let second = null;
    for (let i = 0; i < 200 && !second; i++) {
        await new Promise((res) => setTimeout(res, 50));
        const call = tools.remuxForLiveSeeking(rec);   // not due: resolves false; due: runs until the stand-in ends
        const r = await Promise.race([call.then(() => 'returned'), until(() => spawned.length === 2).then((ok) => (ok ? 'spawned' : 'none'))]);
        if (r === 'spawned') second = call;
    }
    assert.ok(second && spawned.length === 2, 'after the pacing window a new pass starts');

    // 4) Finalization retires the recording: the running pass is killed, nothing is left behind.
    fs.writeFileSync(tmpOut, 'partial');
    await tools.cleanupSeekableFile(rec);
    assert.strictEqual(spawned[1].killedWith, 'SIGKILL', 'the live pass is stopped at finalization');
    assert.strictEqual(await second, false);
    assert.ok(!fs.existsSync(sidecar), 'the snapshot is removed');
    assert.ok(!fs.existsSync(tmpOut), 'the killed pass removed its temp file');

    // 5) No room: a pass that cannot fit its copy next to the recording is skipped (and starts no ffmpeg).
    fs.promises.statfs = async () => ({ bsize: 4096, blocks: 25e6, bfree: 1e5, bavail: 1e5 });   // ~100 GB disk, 0.4 GB free
    const big = path.join(tmp, 'vod-live-2-2.webm');
    fs.writeFileSync(big, Buffer.alloc(1024));
    const before = spawned.length;
    assert.strictEqual(await tools.remuxForLiveSeeking(big), false, 'no room: skipped');
    assert.strictEqual(spawned.length, before, 'no ffmpeg without room for its copy');
    const final = await tools.remuxForSeekingDetailed(big);
    assert.deepStrictEqual([final.ok, final.error], [false, 'no room for the remux copy'], 'the final remux checks the disk too');
    assert.strictEqual(spawned.length, before);
    assert.strictEqual(await tools.hasRoomFor(tmp, 0), false, '0.4 GB free is under the 10 GB reserve');
    fs.promises.statfs = roomy;
    assert.strictEqual(await tools.hasRoomFor(tmp, 20e9), true, '41 GB free takes a 20 GB copy and keeps 10 GB');
    assert.strictEqual(await tools.hasRoomFor(tmp, 35e9), false, 'but not a 35 GB one');
    fs.promises.statfs = realStatfs;

    // 6) removeFile: off the event loop, never throws.
    const gone = path.join(tmp, 'gone.bin');
    fs.writeFileSync(gone, 'x');
    assert.strictEqual(await tools.removeFile(gone), true);
    assert.ok(!fs.existsSync(gone));
    assert.strictEqual(await tools.removeFile(gone), true, 'a missing file is already gone');
    assert.strictEqual(await tools.removeFile(null), false);
    const aDir = path.join(tmp, 'a-dir');
    fs.mkdirSync(aDir);
    assert.strictEqual(await tools.removeFile(aDir), false, 'a directory is not removed');
    assert.ok(fs.existsSync(aDir));

    // 7) diskUsage reads statfs, not df through a shell.
    const vodStorage = require('../server/vod/vod-storage');
    const d = vodStorage.diskUsage(tmp);
    assert.ok(d.total > 0 && d.available > 0 && d.used >= 0 && d.usePct > 0 && d.usePct <= 100, `diskUsage: ${JSON.stringify(d)}`);

    // 8) The VOD lifecycle files hold no synchronous unlink/rename of recordings, and no execSync.
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'vod', f), 'utf8');
    for (const f of ['media-tools.js', 'finalize.js', 'vod-storage.js', 'health-scanner.js']) {
        const body = src(f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        const hits = (body.match(/\b(renameSync|execSync)\b/g) || []);
        assert.deepStrictEqual(hits, [], `${f}: ${hits.join(', ')}`);
    }
    // cleanupTempFile (browser chunks) and the SDP files are small: the only unlinkSync left in these files.
    for (const f of ['finalize.js', 'vod-storage.js', 'health-scanner.js']) {
        assert.ok(!/unlinkSync/.test(src(f)), `${f} frees files with removeFile / fs.promises`);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('live-remux-pacing: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
