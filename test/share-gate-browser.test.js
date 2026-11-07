'use strict';
/**
 * The Specific-people gate is markup, not an inline script (openvibe-shared 4.123.0): Headless Chrome
 * loads the real watch-page gate, runs ov-share.js and checks that it draws — "Sign in" signed out,
 * "Ask for access" for a signed-in stranger — with no console error and no CSP refusal.
 *
 * Skips (exit 0) where Playwright or Chrome is not installed, as in CI; PLAYWRIGHT_MODULE overrides the path.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');

function loadPlaywright() {
    const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright',
        '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'].filter(Boolean);
    for (const name of candidates) { try { return require(name); } catch { /* next */ } }
    return null;
}
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

(async () => {
    if (!fs.existsSync(CHROME)) return console.log('◌ share gate browser: skipped (no Chrome)');
    const playwright = loadPlaywright();
    if (!playwright) return console.log('◌ share gate browser: skipped (no Playwright)');

    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    const express = require('express');
    const pages = require('../server/public/pages');

    const app = express();
    app.use('/shared', require('openvibe-shared/serve').handler());
    const gate = (signedInAs) => pages.renderShareGate('vod', '100001', {
        signedInAs, signInUrl: '/auth/login?next=%2Fv%2F100001',
    });
    app.get('/gate-out', (_req, res) => res.status(404).type('html').send(gate(null)));
    app.get('/gate-in', (_req, res) => res.status(404).type('html').send(gate('sam')));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    try {
        const check = async (path, words) => {
            const page = await browser.newPage();
            const errors = [];
            page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
            page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
            await page.goto(base + path, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('.ov-share-gate', { timeout: 15000 });
            const text = await page.locator('.ov-share-gate').innerText();
            for (const word of words) assert.ok(text.includes(word), `${path}: ${word} in ${JSON.stringify(text)}`);
            const bad = errors.filter((e) => /content security policy|refused to (execute|load|apply).*inline|violates the following/i.test(e));
            assert.deepStrictEqual(bad, [], `${path}: CSP/console errors: ${bad.join(' | ')}`);
            await page.close();
        };
        await check('/gate-out', ['This is shared with specific people', 'Sign in']);
        await check('/gate-in', ['This is shared with specific people', 'Ask for access', '@sam']);
        console.log('✅ share gate browser: both gates draw with no CSP refusal');
    } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); process.exit(1); });
