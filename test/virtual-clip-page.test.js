'use strict';
// A virtual clip (storage_provider 'timeline', no file of its own) has no bytes for a watch page here:
// the page's player and download link name ?raw=1 bytes it does not have. So a browser NAVIGATING to a
// shared virtual clip is sent to the canonical watch page (OpenVibe.Video for Live's items, the owning
// app's own page otherwise) — the page that plays the clip. Every other reader (players, fetches,
// ?raw=1, ?download) keeps today's playlist redirect, and a private clip keeps answering 404 to a reader
// who may not see it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-virtual-page-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
        MEDIA_HLS_ENABLED: '1', MEDIA_INVARIANT_SCAN_HOURS: '0',
    });

    const config = require('../server/config');
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const pages = require('../server/public/pages');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-virtual-page' });

    // A virtual clip: an HLS playlist over the source's timeline, no file of its own.
    const makeClip = async ({ title, visibility }) => {
        const objectId = await model.createObject({ app_id: 'live', owner_user_id: 5, visibility,
            lifecycle_status: 'ready', kind: 'clip', mime_type: 'video/mp4', size_bytes: 1 });
        const id = Number((await db.run(`INSERT INTO clips (app_id, user_id, title, file_path, storage_provider, object_id,
                status, is_public, visibility, duration_seconds, start_time, end_time)
            VALUES ('live', 5, ?, NULL, 'timeline', ?, 'ready', ?, ?, 6, 5, 11) RETURNING id`,
        [title, objectId, visibility === 'public' ? 1 : 0, visibility])).lastInsertRowid);
        return { id, objectId };
    };
    const open = await makeClip({ title: 'Shared moment', visibility: 'public' });
    const hidden = await makeClip({ title: 'Private moment', visibility: 'private' });

    const express = require('express');
    const app = express();
    app.use('/', require('../server/public/routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const get = (p, headers = {}) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
            let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
    const viewsOf = async (id) => Number((await db.get('SELECT COALESCE(view_count,0) AS n FROM clips WHERE id = ?', [id])).n);

    try {
        const nav = { accept: 'text/html,*/*;q=0.8', 'sec-fetch-dest': 'document' };
        const playlist = `${config.publicUrl}/o/${open.objectId}/master.m3u8`;

        // ── A browser navigating to a shared virtual clip: the canonical watch page ──
        let r = await get(`/c/${open.id}`, nav);
        assert.strictEqual(r.status, 302, 'a navigation is redirected, not answered with the playlist');
        assert.strictEqual(r.headers.location, `https://openvibe.video/c/${open.id}`, 'Live\'s clip is canonical on OpenVibe.Video');
        assert.strictEqual(r.headers['cache-control'], 'private, max-age=0', 'no stale redirect is cached');
        assert.strictEqual(r.headers['x-robots-tag'], 'noindex', 'the redirect itself never indexes');
        assert.strictEqual(await viewsOf(open.id), 0, 'the page redirect counts no view (a view is for bytes)');
        console.log('✅ a browser navigating to a virtual clip is redirected to its canonical watch page');

        // ── The bytes are unchanged: ?raw=1 and a player still get the playlist ──
        r = await get(`/c/${open.id}?raw=1`, nav);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, playlist, '?raw=1 still yields the master playlist');
        assert.strictEqual(await viewsOf(open.id), 1, 'the bytes count a view');
        r = await get(`/c/${open.id}`, { accept: 'video/webm,*/*;q=0.5', 'sec-fetch-dest': 'video' });
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, playlist, 'a player still gets the master playlist');
        r = await get(`/c/${open.id}`, { accept: '*/*' });
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, playlist, 'a plain fetch still gets the master playlist');
        console.log('✅ ?raw=1, a player and a plain fetch keep today\'s playlist redirect');

        // ── A private clip looks missing to a reader who may not see it ──
        r = await get(`/c/${hidden.id}`, nav);
        assert.strictEqual(r.status, 404, 'a private virtual clip seen anonymously: 404, as today');
        assert.ok(!r.headers.location, 'and no redirect that would name it');
        console.log('✅ a private virtual clip seen anonymously is still a 404');

        // ── The rule itself: another site's canonical page, or none at all ──
        assert.strictEqual(pages.canonicalPageUrl('clip', { id: 7, app_id: 'live' }), 'https://openvibe.video/c/7');
        assert.strictEqual(pages.canonicalPageUrl('clip', { id: 7, app_id: 'games' }), 'https://openvibe.games/clip/7');
        {
            // The same host: this site is the canonical home, so there is nothing to redirect to.
            const framePath = require.resolve('../server/public/page-frame');
            const pagesPath = require.resolve('../server/public/pages');
            const realVideo = process.env.VIDEO_PUBLIC_URL;
            process.env.VIDEO_PUBLIC_URL = 'https://media.test';
            delete require.cache[framePath];
            delete require.cache[pagesPath];
            const sameHost = require(pagesPath);
            assert.strictEqual(sameHost.canonicalPageUrl('clip', { id: 7, app_id: 'live' }), null, 'no canonical page on another host: nothing to redirect to');
            process.env.VIDEO_PUBLIC_URL = realVideo;
            delete require.cache[framePath];
            delete require.cache[pagesPath];
        }
        console.log('✅ the canonical page is another site\'s, or none: the rule is one place');

        console.log('virtual clip page: all checks passed');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
