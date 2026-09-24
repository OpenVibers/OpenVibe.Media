'use strict';
// 'trust proxy' is loopback only (server/client-ip.js, server/index.js): a request that came through
// the local nginx is attributed to the X-Forwarded-For address nginx set, and a caller reaching the
// port directly cannot choose its IP by sending X-Forwarded-For / CF-Connecting-IP itself (views and
// rate limits key on req.ip). The real server is booted to prove index.js applies it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');

const { TRUST_PROXY, clientIp } = require('../server/client-ip');

const get = (host, port, p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.end();
});
const externalAddress = () => {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
    return null;
};

(async () => {
    assert.strictEqual(TRUST_PROXY, 'loopback');

    // ── 1. The setting, on an app like index.js's: loopback proxies are believed, nobody else ──
    const app = express();
    app.set('trust proxy', TRUST_PROXY);
    app.get('/ip', (req, res) => res.json({ ip: req.ip, client: clientIp(req) }));
    const server = await new Promise((r) => { const s = app.listen(0, '0.0.0.0', () => r(s)); });
    const port = server.address().port;
    let r = JSON.parse((await get('127.0.0.1', port, '/ip', { 'X-Forwarded-For': '203.0.113.7' })).body);
    assert.deepStrictEqual([r.ip, r.client], ['203.0.113.7', '203.0.113.7'], 'through the local proxy: the forwarded client');
    r = JSON.parse((await get('127.0.0.1', port, '/ip')).body);
    assert.ok(/127\.0\.0\.1$/.test(r.ip), `loopback caller without a proxy header: ${r.ip}`);
    const ext = externalAddress();
    if (ext) {
        r = JSON.parse((await get(ext, port, '/ip', { 'X-Forwarded-For': '198.51.100.9', 'CF-Connecting-IP': '198.51.100.9' })).body);
        assert.ok(r.ip.endsWith(ext) && r.client.endsWith(ext), `a direct caller cannot choose its IP (got ${r.ip})`);
        console.log('✅ a non-loopback peer\'s X-Forwarded-For / CF-Connecting-IP are ignored');
    } else {
        console.log('⚠️  no non-loopback interface: the direct-caller check is skipped');
    }
    server.close();
    // The view counter keys on req.ip, not on the headers.
    assert.strictEqual(require('../server/views/service').clientIp({ ip: '192.0.2.4', headers: { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' } }), '192.0.2.4');
    assert.strictEqual(clientIp({ socket: { remoteAddress: '::1' }, headers: {} }), '::1');
    console.log('✅ trust proxy loopback: the local proxy\'s forwarded address, else the socket; views key on req.ip');

    // ── 2. index.js applies it (the real server, booted) ──
    const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    assert.ok(!/set\('trust proxy',\s*true\)/.test(src), 'no trust-everyone left');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-trust-'));
    const freePort = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const env = { ...process.env, DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: path.join(tmp, 'vods'), CLIPS_PATH: path.join(tmp, 'clips'), PASTES_PATH: path.join(tmp, 'pastes'),
        THUMBNAILS_PATH: path.join(tmp, 'thumbs'), FILES_PATH: path.join(tmp, 'files'), OBJECTS_PATH: path.join(tmp, 'objects'), PORT: String(freePort), HOST: ext ? '0.0.0.0' : '127.0.0.1',
        NODE_ENV: 'test', MEDIA_JOBS_ENABLED: '0', MEDIA_VERIFY_ENABLED: '0', MEDIA_OWNER_SUBJECT_SYNC: '0', EVENTS_URL: '', MEDIA_APP_KEYS: 'live:live-key-for-trust-test' };
    const child = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
        try { up = (await get('127.0.0.1', freePort, '/healthz')).status === 200; } catch { await new Promise((res) => setTimeout(res, 100)); }
    }
    assert.ok(up, `the server booted: ${log.slice(-500)}`);
    // /metrics answers loopback callers only and refuses anything that came through a proxy; with
    // trust proxy loopback, Express agrees the request came from the local proxy.
    const direct = await get('127.0.0.1', freePort, '/metrics');
    const proxied = await get('127.0.0.1', freePort, '/metrics', { 'X-Forwarded-For': '203.0.113.7' });
    assert.strictEqual(direct.status, 200);
    assert.strictEqual(proxied.status, 404, 'a proxied caller is not local');
    // The live-frame endpoint rate-limits per req.ip (burst 30). Through the local proxy every
    // forwarded client has its own bucket; a direct caller rotating X-Forwarded-For does not.
    const burst = async (host, n) => {
        let limited = 0;
        for (let i = 0; i < n; i++) {
            const res = await get(host, freePort, '/live/1/frame.jpg?format=json', { 'X-Forwarded-For': `198.51.100.${i + 1}` });
            if (res.status === 429) limited++;
        }
        return limited;
    };
    assert.strictEqual(await burst('127.0.0.1', 45), 0, 'forwarded clients each get their own budget');
    if (ext) {
        const limited = await burst(ext, 45);
        assert.ok(limited > 0, 'a direct caller cannot mint new identities with X-Forwarded-For (the real server trusts loopback only)');
    }
    child.kill('SIGTERM');
    await new Promise((res) => child.on('exit', res));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('✅ the booted server runs with trust proxy loopback');

    console.log('\n✅ All trust-proxy tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
