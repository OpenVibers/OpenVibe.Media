'use strict';
// Fonts, icons and the common kinds (2026-11-16; the owner: "Media should support svg and all other file formats …
// And fonts and icons"): a file sent without a type takes the one its name says; icon, cursor, Apple icon set and TIFF
// bytes are recognised as the images they are.
const assert = require('assert');
const c = require('../server/objects/content-type');

const want = { 'Brand.WOFF2': 'font/woff2', 'a.woff': 'font/woff', 'a.ttf': 'font/ttf', 'a.otf': 'font/otf', 'favicon.ico': 'image/x-icon',
    'arrow.cur': 'image/x-icon', 'app.icns': 'image/icns', 'logo.svg': 'image/svg+xml', 'scan.tiff': 'image/tiff', 'clip.mov': 'video/quicktime',
    'song.flac': 'audio/flac', 'model.glb': 'model/gltf-binary', 'notes.md': 'text/markdown' };
Object.entries(want).forEach(([name, type]) => assert.strictEqual(c.typeFromName(name), type, name));
['README', 'archive.unknownext', '', null, 'evil.svg/../x'].forEach((name) => assert.strictEqual(c.typeFromName(name), null, String(name)));

assert.deepStrictEqual(c.sniff(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0])), { family: 'image', format: 'ico' });
assert.deepStrictEqual(c.sniff(Buffer.from([0, 0, 2, 0, 1, 0, 32, 32, 0, 0])), { family: 'image', format: 'cur' });
assert.deepStrictEqual(c.sniff(Buffer.from('icns\0\0\0\x08', 'latin1')), { family: 'image', format: 'icns' });
assert.deepStrictEqual(c.sniff(Buffer.from('MM\0*\0\0\0\x08', 'latin1')), { family: 'image', format: 'tiff' });
assert.strictEqual(c.sniff(Buffer.from([0, 0, 1, 0, 0, 0])), null, 'an icon file with no images is not one');
assert.strictEqual(c.contentProblem('asset', 'image/x-icon', Buffer.from([0, 0, 1, 0, 1, 0, 16, 16])), null, 'an icon is shown in place');
assert.match(c.contentProblem('asset', 'image/x-icon', Buffer.from('<html>')), /not a recognised image/, 'a page named .ico is refused');
console.log('content-type-names: a file\'s name gives its type; icons and TIFF are recognised');
