'use strict';
// server/index.js mounts the IndexNow key file from INDEXNOW_KEY (openvibe-shared/indexnow): the key
// configured at boot is served at /<key>.txt, the file the protocol requires engines to fetch before
// they accept a ping. Unset, nothing is mounted. A malformed key disables IndexNow with a warning
// instead of crashing the service at boot. A restore drill serves the key file too (it is public).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** Boot server/index.js with INDEXNOW_KEY set to `key`, wait for /healthz, and return it plus stderr. */
async function boot(dir, key) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', INDEXNOW_KEY: key,
            MEDIA_PGLITE_DIR: path.join(dir, 'pglite'), DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '',
            VOD_PATH: path.join(dir, 'vods'), CLIPS_PATH: path.join(dir, 'clips'), FILES_PATH: path.join(dir, 'files'),
            THUMBNAILS_PATH: path.join(dir, 'thumbnails'), PASTES_PATH: path.join(dir, 'pastes'), OBJECTS_PATH: path.join(dir, 'objects'),
            MEDIA_JOBS_ENABLED: 'off',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
        up = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
        if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    return { child, base, get stderr() { return stderr; }, up };
}

(async () => {
    const KEY = 'mediaIndexNowKey123';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-indexnow-'));
    let first = null;
    try {
        // ── A valid key: the file is served, and only the file ──
        first = await boot(dir, KEY);
        assert.ok(first.up, `the server did not start:\n${first.stderr}`);
        const r = await fetch(`${first.base}/${KEY}.txt`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.headers.get('content-type').startsWith('text/plain'));
        assert.strictEqual((await r.text()).trim(), KEY, 'the file holds exactly the key');
        const other = await fetch(`${first.base}/not-the-key.txt`);
        assert.strictEqual(other.status, 404, 'only the key file is mounted; it serves itself and passes everything else on');
        console.log('indexnow: the key file is served when INDEXNOW_KEY is set');
    } finally {
        if (first) first.child.kill();
    }
    try {
        // ── A malformed key: Media boots anyway, IndexNow is disabled and no key file is mounted ──
        const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-indexnow-bad-'));
        const second = await boot(badDir, 'not a valid key!');
        try {
            assert.ok(second.up, `a malformed INDEXNOW_KEY must not crash the service:\n${second.stderr}`);
            assert.ok(/\[IndexNow\] disabled:/.test(second.stderr), 'the refusal is logged as a warning');
            assert.strictEqual((await fetch(`${second.base}/not-a-valid-key.txt`)).status, 404, 'no key file is mounted');
            console.log('indexnow: a malformed key disables IndexNow instead of crashing the boot');
        } finally { second.child.kill(); fs.rmSync(badDir, { recursive: true, force: true }); }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
