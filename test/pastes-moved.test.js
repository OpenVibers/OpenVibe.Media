'use strict';
// Pastes moved to OpenVibe.Community: Media's read-only paste API is retired (T10 step 2), so
// /api/v1/:app/pastes is unmounted and every method there answers 404. The public /p/:slug page
// and its text still 301 to Community when PASTES_MOVED_TO is set, and screenshot bytes are served here.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-moved-'));
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const shot = path.join(tmp, 'shot.png');
    fs.writeFileSync(shot, Buffer.from('\x89PNG\r\n\x1a\n'));
    await db.getDb().prepare("INSERT INTO pastes (app_id, slug, type, title, content, visibility, screenshot_path) VALUES ('live', 'text-1', 'paste', 't', 'hello', 'public', NULL), ('live', 'shot-1', 'screenshot', 's', '', 'public', ?) RETURNING id").run(shot);

    const app = express();
    app.use(express.json());
    app.use(require('../server/public/routes'));
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const get = (p) => fetch(base + p, { redirect: 'manual' });
        const post = () => fetch(`${base}/api/v1/live/pastes`, { method: 'POST', headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });

        // The app API is gone: no method on /api/v1/:app/pastes is mounted, so a write has no route to
        // answer 410 and creates nothing, and a read has no route either.
        const pasteCount = async () => (await db.get('SELECT COUNT(*) AS n FROM pastes')).n;
        const rows = await pasteCount();
        let r = await post();
        assert.strictEqual(r.status, 404, 'no paste-write route remains');
        r = await fetch(`${base}/api/v1/live/pastes/text-1`, { headers: { authorization: 'Bearer live-key' } });
        assert.strictEqual(r.status, 404, 'no paste-read route remains');
        assert.strictEqual(await pasteCount(), rows, 'nothing creates a paste');

        // Before the redirect switch: the pages are served here.
        assert.strictEqual((await get('/p/text-1')).status, 200);
        assert.strictEqual(await (await get('/p/text-1/raw')).text(), 'hello');

        process.env.PASTES_MOVED_TO = 'https://openvibe.community/';
        r = await get('/p/text-1');
        assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), 'https://openvibe.community/p/text-1');
        r = await get('/p/text-1/raw');
        assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), 'https://openvibe.community/p/text-1/raw');
        r = await get('/p/shot-1/raw');
        assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.get('location'), '/p/shot-1/screenshot', 'image pastes keep their local bytes');
        r = await get('/p/shot-1/screenshot');
        assert.strictEqual(r.status, 200, 'screenshot bytes are still served here');
        assert.ok(await db.getPasteBySlug('text-1'), 'no read deletes anything after the switch');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('pastes moved: all checks passed');
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
