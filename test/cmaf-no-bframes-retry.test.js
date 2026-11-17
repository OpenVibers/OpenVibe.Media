'use strict';
// A period the fMP4 muxer refuses for libx264's B-frames ("Not yet implemented in FFmpeg, patches welcome": VOD 6568,
// 2026-11-17, a WebRTC part with lost packets) is cut once more without B-frames; any other failure is not retried.
//   node test/cmaf-no-bframes-retry.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const derive = require('../server/jobs/derive');
const shapes = require('../server/jobs/shapes');
const timeline = require('../server/objects/timeline');

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac'];
const REFUSED = { ok: false, code: 176, stderr: '[out#0/hls @ 0x1] Task finished with error code: -1163346256 (Not yet implemented in FFmpeg, patches welcome)' };

(async () => {
    assert.strictEqual(shapes.noBframesRetry(REFUSED, X264), true);
    assert.strictEqual(shapes.noBframesRetry(REFUSED, ['-c', 'copy']), false, 'a copy has no B-frames to drop');
    assert.strictEqual(shapes.noBframesRetry(REFUSED, [...X264, '-bf', '0']), false, 'never twice');
    assert.strictEqual(shapes.noBframesRetry({ ok: false, stderr: 'Invalid data found when processing input' }, X264), false, 'another failure is not this');
    assert.strictEqual(shapes.noBframesRetry({ ok: true, stderr: '' }, X264), false);

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cmaf-bf0-'));
    const real = derive.ffmpeg;
    const runs = [];
    derive.ffmpeg = async (args) => {
        runs.push(args);
        if (!args.includes('-bf')) return REFUSED;
        const playlist = args[args.length - 1];
        const init = args[args.indexOf('-hls_fmp4_init_filename') + 1];
        fs.writeFileSync(path.join(out, init), 'init');
        fs.writeFileSync(path.join(out, '000001.m4s'), 'seg');
        fs.writeFileSync(playlist, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n000001.m4s\n#EXT-X-ENDLIST\n');
        return { ok: true, code: 0, stderr: '' };
    };
    try {
        const list = await shapes.cut({ source: { input: '/tmp/in.mp4' }, periods: [{ start: 0, end: 4, width: 1280, height: 720 }], start: 0, out,
            segmentSeconds: 4, audio: true, encode: () => X264, timeoutMs: 60000 });
        assert.strictEqual(runs.length, 2, 'refused once, cut again');
        const second = runs[1];
        assert.deepStrictEqual(second.slice(second.indexOf('libx264') - 1, second.indexOf('libx264') + 7), ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-bf', '0'], 'the same encode, B-frames off');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].init, timeline.INIT_NAME);
    } finally {
        derive.ffmpeg = real;
        fs.rmSync(out, { recursive: true, force: true });
    }
    console.log('cmaf-no-bframes-retry: a refused B-frame encode is cut once more without them; nothing else is retried');
})().catch((e) => { console.error(e); process.exit(1); });
