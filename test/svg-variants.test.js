'use strict';
// SVG in Media (2026-11-16; the owner: "Media should support svg and all other file formats"): an SVG's variant
// (?w=&fmt=) is drawn to pixels, at the width asked, from the drawing's bytes, never its path, so a drawing cannot
// pull another object's file from the store into its picture; a drawing over SVG_MAX_BYTES is not drawn.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const sharp = require('sharp');
    const { createVariants, SVG_MAX_BYTES } = require('../server/thumbnails/variants');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-svg-'));
    const store = path.join(tmp, 'objects');
    fs.mkdirSync(store);
    const variants = createVariants({ dir: path.join(tmp, 'variants') });

    // A small item badge, 128 units across: drawn sharp at 320 px.
    const badge = path.join(store, 'med_badge');
    fs.writeFileSync(badge, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><rect width="128" height="128" rx="28" fill="#7c3aed"/><circle cx="64" cy="64" r="36" fill="#fcd34d" stroke="#0f172a" stroke-width="4"/></svg>');
    const v = await variants.get(badge, { w: 320, fmt: 'webp', svg: true });
    const meta = await sharp(v.file).metadata();
    assert.deepStrictEqual([meta.format, meta.width], ['webp', 320], 'drawn at the width asked, not the drawing\'s own 128');
    assert.strictEqual(v.type, 'image/webp');
    const again = await variants.get(badge, { w: 320, fmt: 'webp', svg: true });
    assert.ok(again.hit, 'made once, then cached');

    // Another object's file beside it in the store: a drawing that names it draws nothing of it.
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toFile(path.join(store, 'secret.png'));
    const sneaky = path.join(store, 'med_sneaky');
    fs.writeFileSync(sneaky, '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="#ffffff"/><image href="secret.png" xlink:href="secret.png" x="0" y="0" width="64" height="64"/></svg>');
    const s = await variants.get(sneaky, { w: 64, fmt: 'jpeg', svg: true });
    const { data } = await sharp(s.file).raw().toBuffer({ resolveWithObject: true });
    const mid = (32 * 64 + 32) * 3;
    assert.ok(data[mid] > 200 && data[mid + 1] > 200 && data[mid + 2] > 200, `the sibling file is not drawn in (${data[mid]},${data[mid + 1]},${data[mid + 2]})`);

    // A drawing too big to be a picture is not drawn: the original answers instead (routes.js catches this).
    const huge = path.join(store, 'med_huge');
    fs.writeFileSync(huge, `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(SVG_MAX_BYTES + 1)}</svg>`);
    await assert.rejects(() => variants.get(huge, { w: 64, fmt: 'webp', svg: true }), /is not drawn/);

    // A raster image is unchanged: still drawn from its path.
    const png = path.join(store, 'med_png');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#3366cc' } }).png().toFile(png);
    const r = await variants.get(png, { w: 160, fmt: 'webp' });
    assert.strictEqual((await sharp(r.file).metadata()).width, 160);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('svg-variants: an SVG is drawn to pixels from its bytes, at the width asked, and never draws a sibling file');
})().catch((e) => { console.error(e); process.exit(1); });
