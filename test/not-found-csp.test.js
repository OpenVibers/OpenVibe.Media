'use strict';
// server/not-found.js: an unknown path gets Express's own 404 page ("Cannot GET /x") under Media's CSP,
// which is default-src 'none' plus Cloudflare Web Analytics (script-src static.cloudflareinsights.com,
// connect-src cloudflareinsights.com). Cloudflare injects the beacon at the edge; Express's default
// policy blocked it and logged a CSP error on every not-found page (browser check, OpenVibe.Host).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { notFound, CSP } = require('../server/not-found');

function send(base, p, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(base + p, { method, headers: { accept: 'text/html' } }, (res) => {
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
        assert.strictEqual(CSP, "default-src 'none'; script-src https://static.cloudflareinsights.com; connect-src https://cloudflareinsights.com");
        assert.strictEqual((await send(base, '/known')).status, 200);

        const r = await send(base, '/__ovcheck-404');
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.headers['content-security-policy'], CSP);
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        assert.match(r.headers['content-type'], /^text\/html/);
        assert.ok(r.body.includes('<pre>Cannot GET /__ovcheck-404</pre>'), r.body);

        const x = await send(base, '/x%3Cb%3E?q=<script>');
        assert.strictEqual(x.status, 404);
        assert.ok(!x.body.includes('<script>'), 'the path is escaped');

        const post = await send(base, '/nope', 'POST');
        assert.ok(post.body.includes('<pre>Cannot POST /nope</pre>'));
        const head = await send(base, '/nope', 'HEAD');
        assert.deepStrictEqual([head.status, head.body], [404, '']);

        // index.js mounts it after every route and before the error handler.
        const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
        const at = idx.indexOf("app.use(require('./not-found').notFound)");
        assert.ok(at > idx.indexOf("app.use('/', require('./public/routes'))"), 'after the last routes');
        assert.ok(at < idx.indexOf('app.use((err, req, res, next) =>'), 'before the error handler');
        console.log('not-found: 404 under Media\'s CSP, Cloudflare Web Analytics allowed');
    } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
