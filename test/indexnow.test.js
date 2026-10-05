'use strict';
// server/index.js mounts the IndexNow key file from INDEXNOW_KEY (openvibe-shared/indexnow): the key
// configured at boot is served at /<key>.txt, the file the protocol requires engines to fetch before
// they accept a ping. Unset, nothing is mounted. A restore drill serves it too (it is a public file).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    const KEY = 'mediaIndexNowKey123';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-indexnow-'));
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', INDEXNOW_KEY: KEY,
            MEDIA_PGLITE_DIR: path.join(dir, 'pglite'), DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '',
            VOD_PATH: path.join(dir, 'vods'), CLIPS_PATH: path.join(dir, 'clips'), FILES_PATH: path.join(dir, 'files'),
            THUMBNAILS_PATH: path.join(dir, 'thumbnails'), PASTES_PATH: path.join(dir, 'pastes'), OBJECTS_PATH: path.join(dir, 'objects'),
            MEDIA_JOBS_ENABLED: 'off',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 600 && !up; i++) {
            up = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        const r = await fetch(`${base}/${KEY}.txt`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.headers.get('content-type').startsWith('text/plain'));
        assert.strictEqual((await r.text()).trim(), KEY, 'the file holds exactly the key');
        const other = await fetch(`${base}/not-the-key.txt`);
        assert.strictEqual(other.status, 404, 'only the key file is mounted; it serves itself and passes everything else on');
        console.log('indexnow: the key file is served when INDEXNOW_KEY is set');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
