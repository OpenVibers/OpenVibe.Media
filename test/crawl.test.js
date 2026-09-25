'use strict';
// Crawler basics at the origin (server/public/crawl.js, pages.js): /robots.txt names the sitemap and
// keeps APIs out; /sitemap.xml lists the home and the watch pages Media is canonical for (public,
// ready, playable: a copy whose bytes were verified; not Live's, not AI clips, never
// private/unlisted/sandbox), and every listed page renders `index, follow`; /llms.txt maps the site;
// public watch pages carry a VideoObject; AI clips are noindex with no Person author, like on Live.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-crawl-'));
Object.assign(process.env, { DB_PATH: path.join(tmp, 'media.db'), MEDIA_PUBLIC_URL: 'https://media.test', VOD_PATH: path.join(tmp, 'vods'), CLIPS_PATH: path.join(tmp, 'clips') });

const db = require('../server/db/database');
require('../server/views/service').ensureSchema();
const pages = require('../server/public/pages');

db.upsertApp({ app_id: 'live', api_key: 'k1-live-crawl' });
db.upsertApp({ app_id: 'games', api_key: 'k2-games-crawl' });
db.ensureProjectTenant('prj_01TESTCRAWL00000000000000A', 'sandbox', 1024);
const raw = db.getDb();
const vod = raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, is_public, visibility, is_recording, health_status, thumbnail_url, created_at, duration_seconds)
    VALUES (?, ?, ?, '/x.mp4', ?, ?, ?, ?, ?, ?, 60)`);
const clip = raw.prepare(`INSERT INTO clips (id, app_id, vod_id, title, file_path, is_public, visibility, auto_generated, status, created_at)
    VALUES (?, ?, ?, ?, '/c.webm', ?, ?, ?, ?, ?)`);
vod.run(1, 'games', 'Games public', 1, 'public', 0, 'ok', '/t/g1.jpg', '2026-09-20 10:00:00');
vod.run(2, 'games', 'Games unlisted', 0, 'unlisted', 0, 'ok', null, '2026-09-20 11:00:00');
vod.run(3, 'games', 'Games private', 0, 'private', 0, 'ok', null, '2026-09-20 12:00:00');
vod.run(4, 'live', 'Live public', 1, 'public', 0, 'ok', null, '2026-09-21 10:00:00');
vod.run(5, 'games', 'Games recording', 1, 'public', 1, 'unknown', null, '2026-09-21 11:00:00');
vod.run(6, 'games', 'Games failed', 1, 'public', 0, 'corrupt', null, '2026-09-21 12:00:00');
vod.run(7, 'prj_01TESTCRAWL00000000000000A-sandbox', 'Sandbox', 1, 'public', 0, 'ok', null, '2026-09-21 13:00:00');
clip.run(11, 'games', 1, 'Games clip', 1, 'public', 0, 'ready', '2026-09-22 10:00:00');
clip.run(12, 'games', 1, 'AI moment', 1, 'public', 1, 'ready', '2026-09-22 11:00:00');
clip.run(13, 'games', 1, 'Cutting', 1, 'public', 0, 'processing', '2026-09-22 12:00:00');
clip.run(14, 'games', 1, 'Unlisted clip', 0, 'unlisted', 0, 'ready', '2026-09-22 13:00:00');
clip.run(15, 'live', 4, 'Live clip', 1, 'public', 0, 'ready', '2026-09-22 14:00:00');
// Public and finished, but its only copy (B2) has never been checked: not playable, never listed.
raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, is_public, visibility, health_status, storage_provider, created_at, duration_seconds)
    VALUES (8, 'games', 'Games unverified', '/gone.mp4', 1, 'public', 'ok', 'b2', '2026-09-21 14:00:00', 60)`).run();
// The files behind the rows, then their objects: the local copies are checked (present) when projected.
fs.mkdirSync(path.join(tmp, 'vods'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'clips'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'vods', 'x.mp4'), 'video bytes');
fs.writeFileSync(path.join(tmp, 'clips', 'c.webm'), 'clip bytes');
const model = require('../server/objects/model');
const readiness = require('../server/objects/readiness');
for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) model.sync('vod', id);
for (const id of [11, 12, 13, 14, 15]) model.sync('clip', id);

const app = express();
app.use('/', require('../server/public/routes'));
const server = app.listen(0, '127.0.0.1');
const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
});

(async () => {
    await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
    // ── robots.txt ──
    let r = await get('/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type'].startsWith('text/plain'));
    assert.ok(r.body.includes('Sitemap: https://media.test/sitemap.xml'));
    for (const d of ['/api/', '/auth/', '/o/', '/internal/']) assert.ok(r.body.includes(`Disallow: ${d}`), `robots keeps ${d} out`);
    assert.ok(/User-agent: GPTBot/.test(r.body) && /User-agent: ClaudeBot/.test(r.body), 'the AI-crawler policy is named');
    console.log('✅ /robots.txt: sitemap, APIs disallowed, AI crawlers named');

    // ── sitemap.xml ──
    r = await get('/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type'].startsWith('application/xml'));
    const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    assert.deepStrictEqual(locs.filter(l => !l.includes('/t/')).sort(), ['https://media.test/', 'https://media.test/c/11', 'https://media.test/v/1'].sort());
    assert.ok(r.body.includes('<image:loc>https://media.test/t/g1.jpg</image:loc>'), 'thumbnails as image entries');
    for (const never of ['/v/2', '/v/3', '/v/4', '/v/5', '/v/6', '/v/7', '/v/8', '/c/12', '/c/13', '/c/14', '/c/15']) {
        assert.ok(!locs.includes(`https://media.test${never}`), `${never} is not listed`);
    }
    // Every listed watch page renders index, follow (no "submitted URL marked noindex").
    const byId = (t, id) => db.get(`SELECT * FROM ${t} WHERE id = ?`, [id]);
    const page = (kind, row) => pages.renderWatchPage(kind, row, readiness.forRow(row));
    assert.ok(page('vod', byId('vods', 1)).includes('content="index, follow"'));
    assert.ok(page('clip', byId('clips', 11)).includes('content="index, follow"'));
    assert.strictEqual(readiness.forRow(byId('vods', 8)).reason, 'verification_pending');
    assert.ok(page('vod', byId('vods', 8)).includes('content="noindex, follow"'), 'a page without a player never indexes');
    console.log('✅ /sitemap.xml: public playable items Media is canonical for; private, unlisted, sandbox, Live-owned, AI, recording, failed and unverified never');

    // ── llms.txt ──
    r = await get('/llms.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.startsWith('# OpenVibe.Media') && r.body.includes('https://media.test/sitemap.xml') && r.body.includes('AI clip'));
    assert.ok(!/\bfree\b/i.test(r.body), 'no cost claims');
    console.log('✅ /llms.txt maps the site');

    // ── Watch pages: VideoObject on public pages; AI clips noindex, no Person, based on the VOD ──
    const ldOf = (html) => { const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html); return m ? JSON.parse(m[1]) : null; };
    const pub = pages.renderWatchPage('vod', { ...byId('vods', 1), username: 'gamer' });
    assert.strictEqual(ldOf(pub)['@type'], 'VideoObject');
    assert.deepStrictEqual(ldOf(pub).author, { '@type': 'Person', name: 'gamer' });
    const aiHtml = pages.renderWatchPage('clip', { ...byId('clips', 12), username: 'gamer' });
    assert.ok(aiHtml.includes('content="noindex, follow"'), 'AI clips never index');
    const aiLd = ldOf(aiHtml);
    assert.strictEqual(aiLd.author, undefined, 'no Person attribution for an AI clip');
    assert.deepStrictEqual(aiLd.creator, { '@type': 'Organization', name: 'OpenVibe AI', url: 'https://openvibe.network' });
    assert.strictEqual(aiLd.isBasedOn, 'https://media.test/v/1');
    assert.ok(aiHtml.includes('<span>AI clip</span>') && !aiHtml.includes('by gamer'));
    assert.strictEqual(ldOf(pages.renderWatchPage('vod', byId('vods', 2))), null, 'unlisted pages carry no structured data');
    assert.ok(pages.renderWatchPage('clip', byId('clips', 15)).includes('content="noindex, follow"'), 'Live-owned: canonical on Live');
    r = await get('/c/12', { accept: 'text/html', 'sec-fetch-dest': 'document' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('content="noindex, follow"'));
    console.log('✅ watch pages: VideoObject when public; AI clips noindex, attributed to OpenVibe AI and their source VOD');

    server.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All crawler tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
