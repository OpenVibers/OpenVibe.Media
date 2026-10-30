'use strict';
// The home on a phone (the owner's short-pages rule, 2026-10-30): the code samples are one pick block, a row of chips
// picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for the chips;
// every block stays in the page for crawlers; a wider screen shows them all and no chips.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = path.join(os.tmpdir(), `ov-media-short-${process.pid}.db`);
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_PGLITE_DIR = path.join(os.tmpdir(), `ov-media-short-${process.pid}-pglite`);

    const db = require('../server/db/database');
    await db.initDb();

    const express = require('express');
    const app = express();
    app.use('/', require('../server/public/routes'));
    const server = app.listen(0);
    const port = server.address().port;
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p, headers: { accept: 'text/html,*/*;q=0.8', 'sec-fetch-dest': 'document' } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });

    try {
        const r = await get('/');
        assert.strictEqual(r.status, 200);
        const text = r.body;

        // The code samples: one pick block, a chip per sample, the first one picked.
        assert.ok(text.includes('<div class="pick" id="pick-api">'), 'the code samples are one pick block');
        assert.match(text, /<div class="pick-row" role="radiogroup" aria-label="The ways to call Media">/);
        const chips = [...text.matchAll(/<input type="radio" name="pick-api" id="pk-api-([a-z0-9-]+)" value="\1"( checked)?><label for="pk-api-\1">([^<]+)<\/label>/g)];
        assert.deepStrictEqual(chips.map((m) => m[1]), ['thumbnail', 'node', 's3'], 'a chip per sample');
        assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), ['thumbnail'], 'the first sample is picked');
        assert.strictEqual((text.match(/class="pick-pane"/g) || []).length, chips.length, 'one pane per chip');
        // Every sample stays in the page for the crawlers.
        for (const label of ['Thumbnail', 'Node (openvibe-sdk)', 'S3 (any tool)']) {
            assert.ok(text.includes(`<figcaption>${label}</figcaption>`), `${label} is in the page`);
        }
        // The rule that shows the picked sample is written for this page.
        assert.ok(text.includes('.pick:has(#pk-api-thumbnail:checked) #pp-api-thumbnail{display:block}'), 'the picked sample shows');

        // The folds: open in the page, closed on a phone, and their content stays in the page.
        for (const id of ['what', 'limits', 'questions', 'shipped']) {
            assert.ok(text.includes(`<details class="md-fold md-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
            assert.ok(text.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
        }
        assert.ok(text.includes('Objects and S3'), 'what it does is still in the page');
        assert.ok(text.includes('sc-limits'), 'the limits table is still in the page');
        assert.ok(text.includes('Do I need an account to watch?'), 'the questions are still in the page');
        assert.ok(text.includes('ov-shipped-home'), 'what shipped is still in the page');

        // The hero and the first useful thing stay where they are.
        assert.match(text, /<h1[\s>]/, 'the hero is still there');
        assert.ok(text.includes('Browse public media'), 'the newest media is still the first thing to reach');
        assert.ok(text.includes('class="sc-sec sc-media"'), 'the newest media rail is still there');
        assert.ok(text.includes('id="api"'), 'the code samples are still there, under their own anchor');

        // The CSS guard: the chips are hidden and the blocks all show until 640 px and where :has() is understood.
        const css = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'browse.js'), 'utf8');
        assert.match(css, /\.pick-row\{display:none\}/, 'the chips are hidden by default');
        assert.match(css, /@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{/, 'the phone rules are under :has() and 640 px');
        assert.match(css, /\.pick-row label\{[^}]*min-height:44px/, 'a chip is a 44 px target');
        assert.match(css, /\.pick-pane\{display:none\}/, 'the blocks are hidden on a phone');

        console.log('home short: all checks passed');
    } finally {
        server.close();
        for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* nothing to clean */ } }
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
