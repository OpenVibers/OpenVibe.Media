'use strict';
/**
 * A new thumbnail's name carries its average colour (<prefix>-<id>-<time>-<rrggbb>.jpg), so every page that shows it can
 * paint that colour behind the picture before it arrives (plan L52, 2026-11-02). Made from a solid red video, the name
 * says red; colourFromName reads it back from a name or a URL with a query; a name without one reads null.
 *
 *   node test/thumbnail-colour.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovm-thumbcolour-'));
process.env.THUMBNAILS_PATH = dir;

(async () => {
    const thumbs = require('../server/thumbnails/thumbnail-service');
    assert.strictEqual(thumbs.colourFromName('vod-3-1730000000000-1a2b3c.jpg'), '#1a2b3c');
    assert.strictEqual(thumbs.colourFromName('https://openvibe.media/t/clip-9-1730000000000-ABCDEF.jpg?w=640'), '#abcdef');
    assert.strictEqual(thumbs.colourFromName('vod-3-1730000000000.jpg'), null, 'an older name has no colour');
    assert.strictEqual(thumbs.colourFromName('stream-live-12.jpg'), null);
    assert.strictEqual(thumbs.colourFromName('stream-live-100234.jpg'), null, 'a stream\'s stable name: its id is not a colour');

    let ffmpeg = true;
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
    if (!ffmpeg) { console.log('thumbnail colour: names read back (no ffmpeg here, so no picture made)'); return; }

    const video = path.join(dir, 'red.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=3', '-pix_fmt', 'yuv420p', video]);
    const url = await thumbs.generateFromVideo(video, 'vod', 424242, { seekSeconds: 1 });
    assert.match(url, /^\/t\/vod-424242-\d+-[0-9a-f]{6}\.jpg$/, url);
    const hex = thumbs.colourFromName(url).slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(r > 200 && g < 60 && b < 60, `red reads red: #${hex}`);
    assert.ok(fs.existsSync(path.join(thumbs.THUMB_DIR, path.basename(url))), 'the file is at its new name');
    assert.strictEqual(await thumbs.colourOf(path.join(dir, 'missing.jpg')), null);
    console.log(`thumbnail colour: a red frame is named …-${hex}.jpg; names read back`);
})().catch((err) => { console.error(err); process.exit(1); }).finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
