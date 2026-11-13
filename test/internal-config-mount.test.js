'use strict';
// The owner's Setup reads Media's settings (2026-11-13): Network's /admin/setup and its guide read every service at
// /internal/config with a Network service token for <service>.config.manage. Media had no such route, so the guide said
// "OpenVibe.Media did not answer". It is mounted behind the service guard (loopback, a token holding
// media.config.manage) with openvibe-shared/config's routes over Media's two storage policies.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
assert.ok(/app\.use\('\/internal\/config', require\('\.\/service-guard'\)\.guard\('media\.config\.manage'\)/.test(src), 'mounted behind the service guard for media.config.manage');
assert.ok(/require\('openvibe-shared\/config'\)\.adminRoutes\(\[vodStorage\.tierConfig\.get\(vodStorage\.DEFAULTS\), require\('\.\/objects\/tier-policy'\)\.get\(\)\], \{\s*basePath: '\/'/.test(src), 'the two storage policies, at the mount\'s root');
assert.ok(typeof require('openvibe-shared/config').adminRoutes === 'function', 'openvibe-shared/config has the routes');
console.log('internal-config-mount: /internal/config answers Network\'s Setup with Media\'s two policies, behind media.config.manage');
