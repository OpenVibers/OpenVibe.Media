'use strict';

const assert = require('assert');
const sharp = require('sharp');
const { applyExifOrientation } = require('../server/images/orientation');

async function main() {
    for (let orientation = 1; orientation <= 8; orientation++) {
        const source = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#d22' } })
            .jpeg().withMetadata({ orientation }).toBuffer();
        const output = await applyExifOrientation(sharp(source, { failOn: 'error' })).jpeg().toBuffer();
        const meta = await sharp(output).metadata();
        const swapped = orientation >= 5;
        assert.deepStrictEqual([meta.width, meta.height], swapped ? [20, 30] : [30, 20], `EXIF orientation ${orientation}`);
        assert.strictEqual(meta.orientation, undefined, `orientation ${orientation} must be in pixels, not retained as metadata`);
    }
    console.log('✅ EXIF orientations 1–8 are applied to pixels and removed from output metadata');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
