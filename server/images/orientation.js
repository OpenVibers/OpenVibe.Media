'use strict';

/** Apply the source image's EXIF orientation to its pixels before any metadata is discarded. */
function applyExifOrientation(image) {
    return image.rotate();
}

module.exports = { applyExifOrientation };
