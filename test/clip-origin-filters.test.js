'use strict';
// Clip origin and list windows (Live's Content and Moments feeds).
//   - POST /clips keeps auto_generated (and the description) when the app itself asks, and never
//     when the call acts for one of the app's users; it used to drop both, so every AI auto-clip
//     was stored as a person's clip.
//   - PUT /clips/:id lets the app mark an existing clip machine-made (its own records), not a user.
//   - GET /clips?auto_generated=0|1 splits people's clips from automation's, ?status=ready leaves
//     out clips still cutting or failed, and ?since= (clips and VODs) bounds a "top this week" list.
//   - None of it opens a private clip to a public list.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-clip-origin-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.FILES_PATH = dir('files');
process.env.OBJECTS_PATH = dir('objects');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.PASTES_PATH = dir('pastes');
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
delete process.env.EVENTS_URL;
console.log = () => {};
console.warn = () => {};

const db = require('../server/db/database');
db.upsertApp({ app_id: 'live', api_key: 'live-key' });
const raw = db.getDb();
// The background cut is not what this checks: fail it at once, without ffmpeg.
require('../server/vod/clip-cutter').cutClipFile = async () => ({ ok: false, error: 'not in this test' });

const vodFile = path.join(process.env.VOD_PATH, 'vod-1.webm');
fs.writeFileSync(vodFile, Buffer.alloc(64, 1));
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, duration_seconds, view_count, created_at)
             VALUES (1, 'live', 5, 'Fresh', ?, 1, 'public', 600, 3, ?)`).run(vodFile, daysAgo(1));
raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, duration_seconds, view_count, created_at)
             VALUES (2, 'live', 5, 'Old', ?, 1, 'public', 600, 90, ?)`).run(vodFile, daysAgo(40));
// An imported row keeps its ISO timestamp: `since` must still compare it by time.
raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, duration_seconds, view_count, created_at)
             VALUES (3, 'live', 5, 'Imported', ?, 1, 'public', 600, 1, ?)`).run(vodFile, new Date(Date.now() - 2 * 86400_000).toISOString());
const insClip = raw.prepare(`INSERT INTO clips (id, app_id, vod_id, user_id, title, file_path, is_public, visibility, status, auto_generated, view_count, created_at)
                             VALUES (?, 'live', 1, 5, ?, 'x.webm', ?, ?, ?, ?, ?, ?)`);
insClip.run(10, 'Person, public', 1, 'public', 'ready', 0, 5, daysAgo(1));
insClip.run(11, 'AI, public', 1, 'public', 'ready', 1, 9, daysAgo(2));
insClip.run(12, 'AI, private', 0, 'private', 'ready', 1, 0, daysAgo(1));
insClip.run(13, 'Person, failed cut', 1, 'public', 'failed', 0, 0, daysAgo(1));
insClip.run(14, 'Person, old', 1, 'public', 'ready', 0, 50, daysAgo(40));
insClip.run(15, 'Imported, no status', 1, 'public', null, 0, 1, daysAgo(3));

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/v1/:app/vods', require('../server/vod/routes'));
app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1/live`;
    const call = async (method, p, { body, user } = {}) => {
        const headers = { authorization: 'Bearer live-key' };
        if (user) headers['x-ov-user-id'] = String(user);
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ids = (r) => r.json.clips.map((c) => c.id).sort((a, b) => a - b);
    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); process.stdout.write(`  ok - ${name}\n`); }
        catch (e) { failures++; process.stdout.write(`  FAIL - ${name}: ${e.message}\n`); }
    };

    await check('auto_generated=0|1 splits the public list; private rows stay out of both', async () => {
        assert.deepStrictEqual(ids(await call('GET', '/clips?auto_generated=0')), [10, 13, 14, 15]);
        assert.deepStrictEqual(ids(await call('GET', '/clips?auto_generated=1')), [11]);
        assert.deepStrictEqual(ids(await call('GET', '/clips?auto_generated=true')), [11]);
        assert.deepStrictEqual(ids(await call('GET', '/clips')), [10, 11, 13, 14, 15], 'no filter: both kinds, as before');
        const r = await call('GET', '/clips?auto_generated=1');
        assert.strictEqual(r.json.total, 1, 'the total counts the same filter');
        assert.strictEqual(r.json.clips[0].auto_generated, true);
    });

    await check('status=ready leaves out failed cuts and keeps imported rows without a status', async () => {
        assert.deepStrictEqual(ids(await call('GET', '/clips?status=ready&auto_generated=0')), [10, 14, 15]);
    });

    await check('since bounds clips and VODs; views order holds inside the window', async () => {
        const week = new Date(Date.now() - 7 * 86400_000).toISOString();
        assert.deepStrictEqual(ids(await call('GET', `/clips?since=${encodeURIComponent(week)}&status=ready`)), [10, 11, 15]);
        const top = await call('GET', `/clips?since=${encodeURIComponent(week)}&order=views&status=ready`);
        assert.deepStrictEqual(top.json.clips.map((c) => c.id), [11, 10, 15]);
        const vods = await call('GET', `/vods?since=${encodeURIComponent(week)}&order=views`);
        assert.deepStrictEqual(vods.json.vods.map((v) => v.id), [1, 3], 'the 40-day-old VOD is out, the ISO-dated one is in');
        assert.strictEqual(vods.json.total, 2);
        const sqlForm = await call('GET', `/vods?since=${encodeURIComponent(daysAgo(7))}`);
        assert.strictEqual(sqlForm.json.total, 2, "'YYYY-MM-DD HH:MM:SS' works too");
        const junk = await call('GET', '/vods?since=not-a-date');
        assert.strictEqual(junk.json.total, 3, 'an unreadable since is ignored, not a 500');
    });

    await check('POST /clips keeps auto_generated and the description for the app itself', async () => {
        const r = await call('POST', '/clips', { body: { vod_id: 1, start_s: 10, end_s: 30, title: 'AI pick', auto_generated: true, description: 'A <b>big</b> moment' } });
        assert.strictEqual(r.status, 202, JSON.stringify(r.json));
        const row = db.getClipById(r.json.id);
        assert.strictEqual(row.auto_generated, 1);
        assert.strictEqual(row.description, 'A big moment');
    });

    await check('POST /clips acting for a user is a person\'s clip, whatever it claims', async () => {
        const r = await call('POST', '/clips', { user: 7, body: { vod_id: 1, start_s: 100, end_s: 120, title: 'Mine', auto_generated: true } });
        assert.strictEqual(r.status, 202, JSON.stringify(r.json));
        assert.strictEqual(db.getClipById(r.json.id).auto_generated, 0);
    });

    await check('PUT /clips/:id: the app may mark a clip machine-made; a user may not', async () => {
        const denied = await call('PUT', '/clips/10', { user: 5, body: { auto_generated: true } });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(db.getClipById(10).auto_generated, 0);
        const ok = await call('PUT', '/clips/10', { body: { auto_generated: true } });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.json.clip.auto_generated, true);
        const back = await call('PUT', '/clips/10', { body: { auto_generated: 0 } });
        assert.strictEqual(back.json.clip.auto_generated, false);
        const title = await call('PUT', '/clips/10', { user: 5, body: { title: 'Renamed' } });
        assert.strictEqual(title.status, 200, 'other fields still work for users');
    });

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nclip origin filters: all checks passed\n');
    process.exit(failures ? 1 : 0);
})();
