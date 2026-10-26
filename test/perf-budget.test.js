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
        htmlRawKB: 43,   // measured 38.8 on 2026-10-22 (fresh database): the home gained its developer half (what it does, code, limits, questions and their FAQPage data); 19.8 before
        htmlBrotliKB: 10.7,   // 9.7 on 2026-10-22; 5.0 before
        jsFiles: 4,   // 3
        // 2026-09-27: theme-loader (44.3 KB, 8.3 brotli) now comes from Media's own /shared (D42) instead of
        // openvibe.network, so it is counted here; the page itself did not grow.
        // 2026-10-13 (T11): the index is composed by openvibe-shared/shell like the watch pages, which adds the
        // shared web-runtime.js; the showcase stylesheet (same-origin) replaces Font Awesome (cross-origin).
        jsRawKB: 253,   // 248.9 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 241 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 230.9 (was 197.7)
        jsBrotliKB: 63,   // 61.5 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 56.1 with openvibe-shared 4.10.0 (Report a problem in the footer, 2026-10-24); 53.7 (was 45.6)
        cssFiles: 2,   // 1 (showcase.css)
        cssRawKB: 22,   // 17.8 with Shared 4.13.0 (2026-10-26: account links); 11.6 same-origin (showcase.css; was 0)
        externalFiles: 3,   // 2
    };

    const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

    (async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
        const port = await freePort();
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', MEDIA_PGLITE_DIR: path.join(dir, 'pglite'), DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', VOD_PATH: path.join(dir, 'vods'), CLIPS_PATH: path.join(dir, 'clips'), FILES_PATH: path.join(dir, 'files'), THUMBNAILS_PATH: path.join(dir, 'thumbnails'), PASTES_PATH: path.join(dir, 'pastes'), OBJECTS_PATH: path.join(dir, 'objects'), MEDIA_JOBS_ENABLED: 'off' },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
        const base = `http://127.0.0.1:${port}`;
        try {
            let up = false;
            for (let i = 0; i < 600 && !up; i++) {   // 60 s: a cold PGlite boot plus migrations is slow on a loaded machine
                up = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
                if (!up) await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(up, `the server did not start:\n${stderr}`);
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
