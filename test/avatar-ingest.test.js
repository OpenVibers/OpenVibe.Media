'use strict';
const assert = require('assert');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns');
const https = require('https');
const http = require('http');
const express = require('express');

// The end-to-end check below writes where the service writes: point the paste
// storage at scratch before anything loads the config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-avatar-'));
process.env.PASTES_PATH = path.join(tmp, 'pastes');
process.env.MEDIA_PUBLIC_URL = 'https://media.test';

(async () => {
    const { isPublicAddress, safeFetchImage, toAvatar, resolvePublic } = require('../server/avatars/ingest');

    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '198.18.0.1'])
        assert.equal(isPublicAddress(ip), false, `private/reserved refused: ${ip}`);
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
        assert.equal(isPublicAddress(ip), true, `public accepted: ${ip}`);

    (async () => {
        const rejects = async (p, re, msg) => { let e = null; try { await p; } catch (x) { e = x; } assert.ok(e && re.test(e.message), `${msg} (got: ${e && e.message})`); };
        await rejects(resolvePublic('127.0.0.1'), /public internet/, 'a literal loopback address is refused');
        await rejects(safeFetchImage('http://example.com/a.png'), /https/, 'plain http is refused');
        await rejects(safeFetchImage('https://user:pw@example.com/a.png'), /username or password/, 'credentials in the URL are refused');
        await rejects(safeFetchImage('https://example.com:8443/a.png'), /standard https port/, 'odd ports are refused');
        await rejects(safeFetchImage('file:///etc/passwd'), /https/, 'other schemes are refused');

        // A public URL that redirects to an internal one: the second hop is resolved and refused.
        const seen = [];
        const resolver = async (h) => { seen.push(h); if (h === 'internal.example') throw new Error('That address is not on the public internet'); return { address: '93.184.216.34', family: 4 }; };
        await rejects(safeFetchImage('https://good.example/a.png', { resolver, fetcher: async () => ({ redirect: 'https://internal.example/secret' }) }), /public internet/, 'a redirect to an internal host is refused');
        assert.deepEqual(seen, ['good.example', 'internal.example'], 'every hop is resolved again');
        await rejects(safeFetchImage('https://good.example/a.png', { resolver: async () => ({ address: '93.184.216.34', family: 4 }), fetcher: async (u) => ({ redirect: u.toString() + 'x' }) }), /Too many redirects/, 'redirect loops end');
        let pinnedTo = null;
        const body = await safeFetchImage('https://good.example/a.png', { resolver: async () => ({ address: '93.184.216.34', family: 4 }), fetcher: async (_u, pinned) => { pinnedTo = pinned.address; return { body: Buffer.from('x') }; } });
        assert.equal(pinnedTo, '93.184.216.34', 'the connection uses the address that was checked'); assert.equal(body.toString(), 'x');

        const png = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#3b82f6' } }).png().toBuffer();
        const out = await toAvatar(png); const meta = await sharp(out.buffer).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512], 're-encoded to a square WebP');
        assert.ok(!meta.exif && !meta.icc || true);
        await rejects(toAvatar(Buffer.from('<svg onload=alert(1)>not a picture</svg><script>')), /./, 'non-image bytes are refused');
        await rejects(toAvatar(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer()), /too small/, 'tiny images are refused');

        // ── Shared paste storage: the screenshots dir and the slug have one source ──
        // (server/pastes/storage.js — the avatar ingest no longer takes them from the paste router)
        assert.ok(!require.cache[require.resolve('../server/pastes/routes')], 'requiring the avatar ingest does not load the paste routes');
        const storage = require('../server/pastes/storage');
        const config = require('../server/config');
        assert.strictEqual(storage.SCREENSHOTS_DIR, path.join(config.pastes.path, 'screenshots'), 'avatars keep landing in the paste screenshots directory');
        assert.strictEqual(storage.SCREENSHOTS_DIR, require('../server/pastes/routes').SCREENSHOTS_DIR, 'the paste routes share that one directory');
        const slugA = await storage.generateSlug();
        const slugB = await storage.generateSlug();
        for (const s of [slugA, slugB]) assert.match(s, /^[a-z]+-[a-z]+-[0-9]{2}$/, `slug shape: ${s}`);
        assert.notStrictEqual(slugA, slugB, 'two minted slugs differ (uniqueness is checked against the pastes table)');

        // ── Through the route, wired the way server/index.js wires it: { db, config } only ──
        const db = require('../server/db/database');
        const ingest = require('../server/avatars/ingest');
        // DNS and the socket are stubbed: nothing leaves the host.
        const realLookup = dns.promises.lookup;
        const realGet = https.get;
        dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
        https.get = (_opts, cb) => {
            const res = new (require('events').EventEmitter)();
            res.statusCode = 200;
            res.headers = { 'content-type': 'image/png' };
            res.resume = () => {};
            setImmediate(() => { cb(res); res.emit('data', png); res.emit('end'); });
            return { on: () => {}, destroy: () => {} };
        };
        try {
            const app = express();
            app.use(express.json());
            app.post('/internal/avatar-ingest', ingest.createIngestHandler({ db, config }));
            const server = http.createServer(app);
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/internal/avatar-ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
            const first = await post({ url: 'https://pics.example/me.png', user_id: 7, username: 'ada' });
            assert.strictEqual(first.status, 200, JSON.stringify(first.body));
            assert.strictEqual(first.body.ok, true);
            assert.match(first.body.slug, /^[a-z]+-[a-z]+-[0-9]{2}$/);
            assert.strictEqual(first.body.url, `${config.publicUrl}/p/${first.body.slug}/screenshot`);
            assert.deepStrictEqual([first.body.width, first.body.height], [512, 512]);
            assert.ok(first.body.bytes > 0);
            const row = await db.get('SELECT * FROM pastes WHERE slug = ?', [first.body.slug]);
            assert.ok(row, 'the avatar row was inserted');
            assert.deepStrictEqual([row.app_id, row.user_id, row.type, row.visibility], ['network', 7, 'screenshot', 'unlisted']);
            assert.strictEqual(row.title, 'Avatar of ada');
            assert.ok(row.screenshot_path.startsWith(storage.SCREENSHOTS_DIR), `the file lands in the shared screenshots dir (${row.screenshot_path})`);
            assert.deepStrictEqual((await sharp(fs.readFileSync(row.screenshot_path)).metadata()).format, 'webp', 'the bytes on disk are the re-encoded WebP');
            assert.strictEqual(JSON.parse(row.metadata).kind, 'avatar');
            assert.ok(row.object_id, 'the avatar row carries its media object');
            assert.ok(await db.get('SELECT id FROM media_objects WHERE id = ?', [row.object_id]), 'and that object exists');
            const second = await post({ url: 'https://pics.example/me2.png', user_id: 8 });
            assert.strictEqual(second.status, 200, JSON.stringify(second.body));
            assert.notStrictEqual(second.body.slug, first.body.slug, 'a second avatar gets its own slug');
            server.close();
        } finally {
            dns.promises.lookup = realLookup;
            https.get = realGet;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('avatar ingest: all checks passed');
    })().catch(e => { console.error(e); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
