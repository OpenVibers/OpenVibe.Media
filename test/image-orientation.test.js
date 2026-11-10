'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { applyExifOrientation, normalizeImage, normalizeImageFile } = require('../server/images/orientation');

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
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'media-orientation-test-'));
    try {
        const input = path.join(scratch, 'source.jpg'), output = path.join(scratch, 'oriented.jpg');
        fs.writeFileSync(input, marker);
        await normalizeImageFile(input, output, 'image/jpeg');
        const fileMeta = await sharp(output).metadata();
        assert.deepStrictEqual([fileMeta.width, fileMeta.height], [10, 20], 'file-backed normalization rotates pixels');
        assert.strictEqual(fileMeta.orientation, undefined, 'file-backed normalization removes EXIF');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    await assert.rejects(normalizeImage(marker, 'image/png'), /does not match/);
    console.log('✅ EXIF orientations 1–8 are applied to pixels and removed from output metadata');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
