'use strict';
// GET /metrics (loopback only, route templates, Media gauges) and GET /api/ready (required: db +
// writable storage; optional: Network key, configured remote tiers, events outbox), wired the way
// server/index.js wires them — and then the real server booted once to prove index.js does.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-obs-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const ENV = {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), PASTES_PATH: dir('pastes'),
    THUMBNAILS_PATH: dir('thumbnails'), FILES_PATH: dir('files'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
    MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'http://127.0.0.1:9', RELEASE_COMMIT: 'abcdef1234567',
};
for (const k of ['MEDIA_B2_ENDPOINT', 'MEDIA_B2_BUCKET', 'MEDIA_R2_ENDPOINT', 'MEDIA_R2_BUCKET', 'EVENTS_URL']) process.env[k] = '';   // never a real tier or Events (dotenv keeps set values)
Object.assign(process.env, ENV);

const db = require('../server/db/database');
const config = require('../server/config');
const express = require('express');
const observability = require('../server/observability');

function request(base, p, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(base + p, { headers }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; });
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', reject);
    });
}
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

(async () => {
    db.getDb();
    db.upsertApp({ app_id: 'live', api_key: 'live-key' });

    // ── Wiring as in index.js, with injectable dependencies ──
    let jwks = true; let remoteUp = true; let remoteProbes = 0; let outbox = { enabled: true, pending: 2, rejected: 1 }; let recording = 1;
    const app = express();
    const inst = observability.instrument(app, { release: 'abcdef123456' });
    app.use('/o', require('express').Router().get('/:id', (req, res) => res.status(404).json({ error: 'Not found' })));
    observability.mountReady(app, inst.registry, {
        release: 'abcdef123456', db, config,
        auth: { jwksLoaded: () => jwks },
        recorder: { activeCount: () => recording },
        events: { status: () => outbox },
        remote: { configured: (n) => n === 'b2', probe: async () => { remoteProbes++; if (!remoteUp) throw new Error('b2 HeadBucket failed: NetworkingError'); return true; } },
    });
    const server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;

    let r = await request(base, '/api/ready');
    assert.strictEqual(r.status, 200, r.body);
    let body = JSON.parse(r.body);
    assert.strictEqual(body.ready, true);
    assert.strictEqual(body.status, 'ready');
    assert.strictEqual(body.service, 'media');
    assert.strictEqual(body.recordings_in_progress, 1);
    const names = Object.keys(body.checks).sort();
    assert.deepStrictEqual(names, ['db', 'events_outbox', 'network_jwks', 'object_copies', 'remote_b2', 'storage_clips', 'storage_files', 'storage_objects', 'storage_pastes', 'storage_thumbnails', 'storage_vods'], 'r2 is not configured, so it has no check');
    for (const [n, c] of Object.entries(body.checks)) {
        assert.strictEqual(c.status, 'ok', n);
        assert.strictEqual(typeof c.latency_ms, 'number');
        assert.ok(Date.parse(c.checked_at));
        assert.strictEqual(c.required, n === 'db' || n.startsWith('storage_'), `${n} required?`);
    }
    assert.deepStrictEqual(body.checks.db.detail, { apps: 1 });
    assert.deepStrictEqual(fs.readdirSync(config.vod.path), [], 'the write probe leaves nothing behind');

    // Optional failures: degraded, still 200.
    jwks = false; remoteUp = false; outbox = { enabled: true, pending: 5000, rejected: 0 };
    r = await request(base, '/api/ready');
    body = JSON.parse(r.body);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.status, 'degraded');
    assert.deepStrictEqual(body.degraded.sort(), ['events_outbox', 'network_jwks']);
    assert.strictEqual(body.checks.remote_b2.status, 'ok', 'the remote tier probe is cached for a minute');
    assert.strictEqual(remoteProbes, 1);

    // A remote-tier failure on a fresh readiness (no cache): degraded, never "down".
    const fresh = observability.createMediaReadiness({ release: 'x', db, config, auth: { jwksLoaded: () => true }, recorder: { activeCount: () => 0 }, events: { status: () => ({ enabled: false }) }, remote: { configured: () => true, probe: async (n) => { throw new Error(`${n} HeadBucket failed: AccessDenied`); } } });
    body = await fresh.run();
    assert.strictEqual(body.ready, true);
    assert.deepStrictEqual(body.degraded, ['remote_b2', 'remote_r2']);
    assert.strictEqual(body.checks.remote_r2.error, 'r2 HeadBucket failed: AccessDenied');
    assert.deepStrictEqual(body.checks.events_outbox.detail, { enabled: false });

    // A storage directory that cannot be written: not ready, 503, named.
    jwks = true; outbox = { enabled: false };
    fs.rmSync(config.vod.clipsPath, { recursive: true });
    fs.writeFileSync(config.vod.clipsPath, 'not a directory');
    r = await request(base, '/api/ready');
    body = JSON.parse(r.body);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(body.ready, false);
    assert.deepStrictEqual(body.failed, ['storage_clips']);
    fs.rmSync(config.vod.clipsPath); fs.mkdirSync(config.vod.clipsPath);

    // ── /metrics ──
    await request(base, '/o/med_01J9ZX4YQ0ABCDEFGHJKMNPQRS');
    await request(base, '/assets/icon-192.png');
    recording = 2;
    r = await request(base, '/metrics');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('release_info{service="media",release="abcdef123456"} 1\n'));
    assert.ok(r.body.includes('http_requests_total{method="GET",route="/o/:id",status_class="4xx"} 1\n'), 'object ids never reach a label');
    assert.ok(r.body.includes('http_requests_total{method="GET",route="/assets/*",status_class="4xx"} 1\n'));
    assert.ok(r.body.includes('http_requests_total{method="GET",route="/api/ready",status_class="2xx"}'));
    assert.ok(!r.body.includes('med_01J9'));
    assert.ok(r.body.includes('media_recordings_in_progress 2\n'));
    assert.ok(r.body.includes('# TYPE media_object_locations gauge'));
    assert.ok(r.body.includes('# TYPE media_objects gauge'));
    assert.ok(!r.body.includes('media_events_outbox{'), 'no outbox running: no invented series');
    r = await request(base, '/metrics', { 'X-Forwarded-For': '203.0.113.7' });
    assert.strictEqual(r.status, 404, 'proxied callers never see metrics');
    server.close();
    inst.stop();

    // ── The real index.js boots with both routes ──
    const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-obs-boot-'));
    const env = { ...process.env, ...ENV, DB_PATH: path.join(bootDir, 'media.db'), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' };
    for (const k of ['VOD_PATH', 'CLIPS_PATH', 'PASTES_PATH', 'THUMBNAILS_PATH', 'FILES_PATH', 'OBJECTS_PATH', 'ASSETS_PATH']) env[k] = path.join(bootDir, k.toLowerCase());
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const b2 = `http://127.0.0.1:${port}`;
    let up = null;
    for (let i = 0; i < 100 && !up; i++) {
        await new Promise((res) => setTimeout(res, 100));
        try { up = await request(b2, '/api/ready'); } catch { /* not listening yet */ }
    }
    try {
        assert.ok(up, `server did not start:\n${log}`);
        body = JSON.parse(up.body);
        assert.strictEqual(up.status, 200, up.body);
        assert.strictEqual(body.release, 'abcdef123456');
        assert.ok(body.checks.db && body.checks.storage_objects);
        assert.ok(!body.checks.remote_b2, 'unconfigured tiers are not checked');
        const m = await request(b2, '/metrics');
        assert.strictEqual(m.status, 200);
        assert.ok(m.body.includes('http_requests_total{method="GET",route="/api/ready",status_class="2xx"} 1\n'), m.body.slice(0, 400));
        const h = await request(b2, '/healthz');
        assert.strictEqual(h.status, 200, '/healthz still answers');
    } finally {
        child.kill('SIGKILL');
    }
    console.log('observability: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
