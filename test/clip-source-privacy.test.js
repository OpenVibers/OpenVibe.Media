'use strict';
// A new clip is never more visible than its recording (item 151, C17): POST /clips caps what was asked (the public
// default included) by the source's visibility. A private recording's clip is private, an unlisted one's at most
// unlisted; a public recording's clip is what was asked. Its owner can still open it later with PUT, on purpose.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-clip-privacy-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
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
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const raw = db.getDb();
    require('../server/vod/clip-cutter').cutClipFile = async () => ({ ok: false, error: 'not in this test' });
    const vodFile = path.join(process.env.VOD_PATH, 'vod.webm');
    fs.writeFileSync(vodFile, Buffer.alloc(64, 1));
    const ins = raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, duration_seconds) OVERRIDING SYSTEM VALUE
                             VALUES (?, 'live', 5, ?, ?, ?, ?, 600) RETURNING id`);
    await ins.run(1, 'Public', vodFile, 1, 'public');
    await ins.run(2, 'Unlisted', vodFile, 0, 'unlisted');
    await ins.run(3, 'Private', vodFile, 0, 'private');
    await raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, duration_seconds) OVERRIDING SYSTEM VALUE
                       VALUES (4, 'live', 5, 'Legacy private', ?, 0, NULL, 600) RETURNING id`).run(vodFile);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1/live`;
    // Media hands back the clip already cut of the same window, so every call cuts its own.
    let at = 0;
    const make = async (vodId, visibility) => {
        at += 40;
        const body = { vod_id: vodId, start_s: at, end_s: at + 30, title: 'x', ...(visibility ? { visibility } : {}) };
        const res = await fetch(`${base}/clips`, { method: 'POST', headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json().catch(() => null);
        assert.ok(res.status === 201 || res.status === 202 || res.status === 200, `${res.status} ${JSON.stringify(json)}`);
        const id = (json && (json.id || (json.clip && json.clip.id)));
        const row = await raw.prepare('SELECT visibility FROM clips WHERE id = ?').get(id);
        return row.visibility;
    };

    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); process.stdout.write(`  ok - ${name}\n`); }
        catch (e) { failures++; process.stdout.write(`  FAIL - ${name}: ${e.message}\n`); }
    };

    await check('the lower of what was asked and what the source allows', async () => {
        const { capVisibility } = require('../server/vod/clips-routes');
        assert.strictEqual(capVisibility('public', 'public'), 'public');
        assert.strictEqual(capVisibility('public', 'unlisted'), 'unlisted');
        assert.strictEqual(capVisibility('unlisted', 'public'), 'unlisted');
        assert.strictEqual(capVisibility('public', 'private'), 'private');
        assert.strictEqual(capVisibility('public', undefined), 'private', 'an unknown source is private');
    });

    await check('POST /clips: a public recording gives what was asked (public by default)', async () => {
        assert.strictEqual(await make(1), 'public');
        assert.strictEqual(await make(1, 'unlisted'), 'unlisted');
    });

    await check('POST /clips: an unlisted recording gives at most unlisted; a private one gives private', async () => {
        assert.strictEqual(await make(2), 'unlisted', 'the default no longer opens it');
        assert.strictEqual(await make(2, 'public'), 'unlisted');
        assert.strictEqual(await make(3), 'private');
        assert.strictEqual(await make(3, 'public'), 'private', 'asking for public does not open it');
        assert.strictEqual(await make(4, 'public'), 'private', 'a legacy row with is_public = 0 is private');
    });

    server.close();
    if (failures) { process.stdout.write(`${failures} failed\n`); process.exit(1); }
    process.stdout.write('clip source privacy: all checks passed\n');
    process.exit(0);
})().catch((e) => { process.stdout.write(`FAILED ${e.stack}\n`); process.exit(1); });
