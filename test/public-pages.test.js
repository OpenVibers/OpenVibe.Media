'use strict';
// The public pages: /v and /c watch pages on browser navigation (bytes otherwise),
// the paste redirect to Community, and the OpenVibe Frame + SEO on the pages.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = path.join(os.tmpdir(), `ov-media-pages-${process.pid}.db`);
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';

    const db = require('../server/db/database');
    const pages = require('../server/public/pages');
    const pageFrame = require('../server/public/page-frame');

    // ── wantsHtmlPage: navigations and preview bots get the page, players get bytes ──
    const req = (headers, query = {}) => ({ method: 'GET', headers, query });
    assert.strictEqual(pages.wantsHtmlPage(req({ 'sec-fetch-dest': 'document', accept: 'text/html,*/*' })), true);
    assert.strictEqual(pages.wantsHtmlPage(req({ 'sec-fetch-dest': 'video', accept: 'video/webm,*/*;q=0.5' })), false);
    assert.strictEqual(pages.wantsHtmlPage(req({ 'sec-fetch-dest': 'document', accept: 'text/html' }, { raw: '1' })), false, '?raw=1 always yields bytes');
    assert.strictEqual(pages.wantsHtmlPage(req({ 'sec-fetch-dest': 'document', accept: 'text/html', range: 'bytes=0-' })), false, 'range requests are bytes');
    assert.strictEqual(pages.wantsHtmlPage(req({ accept: 'text/html,application/xhtml+xml' })), true, 'Accept-based fallback');
    assert.strictEqual(pages.wantsHtmlPage(req({ accept: '*/*' })), false, 'curl / fetch defaults get bytes');
    assert.strictEqual(pages.wantsHtmlPage(req({ accept: '*/*', 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)' })), true, 'preview bots get the page');
    assert.strictEqual(pages.wantsHtmlPage({ method: 'POST', headers: { accept: 'text/html' }, query: {} }), false);

    // ── Watch page: SEO + Frame + canonical rules ──
    const vod = {
        id: 42, app_id: 'live', title: 'Late night <build>', description: 'We built a thing & it worked.',
        file_path: '/x/vod-42.mp4', thumbnail_url: '/t/vod-42-1.jpg', duration_seconds: 3725, view_count: 1234,
        is_public: 1, visibility: 'public', created_at: '2026-09-10 20:15:00', ai_overview: 'AI says: nice.',
    };
    const html = pages.renderWatchPage('vod', vod);
    assert.ok(html.includes('<title>Late night &lt;build&gt; — OpenVibe.Media</title>'));
    assert.ok(html.includes('<link rel="canonical" href="https://openvibe.live/vod/42">'), 'Live-owned VOD is canonical on Live');
    assert.ok(html.includes('<meta name="robots" content="noindex, follow">'));
    assert.ok(/\/shared\/theme-loader\.js\?v=[0-9a-f]{12}/.test(html), 'this site\'s own pinned Frame files');
    // The shell loads the theme-loader eagerly (no defer) inside <head>, so it applies the user's
    // theme before the first paint; the page palette rides in the shell's extra head.
    assert.ok(/<script src="[^"]*theme-loader\.js\?v=[0-9a-f]{12}"><\/script>/.test(html), 'theme-loader is eager, before the first paint');
    assert.ok(/\/shared\/web-runtime\.js\?v=[0-9a-f]{12}/.test(html), 'the shared web runtime from this site\'s own pinned copy');
    assert.ok(/\/shared\/navbar\.js\?v=[0-9a-f]{12}/.test(html) && /\/shared\/footer\.js\?v=[0-9a-f]{12}/.test(html), 'the Frame from this site\'s own pinned copy');
    assert.ok(html.includes('"service":"media"') && html.includes('"history":{"type":"vod","title":"Late night <build>"}'.replace('<', '\\u003c')));
    assert.ok(html.includes('data-variant="compact"'), 'the server-rendered footer is compact');
    // openvibe-shared/shell v2.10.0 boots the navbar but not the footer; page-frame adds the init so
    // the "shipped X ago" line fills and the site's links survive a client render.
    assert.ok(html.includes('OpenVibeFooter.init('), 'the footer is initialised client-side');
    assert.ok(html.includes('"mount":"#ov-footer"') && html.includes('"updates":"/updates"') && html.includes('"variant":"compact"'),
        'the footer init carries the mount, this site\'s log and the compact variant');
    assert.ok(html.includes('"links":[{"heading":"Media"'), 'and the site\'s own footer links');
    assert.ok(html.includes('<meta property="og:type" content="video.other">'));
    assert.ok(html.includes('<meta property="og:video" content="https://media.test/v/42?raw=1">'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(html.includes('src="https://media.test/v/42?raw=1"'), 'the player fetches the bytes with ?raw=1');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.strictEqual(ld['@type'], 'VideoObject');
    assert.strictEqual(ld.duration, 'PT1H2M5S');
    assert.strictEqual(ld.uploadDate, '2026-09-10T20:15:00.000Z');
    assert.deepStrictEqual(ld.thumbnailUrl, ['https://media.test/t/vod-42-1.jpg']);
    assert.strictEqual(ld.url, 'https://openvibe.live/vod/42');
    assert.ok(!html.includes('</script>"'), 'no script-closing sequence smuggled through JSON');

    const other = pages.renderWatchPage('clip', { ...vod, id: 7, app_id: 'games', title: 'Frag' });
    assert.ok(other.includes('<link rel="canonical" href="https://media.test/c/7">'), 'non-Live items are self-canonical');
    assert.ok(other.includes('<meta name="robots" content="index, follow">'));
    const unlisted = pages.renderWatchPage('clip', { ...vod, id: 8, app_id: 'games', visibility: 'unlisted' });
    assert.ok(unlisted.includes('content="noindex, follow"'), 'unlisted never indexes');

    // Paste pages are Community's: there is no viewer here (public/routes.js only redirects).
    assert.ok(!/\bfree\b/i.test(html + pageFrame.baseCss()), 'no cost claims in served HTML');

    // ── End to end through the router: navigation → page, ?raw=1 → bytes path ──
    const express = require('express');
    const raw = db.getDb();
    await raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, is_public, visibility, duration_seconds) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, 1, 'public', 10) RETURNING id`).run(42, 'live', 'Router VOD', '/nonexistent/vod-42.mp4');
    const app = express();
    app.use('/', require('../server/public/routes'));
    const server = app.listen(0);
    const port = server.address().port;
    const get = (p, headers) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
            let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
    (async () => {
        const nav = { accept: 'text/html,*/*;q=0.8', 'sec-fetch-dest': 'document' };
        let r = await get('/v/42', nav);
        assert.strictEqual(r.status, 200);
        assert.ok(r.headers['content-type'].startsWith('text/html'));
        assert.ok(r.body.includes('Router VOD') && r.body.includes('id="navbar-mount"'));
        // No Content-Security-Policy on a page response today: the shell composes inline scripts
        // (theme boot, navbar/runtime boot, footer init), so adding a policy later must allow them.
        assert.ok(!('content-security-policy' in r.headers), 'watch pages carry no CSP header');
        assert.ok(/\/shared\/web-runtime\.js\?v=[0-9a-f]{12}/.test(r.body), 'the page ships the shell\'s web-runtime.js');
        r = await get('/v/42?raw=1', nav);
        assert.strictEqual(r.status, 404, 'bytes path (no file on disk → 404 JSON), not the page');
        assert.ok(r.headers['content-type'].startsWith('application/json'));
        r = await get('/v/42', { accept: 'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5', 'sec-fetch-dest': 'video' });
        assert.strictEqual(r.status, 404, 'a <video> element never gets HTML');
        r = await get('/p/slug1', nav);
        assert.deepStrictEqual([r.status, r.headers.location], [301, 'https://openvibe.community/p/slug1'], 'the paste page is a redirect, no row needed');
        r = await get('/og-image.png', {});
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['content-type'], 'image/png');
        server.close();
        for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
        console.log('public pages: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); server.close(); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
