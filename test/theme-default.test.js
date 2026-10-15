'use strict';
// ADR-024 (WS-E task 1): Media's pages define the default theme's tokens themselves, so they paint with the
// default theme when openvibe.network (the theme loader) is unreachable. The browser check's --network-down
// run found --accent undefined here on 2026-09-26 (the styles used fallbacks, shared components did not).
const assert = require('assert');
(async () => {
    const { baseCss } = require('../server/public/page-frame');
    const { DEFAULT_VARS } = require('openvibe-shared/builtin-themes');

    const css = baseCss();
    for (const k of ['--accent', '--bg-primary', '--text-primary']) {
        assert.ok(DEFAULT_VARS[k], `openvibe-shared has a default ${k}`);
        assert.ok(css.includes(`${k}:${DEFAULT_VARS[k]}`), `the page defines ${k} as the default theme does`);
    }
    assert.ok(!/url\(|;\s*}/.test(css.split('\n').find((l) => l.includes('--accent:')) || ''), 'only plain token values');
    // A filled button is white on the strong accent (AA); white on --accent is 3.7:1 (axe color-contrast on /v/:id).
    assert.ok(/\.btn \{[^}]*background: var\(--accent-strong, #2563eb\); color: var\(--on-accent-strong, #fff\)/.test(css), 'buttons use the strong accent');
    // The index page (browse.js) is composed by page-frame too, so it carries the same tokens.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'public', 'browse.js'), 'utf8');
    assert.ok(/pageFrame\.page\(/.test(src) && !/<!DOCTYPE/i.test(src), 'browse.js renders through page-frame, not its own document');
    console.log('theme default: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
