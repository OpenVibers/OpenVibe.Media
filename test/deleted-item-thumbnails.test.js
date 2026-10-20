'use strict';
// A deleted recording's or clip's thumbnail goes with it (migration 0013, server/thumbnails/thumbnail-service.js):
// the derived thumbnail object is deleted by the trigger whenever its parent is (and comes back when a native parent
// is restored), and /t/vod-<id>-… answers the empty pixel once the item's row is gone, as for a missing file. On
// 2026-10-20 the reconcile found 57 thumbnails of deleted recordings still served.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-deleted-thumbs-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
    });
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const thumbs = require('../server/thumbnails/thumbnail-service');
    const d = db.getDb();
    let failed = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.stack}`); }
    };
    const write = (p, content) => { fs.writeFileSync(p, content); return p; };
    const V = d.prepare(`INSERT INTO vods (id, app_id, file_path, file_size, duration_seconds, visibility, is_public, storage_provider, thumbnail_url) OVERRIDING SYSTEM VALUE
                         VALUES (?, 'live', ?, 100, 60, 'public', 1, 'local', ?) RETURNING id`);
    const vod = async (id) => {
        write(path.join(process.env.VOD_PATH, `${id}.webm`), Buffer.alloc(100));
        write(path.join(process.env.THUMBNAILS_PATH, `vod-${id}-1.jpg`), `thumb of ${id}`);
        await V.run(id, path.join(process.env.VOD_PATH, `${id}.webm`), `/t/vod-${id}-1.jpg`);
        await model.sync('vod', id);
        return (await d.prepare('SELECT object_id FROM vods WHERE id = ?').get(id)).object_id;
    };
    const thumbOf = async (objectId) => await db.get(`SELECT d.id, d.lifecycle_status FROM media_variants v JOIN media_objects d ON d.id = v.derived_object_id
                                                       WHERE v.object_id = ? AND v.variant_name = 'thumbnail'`, [objectId]);

    const server = http.createServer((req, res) => {
        req.params = { id: decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/t\//, '')) };
        req.query = {};
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (b) => res.end(JSON.stringify(b));
        thumbs.serveThumbnail(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = async (p) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
        return { status: r.status, cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()).toString() };
    };

    await check('a recording\'s thumbnail object is deleted with it, by every path that deletes the row', async () => {
        const obj = await vod(7);
        assert.strictEqual((await thumbOf(obj)).lifecycle_status, 'ready');
        await db.run('DELETE FROM vods WHERE id = 7');
        assert.strictEqual((await db.get('SELECT lifecycle_status FROM media_objects WHERE id = ?', [obj])).lifecycle_status, 'deleted');
        assert.strictEqual((await thumbOf(obj)).lifecycle_status, 'deleted', 'its thumbnail followed');
    });

    await check('/t/ serves a live item\'s thumbnail, and only the empty pixel once the item is deleted', async () => {
        await vod(8);
        const live = await get('/t/vod-8-1.jpg');
        assert.deepStrictEqual([live.status, live.body, live.cache], [200, 'thumb of 8', 'public, max-age=604800, immutable']);
        const gone = await get('/t/vod-7-1.jpg');
        assert.strictEqual(gone.status, 200);
        assert.notStrictEqual(gone.body, 'thumb of 7', 'not the deleted recording\'s picture');
        assert.strictEqual(gone.cache, 'no-cache', 'the pixel, as for a missing file');
        assert.ok(fs.existsSync(path.join(process.env.THUMBNAILS_PATH, 'vod-7-1.jpg')), 'the file stays on disk');
        write(path.join(process.env.THUMBNAILS_PATH, 'stream-live-3.jpg'), 'live frame');
        assert.strictEqual((await get('/t/stream-live-3.jpg')).body, 'live frame', 'a live stream\'s picture names no item');
    });

    await check('restoring a native object brings back the derivatives deleted with it, not one deleted before', async () => {
        const parent = await model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready' });
        const withIt = await model.createObject({ app_id: 'live', kind: 'thumbnail', lifecycle_status: 'ready' });
        const earlier = await model.createObject({ app_id: 'live', kind: 'thumbnail', lifecycle_status: 'ready' });
        await model.setVariant(parent, 'thumbnail', withIt);
        await model.setVariant(parent, 'poster', earlier);
        await db.run("UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = '2020-01-01 00:00:00' WHERE id = ?", [earlier]);
        await model.softDelete(await model.getObject(parent));
        assert.strictEqual((await model.getObject(withIt)).lifecycle_status, 'deleted', 'the trigger follows a soft delete too');
        await model.restore(await model.getObject(parent));
        assert.strictEqual((await model.getObject(parent)).lifecycle_status, 'ready');
        assert.strictEqual((await model.getObject(withIt)).lifecycle_status, 'ready', 'deleted with it: back with it');
        assert.strictEqual((await model.getObject(earlier)).lifecycle_status, 'deleted', 'deleted on its own before: stays deleted');
    });

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
    console.log('\ndeleted item thumbnails: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
