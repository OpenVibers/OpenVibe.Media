'use strict';
// SSRF (roadmap WS-R task 5). Media connects to an address someone else chose in two places:
//   - POST /internal/avatar-ingest fetches the picture URL a person gave (server/avatars/ingest.js), through
//     its guard: https only, openvibe-shared/egress's address rule for every DNS answer and literal, the
//     connection pinned to the checked address, every redirect hop checked again;
//   - POST /api/v1/:app/vods/:id/ingest/rtmp makes ffmpeg pull an app-supplied rtmp_url, which must name an
//     allow-listed host:port (MEDIA_RTMP_PULL_ALLOW; test/rtmp-allowlist.test.js has the URL grammar).
// Every other outbound request goes to an operator-configured address (Network, Events, Live's internal
// URL, B2/R2, an app's webhook_url from MEDIA_APPS_SEED, IndexNow's fixed api.indexnow.org from
// INDEXNOW_KEY). The inventory below fails when a new outbound call appears in server/ until it is
// classified here, and no route lets a tenant set a webhook URL.
// No test here needs the network: literals and internal names are refused before DNS, and DNS answers
// and the socket are stubbed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dns = require('dns');
const https = require('https');

(async () => {
    const ROOT = path.join(__dirname, '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-ssrf-'));
    process.env.OBJECTS_PATH = path.join(tmp, 'objects');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    delete process.env.MEDIA_RTMP_PULL_ALLOW;

    // ── Inventory: every outbound call in server/, and whose address it uses ──
    const OUTBOUND = {
        'server/avatars/ingest.js': 'a person\'s picture URL: safeFetchImage, tested below',
        'server/account-data.js': 'Network internal API (OV_NETWORK_INTERNAL_URL), fixed paths: export parts and deletion confirmations',
        'server/user-auth.js': 'Network OAuth (OV_NETWORK_URL / OV_NETWORK_INTERNAL_URL); the signing keys come from openvibe-sdk/auth',
        'server/webhooks.js': 'an app\'s webhook_url, set by the operator (MEDIA_APPS_SEED)',
        'server/thumbnails/live-frame-service.js': 'the app\'s internal URL (APP_INTERNAL_URLS), fixed path',
        'server/public/dev-data.js': 'the app\'s internal URL (APP_INTERNAL_URLS), ids and encoded names in the path',
        'server/jobs/pack.js': 'a presigned GET on B2/R2 (operator-configured buckets) for a segment\'s durable copy',
        'server/objects/routes.js': 'a ranged GET on a presigned B2/R2 URL (operator-configured buckets) for a packed segment\'s chunk',
        'server/jobs/previews.js': 'a (ranged) GET on a presigned B2/R2 URL (operator-configured buckets) for a timeline segment, to cut a sprite frame',
        'server/drill.js': 'restore drill: only this server itself',
        'server/me/client.js': 'browser script, same-origin',
    };
    {
        const found = new Set();
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (p.endsWith('.js') && /\bfetch\(|\bhttps?\.(get|request)\(|\b(net|tls)\.connect\(|require\(['"](axios|got|node-fetch|undici)['"]\)/.test(fs.readFileSync(p, 'utf8'))) found.add(path.relative(ROOT, p));
            }
        };
        walk(path.join(ROOT, 'server'));
        for (const f of found) assert.ok(OUTBOUND[f], `${f} makes an outbound request: classify it in test/security-ssrf.test.js (a user-chosen address must go through a guard)`);
        for (const f of Object.keys(OUTBOUND)) assert.ok(found.has(f), `${f} no longer makes an outbound request: drop it from the inventory`);
        // Webhook targets are operator configuration: the only SQL that writes an app's webhook_url is
        // db.upsertApp, and the only caller of that is app seeding (MEDIA_APPS_SEED / MEDIA_APP_KEYS).
        const sqlWriters = [], upserters = [];
        const scan = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) { scan(p); continue; }
                if (!p.endsWith('.js')) continue;
                const src = fs.readFileSync(p, 'utf8');
                if (/(INSERT\s+(OR\s+\w+\s+)?INTO\s+apps|UPDATE\s+apps\s+SET)[^;]*webhook_url/i.test(src)) sqlWriters.push(path.relative(ROOT, p));
                if (/\bupsertApp\(/.test(src) && !p.endsWith(path.join('db', 'database.js'))) upserters.push(path.relative(ROOT, p));
            }
        };
        scan(path.join(ROOT, 'server'));
        assert.deepStrictEqual(sqlWriters, ['server/db/database.js'], 'only db.upsertApp writes an app\'s webhook_url');
        assert.deepStrictEqual(upserters, ['server/auth.js'], 'and only app seeding calls it');
        assert.ok(/function seedApps[\s\S]*upsertApp\(/.test(fs.readFileSync(path.join(ROOT, 'server/auth.js'), 'utf8')), 'from seedApps');
        // IndexNow (openvibe-shared/indexnow, wired in server/index.js): the only outbound request made
        // from a dependency. Its endpoint is the fixed api.indexnow.org and host/key are operator config
        // (MEDIA_PUBLIC_URL / INDEXNOW_KEY) — never a tenant or a user-supplied URL, and no route reaches it.
        const idxSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
        assert.ok(idxSrc.includes('createIndexNow(') && idxSrc.includes('host: config.publicUrl') && idxSrc.includes('key: config.indexnow.key'),
            'IndexNow is wired from operator config (host/key), the one outbound dependency');
        console.log(`✅ outbound inventory: ${found.size} files, one user-chosen address (avatar ingest); webhook URLs are operator-set; IndexNow posts to the fixed api.indexnow.org`);
    }

    const ingest = require('../server/avatars/ingest');
    const { checkRtmpUrl } = require('../server/vod/recorder');

    const INTERNAL_IPS = ['127.0.0.1', '127.8.9.10', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '255.255.255.255', '224.0.0.1',
        '::', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1', '::7f00:1',
        'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:a9fe:a9fe::1',
        '2001:0:4136:e378:8000:63bf:80ff:fffe', '2001:db8::1'];
    for (const ip of INTERNAL_IPS) assert.strictEqual(ingest.isPublicAddress(ip), false, `not public: ${ip}`);
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.strictEqual(ingest.isPublicAddress(ip), true, `public: ${ip}`);
    console.log('✅ avatar address rule: loopback, RFC 1918, link-local/metadata, CGNAT, 0/8, multicast and every IPv6 form of them refused');

    (async () => {
        const rejects = async (p, re, msg) => { let e = null; try { await p; } catch (x) { e = x; } assert.ok(e && re.test(e.message), `${msg} (got: ${e ? e.message : 'no error'})`); };
        const DENIED = /not on the public internet|https address|username or password|standard https port|not a web address/;
        // DNS is stubbed: names below answer from this table; any other name fails the test (nothing leaves the host).
        const answers = {};
        const lookups = [];
        dns.promises.lookup = async (host, opts) => {
            lookups.push(host);
            const a = answers[host];
            if (!a) throw new Error(`unexpected DNS lookup for ${host}`);
            return typeof a === 'function' ? a() : a;
        };
        let fetched = [];
        const noFetch = async (u) => { fetched.push(u.hostname); throw new Error('fetcher reached'); };

        // ── Literal and encoded internal addresses, internal names, other schemes: refused before DNS or a socket ──
        const refusedUrls = [
            'https://127.0.0.1/a.png', 'https://127.1/a.png', 'https://2130706433/a.png', 'https://0177.0.0.1/a.png', 'https://0x7f000001/a.png', 'https://0x7f.0.0.1/a.png',
            'https://017700000001/a.png', 'https://0.0.0.0/a.png', 'https://0/a.png', 'https://10.1.2.3/a.png', 'https://192.168.0.1/a.png', 'https://169.254.169.254/latest/meta-data/iam/',
            'https://2852039166/latest/meta-data/', 'https://[::1]/a.png', 'https://[::]/a.png', 'https://[::ffff:127.0.0.1]/a.png', 'https://[::ffff:7f00:1]/a.png',
            'https://[::ffff:169.254.169.254]/a.png', 'https://[0:0:0:0:0:0:0:1]/a.png', 'https://[fc00::1]/a.png', 'https://[fd00::1]/a.png', 'https://[fe80::1]/a.png',
            'https://[64:ff9b::7f00:1]/a.png', 'https://[2002:7f00:1::1]/a.png',
            'https://localhost/a.png', 'https://LOCALHOST./a.png', 'https://api.localhost/a.png', 'https://printer.local/a.png', 'https://metadata.google.internal/a.png', 'https://intranet/a.png',
            'http://93.184.216.34/a.png', 'ftp://93.184.216.34/a.png', 'file:///etc/passwd', 'gopher://93.184.216.34/', 'https://user:pw@93.184.216.34/a.png', 'https://93.184.216.34:8443/a.png',
            'https://93.184.216.34:22/a.png', 'not a url',
        ];
        for (const u of refusedUrls) await rejects(ingest.safeFetchImage(u, { fetcher: noFetch }), DENIED, `refused: ${u}`);
        assert.deepStrictEqual([fetched, lookups], [[], []], 'no connection and no DNS lookup for any of them');
        console.log(`✅ ${refusedUrls.length} internal, encoded (decimal, octal, hex, short), IPv6-wrapped and internal-name URLs refused before DNS or a socket`);

        // ── DNS answers: every answer must be public (a single private one refuses the name) ──
        Object.assign(answers, {
            'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
            'v6.example': [{ address: '::ffff:10.0.0.1', family: 6 }],
            'nat64.example': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
            'v6compat.example': [{ address: '::127.0.0.1', family: 6 }],
            'loop6.example': [{ address: '::1', family: 6 }],
            'meta.example': [{ address: '169.254.169.254', family: 4 }],
        });
        for (const h of Object.keys(answers)) await rejects(ingest.safeFetchImage(`https://${h}/a.png`, { fetcher: noFetch }), /not on the public internet/, `a name answering an internal address: ${h}`);
        assert.deepStrictEqual(fetched, [], 'no connection to any of them');

        // ── Redirects: each hop is checked again, whatever the first host was ──
        answers['good.example'] = [{ address: '93.184.216.34', family: 4 }];
        for (const target of ['https://127.0.0.1/x', 'https://2130706433/x', 'https://[::1]/x', 'https://[::ffff:7f00:1]/x', 'https://169.254.169.254/latest/meta-data/',
            'https://localhost/x', 'https://meta.example/x', 'http://good.example/x', 'https://good.example:8443/x', '//10.0.0.1/x']) {
            fetched = [];
            const fetcher = async (u) => { fetched.push(u.host); return fetched.length === 1 ? { redirect: target } : { body: Buffer.from('reached') }; };
            await rejects(ingest.safeFetchImage('https://good.example/a.png', { fetcher }), DENIED, `a redirect to ${target}`);
            assert.deepStrictEqual(fetched, ['good.example'], `the internal hop is never connected to (${target})`);
        }
        console.log('✅ DNS answers with any internal address, and redirects to internal addresses, are refused');

        // ── DNS rebinding: the socket connects to the address that was checked, not a second lookup ──
        let calls = 0;
        answers['rebind.example'] = () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
        const realGet = https.get;
        let opts = null;
        https.get = (o) => { opts = o; const req = new (require('events'))(); req.destroy = () => {}; setImmediate(() => req.emit('error', new Error('stubbed socket'))); return req; };
        try {
            await rejects(ingest.safeFetchImage('https://rebind.example/a.png'), /stubbed socket/, 'the real fetcher runs up to the socket');
        } finally { https.get = realGet; }
        assert.strictEqual(calls, 1, 'the name is resolved once');
        assert.strictEqual(opts.host, 'rebind.example', 'TLS still names the host');
        const pinned = await new Promise((resolve) => opts.lookup('rebind.example', {}, (err, address, family) => resolve({ err, address, family })));
        assert.deepStrictEqual([pinned.err, pinned.address, pinned.family], [null, '93.184.216.34', 4], 'the socket\'s lookup answers the checked address');
        const pinnedAll = await new Promise((resolve) => opts.lookup('rebind.example', { all: true }, (err, list) => resolve(list)));
        assert.deepStrictEqual(pinnedAll, [{ address: '93.184.216.34', family: 4 }], 'also when Node asks for every address');
        assert.strictEqual(calls, 1, 'connecting does not resolve again (a rebinding answer is never used)');
        console.log('✅ DNS rebinding: the connection is pinned to the checked address');

        // ── Through the route: an internal URL is refused and nothing is stored ──
        const db = require('../server/db/database');
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.post('/internal/avatar-ingest', ingest.createIngestHandler({ db, config: require('../server/config'), log: { warn() {} } }));
        const server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        for (const url of ['https://169.254.169.254/latest/meta-data/iam/security-credentials/', 'https://[::ffff:7f00:1]/a.png', 'https://2130706433/a.png', 'https://localhost/a.png', 'https://mixed.example/a.png']) {
            const r = await fetch(`http://127.0.0.1:${server.address().port}/internal/avatar-ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, user_id: 1 }) });
            const body = await r.json();
            assert.deepStrictEqual([r.status, body.ok], [422, false], `${url}: ${JSON.stringify(body)}`);
        }
        assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM media_objects WHERE kind = 'avatar'")).n, 0, 'no avatar object was stored');
        assert.ok(!fs.existsSync(require('../server/config').objects.path) || fs.readdirSync(require('../server/config').objects.path).length === 0, 'no object file was written');
        server.close();
        console.log('✅ POST /internal/avatar-ingest refuses internal URLs and stores nothing');

        // ── RTMP pull: only the allow-listed host:port, in no other spelling ──
        for (const u of ['rtmp://2130706433:1935/live/k', 'rtmp://0177.0.0.1:1935/live/k', 'rtmp://0x7f000001:1935/live/k', 'rtmp://127.1:1935/live/k', 'rtmp://0.0.0.0:1935/live/k',
            'rtmp://[::ffff:127.0.0.1]:1935/live/k', 'rtmp://[::ffff:7f00:1]:1935/live/k', 'rtmp://[fe80::1]:1935/live/k', 'rtmp://169.254.169.254:1935/live/k', 'rtmp://10.0.0.5:1935/live/k',
            'rtmp://localhost.:1935/live/k', 'rtmp://127.0.0.1.nip.io:1935/live/k', 'rtmp://localhost.evil.example:1935/live/k', 'rtmp://127.0.0.1:19350/live/k', 'rtmp://127.0.0.1:1935@evil.example/live/k',
            'http://127.0.0.1:1935/live/k', 'rtmpt://127.0.0.1:1935/live/k', 'file:///etc/passwd']) {
            assert.strictEqual(checkRtmpUrl(u).ok, false, `RTMP pull refused: ${u}`);
        }
        assert.strictEqual(checkRtmpUrl('rtmp://127.0.0.1:1935/live/k').ok, true, 'Live\'s RTMP server on this host (control)');
        console.log('✅ RTMP pull: encoded, IPv6-mapped and look-alike hosts are not the allow-listed one');

        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('security-ssrf: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
