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
        is_public: 1, visibility: 'public', created_at: '2026-09-10 20:15:00', ai_overview: 'AI says: nice.', username: 'maker',
    };
    const html = pages.renderWatchPage('vod', vod);
    assert.ok(html.includes('<title>Late night &lt;build&gt; — OpenVibe.Media</title>'));
    assert.ok(html.includes('<link rel="canonical" href="https://openvibe.video/v/42">'), 'Live-owned VOD is canonical on OpenVibe.Video');
    // The browse cards' "VOD page" and "Clip page" links use the same rule: Live's on OpenVibe.Video, another app's own.
    assert.strictEqual(pageFrame.watchPageUrl('vod', 'live', 42), 'https://openvibe.video/v/42');
    assert.strictEqual(pageFrame.watchPageUrl('clip', null, 9), 'https://openvibe.video/c/9');
    assert.strictEqual(pageFrame.watchPageUrl('vod', 'games', 3), 'https://openvibe.games/vod/3');
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
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.strictEqual(scripts.length, 1);
    const ld = JSON.parse(scripts[0][1])['@graph'][0];
    assert.strictEqual(ld['@type'], 'VideoObject');
    assert.strictEqual(ld.duration, 'PT1H2M5S');
    assert.strictEqual(ld.uploadDate, '2026-09-10T20:15:00.000Z');
    assert.deepStrictEqual(ld.thumbnailUrl, ['https://media.test/t/vod-42-1.jpg']);
    assert.strictEqual(ld.url, 'https://openvibe.video/v/42');
    assert.deepStrictEqual(ld.creator, { '@type': 'Person', name: 'maker', url: 'https://openvibe.video/@maker' });
    assert.deepStrictEqual(ld.author, ld.creator);
    assert.strictEqual(ld.isLiveBroadcast, undefined);
    assert.ok(!pages.renderWatchPage('vod', { ...vod, username: null }).includes('application/ld+json'), 'unknown maker has no invented attribution');
    assert.ok(!html.includes('</script>"'), 'no script-closing sequence smuggled through JSON');

    const other = pages.renderWatchPage('clip', { ...vod, id: 7, app_id: 'games', title: 'Frag' });
    assert.ok(other.includes('<link rel="canonical" href="https://media.test/c/7">'), 'non-Live items are self-canonical');
    assert.ok(other.includes('<meta name="robots" content="index, follow">'));
    const unlisted = pages.renderWatchPage('clip', { ...vod, id: 8, app_id: 'games', visibility: 'unlisted' });
    assert.ok(unlisted.includes('content="noindex, follow"'), 'unlisted never indexes');
    // The AI summary (openvibe-shared/seo pageSummary) on public watch pages: description, canonical, facts.
    assert.ok(html.includes('<meta name="ai-summary" content="We built a thing &amp; it worked.">'), 'the watch page carries the AI summary');
    assert.ok(html.includes('<li>Duration: 1:02:05</li>') && html.includes('<li>Views: 1,234</li>'), 'with its facts');
    assert.ok(html.includes('"@type":"WebPage"') && html.includes('"url":"https://openvibe.video/v/42"'), 'its WebPage names the canonical');
    assert.ok(!unlisted.includes('name="ai-summary"'), 'unlisted pages carry none');

    // ── Next-step cards (Shared ADR 0002, D94): real, signed-out targets, ov_from=media, at most four ──
    const config = require('../server/config');
    const cards = (page) => [...page.matchAll(/<a class="sc-next-main" href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const checkCards = (page, label) => {
        const hrefs = cards(page);
        assert.ok(hrefs.length >= 1 && hrefs.length <= 4, `${label}: one to four cards (${hrefs.length})`);
        hrefs.forEach((href) => {
            assert.ok(/^https:\/\/openvibe\.[a-z]+(\/|$)/.test(href) || href.startsWith('/') || href.startsWith(`${config.publicUrl}/`),
                `${label}: ${href} is an OpenVibe zone, site-relative or this site`);
            assert.strictEqual(new URL(href, config.publicUrl).search, '?ov_from=media', `${label}: ${href} carries ov_from=media and no other query`);
        });
        return hrefs;
    };
    // A playable public Live-owned VOD: the Live card (the canonical) and the index; no clip-cutting card on a VOD.
    assert.ok(html.includes('class="sc-sec sc-next"') && html.includes('<ol class="sc-next-list">'), 'a playable public VOD page carries the next-step cards');
    assert.deepStrictEqual(checkCards(html, 'Live VOD'), ['https://openvibe.video/v/42?ov_from=media', 'https://media.test/?ov_from=media'],
        'a Live-owned item\'s card is its canonical; the index card is always there');
    // A VOD another app owns: only the index.
    assert.deepStrictEqual(checkCards(pages.renderWatchPage('vod', { ...vod, id: 43, app_id: 'games' }), 'games VOD'), ['https://media.test/?ov_from=media']);
    // A playable person-cut clip on Live: Live, cut your own, the index.
    assert.deepStrictEqual(checkCards(pages.renderWatchPage('clip', { ...vod, id: 9 }), 'Live clip'),
        ['https://openvibe.video/c/9?ov_from=media', 'https://openvibe.live/?ov_from=media', 'https://media.test/?ov_from=media']);
    // An AI clip with a source VOD: every card applies, and four is the most that render.
    const sourceVod = (fields = {}) => ({ id: 42, visibility: 'public', is_public: 1, clips_only: 0, is_recording: 0, playable: true, ...fields });
    const aiClip = pages.renderWatchPage('clip', { ...vod, id: 10, auto_generated: 1, vod_id: 42, source_vod: sourceVod() });
    assert.deepStrictEqual(checkCards(aiClip, 'AI clip'), ['https://openvibe.video/c/10?ov_from=media', 'https://media.test/v/42?ov_from=media',
        'https://openvibe.live/?ov_from=media', 'https://media.test/?ov_from=media'], 'a clip with a source VOD shows the VOD card');
    assert.ok(aiClip.includes('See the VOD this clip came from'));
    assert.strictEqual((aiClip.match(/class="sc-next-item"/g) || []).length, 4, 'at most four cards');
    // A source VOD that /v/:id would not answer 200 for: no link card and no isBasedOn.
    const noSource = (source) => pages.renderWatchPage('clip', { ...vod, id: 12, auto_generated: 1, vod_id: 42, ...(source === undefined ? {} : { source_vod: source }) });
    for (const [label, page] of [
        ['private', noSource(sourceVod({ visibility: 'private', is_public: 0 }))],
        ['missing', noSource(undefined)],
        ['still recording', noSource(sourceVod({ is_recording: 1 }))],
        ['not playable', noSource(sourceVod({ playable: false }))],
    ]) {
        assert.ok(!page.includes('See the VOD this clip came from'), `${label} source VOD shows no link card`);
        assert.ok(!page.includes('"isBasedOn"'), `${label} source VOD is not isBasedOn`);
        assert.ok(!checkCards(page, label).some((href) => /\/v\/42/.test(href)), `${label} source VOD adds no card`);
    }
    // A clip without a player offers no clip-cutting card.
    const pending = pages.renderWatchPage('clip', { ...vod, id: 11 }, { playable: false, reason: 'processing' });
    assert.ok(!cards(pending).includes('https://openvibe.live/?ov_from=media'), 'no "go live" card without a player');

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
        assert.ok(r.body.includes('<main id="main">'));
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
        r = await get('/', nav);
        assert.strictEqual(r.status, 200);
        const ld = [...r.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => JSON.parse(m[1])['@graph'] || []);
        assert.ok(ld.some((x) => x['@type'] === 'WebSite'), 'the index names the site');
        const list = ld.find((x) => x['@type'] === 'ItemList');
        assert.ok(list && list.itemListElement.length >= 1 && list.itemListElement.every((it) => /^https?:\/\//.test(it.url)), 'the listed cards, with absolute URLs');
        const h1s = (html) => (html.match(/<h1[\s>]/g) || []).length;
        assert.ok(r.body.includes('class="sc-hero'), 'the index opens with the showcase hero');
        assert.ok(/\/shared\/showcase\.css\?v=[0-9a-f]{12}/.test(r.body), 'the kit stylesheet, through ovServe');
        assert.ok(r.body.includes('id="navbar-mount"') && r.body.includes('<main id="main">'));
        assert.ok(r.body.includes('<meta name="ai-summary"'), 'the index carries the AI summary');
        assert.ok(ld.some((x) => x['@type'] === 'WebPage'), 'the summary\'s WebPage');
        assert.strictEqual(h1s(r.body), 1, 'exactly one <h1>');
        assert.strictEqual((r.body.match(/<!doctype/gi) || []).length, 1, 'one document');
        // The front page is a taste and a door: the newest items as a rail, the kinds that have items as filters, and
        // See all → the index (/?tab=all), which keeps every tab and the pager.
        assert.ok(r.body.includes('class="ovk-rail') && r.body.includes('class="ovk-card'), 'the newest items as a rail of cards');
        assert.ok(r.body.includes('href="/?tab=all"') && /See all [0-9,]+/.test(r.body), 'See all opens the index');
        assert.ok(/\/shared\/room\.css\?v=/.test(r.body) && !/\/shared\/kit\.css\?v=/.test(r.body) && !/\/shared\/kit-web\.js/.test(r.body), 'only the cards\' and rails\' look (room.css), no kit.css or kit-web.js');
        assert.ok(!r.body.includes('class="pager"'), 'no pager on the front page');
        const index = await get('/?tab=all', nav);
        for (const k of ['all', 'videos', 'clips', 'emotes', 'sounds', 'thumbnails', 'files']) assert.ok(index.body.includes(`href="/?tab=${k}"`), `tab ${k}`);
        assert.ok(index.body.includes('class="pager"') && index.body.includes('Page 1 /') && !index.body.includes('class="sc-hero'), 'the index: every tab, the pager, no hero');
        assert.ok(r.body.includes('<meta name="robots" content="index, follow">'));
        // The front page is also Media's public home for developers: what it does, how an app uses it, the limits it
        // enforces (limitsOf, the same numbers as /limits.json) and the questions, which are FAQPage data too.
        assert.ok(r.body.includes('<title>OpenVibe.Media: open media and object storage'), 'the title says what it is');
        for (const id of ['media', 'what', 'api', 'questions']) assert.ok(r.body.includes(`id="${id}"`), `the home has #${id}`);
        assert.ok(r.body.includes('sc-limits') && r.body.includes('/limits.json'), 'the limits table and its source');
        const faq = ld.find((x) => x['@type'] === 'FAQPage');
        assert.ok(faq && faq.mainEntity.length >= 5, 'FAQPage data');
        for (const q of faq.mainEntity) assert.ok(r.body.includes(`<summary>${q.name.replace(/'/g, '&#39;')}</summary>`) || r.body.includes(`<summary>${q.name}</summary>`), `the page asks "${q.name}"`);
        r = await get('/?tab=videos', nav);
        assert.ok(!r.body.includes('class="sc-hero') && h1s(r.body) === 1, 'the hero is the front page\'s only');
        assert.ok(!r.body.includes('id="questions"') && !r.body.includes('FAQPage'), 'the developer half is the front page\'s only');
        r = await get('/?page=2', nav);
        assert.ok(!r.body.includes('application/ld+json'), 'a later (noindex) page carries none');
        assert.ok(!r.body.includes('class="sc-hero') && h1s(r.body) === 1, 'no hero after page 1');
        assert.ok(r.body.includes('<meta name="robots" content="noindex, follow">'));
        assert.ok(r.body.includes('Page 2 /') && r.body.includes('href="/?tab=all&page=1"'), 'the pager links back');
        r = await get('/og-image.png', {});
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['content-type'], 'image/png');
        server.close();
        for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
        console.log('public pages: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); server.close(); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
