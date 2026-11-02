'use strict';
// A missing, private or unread recording or clip: a browser that navigates there gets the site's own 404 page
// (the same frame and look as every other page), an API client or a player keeps the JSON answer, and the page
// never says what was asked for — a private item looks exactly like a missing one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-404-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';

    const express = require('express');
    const notFoundPage = require('../server/public/not-found-page');
    const app = express();
    app.use('/', require('../server/public/routes'));
    const server = http.createServer(app);

    const nav = { accept: 'text/html,*/*;q=0.8', 'sec-fetch-dest': 'document' };
    const api = { accept: 'application/json' };
    const player = { accept: 'video/webm,*/*;q=0.5', 'sec-fetch-dest': 'video' };

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p, headers = {}) => {
        const res = await fetch(base + p, { headers });
        return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
    };
    try {
        // ── A browser gets the site's own 404 page ──
        for (const p of ['/v/999999', '/c/999999', '/v/not-a-number']) {
            const r = await get(p, nav);
            assert.strictEqual(r.status, 404, p);
            assert.match(r.type, /^text\/html/, p);
            assert.ok(r.text.includes('<title>Not found — OpenVibe.Media</title>'), p);
            assert.ok(r.text.includes('data-variant="compact"'), 'the page is in the site frame');
            assert.ok(r.text.includes('<meta name="robots" content="noindex, follow">'), 'a page that does not exist is not indexed');
            assert.ok(!r.text.includes('999999') && !r.text.includes('not-a-number'), 'the page never names what was asked for');
        }
        // Every page answers the same way: one 404 page, whatever was asked for.
        const one = await get('/v/999999', nav);
        const two = await get('/c/999999', nav);
        assert.strictEqual(one.text, two.text, 'the same page for every missing item');

        // ── An API client or a player keeps the JSON answer ──
        for (const [p, headers] of [['/v/999999', api], ['/c/999999', api], ['/v/999999', player], ['/v/999999', {}]]) {
            const r = await get(p, headers);
            assert.strictEqual(r.status, 404, p);
            assert.match(r.type, /^application\/json/, p);
            assert.deepStrictEqual(JSON.parse(r.text), { error: 'Not found' }, p);
        }

        // ── The page itself ──
        const html = notFoundPage.renderNotFound();
        assert.ok(html.includes('<title>Not found — OpenVibe.Media</title>'));
        assert.ok(html.includes('this site\'s own pinned copy') || html.includes('theme-loader'), 'the site frame is there');
        assert.ok(html.includes('Browse everything on Media'), 'the page offers the way back');
        console.log('public-not-found: a browser gets the site\'s 404 page, an API client keeps the JSON');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
