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
        htmlRawKB: 56.5, // 56.5: measured 56.4 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 54.8: measured 52.8 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
        htmlBrotliKB: 13,   // 13: measured 12.9 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 12.5 with openvibe-shared 4.177.0 (2026-11-09: the menu Home grid, the model chip and the offer card); 12.4 with openvibe-shared 4.113.0 (2026-11-06: the kit's badge at 12 px and the room link's touch hit area); 12.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 10.8 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 9.7 on 2026-10-22; 5.0 before
        jsFiles: 4,   // 3
        // 2026-09-27: theme-loader (44.3 KB, 8.3 brotli) now comes from Media's own /shared (D42) instead of
        // openvibe.network, so it is counted here; the page itself did not grow.
        // 2026-10-13 (T11): the index is composed by openvibe-shared/shell like the watch pages, which adds the
        // shared web-runtime.js; the showcase stylesheet (same-origin) replaces Font Awesome (cross-origin).
        jsRawKB: 377.5, // 377.5: measured 377.2 with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 361.4: measured 353.4 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
        jsBrotliKB: 89.5, // 89.5: measured 89.2 KB brotli with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 85.3: measured 85.2 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 85.1: measured 83.1 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
        cssFiles: 2,   // 1 (showcase.css)
        cssRawKB: 60.4, // 60.4: measured 55.4 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
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
