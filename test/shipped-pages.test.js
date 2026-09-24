'use strict';
// The shared update system on openvibe.media: the index shows what shipped, /updates is the log (the
// markup every OpenVibe site renders, from openvibe-shared/frame), the footer links it, and the
// navbar signs out through this site (logoutUrl).
const assert = require('assert');
const pageFrame = require('../server/public/page-frame');
const frame = require('openvibe-shared/frame');

const doc = pageFrame.page({ seo: { title: 'What shipped on OpenVibe.Media', description: 'x', canonical: pageFrame.abs('/updates') }, body: frame.updatesBody({ service: 'media', siteName: 'OpenVibe.Media' }), footer: { variant: 'full' } });
assert.ok(doc.includes('What shipped on OpenVibe.Media') && doc.includes('data-ov-shipped="log" data-service="media"'));
assert.ok(doc.includes('rel="canonical"') && doc.includes('/updates"'));
assert.ok(doc.includes('"updates":"/updates"'), 'the footer links this site\'s log');
assert.ok(doc.includes('"logoutUrl":"/auth/logout?next={path}"'), 'Sign out in the shared navbar ends this site\'s session');
assert.ok(doc.includes('data-ov-shipped="latest" data-service="media" href="/updates"'), 'the footer\'s shipped line');
assert.ok(!/chrome-ssr/.test(require('fs').readFileSync(require.resolve('../server/public/browse.js'), 'utf8')), 'openvibe-shared/frame, not the old name');
console.log('shipped pages: all checks passed');
