'use strict';
// Server and scripts must leave the frozen paste tables to Community.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tableSql = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:"?\w+"?\.)?"?(?:pastes|paste_likes|paste_comments)"?\b/gi;
const found = [];
for (const folder of ['server', 'scripts']) {
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile() && /\.(?:js|sh)$/.test(entry.name)) {
                const source = fs.readFileSync(file, 'utf8');
                for (const match of source.matchAll(tableSql)) found.push(`${path.relative(root, file)}: ${match[0]}`);
            }
        }
    };
    walk(path.join(root, folder));
}
assert.deepStrictEqual(found, [], `legacy paste table SQL remains:\n${found.join('\n')}`);
console.log('paste tables unread: all checks passed');
