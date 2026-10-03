'use strict';
// The README documents the shared libraries Media pins by release tarball. The pin and the lockfile move
// together (ov bump), but the README's copy was left behind on the openvibe-shared v2.3.1 → v2.5.0 bump —
// the doc drift this guards. Every pinned tag in package.json must be the version the README names.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const PIN = /OpenVibers\/OpenVibe\.[A-Za-z]+\/tar\.gz\/refs\/tags\/v(\d+\.\d+\.\d+)$/;
let pinned = 0;
for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (!name.startsWith('openvibe-')) continue;
    const m = PIN.exec(String(spec));
    if (!m) continue;
    pinned++;
    assert.ok(new RegExp(`${name.replace(/\./g, '\\.')}\`? v${m[1]}`).test(readme), `README names ${name} v${m[1]}, the pinned tag`);
}
assert.ok(pinned >= 3, `the README's pin list covers every tarball pin (found ${pinned})`);
console.log(`pins: README matches ${pinned} pinned release tarballs`);
