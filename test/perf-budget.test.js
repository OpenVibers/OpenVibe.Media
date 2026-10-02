'use strict';
// Size budgets for openvibe.media's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the server as
// it runs (a fresh database), measured without a browser. Budgets sit a little above the 2026-09-26
// measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

(async () => {
    const BUDGETS = {
        htmlRawKB: 25,   // measured 19.8 (fresh database)
        htmlBrotliKB: 6.5,   // 5.0
        jsFiles: 4,   // 3
        // 2026-09-27: theme-loader (44.3 KB, 8.3 brotli) now comes from Media's own /shared (D42) instead of
        // openvibe.network, so it is counted here; the page itself did not grow.
        jsRawKB: 215,   // 197.7
        jsBrotliKB: 50,   // 45.6
        cssFiles: 2,   // 1 (Font Awesome, cross-origin)
        cssRawKB: 10,   // 0 same-origin
        externalFiles: 3,   // 2
    };

    const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

    (async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
        const port = await freePort();
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', MEDIA_PGLITE_DIR: path.join(dir, 'pglite'), DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', VOD_PATH: path.join(dir, 'vods'), CLIPS_PATH: path.join(dir, 'clips'), FILES_PATH: path.join(dir, 'files'), THUMBNAILS_PATH: path.join(dir, 'thumbnails'), PASTES_PATH: path.join(dir, 'pastes'), OBJECTS_PATH: path.join(dir, 'objects'), MEDIA_JOBS_ENABLED: 'off' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        const keep = (d) => { tail = (tail + d).slice(-2000); };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const base = `http://127.0.0.1:${port}`;
        try {
            let up = false;
            let exited = false;
            child.on('exit', () => { exited = true; });
            // 60 s: a cold PGlite boot plus migrations is slow on a loaded machine (the suite beside test:pg).
            for (let i = 0; i < 600 && !up && !exited; i++) {
                up = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
                if (!up) await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(up, `the server did not start (${exited ? 'the child exited' : 'timed out after 60 s'}):\n${tail}`);
            const m = await measure({ base });
            const over = check(m, BUDGETS);
            assert.deepStrictEqual(over, [], format(m, over));
            console.log(format(m));
            console.log('perf budget: all checks passed');
        } finally {
            child.kill();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    })().catch((err) => { console.error(err); process.exitCode = 1; });
})().catch((err) => { console.error(err); process.exit(1); });
