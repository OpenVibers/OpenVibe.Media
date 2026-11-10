'use strict';

/** Apply the source image's EXIF orientation to its pixels before metadata is discarded. */
function applyExifOrientation(image) { return image.rotate(); }

/** Apply EXIF orientation, then re-encode so all embedded metadata is discarded. */
async function normalizeImage(input, mimeType, { sharp = require('sharp') } = {}) {
    const format = ({ 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' })[String(mimeType || '').toLowerCase()];
    if (!format) throw new Error('Only JPEG, PNG and WebP images can be normalized');
    const image = sharp(input, { limitInputPixels: 40_000_000, failOn: 'error', animated: false });
    const meta = await image.metadata();
    const actual = meta.format === 'jpg' ? 'jpeg' : meta.format;
    if (!meta.width || !meta.height || actual !== format) throw new Error('Image content does not match its media type');
    const oriented = applyExifOrientation(image);
    const output = format === 'jpeg' ? oriented.jpeg({ quality: 92, mozjpeg: true }) : format === 'png' ? oriented.png() : oriented.webp({ quality: 92 });
    return await output.toBuffer();
}

module.exports = { applyExifOrientation, normalizeImage };
