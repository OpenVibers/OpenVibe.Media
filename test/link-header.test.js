'use strict';
// SEO-24: a page that names its Markdown twin and llms.txt in its head says the same in a Link: header.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { linkHeader, linksOf } = require('../server/link-header');

const page = (head) => `<!doctype html><html><head><title>A page</title>${head}</head><body><link rel="describedby" href="/not-the-head"></body></html>`;
const TWIN = '<link rel="alternate" type="application/rss+xml" href="/feed.xml">'
    + '<link rel="alternate" type="text/markdown" href="https://site.test/q?a=1&amp;b=2.md">\n<link rel="describedby" href="/llms.txt">';

assert.strictEqual(linksOf(page(TWIN)), '<https://site.test/q?a=1&b=2.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    'the header names what the head names, unescaped once');
assert.strictEqual(linksOf(page('<link rel="alternate" type="application/rss+xml" href="/feed.xml">')), null, 'a head with no twin: no header');
assert.strictEqual(linksOf('<p>no head</p>'), null);
assert.strictEqual(linksOf(page("<link type='text/markdown' rel='alternate' href='/x.md'><link href='/llms.txt' rel='describedby'>")),
    '</x.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"', 'attribute order and quotes do not matter');
assert.strictEqual(linksOf(page('<link rel="alternate" type="text/markdown" href="/a&quot;b&lt;c.md"><link rel="describedby" href="/llms.txt">')).split(', ')[0],
    '</a%22b%3Cc.md>; rel="alternate"; type="text/markdown"', 'a quote or bracket in an address is encoded, never raw in the header');

function run({ method = 'GET', status = 200, type, link, body }) {
    const headers = {};
    if (type) headers['content-type'] = type;
    if (link) headers.link = link;
    const res = {
        statusCode: status,
        get: (k) => headers[k.toLowerCase()],
        set(k, v) { headers[k.toLowerCase()] = v; return this; },
        send(b) { this.sent = b; return this; },
    };
    let called = false;
    linkHeader()({ method }, res, () => { called = true; });
    assert.ok(called, 'the middleware always passes on');
    res.send(body);
    return headers.link;
}

assert.match(run({ body: page(TWIN) }), /rel="alternate"; type="text\/markdown"/, 'a 200 HTML page gets the header');
assert.match(run({ method: 'HEAD', type: 'text/html; charset=utf-8', body: page(TWIN) }), /rel="describedby"/, 'HEAD too');
assert.strictEqual(run({ status: 404, body: page(TWIN) }), undefined, 'a page that was not found: none');
assert.strictEqual(run({ type: 'application/json', body: page(TWIN) }), undefined, 'not HTML: none');
assert.strictEqual(run({ method: 'POST', body: page(TWIN) }), undefined, 'a form post: none');
assert.strictEqual(run({ link: '</other>; rel="next"', body: page(TWIN) }), '</other>; rel="next"', 'a header the page set itself stays');
assert.strictEqual(run({ body: page('') }), undefined, 'a page whose head names no twin: none');

const app = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');
assert.match(app, /app\.use\(require\('\.\/link-header'\)\.linkHeader\(\)\);/, 'the app mounts it before its page routes');
console.log('link-header: ok');
