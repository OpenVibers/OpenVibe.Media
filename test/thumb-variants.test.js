'use strict';
// Thumbnail variants (Media Fabric F4, server/thumbnails/variants.js): GET /t/:id?w=&fmt= answers the thumbnail resized
// to a ladder width and re-encoded (WebP by default, AVIF, JPEG), made once and served from the cache after; a bad w or
// fmt is a 400; no query is the original, unchanged. The cache follows the source's modification time, drops the least
// recently used over its budget, and a busy cache gives the original (cached briefly) instead of waiting.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-variants-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.THUMBNAIL_VARIANTS_PATH = path.join(tmp, 'variants');
    const sharp = require('sharp');
    const { parse, createVariants } = require('../server/thumbnails/variants');
    const thumbs = require('../server/thumbnails/thumbnail-service');
    let failed = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.stack}`); }
    };
    // A 640×360 JPEG with some detail, like the thumbnails Media cuts.
    const jpeg = (file, color) => sharp({ create: { width: 640, height: 360, channels: 3, background: color } })
        .composite([{ input: Buffer.from('<svg width="640" height="360"><circle cx="320" cy="180" r="120" fill="#fff"/></svg>') }])
        .jpeg({ quality: 85 }).toFile(file);
    await jpeg(path.join(process.env.THUMBNAILS_PATH, 'vod-1-1.jpg'), '#3366cc');
    // A recording's thumbnail is served while its row exists (a deleted item's is not: deleted-item-thumbnails.test.js).
    // Under the test runner there is a database; run alone there is none, and the thumbnail is served as before.
    try {
        await require('../server/db/database').getDb().prepare(`INSERT INTO vods (id, app_id, file_path, file_size, duration_seconds, visibility, is_public, storage_provider)
            OVERRIDING SYSTEM VALUE VALUES (1, 'live', '/v/1.webm', 100, 60, 'public', 1, 'local') RETURNING id`).run();
    } catch { /* no database */ }
    await jpeg(path.join(process.env.THUMBNAILS_PATH, 'stream-live-1.jpg'), '#cc3333');

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        req.params = { id: decodeURIComponent(u.pathname.replace(/^\/t\//, '')) };
        req.query = Object.fromEntries(u.searchParams);
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (b) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); };
        thumbs.serveThumbnail(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = async (p) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
        return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), body: Buffer.from(await r.arrayBuffer()) };
    };

    await check('parse: no query is the original; w snaps up the ladder; webp by default; bad values are errors', () => {
        assert.strictEqual(parse({}), null);
        assert.deepStrictEqual(parse({ w: '480' }), { w: 480, fmt: 'webp' });
        assert.deepStrictEqual(parse({ w: '200' }), { w: 320, fmt: 'webp' });
        assert.deepStrictEqual(parse({ w: '2000', fmt: 'AVIF' }), { w: 640, fmt: 'avif' });
        assert.deepStrictEqual(parse({ fmt: 'jpeg' }), { w: 640, fmt: 'jpeg' });
        assert.ok(parse({ w: 'abc' }).error && parse({ w: '0' }).error && parse({ w: '1.5' }).error);
        assert.ok(parse({ fmt: 'gif' }).error);
    });

    await check('GET /t/:id?w=480 answers a 480 px WebP, smaller than the original, with the original\'s caching', async () => {
        const orig = await get('/t/vod-1-1.jpg');
        assert.deepStrictEqual([orig.status, orig.type, orig.cache], [200, 'image/jpeg', 'public, max-age=604800, immutable']);
        const v = await get('/t/vod-1-1.jpg?w=480');
        assert.deepStrictEqual([v.status, v.type, v.cache], [200, 'image/webp', 'public, max-age=604800, immutable']);
        const meta = await sharp(v.body).metadata();
        assert.deepStrictEqual([meta.format, meta.width, meta.height], ['webp', 480, 270]);
        assert.ok(v.body.length < orig.body.length, `${v.body.length} < ${orig.body.length}`);
        const again = await get('/t/vod-1-1.jpg?w=480');
        assert.ok(again.body.equals(v.body), 'served from the cache the second time');
        assert.strictEqual(fs.readdirSync(process.env.THUMBNAIL_VARIANTS_PATH).filter((f) => f.startsWith('vod-1-1.jpg.')).length, 1);
    });

    await check('AVIF and JPEG variants; a bad w or fmt is a 400; a live thumbnail keeps its short cache', async () => {
        const avif = await get('/t/vod-1-1.jpg?w=320&fmt=avif');
        assert.strictEqual(avif.type, 'image/avif');
        assert.strictEqual((await sharp(avif.body).metadata()).width, 320);
        const jpg = await get('/t/vod-1-1.jpg?w=160&fmt=jpeg');
        assert.deepStrictEqual([jpg.type, (await sharp(jpg.body).metadata()).width], ['image/jpeg', 160]);
        assert.strictEqual((await get('/t/vod-1-1.jpg?w=abc')).status, 400);
        assert.strictEqual((await get('/t/vod-1-1.jpg?fmt=gif')).status, 400);
        const live = await get('/t/stream-live-1.jpg?w=320');
        assert.deepStrictEqual([live.status, live.type, live.cache], [200, 'image/webp', 'public, max-age=30']);
    });

    await check('a rewritten source gets a fresh variant (the key holds its modification time)', async () => {
        const src = path.join(process.env.THUMBNAILS_PATH, 'stream-live-1.jpg');
        const first = await get('/t/stream-live-1.jpg?w=320');
        await jpeg(src, '#22aa44');
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(src, later, later);
        const second = await get('/t/stream-live-1.jpg?w=320');
        assert.ok(!second.body.equals(first.body), 'the new picture, not the cached old one');
    });

    await check('the cache drops the least recently used variants over its budget', async () => {
        const vdir = path.join(tmp, 'small-cache');
        const v = createVariants({ dir: vdir, maxBytes: 9000, sharp });
        const src = path.join(process.env.THUMBNAILS_PATH, 'vod-1-1.jpg');
        await v.get(src, { w: 640, fmt: 'jpeg' });
        await v.get(src, { w: 480, fmt: 'jpeg' });
        await v.get(src, { w: 320, fmt: 'jpeg' });
        const left = fs.readdirSync(vdir);
        assert.ok(v.stats().bytes <= 9000, `cache at ${v.stats().bytes} bytes`);
        assert.ok(left.some((f) => f.endsWith('.320.jpeg')), 'the newest stays');
        assert.ok(!left.some((f) => f.endsWith('.640.jpeg')), 'the oldest went');
    });

    await check('a busy cache answers null (the route then serves the original), never an error', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const slow = { calls: 0 };
        const fake = () => ({ rotate() { return this; }, resize() { return this; }, webp() { return this; }, async toFile(f) { slow.calls++; await gate; fs.writeFileSync(f, 'x'); } });
        const v = createVariants({ dir: path.join(tmp, 'busy'), concurrency: 1, queueMax: 0, sharp: fake });
        const src = path.join(process.env.THUMBNAILS_PATH, 'vod-1-1.jpg');
        const first = v.get(src, { w: 320, fmt: 'webp' });
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(await v.get(src, { w: 480, fmt: 'webp' }), null, 'over the queue: null');
        release();
        assert.strictEqual((await first).type, 'image/webp');
        assert.strictEqual(slow.calls, 1);
    });

    await check('a missing thumbnail with a variant query is still the transparent pixel', async () => {
        const r = await get('/t/nope.jpg?w=320');
        assert.deepStrictEqual([r.status, r.type, r.cache], [200, 'image/jpeg', 'no-cache']);
    });

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `thumb-variants: ${failed} failed` : 'thumb-variants: all passed');
    process.exit(failed ? 1 : 0);
})();
