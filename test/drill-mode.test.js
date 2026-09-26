'use strict';
/**
 * MEDIA_DRILL=1 (server/drill.js): a restore-drill instance (`ovhost drill media`, OpenVibe.Host
 * docs/restore-drills.md) serves reads from a restored copy of media.db and does nothing else.
 *
 *   - It refuses to start when DB_PATH is production's media.db or inside the checkout, when HOST is
 *     not loopback or PORT is production's 4100, before the database is opened (a real
 *     `node server/index.js`, in a child process).
 *   - Booted for real (server/index.js, in this process) on a copy whose `live` app has a webhook
 *     URL, with production-like settings (EVENTS_URL + client secret, B2/R2, app seeding, VOD_PATH …):
 *     one listener, its HTTP port on 127.0.0.1; no setInterval and no long timer from Media's code;
 *     no program but git (no ffmpeg/ffprobe); no outbound connection; no webhook reaches the app;
 *     nothing written or created outside the copy's directory.
 *   - The endpoints the Host inventory compares (/release.json, the /browse index) and the watch pages
 *     render from the copy; every route that would stream a stored file answers 503 without opening
 *     the path the database gives it.
 *   - Writes answer 403 (POST /release-metrics too), sign-in 503, and the copy's rows stay as they were.
 *
 * Run: node test/drill-mode.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-drill-test-'));
// "Production": its database and its storage, with real files the database points at.
const PROD = path.join(tmp, 'prod');
const P = { vods: path.join(PROD, 'vods'), clips: path.join(PROD, 'clips'), pastes: path.join(PROD, 'pastes'), files: path.join(PROD, 'files'), objects: path.join(PROD, 'objects'), assets: path.join(PROD, 'assets'), thumbs: path.join(PROD, 'thumbnails') };
// The drill: the restored copy in its own directory; storage the way the Host inventory sets it
// (every directory but thumbnails moved under the drill directory, never created).
const DRILL = path.join(tmp, 'drill');
const DB_PATH = path.join(DRILL, 'db', 'media.db');
const STORAGE = path.join(DRILL, 'storage');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
}
function freePort() {
    return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
/** Every file and directory under dir with its size and mtime. */
function snapshot(dir) {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const s = fs.statSync(p); out[path.relative(dir, p)] = `${e.isDirectory() ? 'dir' : s.size}:${s.mtimeMs}`; if (e.isDirectory()) walk(p); } };
    walk(dir);
    return out;
}

const drillMod = require('../server/drill');   // MEDIA_DRILL is unset here: `enabled` is false until the boot below
const safe = { DB_PATH, HOST: '127.0.0.1', PORT: '14100' };

(async () => {
    console.log('drill-mode: environment guard');
    await check('MEDIA_DRILL parses like a switch and is off by default', () => {
        for (const v of ['1', 'true', 'on', 'yes']) assert.strictEqual(drillMod.parse(v), true, v);
        for (const v of ['', '0', 'false', 'off', undefined]) assert.strictEqual(drillMod.parse(v), false, String(v));
        assert.strictEqual(drillMod.enabled, false);
    });
    await check('a safe environment passes', () => assert.deepStrictEqual(drillMod.problems(safe), []));
    await check('refuses production\'s media.db (the checkout\'s, /opt/openvibe.media\'s, the relative default)', () => {
        for (const p of [path.join(REPO, 'data', 'media.db'), '/opt/openvibe.media/data/media.db']) {
            assert.ok(drillMod.problems({ ...safe, DB_PATH: p }).some((m) => /production's database/.test(m)), p);
        }
        assert.ok(drillMod.problems({ ...safe, DB_PATH: './data/media.db' }, { cwd: REPO }).some((m) => /production's database/.test(m)));
        assert.ok(drillMod.problems({ ...safe, DB_PATH: '' }).some((m) => /DB_PATH is not set/.test(m)));
    });
    await check('refuses a copy inside the checkout or /opt/openvibe.media, also through a symlink', () => {
        assert.ok(drillMod.problems({ ...safe, DB_PATH: path.join(REPO, 'drill.db') }).some((m) => /is inside/.test(m)));
        assert.ok(drillMod.problems({ ...safe, DB_PATH: '/opt/openvibe.media/drill/media.db' }).some((m) => /is inside \/opt\/openvibe\.media/.test(m)));
        const link = path.join(tmp, 'sneaky');
        fs.symlinkSync(REPO, link);
        assert.ok(drillMod.problems({ ...safe, DB_PATH: path.join(link, 'copy.db') }).some((m) => /is inside/.test(m)));
        fs.unlinkSync(link);
    });
    await check('refuses a non-loopback HOST and production\'s PORT', () => {
        for (const h of ['', '0.0.0.0', '::', '10.0.0.4']) assert.ok(drillMod.problems({ ...safe, HOST: h }).some((m) => /not loopback/.test(m)), h);
        for (const h of ['127.0.0.1', '::1', 'localhost']) assert.deepStrictEqual(drillMod.problems({ ...safe, HOST: h }), [], h);
        assert.ok(drillMod.problems({ ...safe, PORT: '4100' }).some((m) => /production's port/.test(m)));
        assert.ok(drillMod.problems({ ...safe, PORT: '' }).some((m) => /PORT is not set/.test(m)));
    });

    // ── A real `node server/index.js` refuses before opening anything ──
    console.log('drill-mode: refusal at boot');
    const refusalPort = await freePort();
    const boot = (env) => spawnSync(process.execPath, [path.join(SERVER, 'index.js')], {
        cwd: REPO, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, MEDIA_DRILL: '1', HOST: '127.0.0.1', PORT: String(refusalPort), ...env },
    });
    const stamp = (p) => { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
    await check('DB_PATH = production\'s media.db: exit 1, the file untouched', () => {
        const prod = path.join(REPO, 'data', 'media.db');
        const before = [prod, `${prod}-wal`, `${prod}-shm`].map(stamp);
        const r = boot({ DB_PATH: prod });
        assert.strictEqual(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /refusing to start a restore-drill instance: DB_PATH .* is production's database/);
        assert.deepStrictEqual([prod, `${prod}-wal`, `${prod}-shm`].map(stamp), before);
    });
    await check('HOST 0.0.0.0: exit 1 before the database is created', () => {
        const other = path.join(tmp, 'never', 'media.db');
        const r = boot({ DB_PATH: other, HOST: '0.0.0.0' });
        assert.strictEqual(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /HOST \(0\.0\.0\.0\) is not loopback/);
        assert.ok(!fs.existsSync(path.dirname(other)));
    });

    // ── Production's database and files (a normal-mode process writes them) ──
    // The `live` app's webhook goes to a sink here: a drill must never call it.
    const sinkHits = [];
    const sink = http.createServer((req, res) => { sinkHits.push(`${req.method} ${req.url}`); res.end('ok'); });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const SINK = `http://127.0.0.1:${sink.address().port}/media-webhook`;
    for (const d of Object.values(P)) fs.mkdirSync(d, { recursive: true });
    const bytes = { vod: path.join(P.vods, 'vod-1.mp4'), rec: path.join(P.vods, 'vod-2.mp4'), clip: path.join(P.clips, 'clip-1.mp4'), asset: path.join(P.assets, 'wave.png'), shot: path.join(P.pastes, 'shot-1.png'), file: path.join(P.files, 'live', 'f1.txt') };
    fs.mkdirSync(path.dirname(bytes.file), { recursive: true });
    for (const f of Object.values(bytes)) fs.writeFileSync(f, `bytes of ${path.basename(f)}`);
    fs.writeFileSync(path.join(P.thumbs, 'vod-1-1.jpg'), 'jpeg');
    const prodDb = path.join(PROD, 'media.db');
    const seed = spawnSync(process.execPath, ['-e', `
        const db = require('./server/db/database');
        db.getDb();
        require('./server/views/service').ensureSchema();
        const b = ${JSON.stringify(bytes)};
        db.run("INSERT INTO apps (app_id, name, api_key_hash, webhook_url, webhook_secret) VALUES ('live', 'OpenVibe.Live', ?, ?, 'whsec')", [require('crypto').createHash('sha256').update('k'.repeat(40)).digest('hex'), ${JSON.stringify(SINK)}]);
        db.run("INSERT INTO vods (app_id, title, file_path, thumbnail_url, duration_seconds, is_public, visibility) VALUES ('live', 'Restored VOD', ?, '/t/vod-1-1.jpg', 60, 1, 'public')", [b.vod]);
        db.run("INSERT INTO vods (app_id, title, file_path, is_public, visibility, is_recording) VALUES ('live', 'Still recording', ?, 1, 'public', 1)", [b.rec]);
        db.run("INSERT INTO clips (app_id, vod_id, title, file_path, duration_seconds, status) VALUES ('live', 1, 'Restored clip', ?, 10, 'ready')", [b.clip]);
        db.run("INSERT INTO assets (app_id, kind, name, file_path, mime) VALUES ('live', 'emote', 'drillWave', ?, 'image/png')", [b.asset]);
        db.run("INSERT INTO pastes (app_id, slug, type, title, screenshot_path, visibility) VALUES ('live', 'shot1', 'screenshot', 'Shot', ?, 'public')", [b.shot]);
        db.run("INSERT INTO files (key, app_id, original_name, size, mime) VALUES ('f1.txt', 'live', 'f1.txt', 13, 'text/plain')");
        require('./server/objects/backfill').backfill({ onlyMissing: true });
        db.close();
    `], { cwd: REPO, encoding: 'utf8', env: { ...process.env, DB_PATH: prodDb, VOD_PATH: P.vods, CLIPS_PATH: P.clips, PASTES_PATH: P.pastes, FILES_PATH: P.files, OBJECTS_PATH: P.objects, ASSETS_PATH: P.assets, THUMBNAILS_PATH: P.thumbs } });
    assert.strictEqual(seed.status, 0, `seeding failed:\n${seed.stdout}\n${seed.stderr}`);
    // The restore: a copy of the database file in the drill's own directory.
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.copyFileSync(prodDb, DB_PATH);
    const Database = require('better-sqlite3');
    const COUNTED = ['media_objects', 'vods', 'clips', 'apps', 'media_locations', 'media_jobs', 'event_outbox'];
    const counts = () => { const d = new Database(DB_PATH, { readonly: true }); try { return Object.fromEntries(COUNTED.map((t) => { try { return [t, d.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]; } catch { return [t, null]; } })); } finally { d.close(); } };
    const countsBefore = counts();
    const objectId = (() => { const d = new Database(DB_PATH, { readonly: true }); try { return d.prepare("SELECT id FROM media_objects WHERE kind = 'vod' ORDER BY id LIMIT 1").get().id; } finally { d.close(); } })();
    const prodBefore = snapshot(PROD);

    // ── Boot the real server in drill mode, in this process, with spies ──
    const port = await freePort();
    Object.assign(process.env, {
        MEDIA_DRILL: '1', DB_PATH, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
        // What the production env file sets; a normal boot would act on all of it.
        EVENTS_URL: 'http://127.0.0.1:9', OV_OAUTH_CLIENT_SECRET: 's'.repeat(40), INTERNAL_API_KEY: 'k'.repeat(40),
        MEDIA_APP_KEYS: `live:${'n'.repeat(40)},games:${'g'.repeat(40)}`,
        MEDIA_B2_ENDPOINT: 'https://s3.example.invalid', MEDIA_B2_BUCKET: 'b', MEDIA_B2_KEY_ID: 'id', MEDIA_B2_APP_KEY: 'key',
        MEDIA_R2_ENDPOINT: 'https://r2.example.invalid', MEDIA_R2_BUCKET: 'r', MEDIA_R2_ACCESS_KEY_ID: 'id', MEDIA_R2_SECRET_ACCESS_KEY: 'key',
        // The Host inventory's storage: nothing but the thumbnail listing points at production.
        VOD_PATH: path.join(STORAGE, 'vods'), CLIPS_PATH: path.join(STORAGE, 'clips'), PASTES_PATH: path.join(STORAGE, 'pastes'),
        FILES_PATH: path.join(STORAGE, 'files'), OBJECTS_PATH: path.join(STORAGE, 'objects'), ASSETS_PATH: path.join(STORAGE, 'assets'),
        THUMBNAILS_PATH: P.thumbs,
    });
    const inServer = (stack) => {
        const frame = stack.split('\n').slice(2).find((l) => l.includes(REPO) && !l.includes(`${path.sep}node_modules${path.sep}`) && !l.includes(__filename));
        return frame && frame.includes(`${SERVER}${path.sep}`) ? frame.trim() : null;
    };
    const spied = { intervals: [], longTimeouts: [], listens: [], programs: [], dbPathTouches: [] };
    const realSetInterval = global.setInterval;
    global.setInterval = function (fn, ms, ...a) { spied.intervals.push({ ms, at: (new Error().stack.split('\n')[2] || '').trim() }); return realSetInterval(fn, ms, ...a); };
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, ms, ...a) { if (ms >= 1000) { const at = inServer(new Error().stack); if (at) spied.longTimeouts.push({ ms, at }); } return realSetTimeout(fn, ms, ...a); };
    const realListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...a) { spied.listens.push(a[0]); return realListen.apply(this, a); };
    const cp = require('child_process');
    for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const orig = cp[fn];
        cp[fn] = function (...a) { spied.programs.push(fn === 'exec' || fn === 'execSync' ? String(a[0]).split(/\s+/)[0] : String(a[0])); return orig.apply(this, a); };
    }
    // Any look at a file path the database holds (production's media) is recorded.
    const dbPaths = new Set(Object.values(bytes));
    for (const fn of ['createReadStream', 'statSync', 'existsSync', 'openSync', 'readFileSync', 'stat', 'open', 'readFile']) {
        const orig = fs[fn];
        fs[fn] = function (p, ...a) { if (dbPaths.has(String(p))) spied.dbPathTouches.push(`${fn} ${p}`); return orig.call(this, p, ...a); };
    }

    delete require.cache[require.resolve('../server/drill')];   // loaded above with MEDIA_DRILL unset
    require('../server/index.js');
    const drill = require('../server/drill');
    const base = `http://127.0.0.1:${port}`;
    const request = (method, p, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
        const req = http.request(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
    let ready = null;
    for (let i = 0; i < 150 && !(ready && ready.status === 200); i++) {
        try { ready = await request('GET', '/api/ready'); } catch { /* not listening yet */ }
        if (!ready || ready.status !== 200) await new Promise((r) => realSetTimeout(r, 100));
    }
    await new Promise((r) => realSetTimeout(r, 1500));   // let anything deferred show itself

    console.log('drill-mode: a booted drill instance');
    await check('/api/ready is 200, mode: drill, and checks no storage and no remote tier', () => {
        assert.strictEqual(ready && ready.status, 200, ready && ready.text);
        assert.strictEqual(ready.json.ready, true);
        assert.strictEqual(ready.json.mode, 'drill');
        assert.deepStrictEqual(Object.keys(ready.json.checks).filter((k) => /^(storage|remote)_/.test(k)), []);
        assert.strictEqual(ready.json.checks.events_outbox.detail.enabled, false);
    });
    await check('one listener: its HTTP port on 127.0.0.1 (no RTP, no other server)', () => {
        assert.deepStrictEqual(spied.listens.map(String), [String(port)]);
        const servers = process._getActiveHandles().filter((h) => h instanceof net.Server && h.listening && h !== sink);
        assert.deepStrictEqual(servers.map((s) => s.address()), [{ address: '127.0.0.1', family: 'IPv4', port }]);
    });
    await check('no timers: no setInterval at all, no timer of a second or more from Media\'s code', () => {
        assert.deepStrictEqual(spied.intervals, [], JSON.stringify(spied.intervals, null, 1));
        assert.deepStrictEqual(spied.longTimeouts, [], JSON.stringify(spied.longTimeouts, null, 1));
    });
    await check('no program but git ran, nothing tried to leave, no webhook reached the app', () => {
        assert.ok(spied.programs.every((p) => path.basename(p) === 'git'), spied.programs.join(', '));
        assert.deepStrictEqual(drill.blocked, []);
        assert.deepStrictEqual(sinkHits, []);
    });
    await check('no app seeding: the copy\'s apps are production\'s, untouched by MEDIA_APP_KEYS', () => {
        assert.deepStrictEqual(counts(), countsBefore);
    });

    console.log('drill-mode: reads');
    const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    await check('the endpoints the Host inventory compares render from the copy and ask nobody', async () => {
        const rel = await request('GET', '/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json.release, head);
        const videos = await request('GET', '/browse?tab=videos');
        assert.strictEqual(videos.status, 200);
        assert.ok(videos.text.includes('Restored VOD') && !videos.text.includes('Still recording'));
        assert.match(videos.text, /Thumbnails<span class="n">1</, 'the thumbnail listing is production\'s directory');
        const clips = await request('GET', '/browse?tab=clips');
        assert.strictEqual(clips.status, 200);
        assert.ok(clips.text.includes('Restored clip'));
        assert.strictEqual((await request('GET', '/')).status, 200);
        assert.strictEqual((await request('GET', '/healthz')).status, 200);
        const page = await request('GET', '/v/1', { headers: { Accept: 'text/html' } });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('Restored VOD'), 'the watch page renders from the row');
        assert.deepStrictEqual(drill.blocked, []);
        assert.deepStrictEqual(spied.dbPathTouches, []);
    });
    await check('every route that would stream a stored file answers 503 without opening the database\'s path', async () => {
        const byteRoutes = ['/v/1', '/v/1?raw=1', '/v/vod-1.mp4', '/c/1', '/c/1?raw=1', `/o/${objectId}`, '/t/vod-1-1.jpg', '/api/thumbnails/vod-1-1.jpg',
            '/a/1', '/f/f1.txt', '/f/screenshots/shot-1.png', '/p/shot1/screenshot', '/live/1/frame.jpg'];
        for (const p of byteRoutes) {
            const r = await request('GET', p, { headers: { Range: 'bytes=0-' } });
            assert.strictEqual(r.status, 503, `${p}: ${r.status} ${r.text.slice(0, 120)}`);
            assert.strictEqual(r.json && r.json.code, 'media.drill_no_bytes', p);
        }
        assert.deepStrictEqual(spied.dbPathTouches, [], 'no stored file was looked at');
        assert.deepStrictEqual(spied.programs.filter((p) => path.basename(p) !== 'git'), [], 'no ffmpeg/ffprobe');
    });

    console.log('drill-mode: writes, sign-in, side effects');
    await check('writes answer 403 on every path and change nothing; sign-in answers 503', async () => {
        const auth = { Authorization: `Bearer ${'k'.repeat(40)}` };
        const writes = [
            ['POST', '/api/v1/live/vods', { title: 'x' }], ['PUT', '/api/v1/live/vods/1', { title: 'y' }], ['DELETE', '/api/v1/live/vods/1', null],
            ['POST', '/api/v1/live/clips', { vod_id: 1 }], ['PUT', `/api/v2/live/objects/${objectId}/content`, 'raw bytes'], ['POST', '/api/v2/live/jobs', { type: 'thumbnail' }],
            ['POST', '/api/v1/live/admin/storage/tiers/sweep', {}], ['POST', '/internal/avatar-ingest', {}], ['PATCH', '/api/v1/live/vods/1', {}],
            ['POST', '/release-metrics', { counts: { reloaded: { user: 1 } } }],
        ];
        for (const [m, p, body] of writes) {
            const r = await request(m, p, { headers: auth, body });
            assert.strictEqual(r.status, 403, `${m} ${p}: ${r.status}`);
            assert.strictEqual(r.json && r.json.code, 'media.drill_read_only', `${m} ${p}`);
        }
        const login = await request('GET', '/auth/login');
        assert.strictEqual(login.status, 503);
        // The object explorer signs nobody in either, and verifies no token (that would ask Network for its key).
        const mine = await request('GET', '/api/v2/me/objects', { headers: { Cookie: 'ov_token=a.b.c' } });
        assert.deepStrictEqual([mine.status, mine.json && mine.json.code], [503, 'media.drill_no_sign_in']);
        const mePage = await request('GET', '/me', { headers: { Cookie: 'ov_token=a.b.c' } });
        assert.ok(mePage.status === 503 && mePage.text.includes('restore-drill'), `/me: ${mePage.status}`);
        assert.deepStrictEqual(drill.blocked, [], 'nothing tried to leave');
        assert.deepStrictEqual(counts(), countsBefore);
    });
    await check('webhooks and the Events relay stay off even when called', async () => {
        assert.strictEqual(await require('../server/webhooks').sendWebhook('live', 'vod.ready', { id: 1 }), false);
        assert.strictEqual(require('../server/events').init(), null);
        assert.deepStrictEqual(sinkHits, []);
    });
    await check('the guards refuse a connection, ffmpeg, a listener and a UDP socket', async () => {
        await assert.rejects(fetch('https://openvibe.live/internal/media-webhook'), /fetch failed/);
        const sock = net.connect({ host: '127.0.0.1', port: sink.address().port });
        const err = await new Promise((resolve) => sock.on('error', resolve));
        assert.strictEqual(err.code, 'ECONNREFUSED');
        assert.deepStrictEqual(sinkHits, [], 'the connection never reached the app');
        assert.throws(() => cp.spawn('ffmpeg', ['-version']), (e) => e.code === 'EDRILL');
        assert.throws(() => net.createServer().listen(12000), (e) => e.code === 'EDRILL');
        assert.throws(() => require('dgram').createSocket('udp4'), (e) => e.code === 'EDRILL');
    });
    await check('production\'s files are untouched and the drill created no storage directory', () => {
        assert.deepStrictEqual(snapshot(PROD), prodBefore);
        assert.ok(!fs.existsSync(STORAGE), `${STORAGE} was created`);
        assert.deepStrictEqual(fs.readdirSync(DRILL), ['db']);
    });

    sink.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    if (failures) { console.error(`\n${failures} drill-mode check(s) failed`); process.exit(1); }
    console.log('\ndrill-mode: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
