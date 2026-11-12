'use strict';
// The one view API (server/views/unified.js, POST /api/v1/views):
//   - a preview counts a view from 1 s, once per person/session per item per 30 minutes;
//   - engagement comes at 30 s, a third of the length when known, or 60 s of a live stream;
//   - bots never count, a batch is up to 20 events, and no IP address, user agent or raw session id is stored;
//   - every kind (a Feed item included) gets counts.views/counts.engaged, and Report reads per item/creator/site.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-views-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    delete process.env.EVENTS_URL;
    const realLog = console.log;

    const db = require('../server/db/database');
    await db.initDb();
    const views = require('../server/views/unified');

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/views', require('../server/views/api'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1/views`;
    const post = async (body, { ua } = {}) => {
        const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(ua ? { 'user-agent': ua } : {}) }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const get = async (q) => {
        const res = await fetch(`${base}${q}`);
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const preview = (id, session, extra = {}) => ({ ref: { service: 'media', kind: 'clip', id: String(id), ...extra }, how: 'preview', seconds: 2, session });
    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log(`  ok - ${name}`); }
        catch (e) { failures++; console.log(`  FAIL - ${name}: ${e.message}`); }
    };
    const countsOf = async (service, kind, id) => (await get(`/counts?service=${service}&kind=${kind}&id=${id}`)).json.counts;

    await check('a preview counts from 1 s and repeats inside 30 minutes do not', async () => {
        let r = await post({ events: [preview(101, 'anon_session_101')] });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json.results[0].counted, true);
        r = await post({ events: [preview(101, 'anon_session_101')] });
        assert.strictEqual(r.json.results[0].counted, false);
        assert.strictEqual(r.json.results[0].reason, 'window');
        assert.strictEqual((await countsOf('media', 'clip', '101')).views, 1);
    });

    await check('0.5 s is a preview that did not count', async () => {
        const r = await post({ events: [{ ...preview(102, 'anon_session_102'), seconds: 0.5 }] });
        assert.strictEqual(r.json.results[0].counted, false);
        assert.strictEqual(r.json.results[0].reason, 'too-short');
        assert.strictEqual((await countsOf('media', 'clip', '102')).views, 0);
    });

    await check('the window passes after 30 minutes and the same session counts again', async () => {
        const raw = db.getDb();
        await raw.prepare('UPDATE content_view_actors SET last_view_ms = last_view_ms - ? WHERE item_id = ?').run(30 * 60 * 1000 + 1, '101');
        const r = await post({ events: [preview(101, 'anon_session_101')] });
        assert.strictEqual(r.json.results[0].counted, true);
        assert.strictEqual((await countsOf('media', 'clip', '101')).views, 2);
    });

    await check('engagement: 30 s, a third of the length, once per viewer', async () => {
        let r = await post({ events: [{ ref: { service: 'media', kind: 'vod', id: '201' }, how: 'watch', seconds: 30, session: 'anon_session_201' }] });
        assert.strictEqual(r.json.results[0].counted, true);
        assert.strictEqual(r.json.results[0].engaged, true);
        r = await post({ events: [{ ref: { service: 'media', kind: 'vod', id: '201' }, how: 'watch', seconds: 31, session: 'anon_session_201' }] });
        assert.strictEqual(r.json.results[0].engaged, false, 'engaged only once');
        assert.strictEqual((await countsOf('media', 'vod', '201')).engaged, 1);

        r = await post({ events: [{ ref: { service: 'media', kind: 'vod', id: '202' }, how: 'watch', seconds: 15, of_seconds: 45, session: 'anon_session_202' }] });
        assert.strictEqual(r.json.results[0].engaged, true, 'a third of 45 s is 15 s');
    });

    await check('live: 60 s engages and two watchers make a peak of at least 2', async () => {
        let r = await post({ events: [{ ref: { service: 'live', kind: 'stream', id: '301' }, how: 'live', seconds: 59, session: 'anon_session_301' }] });
        assert.strictEqual(r.json.results[0].engaged, false);
        r = await post({ events: [{ ref: { service: 'live', kind: 'stream', id: '301' }, how: 'live', seconds: 60, session: 'anon_session_301' }] });
        assert.strictEqual(r.json.results[0].engaged, true, 'the same session watches past 60 s');
        await post({ events: [{ ref: { service: 'live', kind: 'stream', id: '301' }, how: 'live', seconds: 61, session: 'anon_session_302' }] });
        const c = await countsOf('live', 'stream', '301');
        assert.strictEqual(c.engaged, 2);
        assert.ok(c.peak_concurrent >= 2, `peak ${c.peak_concurrent}`);
    });

    await check('a declared crawler is never counted', async () => {
        const before = await countsOf('media', 'clip', '101');
        const r = await post({ events: [preview(101, 'anon_session_bot')] }, { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
        assert.strictEqual(r.json.results[0].counted, false);
        assert.strictEqual(r.json.results[0].reason, 'bot');
        assert.strictEqual((await countsOf('media', 'clip', '101')).views, before.views);
    });

    await check('a batch records each event; more than 20 is refused', async () => {
        let r = await post({ events: [preview(401, 'anon_session_401'), preview(402, 'anon_session_402')] });
        assert.strictEqual(r.json.results.length, 2);
        assert.ok(r.json.results.every((x) => x.counted));
        const tooMany = Array.from({ length: 21 }, (_, i) => preview(500 + i, `anon_session_50${i}`));
        r = await post({ events: tooMany });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.json.code, 'views.batch_size');
    });

    await check('every kind gets counts: a Feed item, a creator and a site', async () => {
        await post({ events: [{
            ref: { service: 'network', kind: 'feed', id: 'p:abc', site: 'network', creator: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' },
            how: 'preview', seconds: 3, session: 'anon_session_feed',
        }] });
        const c = await countsOf('network', 'feed', 'p:abc');
        assert.strictEqual(c.views, 1);
        assert.strictEqual(c.preview_share, 1);
        const byCreator = await get('/aggregate?scope=creator&id=usr_01JAB2C3D4E5F6G7H8J9K0MNPQ&days=7');
        assert.ok(byCreator.json.rows.some((row) => row.views >= 1 && row.creator === 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ'));
        const bySite = await get('/aggregate?scope=site&id=network&days=7');
        assert.ok(bySite.json.rows.some((row) => row.views >= 1));
    });

    await check('the legacy /v /c counter adds to the same total', async () => {
        const before = (await countsOf('media', 'vod', '999')).views;
        await views.addLegacyView('vod', 999);
        assert.strictEqual((await countsOf('media', 'vod', '999')).views, before + 1);
    });

    await check('a Media VOD page read carries counts.views and counts.engaged', async () => {
        const raw = db.getDb();
        const row = await raw.prepare("INSERT INTO vods (app_id, title, view_count) VALUES ('live', 'Counted', 0) RETURNING *").get();
        await views.addLegacyView('vod', row.id);
        const out = await require('../server/vod/finalize').vodPublic(row, { counts: true });
        assert.strictEqual(out.counts.views, 1);
        assert.strictEqual(out.counts.engaged, 0);
    });

    await check('privacy: no IP, user agent or raw session id is stored', async () => {
        const raw = db.getDb();
        const rows = [
            ...await raw.prepare('SELECT * FROM content_view_actors').all(),
            ...await raw.prepare('SELECT * FROM content_view_counts').all(),
            ...await raw.prepare('SELECT * FROM content_view_days').all(),
        ];
        const text = JSON.stringify(rows);
        assert.ok(!text.includes('anon_session_101'), 'a raw anonymous session id');
        assert.ok(!text.includes('127.0.0.1'), 'an IP address');
        assert.ok(!text.toLowerCase().includes('googlebot'), 'a user agent');
    });

    server.close();
    await db.close();
    console.log = realLog;
    if (failures) { console.error(`${failures} view check(s) failed`); process.exit(1); }
    console.log('views: ok');
})().catch((error) => { console.error(error); process.exit(1); });
