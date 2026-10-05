'use strict';
// IndexNow pings on the transitions that make a watch page indexable (server/indexnow-notify.js,
// wired into VOD finalize, clip ready and the visibility-change routes): a public, person-made VOD
// or clip that becomes ready or public queues its /v|/c page and the sitemap; private, unlisted,
// Live-owned, AI and sandbox rows never do. The client is injected with a stubbed fetch, so no
// request leaves the process.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-indexnow-ping-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        MEDIA_PUBLIC_URL: 'https://media.test',
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        OBJECTS_PATH: dir('objects'), THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'),
    });
    delete process.env.MEDIA_DRILL;

    const db = require('../server/db/database');
    const { createIndexNow } = require('openvibe-shared/indexnow');
    const notify = require('../server/indexnow-notify');

    await db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const sandbox = await db.ensureProjectTenant('prj_01TESTINDEXNOW0000000000A', 'sandbox', 1024);
    const raw = db.getDb();

    // The client booted in server/index.js, with a fetch that records the POST instead of sending it.
    const posts = [];
    const client = createIndexNow({
        host: 'media.test', key: 'mediaIndexNowKey123',
        fetch: async (_url, init) => { posts.push(JSON.parse(init.body)); return { status: 200 }; },
    });
    notify.use(client);

    const insVod = raw.prepare(`INSERT INTO vods (id, app_id, title, file_path, is_public, visibility, is_recording, health_status, created_at, duration_seconds) OVERRIDING SYSTEM VALUE
        VALUES (?, ?, ?, ?, ?, ?, 0, 'ok', '2026-10-01 10:00:00', 60) RETURNING id`);
    await insVod.run(1, 'games', 'Public ready', '/x/v1.mp4', 1, 'public');
    await insVod.run(2, 'games', 'Private', '/x/v2.mp4', 0, 'private');
    await insVod.run(3, sandbox.app_id, 'Sandbox public', '/x/v3.mp4', 1, 'public');
    await insVod.run(4, 'games', 'Unlisted', '/x/v4.mp4', 0, 'unlisted');
    const insClip = raw.prepare(`INSERT INTO clips (id, app_id, vod_id, title, file_path, is_public, visibility, auto_generated, status, created_at) OVERRIDING SYSTEM VALUE
        VALUES (?, 'games', 1, ?, ?, ?, ?, ?, 'ready', '2026-10-01 11:00:00') RETURNING id`);
    await insClip.run(11, 'Public clip', '/x/c11.webm', 1, 'public', 0);
    await insClip.run(12, 'AI moment', '/x/c12.webm', 1, 'public', 1);

    const vod = async (id) => await db.get('SELECT * FROM vods WHERE id = ?', [id]);
    const clip = async (id) => await db.get('SELECT * FROM clips WHERE id = ?', [id]);
    const flush = async () => { await client.flush(); const batch = posts.at(-1); posts.length = 0; return batch; };

    // ── pingWatch: what qualifies ──
    assert.strictEqual(await notify.pingWatch('vod', await vod(1)), true, 'a public, person-made VOD queues a ping');
    assert.strictEqual(await notify.pingWatch('clip', await clip(11)), true, 'a public, person-made clip queues a ping');
    let batch = await flush();
    assert.deepStrictEqual(batch.urlList.sort(), ['https://media.test/c/11', 'https://media.test/sitemap.xml', 'https://media.test/v/1'].sort());
    assert.strictEqual(batch.host, 'media.test');
    assert.strictEqual(batch.key, 'mediaIndexNowKey123');

    assert.strictEqual(await notify.pingWatch('vod', await vod(2)), false, 'a private VOD is not pinged');
    assert.strictEqual(await notify.pingWatch('vod', await vod(4)), false, 'an unlisted VOD is not pinged');
    assert.strictEqual(await notify.pingWatch('vod', await vod(3)), false, 'a sandbox tenant\'s public VOD is not pinged');
    assert.strictEqual(await notify.pingWatch('clip', await clip(12)), false, 'an AI clip is not pinged');
    assert.strictEqual(await notify.pingWatch('vod', null), false, 'a missing row is not pinged');
    assert.deepStrictEqual(posts, [], 'nothing was queued for any of them');

    // ── The visibility-change route calls it: public pings again, private pings nothing ──
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const put = async (p, body) => {
        const res = await fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer games-key' }, body: JSON.stringify(body) });
        return { status: res.status };
    };
    try {
        assert.strictEqual((await put('/api/v1/games/vods/2', { visibility: 'public' })).status, 200);
        batch = await flush();
        assert.deepStrictEqual(batch.urlList.sort(), ['https://media.test/sitemap.xml', 'https://media.test/v/2'], 'a private VOD made public pings its page');
        assert.strictEqual((await put('/api/v1/games/vods/1', { visibility: 'private' })).status, 200);
        assert.deepStrictEqual(posts, [], 'a public VOD made private pings nothing');
    } finally { server.close(); }

    notify.use(null);
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('indexnow ping: public ready VODs/clips ping; private, unlisted, AI and sandbox never; visibility changes too');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
