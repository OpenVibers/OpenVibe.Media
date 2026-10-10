'use strict';
// Pastes moved to OpenVibe.Community: Media's read-only paste API is retired (T10 step 2), so
// /api/v1/:app/pastes is unmounted and every method there answers 404. The public /p/:slug and
// /p/:slug/raw routes are unconditional 301s to Community — no env var needed (the default is
// config.pastes.movedTo) and no row is read: a known, missing or private slug all go there.
// Legacy screenshot objects redirect to their object URLs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

(async () => {
    delete process.env.PASTES_MOVED_TO;   // the redirect must not depend on it
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-moved-'));
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    const objectId = 'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
    await db.run("INSERT INTO media_objects (id, app_id, namespace, kind, visibility, lifecycle_status, legacy_ref) VALUES (?, 'live', 'live', 'screenshot', 'public', 'ready', 'legacy:live:paste:shot-1')", [objectId]);
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
        let r = await post();
        assert.strictEqual(r.status, 404, 'no paste-write route remains');
        r = await fetch(`${base}/api/v1/live/pastes/text-1`, { headers: { authorization: 'Bearer live-key' } });
        assert.strictEqual(r.status, 404, 'no paste-read route remains');

        // The page and its text are Community's: a permanent 301, with no env var set.
        r = await get('/p/text-1');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, 'https://openvibe.community/p/text-1']);
        r = await get('/p/text-1/raw');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, 'https://openvibe.community/p/text-1/raw'], 'the raw suffix is preserved');

        // No row read: a slug that has no row at all — a paste made in Community since the move — and a
        // slug with characters an app could put in a link both redirect the same way.
        r = await get('/p/no-such-slug');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, 'https://openvibe.community/p/no-such-slug']);
        r = await get('/p/no-such-slug/raw');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, 'https://openvibe.community/p/no-such-slug/raw']);
        r = await get('/p/a%2Fb%20c');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.get('location'), 'https://openvibe.community/p/a%2Fb%20c', 'the slug is URL-encoded, never interpolated raw');

        r = await get('/p/shot-1/screenshot');
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, `/o/${objectId}`]);
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('pastes moved: all checks passed');
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
