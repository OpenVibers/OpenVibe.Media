'use strict';
/**
 * Audio description on the watch page (X1, consent plan 2026-10-31, "AI and data"): Media serves Live's
 * WebVTT as a same-origin `/v/:id/descriptions.vtt` (and `/c/:id/...`), adds the `<track
 * kind="descriptions">` to Live's watch pages, and never asks Live to describe a private item for someone
 * who cannot prove they may see it. Live is stubbed in-process: the real one is tested in OpenVibe.Live
 * (test/audio-description.test.js).
 *
 *   node test/audio-description.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-ad-'));
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.VOD_PATH = path.join(tmp, 'vods');
    process.env.CLIPS_PATH = path.join(tmp, 'clips');

    const VTT = 'WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nA person in a red coat opens a blue door.\n';
    const privateIds = new Set();   // filled once the rows exist; the stub uses it to refuse non-owners
    const live = http.createServer((req, res) => {
        const owner = req.headers.authorization === 'Bearer owner-token';
        const m = /^\/api\/(?:vods|clips)\/(\d+)\//.exec(req.url || '');
        if (m && privateIds.has(m[1]) && !owner) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
        res.end(VTT);
    });
    await new Promise((r) => live.listen(0, '127.0.0.1', r));
    process.env.LIVE_APP_INTERNAL_URL = `http://127.0.0.1:${live.address().port}`;

    const db = require('../server/db/database');
    const pages = require('../server/public/pages');
    await db.initDb();
    const vod = await db.createVod({ app_id: 'live', stream_id: 500, user_id: 3, title: 'Described VOD', visibility: 'public', duration_seconds: 60 });
    const vodId = Number(vod.lastInsertRowid);
    const privateVod = await db.createVod({ app_id: 'live', stream_id: 500, user_id: 3, title: 'Private VOD', visibility: 'private', duration_seconds: 60 });
    const privateVodId = Number(privateVod.lastInsertRowid);
    const gamesVod = await db.createVod({ app_id: 'games', user_id: 4, title: 'Games VOD', visibility: 'public', duration_seconds: 60 });
    const gamesVodId = Number(gamesVod.lastInsertRowid);
    const clip = await db.createClip({ app_id: 'live', vod_id: vodId, stream_id: 500, user_id: 3, title: 'Described clip', visibility: 'public', start_time: 3, end_time: 15, duration_seconds: 12, file_path: '/x/c.webm', status: 'ready' });
    const clipId = Number(clip.lastInsertRowid);
    const privateClip = await db.createClip({ app_id: 'live', vod_id: privateVodId, stream_id: 500, user_id: 3, title: 'Private clip', visibility: 'private', start_time: 3, end_time: 15, duration_seconds: 12, file_path: '/x/c2.webm', status: 'ready' });
    const privateClipId = Number(privateClip.lastInsertRowid);
    privateIds.add(String(privateVodId));
    privateIds.add(String(privateClipId));

    const express = require('express');
    const app = express();
    app.use((req, _res, next) => {
        req.cookies = {};
        for (const part of String(req.headers.cookie || '').split(';')) {
            const i = part.indexOf('=');
            if (i < 0) continue;
            req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        }
        next();
    });
    app.use('/', require('../server/public/routes'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    const get = (p, headers = {}) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });

    // ── The track: same origin, the WebVTT Live built, cacheable for a public item ──
    const pub = await get(`/v/${vodId}/descriptions.vtt`);
    assert.strictEqual(pub.status, 200);
    assert.match(pub.headers['content-type'], /^text\/vtt/);
    assert.match(pub.headers['cache-control'], /public/);
    assert.ok(pub.body.startsWith('WEBVTT') && /red coat/.test(pub.body), 'Live\'s cues are served as they are');
    assert.strictEqual((await get(`/c/${clipId}/descriptions.vtt`)).status, 200, 'a clip has its own track URL');

    // ── Private: the same answer as a missing id until its owner proves who they are ──
    assert.strictEqual((await get(`/v/${privateVodId}/descriptions.vtt`)).status, 404, 'a visitor never gets a private track');
    const other = await get(`/v/${privateVodId}/descriptions.vtt`, { cookie: 'ov_token=other-token' });
    assert.strictEqual(other.status, 404, 'another signed-in person does not either');
    const owner = await get(`/v/${privateVodId}/descriptions.vtt`, { cookie: 'ov_token=owner-token' });
    assert.strictEqual(owner.status, 200, 'the owner asks and gets it');
    assert.match(owner.headers['cache-control'], /private/);
    assert.strictEqual((await get(`/v/${privateVodId}/descriptions.vtt`, { cookie: 'ov_token=owner-token' })).status, 200);
    assert.strictEqual((await get(`/c/${privateClipId}/descriptions.vtt`)).status, 404);
    assert.strictEqual((await get(`/c/${privateClipId}/descriptions.vtt`, { cookie: 'ov_token=owner-token' })).status, 200);

    // Another app's media has no Live scene notes to describe.
    assert.strictEqual((await get(`/v/${gamesVodId}/descriptions.vtt`)).status, 404);

    // ── The watch page: a descriptions track on Live's page, and none on another app's ──
    const publicRecord = { id: vodId, app_id: 'live', title: 'Described VOD', file_path: '/x/v.mp4', is_public: 1, visibility: 'public', duration_seconds: 60 };
    const html = pages.renderWatchPage('vod', publicRecord);
    assert.ok(html.includes(`<track kind="descriptions" srclang="en" label="Audio description" src="https://media.test/v/${vodId}/descriptions.vtt">`), 'the player is handed the descriptions track');
    const gamesRecord = { id: gamesVodId, app_id: 'games', title: 'Games VOD', file_path: '/x/g.mp4', is_public: 1, visibility: 'public', duration_seconds: 60 };
    assert.ok(!pages.renderWatchPage('vod', gamesRecord).includes('kind="descriptions"'), 'not for another app\'s video');
    const privateRecord = { id: privateVodId, app_id: 'live', title: 'Private VOD', file_path: '/x/p.mp4', is_public: 0, visibility: 'private', duration_seconds: 60 };
    assert.ok(pages.renderWatchPage('vod', privateRecord).includes('kind="descriptions"'), 'the owner\'s page carries it; the route is what guards it');

    // The page's CSS and player are the shared ones; no duplicate player script is added by the track.
    assert.ok(html.includes('/shared/player.js'), 'the network player reads the track');

    server.close();
    live.close();
    console.log('media audio description: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
