'use strict';
// A thumbnail's name changes when its picture is made again, and the old file is deleted. On 2026-11-18 Live asked for
// new pictures whenever an image failed to load for a moment (the database restarting), so every recent recording was
// renamed twice in fifteen minutes; openvibe.video's feed, built from a list cached for minutes, still named the old
// files and showed empty cards (Media answered the 1×1 pixel, which never fires a page's onerror). Now:
// - /t/<old name> of a public or unlisted item redirects to its current picture (private, Specific-people and deleted
//   items keep the pixel);
// - asking for a picture of a finished item whose picture is on disk answers that picture with no job; a recording
//   still being written is remade (Live's live-edge cadence), and ?force=1 remakes one on purpose.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-stale-thumbs-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test', MEDIA_INVARIANT_SCAN_HOURS: '0',
    });
    const db = require('../server/db/database');
    const thumbs = require('../server/thumbnails/thumbnail-service');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-stalethumbs' });
    const T = process.env.THUMBNAILS_PATH;
    let failed = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.stack}`); }
    };
    const vod = async (id, { visibility = 'public', thumb = `vod-${id}-2-a1b2c3.jpg`, recording = 0 } = {}) => {
        fs.writeFileSync(path.join(process.env.VOD_PATH, `${id}.mp4`), Buffer.alloc(100));
        if (thumb) fs.writeFileSync(path.join(T, thumb), `picture of ${id}`);
        await db.run(`INSERT INTO vods (id, app_id, title, file_path, file_size, duration_seconds, visibility, is_public, is_recording, storage_provider, thumbnail_url)
                      OVERRIDING SYSTEM VALUE VALUES (?, 'live', 't', ?, 100, 60, ?, ?, ?, 'local', ?)`,
        [id, path.join(process.env.VOD_PATH, `${id}.mp4`), visibility, visibility === 'public' ? 1 : 0, recording, thumb ? `/t/${thumb}` : null]);
    };

    const pub = http.createServer((req, res) => {
        req.params = { id: decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/t\//, '')) };
        req.query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (b) => res.end(JSON.stringify(b));
        thumbs.serveThumbnail(req, res);
    });
    await new Promise((r) => pub.listen(0, '127.0.0.1', r));
    const get = async (p) => {
        const r = await fetch(`http://127.0.0.1:${pub.address().port}${p}`, { redirect: 'manual' });
        return { status: r.status, location: r.headers.get('location'), cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()) };
    };

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
    const api = app.listen(0, '127.0.0.1');
    await new Promise((r) => (api.listening ? r() : api.once('listening', r)));
    const post = (p) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: api.address().port, path: p, method: 'POST', headers: { Authorization: 'Bearer live-key-stalethumbs', 'Content-Length': 0 } },
            (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
        req.on('error', reject);
        req.end();
    });
    const jobs = async () => Number((await db.get("SELECT COUNT(*) AS n FROM media_jobs WHERE job_type = 'thumbnail.regenerate'")).n);

    await check('an old name of a public recording redirects to its current picture, with the size it asked for', async () => {
        await vod(31);
        const r = await get('/t/vod-31-1-0f0f0f.jpg?w=320&fmt=webp');
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.location, '/t/vod-31-2-a1b2c3.jpg?w=320&fmt=webp');
        assert.match(r.cache, /max-age=300/, 'briefly: the picture may be made again');
        const now = await get('/t/vod-31-2-a1b2c3.jpg');
        assert.deepStrictEqual([now.status, now.body.toString()], [200, 'picture of 31'], 'the current name serves the picture');
    });

    await check('an unlisted recording and a public clip redirect too', async () => {
        await vod(32, { visibility: 'unlisted' });
        assert.strictEqual((await get('/t/vod-32-1.jpg')).location, '/t/vod-32-2-a1b2c3.jpg');
        fs.writeFileSync(path.join(T, 'clip-33-5-abcdef.jpg'), 'clip picture');
        await db.run("INSERT INTO clips (id, app_id, vod_id, title, status, visibility, is_public, thumbnail_url) OVERRIDING SYSTEM VALUE VALUES (33, 'live', 31, 'c', 'ready', 'public', 1, '/t/clip-33-5-abcdef.jpg')");
        assert.strictEqual((await get('/t/clip-33-4-123456.jpg?w=640&fmt=webp')).location, '/t/clip-33-5-abcdef.jpg?w=640&fmt=webp');
    });

    await check('a private recording, a deleted one and one with no picture keep the pixel (no redirect)', async () => {
        await vod(34, { visibility: 'private' });
        const priv = await get('/t/vod-34-1.jpg');
        assert.deepStrictEqual([priv.status, priv.location], [200, null]);
        assert.ok(priv.body.length < 400, 'the pixel');
        await vod(35);
        await db.run('DELETE FROM vods WHERE id = 35');
        assert.deepStrictEqual([(await get('/t/vod-35-1.jpg')).status, (await get('/t/vod-35-1.jpg')).location], [200, null]);
        await vod(36, { thumb: null });
        assert.strictEqual((await get('/t/vod-36-1.jpg')).location, null);
        // Another item's name never redirects to this one's picture.
        await db.run("UPDATE vods SET thumbnail_url = '/t/vod-31-2-a1b2c3.jpg' WHERE id = 36");
        assert.strictEqual((await get('/t/vod-36-1.jpg')).location, null);
    });

    await check('asking for a picture of a finished recording that has one answers it, with no job and no new name', async () => {
        await vod(41);
        const before = await jobs();
        const r = await post('/api/v1/live/thumbnails/vod/41');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.url, r.body.current], ['/t/vod-41-2-a1b2c3.jpg', true]);
        assert.strictEqual(await jobs(), before, 'no thumbnail.regenerate job');
        assert.strictEqual((await db.get('SELECT thumbnail_url FROM vods WHERE id = 41')).thumbnail_url, '/t/vod-41-2-a1b2c3.jpg');
        assert.ok(fs.existsSync(path.join(T, 'vod-41-2-a1b2c3.jpg')), 'the picture is still there');
    });

    await check('a recording still being written, one whose file is gone, and ?force=1 still make a new picture', async () => {
        await vod(42, { recording: 1 });
        await vod(43, { thumb: null });
        await db.run("UPDATE vods SET thumbnail_url = '/t/vod-43-1-gone00.jpg' WHERE id = 43");
        await vod(44);
        for (const p of ['/api/v1/live/thumbnails/vod/42', '/api/v1/live/thumbnails/vod/43', '/api/v1/live/thumbnails/vod/44?force=1']) {
            const before = await jobs();
            const r = await post(p);
            assert.notStrictEqual(r.body.current, true, `${p}: ${JSON.stringify(r.body)}`);
            assert.strictEqual(await jobs(), before + 1, `${p}: a thumbnail.regenerate job`);
        }
    });

    pub.close(); api.close();
    if (failed) { console.log(`${failed} failed`); process.exit(1); }
    console.log('thumbnail stale names: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
