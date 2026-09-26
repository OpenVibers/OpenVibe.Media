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
console.log('theme default: all checks passed');
