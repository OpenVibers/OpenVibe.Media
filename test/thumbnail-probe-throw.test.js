'use strict';
// generateFromVideo's promise had no reject path: a throw inside the async 'close' listener (here the
// ffmpeg spawn) left it forever unsettled, so the awaiting request hung, and the rejection was
// unhandled. The listener now catches and resolves null.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-thumbthrow-'));
    process.env.THUMBNAILS_PATH = path.join(tmp, 'thumbs');
    process.env.VOD_PATH = path.join(tmp, 'vods');
    process.env.FILES_PATH = path.join(tmp, 'files');

    // The probe's ffprobe child closes cleanly; the ffmpeg spawn that follows throws.
    const cp = require('child_process');
    const realSpawn = cp.spawn;
    cp.spawn = (cmd) => {
        if (cmd !== 'ffprobe') throw new Error(`cannot spawn ${cmd}`);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => child.emit('close', 0));
        return child;
    };
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);

    const file = path.join(tmp, 'v.mp4');
    fs.writeFileSync(file, 'not really a video');
    try {
        const thumb = require('../server/thumbnails/thumbnail-service');
        // seekSeconds skips the probe-duration branch, so the close handler goes straight to ffmpeg.
        const p = thumb.generateFromVideo(file, 'vod', 4242, { seekSeconds: 1 });
        const result = await Promise.race([p, new Promise((r) => setTimeout(() => r('HUNG'), 3000))]);
        await new Promise((r) => setTimeout(r, 50)); // let a stray unhandled rejection surface
        assert.notStrictEqual(result, 'HUNG', 'the thumbnail request must settle when the close handler throws');
        assert.strictEqual(result, null);
        assert.strictEqual(unhandled, null, `unhandled rejection: ${unhandled && unhandled.message}`);
    } finally {
        cp.spawn = realSpawn;
        process.off('unhandledRejection', onUnhandled);
    }

    console.log('✅ thumbnail probe: a throwing close handler resolves null instead of hanging');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
