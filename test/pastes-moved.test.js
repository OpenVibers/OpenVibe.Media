'use strict';
// After the Wave 5 cutover: paste writes for a frozen app answer 410, the paste page and its text 301 to
// OpenVibe.Community, and screenshot bytes are still served from here. Unset, nothing changes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-moved-'));
process.env.DB_PATH = path.join(tmp, 'media.db');
const db = require('../server/db/database');
require('../server/views/service').ensureSchema();
db.upsertApp({ app_id: 'live', api_key: 'live-key' });
const shot = path.join(tmp, 'shot.png');
fs.writeFileSync(shot, Buffer.from('\x89PNG\r\n\x1a\n'));
db.getDb().prepare("INSERT INTO pastes (app_id, slug, type, title, content, visibility, screenshot_path) VALUES ('live', 'text-1', 'paste', 't', 'hello', 'public', NULL), ('live', 'shot-1', 'screenshot', 's', '', 'public', ?)").run(shot);

const app = express();
app.use(express.json());
app.use('/api/v1/:app/pastes', require('../server/pastes/routes'));
app.use(require('../server/public/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p) => fetch(base + p, { redirect: 'manual' });
    const post = () => fetch(`${base}/api/v1/live/pastes`, { method: 'POST', headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });

    // Before the switch: business as usual.
    assert.strictEqual((await get('/p/text-1')).status, 200);
    assert.strictEqual(await (await get('/p/text-1/raw')).text(), 'hello');
    assert.strictEqual((await post()).status, 201);

    process.env.PASTES_MOVED_TO = 'https://openvibe.community/';
    process.env.PASTES_FROZEN_APPS = 'live';
    let r = await post();
    assert.strictEqual(r.status, 410); assert.strictEqual((await r.json()).code, 'pastes.moved');
    r = await fetch(`${base}/api/v1/live/pastes/text-1`, { headers: { authorization: 'Bearer live-key' } });
    assert.strictEqual(r.status, 200, 'reads still work');
    r = await get('/p/text-1');
    assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), 'https://openvibe.community/p/text-1');
    r = await get('/p/text-1/raw');
    assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), 'https://openvibe.community/p/text-1/raw');
    r = await get('/p/shot-1/raw');
    assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.get('location'), '/p/shot-1/screenshot', 'image pastes keep their local bytes');
    r = await get('/p/shot-1/screenshot');
    assert.strictEqual(r.status, 200, 'screenshot bytes are still served here');
    assert.ok(db.getPasteBySlug('text-1'), 'no read deletes anything after the switch');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('pastes moved: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
