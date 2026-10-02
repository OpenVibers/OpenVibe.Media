'use strict';
// Retention holds (media_holds; WS-G task 10): the staff routes /api/v1/:app/admin/storage/holds place and
// release them (app key only, never acting for a user; each change logged, the row keeps placed_by/at,
// released_by/at and a note). A held object cannot be deleted by any path (v1 routes, the admin bulk
// delete, deleteVodObjects, finalize's empty-recording deletes, the junk sweep, paste deletes, row SQL
// through the triggers) and is never moved between tiers (moveToCold, moveToHot, promoteToR2,
// demoteFromR2, the admin move). A clip cut from a held VOD is held too, before it has an object of its
// own as well. Release lifts all of it. An old database gets the note column and the new triggers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-holds-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        OBJECTS_PATH: dir('objects'), THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'),
        MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'https://openvibe.network',
    });
    for (const k of Object.keys(process.env)) if (/^MEDIA_(B2|R2)_/.test(k)) delete process.env[k];

    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const vodStorage = require('../server/vod/vod-storage');
    // The revisioned tier policies load once the database is open (server/index.js does this at boot).
    await vodStorage.tierConfig.init(vodStorage.DEFAULTS);
    await require('../server/objects/tier-policy').init();
    const express = require('express');

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.upsertApp({ app_id: 'games', api_key: 'games-key' });
    const raw = () => db.getDb();
    const file = (d, name, bytes = 64) => { const p = path.join(d, name); fs.writeFileSync(p, Buffer.alloc(bytes, 3)); return p; };
    const insVod = async (id, name, { app = 'live', bytes = 64, recording = 0, clipsOnly = 0, duration = 60 } = {}) => await raw().prepare(
        `INSERT INTO vods (id, app_id, title, file_path, file_size, is_public, visibility, duration_seconds, is_recording, clips_only, storage_provider) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, ?, 1, 'public', ?, ?, ?, 'local') RETURNING id`).run(id, app, `vod ${id}`, name ? file(process.env.VOD_PATH, name, bytes) : null, bytes, duration, recording, clipsOnly);
    const insClip = async (id, vodId, name) => await raw().prepare(`INSERT INTO clips (id, app_id, vod_id, title, file_path, is_public, visibility, status, duration_seconds) OVERRIDING SYSTEM VALUE
         VALUES (?, 'live', ?, ?, ?, 1, 'public', 'ready', 5) RETURNING id`).run(id, vodId, `clip ${id}`, file(process.env.CLIPS_PATH, name, 32));

    // ── A VOD from before (its object projected) ──
    await insVod(99, 'vod-live-99-1.webm');
    await model.sync('vod', 99);

    // ── Fixtures ──
    await insVod(1, 'vod-live-1-1.webm');
    await insVod(2, 'vod-live-2-2.webm');
    await insVod(3, null, { clipsOnly: 1 });
    await insVod(4, 'vod-games-4-4.webm', { app: 'games' });
    await insVod(5, 'vod-live-5-5.webm');          // no object yet: the staff route projects it
    for (const id of [1, 2, 4]) await model.sync('vod', id);
    await insClip(11, 1, 'clip-11.webm');
    await model.sync('clip', 11);
    await insClip(12, 1, 'clip-12.webm');          // cut from VOD 1, not projected yet
    await insClip(13, 2, 'clip-13.webm');
    await model.sync('clip', 13);
    const vod = async (id) => await db.get('SELECT * FROM vods WHERE id = ?', [id]);
    const clip = async (id) => await db.get('SELECT * FROM clips WHERE id = ?', [id]);
    await raw().prepare(`INSERT INTO pastes (slug, app_id, title, type, content, language, visibility, screenshot_path)
                   VALUES ('shot1', 'live', 'S', 'screenshot', '', 'text', 'public', ?) RETURNING id`).run(file(dir('pastes/screenshots'), 'shot1.png', 20));
    await model.sync('paste', (await db.get("SELECT id FROM pastes WHERE slug = 'shot1'")).id);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/admin/storage', require('../server/admin/routes'));
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v1/:app/pastes', require('../server/pastes/routes'));
    app.use('/api/v2/:app/objects', require('../server/objects/routes'));

    (async () => {
        const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : '';
            const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method,
                headers: { authorization: 'Bearer live-key', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
            (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : {} })); });
            rq.on('error', reject);
            rq.end(data);
        });
        const H = '/api/v1/live/admin/storage/holds';

        // ── Staff routes: place ──
        let r = await call('POST', H, { vod_id: 1, reason: 'DMCA notice #7 — keep the evidence', kind: 'dmca', note: 'counter-notice window ends Oct 9', placed_by: 'staff:alex' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const hold = r.body;
        assert.deepStrictEqual([hold.kind, hold.placed_by, hold.created_by, hold.note, hold.released_at, hold.object.id, hold.object.legacy_ref],
            ['dmca', 'staff:alex', 'staff:alex', 'counter-notice window ends Oct 9', null, (await vod(1)).object_id, 'legacy:live:vod:1']);
        assert.ok(hold.placed_at, 'placed_at is recorded');
        assert.strictEqual(hold.clips_protected, 2, 'both clips cut from the VOD are protected');
        assert.strictEqual((await call('POST', H, { vod_id: 2 })).status, 400, 'a reason is required');
        assert.strictEqual((await call('POST', H, { vod_id: 2, reason: 'x', kind: 'whim' })).status, 400, 'known kinds only');
        assert.strictEqual((await call('POST', H, { reason: 'x' })).status, 400, 'a target is required');
        assert.strictEqual((await call('POST', H, { vod_id: 4, reason: 'x' })).status, 404, "another app's VOD is not found");
        assert.strictEqual((await call('POST', H, { vod_id: 3, reason: 'x' })).status, 409, 'a clips-only recording has no object to hold');
        assert.strictEqual((await call('POST', H, { vod_id: 2, reason: 'x' }, { 'x-ov-user-id': '5' })).status, 403, 'never acting for a user');
        assert.strictEqual((await call('POST', '/api/v1/games/admin/storage/holds', { vod_id: 2, reason: 'x' }, { authorization: 'Bearer games-key' })).status, 404, "games cannot hold live's VOD");
        r = await call('POST', H, { vod_id: 5, reason: 'moderation review' });
        assert.strictEqual(r.status, 201);
        assert.ok((await vod(5)).object_id && r.body.object.id === (await vod(5)).object_id, 'a row with no object yet is projected, then held');
        assert.strictEqual(r.body.placed_by, 'app:live', 'placed_by defaults to the app');
        const hold5 = r.body.id;
        console.log('✅ staff routes place holds by vod/clip/object id (reason required, app key only, own app only)');

        // ── A held VOD: no delete path works ──
        r = await call('DELETE', '/api/v1/live/vods/1');
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.held']);
        r = await call('DELETE', '/api/v1/live/admin/storage/vods/bulk', { ids: [1] });
        assert.deepStrictEqual([r.body.deleted, r.body.results[0].error], [0, 'VOD is under a retention hold']);
        await vodStorage.deleteVodObjects(await vod(1));
        assert.ok(fs.existsSync((await vod(1)).file_path), 'deleteVodObjects keeps held bytes');
        await assert.rejects(async () => await db.run('DELETE FROM vods WHERE id = 1'), /retention hold/, 'row SQL is refused by the trigger');
        await assert.rejects(async () => await db.run("UPDATE media_objects SET lifecycle_status = 'deleted' WHERE id = ?", [(await vod(1)).object_id]), /retention hold/);
        // …nor a tier move of any kind (placement is frozen).
        assert.deepStrictEqual([(await vodStorage.moveToCold(1)).held, (await vodStorage.promoteToR2(1)).held], [true, true]);
        await raw().prepare("UPDATE vods SET storage_provider = 'r2' WHERE id = 1").run();
        const hot = await vodStorage.moveToHot(1);
        assert.deepStrictEqual([hot.ok, hot.held], [false, true], 'moveToHot refuses too (it would drop the R2 copy)');
        assert.strictEqual((await vod(1)).storage_provider, 'r2', 'the row is not flipped');
        assert.strictEqual((await vodStorage.demoteFromR2(1)).held, true);
        await raw().prepare("UPDATE vods SET storage_provider = 'local' WHERE id = 1").run();
        for (const target of ['local', 'b2', 'r2']) {
            r = await call('POST', '/api/v1/live/admin/storage/tiers/move', { vod_id: 1, target });
            assert.strictEqual(r.body.held, true, `the admin move to ${target} is refused`);
        }
        console.log('✅ a held VOD: every delete path and every tier move (including moveToHot) is refused');

        // ── Clips cut from a held VOD follow its hold ──
        assert.strictEqual(await model.isHeld((await clip(11)).object_id), true, 'the clip object inherits the VOD hold');
        r = await call('DELETE', '/api/v1/live/clips/11');
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.held']);
        await vodStorage.deleteVodObjects(await clip(11));
        assert.ok(fs.existsSync((await clip(11)).file_path), 'the clip keeps its bytes');
        await assert.rejects(async () => await db.run('DELETE FROM clips WHERE id = 11'), /retention hold/);
        assert.strictEqual((await clip(12)).object_id, null);
        assert.strictEqual(await model.isHeldRow(await clip(12)), true, 'a clip with no object yet follows its VOD by vod_id');
        await assert.rejects(async () => await db.run('DELETE FROM clips WHERE id = 12'), /retention hold/, 'the trigger covers it too');
        r = await call('GET', `/api/v2/live/objects/${(await clip(11)).object_id}/holds`);
        assert.deepStrictEqual([r.body.held, r.body.holds.length, r.body.inherited_holds.length, r.body.inherited_holds[0].inherited_from],
            [true, 0, 1, (await vod(1)).object_id], 'the v2 holds answer shows the inherited hold');
        assert.strictEqual((await call('GET', `/api/v2/live/objects/${(await clip(11)).object_id}`)).body.held, true);
        assert.strictEqual(await model.isHeld((await clip(13)).object_id), false, "another VOD's clip is not held");
        console.log('✅ clips cut from a held VOD are held (also before they have an object); others are not');

        // ── Finalize and the junk sweep keep held recordings ──
        const finalize = require('../server/vod/finalize');
        await insVod(20, 'vod-live-20-0.webm', { bytes: 0, recording: 1, duration: 0 });
        await model.sync('vod', 20);
        await model.placeHold({ object_id: (await vod(20)).object_id, kind: 'moderation', reason: 'live report', created_by: 'staff:mod' });
        await finalize.finalizeVod(20);
        assert.ok(await vod(20) && fs.existsSync((await vod(20)).file_path), 'a held zero-byte recording keeps its row and file');
        assert.deepStrictEqual([(await vod(20)).is_recording, (await vod(20)).health_status], [0, 'zero_byte'], 'settled as failed instead');
        await insVod(21, null, { recording: 1, duration: 0 });
        await raw().prepare("UPDATE vods SET file_path = ? WHERE id = 21").run(path.join(process.env.VOD_PATH, 'never-written.webm'));
        await model.sync('vod', 21);
        await model.placeHold({ object_id: (await vod(21)).object_id, kind: 'evidence', reason: 'x' });
        await finalize.finalizeVod(21);
        assert.deepStrictEqual([!!await vod(21), await vod(21) && (await vod(21)).health_status], [true, 'missing_file'], 'a held recording with no file keeps its row');
        await insVod(22, null, { recording: 1, duration: 0 });
        await finalize.finalizeVod(22);
        assert.strictEqual(await vod(22), undefined, 'an unheld empty recording is still deleted');
        // Junk sweep: public, finished, 0:00, no media.
        await insVod(23, 'vod-live-23-0.webm', { bytes: 0, duration: 0 });
        await raw().prepare("UPDATE vods SET health_status = 'unknown' WHERE id IN (23)").run();
        await model.sync('vod', 23);
        await model.placeHold({ object_id: (await vod(23)).object_id, kind: 'admin', reason: 'x' });
        await insVod(24, 'vod-live-24-0.webm', { bytes: 0, duration: 0 });
        await require('../server/vod/health-job').start();
        require('../server/vod/health-job').stop();
        assert.ok(await vod(23) && fs.existsSync((await vod(23)).file_path), 'the junk sweep keeps a held row and its file');
        assert.strictEqual(await vod(24), undefined, 'and still removes an unheld one');
        console.log('✅ finalize and the junk sweep settle held empty recordings instead of deleting them');

        // ── A held screenshot paste: paste writes moved to OpenVibe.Community, so deletes answer 410 ──
        const shot = await db.get("SELECT * FROM pastes WHERE slug = 'shot1'");
        await model.placeHold({ object_id: shot.object_id, kind: 'evidence', reason: 'x' });
        r = await call('DELETE', '/api/v1/live/pastes/shot1');
        assert.deepStrictEqual([r.status, r.body.code], [410, 'pastes.moved']);
        r = await call('POST', '/api/v1/live/pastes/bulk', { slugs: ['shot1'], action: 'delete' });
        assert.deepStrictEqual([r.status, r.body.code], [410, 'pastes.moved'], 'bulk delete is gone too');
        assert.ok(fs.existsSync(shot.screenshot_path) && await db.get("SELECT 1 AS x FROM pastes WHERE slug = 'shot1'"));
        const shotObj = await model.getObject(shot.object_id);
        assert.ok(shotObj && shotObj.lifecycle_status !== 'deleted', 'the paste keeps its object');
        console.log('✅ a held screenshot paste: DELETE and bulk delete answer 410 pastes.moved; row, bytes and object stay');

        // ── Listing and release ──
        r = await call('GET', H);
        assert.ok(r.body.holds.every(h => !h.released_at) && r.body.holds.some(h => h.id === hold.id), 'active holds, newest first');
        assert.strictEqual(r.body.holds[0].id > r.body.holds[r.body.holds.length - 1].id, true);
        r = await call('GET', `${H}?vod_id=1`);
        assert.deepStrictEqual(r.body.holds.map(h => h.id), [hold.id]);
        r = await call('POST', `${H}/${hold.id}/release`, { released_by: 'staff:alex' });
        assert.deepStrictEqual([r.status, r.body.released_by, !!r.body.released_at, r.body.note], [200, 'staff:alex', true, 'counter-notice window ends Oct 9']);
        assert.strictEqual((await call('POST', `${H}/${hold.id}/release`, {})).status, 409, 'a released hold cannot be released again');
        assert.strictEqual((await call('DELETE', `/api/v1/games/admin/storage/holds/${hold5}`, {}, { authorization: 'Bearer games-key' })).status, 404, "another app cannot release this app's hold");
        assert.strictEqual((await call('DELETE', `${H}/${hold5}`)).status, 200, 'DELETE releases too');
        assert.ok(!(await call('GET', H)).body.holds.some(h => h.id === hold.id), 'released holds leave the active list');
        assert.ok((await call('GET', `${H}?all=1`)).body.holds.some(h => h.id === hold.id && h.released_by === 'staff:alex'), 'and stay on record');
        assert.strictEqual(await model.isHeld((await clip(11)).object_id), false, 'releasing the VOD releases its clips');
        assert.strictEqual((await call('DELETE', '/api/v1/live/clips/11')).status, 200);
        await raw().prepare('DELETE FROM clips WHERE id = 12').run();
        assert.strictEqual((await call('DELETE', '/api/v1/live/vods/1')).status, 200, 'the VOD can be deleted once released');
        console.log('✅ release by the staff route: on record with released_by/at and the note; deletes work again');

        // ── The v2 route takes a note too ──
        r = await call('POST', `/api/v2/live/objects/${(await vod(2)).object_id}/holds`, { kind: 'admin', reason: 'r', note: 'n' });
        assert.deepStrictEqual([r.status, r.body.note, r.body.placed_by], [201, 'n', 'app:live']);
        console.log('✅ v2 holds: note and placed_by/placed_at on the same table');

        server.close();
        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('retention holds: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
