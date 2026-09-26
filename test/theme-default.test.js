'use strict';
// ADR-024 (WS-E task 1): Media's pages define the default theme's tokens themselves, so they paint with the
// default theme when openvibe.network (the theme loader) is unreachable. The browser check's --network-down
// run found --accent undefined here on 2026-09-26 (the styles used fallbacks, shared components did not).
const assert = require('assert');
const { baseCss } = require('../server/public/page-frame');
const { DEFAULT_VARS } = require('openvibe-shared/builtin-themes');

const css = baseCss();
for (const k of ['--accent', '--bg-primary', '--text-primary']) {
    assert.ok(DEFAULT_VARS[k], `openvibe-shared has a default ${k}`);
    assert.ok(css.includes(`${k}:${DEFAULT_VARS[k]}`), `the page defines ${k} as the default theme does`);
}
assert.ok(!/url\(|;\s*}/.test(css.split('\n').find((l) => l.includes('--accent:')) || ''), 'only plain token values');
// The index page (browse.js) writes its own <style>: it carries the same tokens.
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'public', 'browse.js'), 'utf8');
assert.ok(/<style>\n\$\{DEFAULT_THEME_CSS \?/.test(src), 'browse.js puts the default tokens first in its style');
console.log('theme default: all checks passed');
