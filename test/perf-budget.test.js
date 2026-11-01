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
        htmlRawKB: 51,   // 50.1 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 48.6 with the phone pick block and folds (2026-10-30; a fresh database measures a little larger); 43.8 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); measured 38.8 on 2026-10-22 (fresh database): the home gained its developer half (what it does, code, limits, questions and their FAQPage data); 19.8 before
        htmlBrotliKB: 12.3,   // 12.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 10.8 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 9.7 on 2026-10-22; 5.0 before
        jsFiles: 4,   // 3
        // 2026-09-27: theme-loader (44.3 KB, 8.3 brotli) now comes from Media's own /shared (D42) instead of
        // openvibe.network, so it is counted here; the page itself did not grow.
        // 2026-10-13 (T11): the index is composed by openvibe-shared/shell like the watch pages, which adds the
        // shared web-runtime.js; the showcase stylesheet (same-origin) replaces Font Awesome (cross-origin).
        jsRawKB: 316,   // 313.7 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 310.3 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 309.5 with openvibe-shared 4.64.0: the look travels between sites, the Look panel in the menu (2026-10-31); 308.7 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 306.6 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 303.6 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 301.1 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 293.3 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 286 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 279.9 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 274.1 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 260.1 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 248.9 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 241 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 230.9 (was 197.7)
        jsBrotliKB: 76,   // 75.3 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 74.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 73.5 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 70.1 Shared 4.33.0 navbar glyph widths; 68.2 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 66.7 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 64.1 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 61.5 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 56.1 with openvibe-shared 4.10.0 (Report a problem in the footer, 2026-10-24); 53.7 (was 45.6)
        cssFiles: 2,   // 1 (showcase.css)
        cssRawKB: 48,   // 47.2 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 45.4 with openvibe-shared 4.39.1: room.css carries the kit's tokens and numbers strip (+2.8 KB), so this page's cards keep their corners and colours and its numbers are tiles without loading kit.css (25.6 KB); 38.6 the front page's latest media as a rail of kit cards (room.css, 15.7 KB raw): the page shed a 48-card grid, 17 of its 23 phone screens; 23.3 openvibe-shared 4.26.1 (hero visual); 17.8 with Shared 4.13.0 (2026-10-26); 11.6 same-origin (showcase.css; was 0)
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
