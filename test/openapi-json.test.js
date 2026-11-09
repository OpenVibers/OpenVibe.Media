'use strict';
// SEO-3: /openapi.json answered 404 here (11-03). It is the contracts' OpenAPI 3.1 document for this service
// (openvibe-contracts), without the operations they mark internal-only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const doc = require('openvibe-contracts').openapi.document('media');
assert.ok(doc && doc.openapi && /^3\.1/.test(doc.openapi), 'the contracts carry an OpenAPI 3.1 document for media');
assert.ok(doc.paths['/api/v2/{app}/objects']?.post, 'upload creation is described');
assert.ok(doc.paths['/api/v2/{app}/objects/{id}/multipart/{uploadId}']?.get, 'upload resume status is described');
assert.ok(doc.paths['/api/v2/{app}/objects/{id}/multipart/{uploadId}/parts/{n}']?.put, 'part upload is described');
assert.ok(doc.paths['/api/v2/{app}/objects/{id}/multipart/{uploadId}/complete']?.post, 'completion is described');
const src = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');
assert.match(src, /app\.get\('\/openapi\.json'/, 'the route is mounted');
assert.match(src, /openapi\.document\('media'\)/);
assert.match(src, /vis\.every\(\(v\) => v === 'internal'\)\) continue;/, 'internal-only operations are left out');
console.log('openapi.json: ok');
