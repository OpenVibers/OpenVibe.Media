'use strict';
// The home on a phone (the owner's short-pages rule, 2026-10-30): the code samples are one pick block, a row of chips
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
        assert.match(text, /<nav class="pick-row" aria-label="The ways to call Media">/);
        const chips = [...text.matchAll(/<a class="pick-chip" href="#(?:pp-api-)?([a-z0-9-]+)">()([^<]+)<\/a>/g)];
        assert.deepStrictEqual(chips.map((m) => m[1]), ['thumbnail', 'node', 's3'], 'a chip per sample');
        assert.ok(!/type="radio"/.test(text), 'no chip is a radio: nothing is picked, every pane shows');
        assert.strictEqual((text.match(/class="pick-pane"/g) || []).length, chips.length, 'one pane per chip');
        // Every sample stays in the page for the crawlers.
        for (const label of ['Thumbnail', 'Node (openvibe-sdk)', 'S3 (any tool)']) {
            assert.ok(text.includes(`<figcaption>${label}</figcaption>`), `${label} is in the page`);
        }

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

        const css = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'browse.js'), 'utf8');
        assert.match(css, /\.pick-head,\.pick-row\{display:none\}/, 'no chips where there is room');
        assert.doesNotMatch(css, /\.pick-pane\{display:none\}/, 'no pane is ever hidden (the owner, 2026-10-31)');
        assert.match(css, /\.pick-chip\{/, 'the chips are links');

        console.log('home short: all checks passed');
    } finally {
        server.close();
        for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* nothing to clean */ } }
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
