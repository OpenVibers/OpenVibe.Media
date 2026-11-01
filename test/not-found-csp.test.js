'use strict';
// server/not-found.js: an unknown path asks for Media's own 404 page in the OpenVibe Frame when the client
// accepts HTML; an API caller, a player, or any client that does not want a page keeps the JSON answer.
// The page never echoes the path or method that was asked for, and its CSP still lets Cloudflare's beacon
// load and report (Cloudflare injects it at the edge; Media's pages send no policy of their own).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
(async () => {
    const { notFound, CSP } = require('../server/not-found');

    function send(base, p, method = 'GET', accept = 'text/html') {
        return new Promise((resolve, reject) => {
            const req = http.request(base + p, { method, headers: { accept } }, (res) => {
                let b = ''; res.on('data', (d) => { b += d; });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
            });
            req.on('error', reject); req.end();
        });
    }

    (async () => {
        const app = express();
        app.get('/known', (req, res) => res.send('ok'));
        app.use(notFound);
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            assert.match(CSP, /^default-src 'self'/);
            assert.match(CSP, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
            assert.match(CSP, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
            assert.strictEqual((await send(base, '/known')).status, 200);

            const r = await send(base, '/__ovcheck-404');
            assert.strictEqual(r.status, 404);
            assert.strictEqual(r.headers['content-security-policy'], CSP);
            assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
            assert.strictEqual(r.headers['x-robots-tag'], 'noindex');
            assert.match(r.headers['content-type'], /^text\/html/);
            assert.ok(r.body.includes('<h1>Page not found</h1>'), r.body.slice(0, 300));
            assert.match(r.body, /There is no page at this address on [^<]+\. The link may be old or mistyped\./);
            assert.ok(r.body.includes('id="navbar-mount"'), 'the page is in the site Frame');
            assert.ok(r.body.includes('<meta name="robots" content="noindex, follow">'));
            assert.ok(!r.body.includes('__ovcheck-404'), 'the page never names the path that was asked for');

            // The path and the query are not echoed; every missing path gets the same page.
            const x = await send(base, '/x%3Cb%3E?q=<script>');
            assert.strictEqual(x.status, 404);
            assert.strictEqual(x.body, r.body, 'one 404 page, whatever was asked for');
            assert.ok(!x.body.includes('<pre>Cannot'));

            // An API path, a POST or a client that does not accept HTML keeps the JSON answer.
            for (const [p, method, accept] of [['/api/nope', 'GET', 'text/html'], ['/nope', 'GET', 'application/json'], ['/nope', 'POST', 'text/html']]) {
                const j = await send(base, p, method, accept);
                assert.strictEqual(j.status, 404, `${method} ${p}`);
                assert.match(j.headers['content-type'], /^application\/json/);
                assert.deepStrictEqual(JSON.parse(j.body), { error: 'Not found' });
            }
            const head = await send(base, '/nope', 'HEAD');
            assert.deepStrictEqual([head.status, head.body], [404, '']);

            // index.js mounts it after every route and before the error handler.
            const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
            const at = idx.indexOf("app.use(require('./not-found').notFound)");
            assert.ok(at > idx.indexOf("app.use('/', require('./public/routes'))"), 'after the last routes');
            assert.ok(at < idx.indexOf('app.use((err, req, res, next) =>'), 'before the error handler');
            console.log('not-found: 404 in Media\'s Frame for a browser, JSON for an API caller');
        } finally { server.close(); }
    })().catch((e) => { console.error(e); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
