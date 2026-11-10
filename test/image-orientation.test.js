'use strict';

const assert = require('assert');
const sharp = require('sharp');
const { applyExifOrientation, normalizeImage } = require('../server/images/orientation');

async function main() {
    for (let orientation = 1; orientation <= 8; orientation++) {
        const source = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#d22' } })
            .jpeg().withMetadata({ orientation }).toBuffer();
        const output = await normalizeImage(source, 'image/jpeg');
        const meta = await sharp(output).metadata();
        const swapped = orientation >= 5;
        assert.deepStrictEqual([meta.width, meta.height], swapped ? [20, 30] : [30, 20], `EXIF orientation ${orientation}`);
        assert.strictEqual(meta.orientation, undefined, `orientation ${orientation} must be in pixels, not retained as metadata`);
    }
    const marker = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#d22' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const normalized = await normalizeImage(marker, 'image/jpeg');
    const shared = await applyExifOrientation(sharp(marker)).jpeg().toBuffer();
    const normalizedMeta = await sharp(normalized).metadata();
    const sharedMeta = await sharp(shared).metadata();
    assert.strictEqual(normalizedMeta.orientation, undefined, 'no EXIF orientation remains');
    assert.deepStrictEqual([sharedMeta.width, sharedMeta.height], [10, 20], 'shared helper rotates pixels');
    await assert.rejects(normalizeImage(marker, 'image/png'), /does not match/);
    console.log('✅ EXIF orientations 1–8 are applied to pixels and removed from output metadata');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
