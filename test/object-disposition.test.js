'use strict';
// Content-Disposition for object downloads (server/objects/disposition.js): an ASCII fallback in filename=,
// the real name in filename*= when the fallback lost something, and nothing Node would refuse as a header.
const assert = require('assert');
const http = require('http');
const { contentDisposition, asciiName } = require('../server/objects/disposition');

// Node's own header check: a value outside Latin-1 (or with CR/LF) throws ERR_INVALID_CHAR.
function headerOk(value) {
    http.validateHeaderValue('Content-Disposition', value);
    return true;
}

// A plain ASCII name keeps the old header exactly.
assert.strictEqual(contentDisposition('hello.txt', { inline: true }), 'inline; filename="hello.txt"');
assert.strictEqual(contentDisposition('report v2.pdf'), 'attachment; filename="report v2.pdf"');

// A name Node would refuse: the fallback is ASCII, the real name travels percent-encoded as UTF-8.
const jp = contentDisposition('日本語のファイル.pdf');
assert.ok(headerOk(jp));
assert.strictEqual(jp, `attachment; filename="________.pdf"; filename*=UTF-8''${encodeURIComponent('日本語のファイル.pdf')}`);
assert.throws(() => http.validateHeaderValue('Content-Disposition', 'attachment; filename="日本.pdf"'), /Invalid character/);

// Latin-1 passes Node's check but browsers read it as mojibake: it gets filename*= too.
const cafe = contentDisposition('café.txt');
assert.ok(cafe.includes(`filename*=UTF-8''caf%C3%A9.txt`) && cafe.includes('filename="caf_.txt"'), cafe);

// Quotes, backslashes and the attr-chars encodeURIComponent leaves alone.
const odd = contentDisposition(`it's "a" (copy)*\\.txt`);
assert.ok(headerOk(odd));
assert.ok(odd.startsWith(`attachment; filename="it's _a_ (copy)*_.txt"; filename*=UTF-8''it%27s%20%22a%22%20%28copy%29%2A%5C.txt`), odd);

// CR, LF and other control characters never reach the header (no header splitting).
const split = contentDisposition('a\r\nSet-Cookie: x=1.txt');
assert.ok(headerOk(split));
assert.ok(!/[\r\n]/.test(split));
assert.strictEqual(split, 'attachment; filename="a__Set-Cookie: x=1.txt"');

// Empty and missing names, emoji (surrogate pairs are not cut in half), and a 300-character name.
assert.strictEqual(contentDisposition(''), 'attachment; filename="file"');
assert.strictEqual(contentDisposition(null), 'attachment; filename="file"');
const emoji = contentDisposition('🎥'.repeat(250));
assert.ok(headerOk(emoji));
assert.ok(decodeURIComponent(emoji.split("UTF-8''")[1]) === '🎥'.repeat(200));
assert.strictEqual(asciiName('x'.repeat(300)).length, 200);

console.log('object-disposition: ok');
