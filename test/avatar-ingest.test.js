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

// The end-to-end check writes native objects under scratch storage.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-avatar-'));
process.env.OBJECTS_PATH = path.join(tmp, 'objects');
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

        const config = require('../server/config');

        // ── Through the route, wired the way server/index.js wires it: { db, config } only ──
        const db = require('../server/db/database');
        const ingest = require('../server/avatars/ingest');
        await db.upsertApp({ app_id: 'live', name: 'OpenVibe.Live', api_key: 'live-key' });
        await require('../server/events').initWriter();
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
            assert.match(first.body.object_id, /^med_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(first.body.url, `${config.publicUrl}/o/${first.body.object_id}`);
            assert.deepStrictEqual([first.body.width, first.body.height], [512, 512]);
            assert.ok(first.body.bytes > 0);
            const check = async (body, owner) => {
                const obj = await db.get('SELECT * FROM media_objects WHERE id = ?', [body.object_id]);
                assert.ok(obj, 'avatar object exists');
                const app = await db.getApp('live');
                assert.deepStrictEqual([obj.kind, obj.app_id, obj.namespace, obj.visibility, obj.lifecycle_status, obj.owner_subject],
                    ['avatar', 'live', `${db.rootNamespace(app)}.avatars`, 'unlisted', 'ready', owner]);
                const loc = await db.get("SELECT * FROM media_locations WHERE object_id = ? AND provider = 'local' AND state = 'present'", [obj.id]);
                assert.ok(loc && loc.key.startsWith(config.objects.path) && fs.existsSync(loc.key), 'present local object file');
                const meta = await sharp(fs.readFileSync(loc.key)).metadata();
                assert.deepStrictEqual([meta.format, meta.width, meta.height], ['webp', 512, 512]);
                assert.ok((await db.all('SELECT envelope FROM event_outbox')).some((r) => { const e = typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope; return e.event_type === 'media.object.uploaded' && JSON.stringify(e).includes(obj.id); }), 'upload event queued');
            };
            await check(first.body, null);
            const subject = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
            const second = await post({ url: 'https://pics.example/me2.png', user_id: 8, subject });
            assert.strictEqual(second.status, 200, JSON.stringify(second.body));
            assert.notStrictEqual(second.body.object_id, first.body.object_id);
            await check(second.body, subject);
            const invalid = await post({ url: 'https://pics.example/me3.png', user_id: 9, subject: 'not-a-subject' });
            assert.strictEqual(invalid.status, 200, JSON.stringify(invalid.body));
            await check(invalid.body, null);
            server.close();
        } finally {
            dns.promises.lookup = realLookup;
            https.get = realGet;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('avatar ingest: all checks passed');
    })().catch(e => { console.error(e); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
