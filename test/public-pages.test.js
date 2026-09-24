'use strict';
// The public pages: /v and /c watch pages on browser navigation (bytes otherwise),
// the paste viewer's Community canonical, and the OpenVibe Frame + SEO on all of them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-media-pages-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.MEDIA_PUBLIC_URL = 'https://media.test';

const db = require('../server/db/database');
require('../server/views/service').ensureSchema();
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
assert.ok(html.includes('https://openvibe.network/shared/theme-loader.js'));
assert.ok(html.indexOf('theme-loader.js') < html.indexOf('<style>'), 'theme-loader runs before the styles');
assert.ok(html.includes('https://openvibe.network/shared/navbar.js') && html.includes('https://openvibe.network/shared/footer.js'));
assert.ok(html.includes('"service":"media"') && html.includes('"history":{"type":"vod","title":"Late night <build>"}'.replace('<', '\\u003c')));
assert.ok(html.includes('"variant":"compact"'));
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

// ── Paste viewer: canonical on Community, noindex, Article JSON-LD ──
const paste = { slug: 'abc-123', title: 'hello.js', type: 'paste', content: 'console.log("hi")', language: 'javascript', views: 3, unique_views: 2, created_at: '2026-09-01 10:00:00', updated_at: '2026-09-02 10:00:00', ai_tags: '["js","demo"]' };
const ph = pages.renderPastePage(paste);
assert.ok(ph.includes('<link rel="canonical" href="https://openvibe.community/p/abc-123">'));
assert.ok(ph.includes('<meta name="robots" content="noindex, follow">'));
assert.ok(ph.includes('href="https://openvibe.community/p/abc-123"'), 'header links to the Community page');
assert.ok(ph.includes('console.log(&quot;hi&quot;)'));
assert.ok(ph.includes('"history":{"type":"paste","title":"hello.js"}'));
const pld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(ph)[1]);
assert.strictEqual(pld['@type'], 'Article');
assert.strictEqual(pld.mainEntityOfPage, 'https://openvibe.community/p/abc-123');
assert.strictEqual(pld.keywords, 'js, demo');
const shot = pages.renderPastePage({ ...paste, slug: 'img-1', type: 'screenshot', screenshot_path: '/x/y.png', content: 'a caption' });
assert.ok(shot.includes('<meta property="og:image" content="https://media.test/p/img-1/screenshot">'));
assert.ok(shot.includes('"@type":"ImageObject"'));
assert.ok(!/\bfree\b/i.test(html + ph + shot + pageFrame.baseCss()), 'no cost claims in served HTML');

// ── End to end through the router: navigation → page, ?raw=1 → bytes path ──
const express = require('express');
const raw = db.getDb();
raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, is_public, visibility, duration_seconds) VALUES (?, ?, ?, ?, 1, 'public', 10)`).run(42, 'live', 'Router VOD', '/nonexistent/vod-42.mp4');
raw.prepare(`INSERT INTO pastes (slug, app_id, title, type, content, language, visibility) VALUES (?, 'live', 'P', 'paste', 'x', 'text', 'public')`).run('slug1');
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
    r = await get('/v/42?raw=1', nav);
    assert.strictEqual(r.status, 404, 'bytes path (no file on disk → 404 JSON), not the page');
    assert.ok(r.headers['content-type'].startsWith('application/json'));
    r = await get('/v/42', { accept: 'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5', 'sec-fetch-dest': 'video' });
    assert.strictEqual(r.status, 404, 'a <video> element never gets HTML');
    r = await get('/p/slug1', nav);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('https://openvibe.community/p/slug1'));
    r = await get('/og-image.png', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/png');
    server.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    console.log('public pages: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
