'use strict';
// Internal secrets never leave the service (roadmap WS-R task 5). The real server/index.js boots in this
// process with an obviously fake, low-entropy sentinel for every secret it reads from its environment
// (the list is checked against the source, so a new *_SECRET / *_KEY / *_TOKEN variable fails this test
// until it has a sentinel here), plus secrets it keeps in its database (app keys and their hashes, a
// webhook secret, the popularity salt) and a VOD's stream key. Then every route the Express router
// stack holds is requested (found by walking the stack, so new routes are covered without editing this
// file): GETs anonymously, with a wrong key, as the app (its admin), acting for a user, with a service
// token and as Network staff; writes anonymously, with a wrong key and as the app with a malformed body;
// plus explicit error paths (unknown routes and ids, oversized bodies, auth failures, bad signatures),
// /api/ready, /healthz, /metrics, /release.json and the admin config reads. No response body or header,
// no durable event in the outbox and no log line may contain any sentinel.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const ROOT = path.join(__dirname, '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-secrets-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    const CLOSED = 'http://127.0.0.1:9';   // nothing listens there: no tier, Live or Events is ever reached

    // ── Sentinels ────────────────────────────────────────────────
    const S = (name) => `sentinel-not-a-secret-${name}`;
    const LIVE_KEY = S('live-app-key');
    const GAMES_KEY = S('games-app-key');
    const SECRET_ENV = {
        INTERNAL_API_KEY: S('internal-api-key'),
        MEDIA_SIGNING_SECRET: S('media-signing-secret'),
        MEDIA_SECRET: S('media-secret'),
        VIEW_HASH_SECRET: S('view-hash-secret'),
        MEDIA_INBOUND_EVENTS_SECRET: S('media-inbound-events-secret'),
        OV_OAUTH_CLIENT_SECRET: S('oauth-client-secret'),
        MEDIA_B2_KEY_ID: S('b2-key-id'),
        MEDIA_B2_APP_KEY: S('b2-app-key'),
        MEDIA_R2_ACCESS_KEY_ID: S('r2-access-key-id'),
        MEDIA_R2_SECRET_ACCESS_KEY: S('r2-secret-access-key'),
        MEDIA_APP_KEYS: `live:${LIVE_KEY}`,
        MEDIA_APPS_SEED: JSON.stringify([{ app_id: 'games', name: 'Games', api_key: GAMES_KEY, webhook_url: `${CLOSED}/hook`, webhook_secret: S('games-webhook-secret'), allowed_origins: ['https://games.test'] }]),
    };
    const sentinels = new Map([
        ...Object.entries(SECRET_ENV).filter(([k]) => !['MEDIA_APP_KEYS', 'MEDIA_APPS_SEED'].includes(k)),
        ['live app key', LIVE_KEY], ['games app key', GAMES_KEY], ['games webhook secret', S('games-webhook-secret')],
        ['stream key', S('stream-key')], ['rtmp path key', S('rtmp-path-key')],
    ]);

    // Every secret-looking variable the service reads has a sentinel above.
    {
        const names = new Set();
        const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]); } };
        walk(path.join(ROOT, 'server'));
        for (const line of fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n')) { const m = /^\s*#?\s*([A-Z][A-Z0-9_]+)=/.exec(line); if (m) names.add(m[1]); }
        const secretish = [...names].filter(n => /SECRET|_KEY$|_KEYS$|KEY_ID$|TOKEN|PASSWORD|PASSWD|CREDENTIAL|_SEED$|PRIVATE/.test(n) && !/_(S|MS|MB|GB|MIN|HOURS|DAYS)$/.test(n));   // not the numeric settings (MEDIA_UPLOAD_TOKEN_TTL_S)
        assert.ok(secretish.length >= 10, `found the secret variables (${secretish})`);
        for (const n of secretish) assert.ok(Object.prototype.hasOwnProperty.call(SECRET_ENV, n), `${n} is read by the service: give it a sentinel in test/security-secrets.test.js`);
    }

    // A throwaway Network signing key: service tokens and staff sign-ins verify against it; its private half must never show.
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    sentinels.set('network private key', keys.privateKey.split('\n')[5]);

    // Output of the service (console lines) is kept to be checked too.
    let logs = '';
    for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write.bind(stream);
        stream.write = (chunk, ...rest) => { logs += String(chunk); return write(chunk, ...rest); };
    }

    // A stand-in Network on loopback: its signing key for tokens and sign-ins; no service tokens (503).
    const network = http.createServer((req, res) => {
        if (req.url === '/api/.well-known/jwks') {
            const jwk = crypto.createPublicKey(keys.publicKey).export({ format: 'jwk' });
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }], public_key: keys.publicKey, algorithm: 'RS256' }));
        }
        req.resume();
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"unavailable"}');
    });

    (async () => {
        await new Promise((r) => network.listen(0, '127.0.0.1', r));
        const NET = `http://127.0.0.1:${network.address().port}`;
        Object.assign(process.env, SECRET_ENV, {
            PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'test',
            VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), PASTES_PATH: dir('pastes'),
            THUMBNAILS_PATH: dir('thumbnails'), FILES_PATH: dir('files'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
            MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: NET, OV_NETWORK_INTERNAL_URL: NET, EVENTS_URL: NET,
            OV_LIVE_INTERNAL_URL: CLOSED, LIVE_APP_INTERNAL_URL: CLOSED, APP_INTERNAL_URLS: JSON.stringify({ live: CLOSED }),
            MEDIA_B2_ENDPOINT: CLOSED, MEDIA_B2_BUCKET: 'b2-bucket', MEDIA_B2_REGION: 'us-west-004',
            MEDIA_R2_ENDPOINT: CLOSED, MEDIA_R2_BUCKET: 'r2-bucket', MEDIA_R2_REGION: 'auto',
            MEDIA_JOBS_ENABLED: '0', MEDIA_VERIFY_ENABLED: '0', MEDIA_OWNER_SUBJECT_SYNC: '0', MEDIA_LINEAGE: 'off',
        });
        for (const k of ['MEDIA_DRILL', 'PASTES_MOVED_TO', 'EVENTS_PUBLISH']) delete process.env[k];

        const { app, server } = await require('../server/index.js').ready;
        if (!server.listening) await new Promise((r) => server.once('listening', r));
        const auth = require('../server/auth');
        auth._setNetworkPublicKeyForTests(keys.publicKey);
        const db = require('../server/db/database');
        const base = `http://127.0.0.1:${server.address().port}`;

        // ── Credentials ──
        const now = Math.floor(Date.now() / 1000);
        const { serviceAuth } = require('openvibe-contracts');
        const svcToken = (over = {}) => serviceAuth.signServiceToken({
            iss: NET, sub: 'svc:example', actor_type: 'service', aud: ['openvibe.media'], cap: ['media.object.upload', 'media.object.read', 'media.object.list', 'media.derivative.create'],
            ns: ['live', 'live.*'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...over,
        }, keys.privateKey);
        const jwt = require('jsonwebtoken');
        const staff = jwt.sign({ sub: 1, subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', username: 'staff', role: 'admin', aud: ['openvibe.media', 'openvibe.network'] }, keys.privateKey, { algorithm: 'RS256', issuer: NET, expiresIn: 300 });
        const IDS = {
            anonymous: {},
            wrongKey: { authorization: 'Bearer wrong-key' },
            otherApp: { authorization: `Bearer ${GAMES_KEY}` },
            app: { authorization: `Bearer ${LIVE_KEY}` },
            acting: { authorization: `Bearer ${LIVE_KEY}`, 'x-ov-user-id': '5' },
            service: { authorization: `Bearer ${svcToken()}` },
            expiredService: { authorization: `Bearer ${svcToken({ iat: now - 900, exp: now - 600 })}` },
            staff: { authorization: `Bearer ${staff}` },
            staffCookie: { cookie: `ov_token=${staff}` },
        };

        // ── Requests: every answer is kept for the scan ──
        const seen = [];
        const call = async (method, p, { headers = {}, body, json, as } = {}) => {
            const h = { ...headers };
            let payload = body;
            if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
            const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
            const buf = Buffer.from(await res.arrayBuffer());
            const text = buf.toString('latin1');
            seen.push({ where: `${method} ${p} [${as || Object.keys(headers).join(',') || 'anonymous'}]`, status: res.status, text, headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n') });
            let parsed = null; try { parsed = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
            return { status: res.status, body: parsed, text };
        };

        // ── Data to serve: a VOD carrying a stream key, a clip, objects public and private, a file, a hold ──
        let r = await call('POST', '/api/v1/live/vods', { headers: IDS.app, json: { title: 'Keyed', user_id: 5, stream_key: S('stream-key'), visibility: 'public' } });
        assert.strictEqual(r.status, 201, r.text);
        const vodId = r.body.id;
        const vodFile = path.join(process.env.VOD_PATH, `vod-${vodId}.webm`);
        fs.writeFileSync(vodFile, Buffer.alloc(64, 1));
        await db.run('UPDATE vods SET file_path = ?, duration_seconds = 10 WHERE id = ?', [vodFile, vodId]);
        r = await call('POST', `/api/v1/live/vods/${vodId}/ingest/rtmp`, { headers: IDS.app, json: { rtmp_url: `rtmp://10.0.0.5:1935/live/${S('rtmp-path-key')}` } });
        assert.ok(r.status >= 400, 'an address off the RTMP allow-list is refused');
        const clipFile = path.join(process.env.CLIPS_PATH, 'clip-a.webm');
        fs.writeFileSync(clipFile, Buffer.alloc(32, 2));
        const clipId = Number((await db.getDb().prepare("INSERT INTO clips (app_id, vod_id, user_id, title, file_path, is_public, visibility, status) VALUES ('live', ?, 5, 'Clip', ?, 1, 'public', 'ready') RETURNING id").run(vodId, clipFile)).lastInsertRowid);
        const mkObject = async (visibility) => {
            const bytes = Buffer.from(`hello ${visibility}`);
            let o = await call('POST', '/api/v2/live/objects', { headers: IDS.app, json: { kind: 'file', mime_type: 'text/plain', size_bytes: bytes.length, visibility, filename: 'a.txt' } });
            assert.strictEqual(o.status, 201, o.text);
            const id = o.body.id;
            o = await call('PUT', o.body.upload.url.replace('https://media.test', ''), { headers: { 'content-type': 'text/plain' }, body: bytes });
            assert.strictEqual(o.status, 200, o.text);
            o = await call('POST', `/api/v2/live/objects/${id}/complete`, { headers: IDS.app, json: {} });
            assert.strictEqual(o.status, 200, o.text);
            return id;
        };
        const pubObj = await mkObject('public');
        const privObj = await mkObject('private');
        const browser = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
        assert.strictEqual((await call('GET', `/o/${pubObj}`, { headers: browser })).status, 200, 'a view is counted (the day\'s salt is made)');
        r = await call('POST', `/api/v2/live/objects/${privObj}/holds`, { headers: IDS.app, json: { kind: 'dmca', reason: 'notice' } });
        assert.strictEqual(r.status, 201, r.text);
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from('file bytes')], { type: 'text/plain' }), 'f.txt');
        r = await call('POST', '/api/v1/live/files', { headers: IDS.app, body: fd });
        assert.strictEqual(r.status, 201, r.text);
        const fileKey = r.body.key;
        const signed = require('../server/objects/signing').signedDownloadUrl(privObj, 60).url.replace('https://media.test', '');

        // ── Every route in the router stack ──
        function mountPrefix(layer) {
            if (layer.regexp.fast_slash) return '';
            let i = 0;
            const p = layer.regexp.source
                .replace(/\(\?:(\\\/)?\(\[\^\\?\/\]\+\?\)\)/g, (_m, slash) => `${slash ? '/' : ''}:${layer.keys[i++].name}`)
                .replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
            assert.ok(/^[\w/:.-]*$/.test(p), `mount path read from the router stack: ${layer.regexp}`);
            return p;
        }
        const routes = [];
        (function walk(stack, prefix) {
            for (const layer of stack) {
                if (layer.route) {
                    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
                    for (const p of paths) {
                        if (typeof p !== 'string') continue;
                        for (const m of Object.keys(layer.route.methods)) if (m !== '_all') routes.push({ method: m.toUpperCase(), path: prefix + p });
                    }
                } else if (layer.handle && Array.isArray(layer.handle.stack)) {
                    walk(layer.handle.stack, prefix + mountPrefix(layer));
                }
            }
        })(app._router.stack, '');
        const uniq = [...new Map(routes.map(x => [`${x.method} ${x.path}`, x])).values()];
        for (const must of ['GET /o/:id', 'GET /api/v2/:app/objects/:id', 'GET /api/v1/:app/vods/:id', 'GET /v/:id', 'GET /api/v1/:app/admin/storage/tiers/policy', 'GET /api/v2/me/objects', 'GET /api/ready', 'GET /metrics', 'GET /release.json', 'POST /internal/avatar-ingest']) {
            assert.ok(uniq.some(x => `${x.method} ${x.path}` === must), `the router walk finds ${must}`);
        }
        assert.ok(uniq.length > 100, `the router walk finds the routes (${uniq.length})`);

        // Params: real ids where the path names that kind of thing, so the success paths are read as well.
        const fill = (p) => p.replace(/:(\w+)/g, (_m, name, off) => {
            const before = p.slice(0, off);
            if (name === 'app') return 'live';
            if (name === 'id') {
                if (/\/(objects|o)\/$/.test(before)) return pubObj;
                if (/\/(vods|v)\/$/.test(before)) return String(vodId);
                if (/\/(clips|c)\/$/.test(before)) return String(clipId);
                return '999999';
            }
            if (name === 'key') return encodeURIComponent(fileKey);
            if (name === 'namespace') return 'live';
            if (name === 'metric') return 'vods';
            if (name === 'kind') return 'vod';
            if (name === 'sel') return '@nobody';
            return 'x';
        });
        const SLOW = /^(POST|PUT|DELETE) .*\/(tiers\/(sweep|bulk-move|move)|ops\/recompute)$/;
        for (const { method, path: p } of uniq) {
            const url = fill(p);
            if (method === 'GET') {
                for (const who of Object.keys(IDS)) await call('GET', url, { headers: IDS[who], as: who });
                await call('GET', url.replace(/(live|\d{6,}|med_\w+)/, '999999'), { headers: IDS.app });   // unknown ids and tenants
            } else if (method !== 'OPTIONS') {
                for (const who of ['anonymous', 'wrongKey', 'otherApp', 'expiredService']) await call(method, url, { headers: { ...IDS[who], 'content-type': 'application/json' }, body: '{"broken": ', as: who });
                if (!SLOW.test(`${method} ${p}`)) await call(method, url, { headers: { ...IDS.app, 'content-type': 'application/json' }, body: '{"broken": ' });
            }
        }

        // ── Explicit error paths ──
        await call('GET', '/no/such/route');
        await call('GET', '/api/v1/live/no-such-route', { headers: IDS.app });
        await call('GET', '/api/v2/live/objects/not-an-id', { headers: IDS.app });
        await call('GET', '/api/v2/live/objects?cursor=bad', { headers: IDS.app });
        await call('GET', '/api/v1/nosuchapp/vods', { headers: IDS.app });
        await call('POST', '/api/v2/live/objects', { headers: { ...IDS.app, 'content-type': 'application/json' }, body: `{"x":"${'a'.repeat(3 * 1024 * 1024)}"}` });   // over the 2 MB JSON limit
        await call('POST', '/api/v2/live/objects', { headers: IDS.app, json: { kind: 'nope', size_bytes: -1, visibility: 'weird' } });
        await call('POST', '/api/v2/live/objects', { headers: IDS.app, json: { size_bytes: 1e15 } });
        await call('PUT', `/api/v2/live/objects/${privObj}/content?token=forged`, { body: 'x' });
        await call('GET', `/o/${privObj}?exp=1&sig=forged`);
        await call('GET', `${signed}x`);
        await call('GET', signed);
        await call('GET', `/api/v2/live/objects/${privObj}/download?format=json`, { headers: IDS.app });
        await call('POST', '/internal/avatar-ingest', { headers: { 'x-internal-key': 'wrong' }, json: { url: 'https://127.0.0.1/a.png', user_id: 1 } });
        await call('POST', '/internal/avatar-ingest', { headers: { 'x-internal-key': SECRET_ENV.INTERNAL_API_KEY }, json: { url: 'https://127.0.0.1/a.png', user_id: 1 } });
        await call('POST', '/internal/events', { headers: { 'content-type': 'application/json', 'x-openvibe-signature': 'v2=forged' }, body: '{}' });
        await call('GET', '/auth/callback?code=forged&state=forged');
        await call('GET', '/auth/login?next=/me');
        await call('GET', '/auth/me', { headers: IDS.staff });
        await call('POST', '/auth/refresh');
        await call('OPTIONS', '/api/v1/games/files', { headers: { origin: 'https://games.test', 'access-control-request-method': 'POST' } });
        await call('POST', '/api/v1/live/files', { headers: IDS.app, body: (() => { const f = new FormData(); f.append('file', new Blob([Buffer.alloc(10)]), 'x.bin'); return f; })() });
        for (const p of ['/api/v1/live/admin/storage', '/api/v1/live/admin/storage/tiers', '/api/v1/live/admin/storage/tiers/policy', '/api/v1/live/admin/storage/tiers/objects/policy',
            '/api/v1/live/admin/storage/config', '/api/v1/live/admin/storage/buckets', '/api/v1/live/admin/storage/ops', '/api/v1/live/admin/storage/holds?all=1', '/api/v1/live/stats']) {
            r = await call('GET', p, { headers: IDS.app });
        }
        r = await call('GET', '/api/ready');
        assert.ok([200, 503].includes(r.status) && r.body && r.body.checks, 'readiness answers with its checks');
        assert.strictEqual((await call('GET', '/metrics')).status, 200, 'metrics answer loopback callers');
        assert.strictEqual((await call('GET', '/healthz')).status, 200);
        assert.strictEqual((await call('GET', '/api/v1/live/admin/storage/tiers/policy', { headers: IDS.app })).status, 200, 'the admin config reads were read');
        assert.strictEqual((await call('GET', '/api/v2/me/ops', { headers: IDS.staff })).status, 200, 'staff read the operator report');
        assert.strictEqual((await call('GET', `/api/v2/live/objects/${pubObj}`, { headers: IDS.service })).status, 200, 'the service token was accepted');
        console.log(`✅ ${uniq.length} routes from the router stack and the error paths requested (${seen.length} responses)`);

        // ── Secrets the database holds ──
        for (const row of await db.all('SELECT app_id, api_key_hash FROM apps WHERE api_key_hash != \'\'')) sentinels.set(`${row.app_id} key hash`, row.api_key_hash);
        const salts = await db.all('SELECT salt FROM media_object_view_salts');
        assert.ok(salts.length >= 1, 'a popularity salt exists');
        salts.forEach((s, i) => sentinels.set(`popularity salt ${i}`, String(s.salt)));

        // A sentinel in plain text, URL-encoded, or base64 at any alignment (a cookie, a JWT, a state blob).
        const forms = (v) => {
            const out = new Set([v, encodeURIComponent(v)]);
            for (let pad = 0; pad < 3; pad++) {
                const b = Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(v)]).toString('base64');
                const core = b.slice(Math.ceil(pad * 4 / 3) + 1, -4);
                if (core.length >= 16) { out.add(core); out.add(core.replace(/\+/g, '-').replace(/\//g, '_')); }
            }
            return [...out];
        };
        const needles = [...sentinels].map(([name, v]) => [name, forms(v)]);
        const leaks = [];
        const scan = (where, text) => { for (const [name, fs_] of needles) if (fs_.some(f => text.includes(f))) leaks.push(`${name} in ${where}`); };
        for (const s of seen) { scan(`${s.where} body (${s.status})`, s.text); scan(`${s.where} headers`, s.headers); }
        assert.deepStrictEqual(leaks, [], 'no response carries a secret');
        console.log(`✅ no response body or header carries any of ${sentinels.size} secrets`);

        // ── Durable events: what Media would publish ──
        const outbox = await db.all('SELECT * FROM event_outbox');
        assert.ok(outbox.length >= 1, 'events were queued (the outbox is on)');
        scan('event_outbox', JSON.stringify(outbox));
        assert.deepStrictEqual(leaks, [], 'no queued event carries a secret');
        console.log(`✅ no queued event carries a secret (${outbox.length} events)`);

        // ── Logs ──
        scan('the service log', logs);
        assert.deepStrictEqual(leaks, [], 'no log line carries a secret');
        console.log('✅ no log line carries a secret');

        server.close();
        network.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('security-secrets: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
