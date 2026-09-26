'use strict';
/**
 * Media's side of the N-1 harness (test/n-1/harness.js): its clients, how a release boots and is
 * seeded, where its SQL lives. Used by scripts/n-1-record.js (on N-1, in a temporary worktree) and by
 * test/n-1.test.js (on this checkout), so both boot and seed the same way.
 *
 * Media's clients: its server-rendered pages (/, /browse, /v, /c, /p, /me: an open tab holds the page
 * N-1 served, the player's media URLs and every link and form in it), the object explorer's script,
 * and the openvibe-sdk media and objects clients (files v1, Object API v2 and jobs) as that release
 * installed them, signed in with an app key the way the SDK is.
 *
 * A release boots as a real `node server/index.js` in the restore-drill sandbox (MEDIA_DRILL: loopback
 * only, no outbound connection, program or background job; stored bytes answer 503), with
 * test/n-1/preload.js lifting the drill's read-only guard so writes reach their routes.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readTree } = require('./harness');

const PRELOAD = path.join(__dirname, 'preload.js');
const APP_BEARER = 'n1n1n1n1n1n1n1n1n1n1n1n1';
const STORAGE = ['VOD_PATH:vods', 'CLIPS_PATH:clips', 'PASTES_PATH:pastes', 'FILES_PATH:files', 'OBJECTS_PATH:objects', 'ASSETS_PATH:assets', 'THUMBNAILS_PATH:thumbnails'];

function freePort() {
    return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/** A clean environment: the release's storage under dataDir; nothing from the caller's shell but PATH and HOME. */
function baseEnv(dbPath, dataDir, extra) {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp', NODE_ENV: 'test', DB_PATH: dbPath, MEDIA_PUBLIC_URL: 'https://openvibe.media', ...extra };
    for (const s of STORAGE) { const [k, d] = s.split(':'); env[k] = path.join(dataDir, d); fs.mkdirSync(env[k], { recursive: true }); }
    return env;
}

const SEED = `
    console.log = () => {}; console.warn = () => {};
    const fs = require('fs'); const path = require('path');
    const db = require('./server/db/database');
    db.getDb();
    try { require('./server/views/service').ensureSchema(); } catch (e) { /* older release */ }
    db.upsertApp({ app_id: 'live', name: 'OpenVibe.Live', api_key: ${JSON.stringify(APP_BEARER)} });
    const put = (dir, name) => { const f = path.join(process.env[dir], name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'bytes of ' + name); return f; };
    db.run("INSERT INTO vods (app_id, user_id, title, file_path, file_size, thumbnail_url, duration_seconds, is_public, visibility) VALUES ('live', 1, 'N-1 VOD', ?, 18, '/t/vod-1-1.jpg', 60, 1, 'public')", [put('VOD_PATH', 'vod-1.mp4')]);
    db.run("INSERT INTO clips (app_id, vod_id, user_id, title, file_path, duration_seconds, status, is_public, visibility) VALUES ('live', 1, 1, 'N-1 clip', ?, 10, 'ready', 1, 'public')", [put('CLIPS_PATH', 'clip-1.mp4')]);
    db.run("INSERT INTO pastes (app_id, slug, type, title, content, visibility) VALUES ('live', 'n1paste', 'paste', 'N-1 paste', 'hello from N-1', 'public')");
    db.run("INSERT INTO files (key, app_id, original_name, size, mime) VALUES ('n1file.txt', 'live', 'n1file.txt', 17, 'text/plain')");
    put('FILES_PATH', 'live/n1file.txt'); put('THUMBNAILS_PATH', 'vod-1-1.jpg');
    try { require('./server/objects/backfill').backfill({ onlyMissing: true }); } catch (e) { /* older release */ }
    db.close();
`;

module.exports = {
    service: 'media',

    clientFiles(dir) {
        return readTree(dir, ['server/public', 'server/me', 'node_modules/openvibe-sdk/src/media.js', 'node_modules/openvibe-sdk/src/objects.js'], ['.js']);
    },
    callers: [
        { name: 'fetch' },
        { name: 'fetchJson' },
        { name: 'call', object: true },
        { name: 'json', object: true },
    ],
    forms: true,
    keep: () => true,
    crawl: ['/', '/browse', '/v/1', '/c/1', '/p/n1paste', '/me', '/updates'],
    origins: ['https://openvibe.media'],
    /** Values for template expressions, first match wins (the rows SEED writes). */
    samples: [
        [/app/i, 'live'],
        [/key/i, 'n1file.txt'],
        [/upload_?id|uploadId/i, 'n1-upload'],
        [/object_?id|created\.id|^enc\(id\)$/i, '@object'],
        [/id\)*$/i, '1'],
        [/slug/i, 'n1paste'],
        [/scope/i, ''],
        [/^n$/, '1'],
    ],

    sqlDirs: ['server'],
    ledgerTables: [],

    /** Seeds a database with the release in `dir` (opening it migrates first). */
    seed({ dir, dbPath, dataDir }) {
        const r = spawnSync(process.execPath, ['-e', SEED], { cwd: dir, encoding: 'utf8', timeout: 120000, env: baseEnv(dbPath, dataDir, {}) });
        if (r.status !== 0) throw new Error(`seeding failed:\n${String(r.stderr || '').slice(-2000)}`);
    },

    /** Boots the release in `dir` → { url, headers(auth), close() }; 'user' is the SDK's app key. */
    async boot({ dir, dbPath, dataDir, sqlOut = '' }) {
        const port = await freePort();
        const child = spawn(process.execPath, ['-r', PRELOAD, 'server/index.js'], {
            cwd: dir,
            env: baseEnv(dbPath, dataDir, { MEDIA_DRILL: '1', HOST: '127.0.0.1', PORT: String(port), N1_SQL_OUT: sqlOut }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        child.stdout.on('data', (c) => { log = (log + c).slice(-20000); });
        child.stderr.on('data', (c) => { log = (log + c).slice(-20000); });
        const exited = new Promise((resolve) => child.on('exit', resolve));
        const url = `http://127.0.0.1:${port}`;
        for (let i = 0; ; i++) {
            if (child.exitCode != null) throw new Error(`the release in ${dir} exited while booting:\n${log.slice(-3000)}`);
            try { const r = await fetch(`${url}/release.json`); if (r.status === 200) break; } catch { /* not listening yet */ }
            if (i > 300) { child.kill('SIGKILL'); throw new Error(`the release in ${dir} did not become ready:\n${log.slice(-3000)}`); }
            await new Promise((r) => setTimeout(r, 100));
        }
        // The seeded VOD's object (ids are random): the SDK's object calls address it.
        let object = null;
        try {
            const Database = require('better-sqlite3');
            const d = new Database(dbPath, { readonly: true, fileMustExist: true });
            try { object = (d.prepare("SELECT id FROM media_objects WHERE kind = 'vod' ORDER BY created_at, id LIMIT 1").get() || {}).id || null; } finally { d.close(); }
        } catch { /* an older release without media_objects */ }
        return {
            url,
            ids: { object },
            log: () => log,
            headers: (auth) => (auth === 'user' ? { authorization: `Bearer ${APP_BEARER}` } : {}),
            async close() {
                if (child.exitCode == null) child.kill('SIGTERM');
                const t = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 5000);
                await exited;
                clearTimeout(t);
            },
        };
    },
};
