'use strict';

// The deployed code's commit time. RELEASE_AT is the release manifest's override.
const path = require('path');
const { execFileSync } = require('child_process');

let value = process.env.RELEASE_AT;
if (!value) {
    try { value = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 2000 }).trim(); }
    catch { /* A source archive without release metadata has no defensible lastmod. */ }
}
module.exports = value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
