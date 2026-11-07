'use strict';
// Watch ids (plan track U, 2026-11-07): every VOD and clip is addressed by an 11-character random id as well as its
// number, minted by Media (which owns both tables), in one id space across the two.
//   - the format: 11 URL-safe base64 characters from 8 random bytes, never derived from the numeric id;
//   - a new VOD and a new clip each get one at insert, distinct, and no two rows share an id;
//   - a resolver answers { kind, id } for one and 404 for an unknown one;
//   - the backfill fills rows written before the column, is idempotent (a second pass fills nothing, changes nothing),
//     and leaves no row without an id;
//   - watch_id is on the public shapes Media serves (vodPublic / clipPublic, and so every API read and list) and on a
//     private row too: visibility is unchanged, so a private item still resolves and still answers as before.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-watch-ids-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), OBJECTS_PATH: dir('objects'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'),
        MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'https://openvibe.network', MEDIA_SIGNING_SECRET: 'test-signing-secret',
    });
    delete process.env.MEDIA_DRILL;

    const express = require('express');
    const db = require('../server/db/database');
    const watch = require('../server/watch-ids');
    const { vodPublic } = require('../server/vod/finalize');
    const { clipPublic } = require('../server/vod/clips-routes');

    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.upsertApp({ app_id: 'games', api_key: 'games-key' });

    // ── The format ─────────────────────────────────────────────
    for (let i = 0; i < 200; i++) {
        const id = watch.mint();
        assert.match(id, /^[A-Za-z0-9_-]{11}$/, `mint() gave ${id}`);
        assert.strictEqual(Buffer.from(id, 'base64url').length, 8, '11 base64url characters are 8 bytes (64 bits)');
        assert.ok(watch.isWatchId(id));
    }
    assert.ok(!watch.isWatchId('6203'), 'a number is not a watch id');
    assert.ok(!watch.isWatchId('short'), 'a short string is not a watch id');
    assert.ok(!watch.isWatchId(''), 'an empty string is not a watch id');
    console.log('✅ the id: 11 URL-safe base64 characters from 8 random bytes, never a number');

    // ── A new row gets one, and it is not its number ──────────
    const vodId = Number((await db.createVod({ app_id: 'live', title: 'A stream', visibility: 'public' })).lastInsertRowid);
    const clipId = Number((await db.createClip({ app_id: 'live', vod_id: vodId, title: 'A moment', visibility: 'public' })).lastInsertRowid);
    const vodRow = await db.getVodById(vodId);
    const clipRow = await db.getClipById(clipId);
    assert.ok(vodRow.watch_id, 'a new VOD has a watch id at insert');
    assert.ok(clipRow.watch_id, 'a new clip has a watch id at insert');
    assert.match(vodRow.watch_id, /^[A-Za-z0-9_-]{11}$/);
    assert.notStrictEqual(vodRow.watch_id, String(vodId), 'the id is not the number');
    assert.notStrictEqual(vodRow.watch_id, clipRow.watch_id, 'a VOD and a clip never share one');
    assert.strictEqual((await db.getVodById(vodId)).watch_id, vodRow.watch_id, 'the id never changes');
    console.log('✅ a new VOD and a new clip each get one at insert, distinct from each other and from their numbers');

    // ── The resolver ─────────────────────────────────────────
    assert.deepStrictEqual(await watch.resolve(vodRow.watch_id), { kind: 'vod', id: vodId });
    assert.deepStrictEqual(await watch.resolve(clipRow.watch_id), { kind: 'clip', id: clipId });
    assert.strictEqual(await watch.resolve('nosuchidxyz'), null, 'an unknown id resolves to nothing');
    assert.strictEqual(await watch.resolve('6203'), null, 'a number is not looked up as a watch id');
    console.log('✅ the resolver answers { kind, id } for a VOD and a clip, and nothing for an unknown id');

    // ── The public shapes carry it ────────────────────────────
    const vodShape = await vodPublic(await db.getVodById(vodId), { hls: false });
    const clipShape = await clipPublic(await db.getClipById(clipId), { hls: false });
    assert.strictEqual(vodShape.watch_id, vodRow.watch_id, 'vodPublic carries the watch id');
    assert.strictEqual(clipShape.watch_id, clipRow.watch_id, 'clipPublic carries the watch id');
    console.log('✅ the public shapes Media serves carry watch_id');

    // ── A private row resolves too; visibility is the route's business ──
    const privId = Number((await db.createVod({ app_id: 'live', title: 'A private stream', visibility: 'private' })).lastInsertRowid);
    const privRow = await db.getVodById(privId);
    assert.ok(privRow.watch_id, 'a private VOD has a watch id too');
    assert.deepStrictEqual(await watch.resolve(privRow.watch_id), { kind: 'vod', id: privId },
        'the resolver answers; the route then applies the same visibility rule the number had');
    console.log('✅ a private item resolves by its watch id, and its visibility is still the route\'s to enforce');

    // ── The backfill: rows written before the column ──────────
    // Simulate the pre-column estate: clear the ids the inserts minted, and add rows with none at all.
    await db.run('UPDATE vods SET watch_id = NULL');
    await db.run('UPDATE clips SET watch_id = NULL');
    const legacyVods = [];
    for (let i = 0; i < 12; i++) {
        legacyVods.push(Number((await db.run(
            `INSERT INTO vods (app_id, title, is_public, visibility) VALUES ('live', ?, 1, 'public') RETURNING id`,
            [`legacy ${i}`])).lastInsertRowid));
    }
    const before = await db.get('SELECT COUNT(*) AS n FROM vods WHERE watch_id IS NULL');
    assert.ok(Number(before.n) >= 13, 'the estate is all NULL before the backfill');

    const first = await watch.backfillAll({ batch: 4 });
    assert.ok(first.filled >= 13, `the backfill filled every row (filled ${first.filled})`);
    assert.strictEqual(first.remaining, 0, 'no row is left without an id');
    const leftVods = Number((await db.get('SELECT COUNT(*) AS n FROM vods WHERE watch_id IS NULL'))?.n);
    const leftClips = Number((await db.get('SELECT COUNT(*) AS n FROM clips WHERE watch_id IS NULL'))?.n);
    assert.strictEqual(leftVods, 0, 'every VOD has an id');
    assert.strictEqual(leftClips, 0, 'every clip has an id');
    console.log(`✅ the backfill: ${first.filled} row(s) filled, 0 left NULL`);

    // ── Idempotent: a second pass writes nothing and changes nothing ──
    const snapshot = async () => {
        const v = await db.all('SELECT id, watch_id FROM vods ORDER BY id');
        const c = await db.all('SELECT id, watch_id FROM clips ORDER BY id');
        return JSON.stringify({ v, c });
    };
    const was = await snapshot();
    const second = await watch.backfillAll({ batch: 4 });
    assert.strictEqual(second.filled, 0, 'a second backfill fills nothing');
    assert.strictEqual(second.remaining, 0);
    assert.strictEqual(await snapshot(), was, 'and changes no id that was already there');
    console.log('✅ the backfill is idempotent: a second pass fills nothing and changes nothing');

    // ── Uniqueness across the whole estate, both tables ────────
    const allIds = [
        ...(await db.all('SELECT id, watch_id FROM vods')).map((r) => r.watch_id),
        ...(await db.all('SELECT id, watch_id FROM clips')).map((r) => r.watch_id),
    ];
    for (const id of allIds) assert.match(id, /^[A-Za-z0-9_-]{11}$/, `every row has a well-formed id (${id})`);
    assert.strictEqual(new Set(allIds).size, allIds.length, 'every id is unique across vods and clips');
    console.log(`✅ ${allIds.length} rows, every id unique across both tables`);

    // ── The API route: GET /api/v1/:app/watch/:watch_id ────────
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/watch', require('../server/watch-routes'));
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const get = async (p) => {
            const r = await fetch(base + p, { headers: { authorization: 'Bearer live-key' } });
            const text = await r.text();
            let body = null; try { body = JSON.parse(text); } catch { /* */ }
            return { status: r.status, body };
        };
        const someVod = await db.get('SELECT id, watch_id FROM vods WHERE watch_id IS NOT NULL LIMIT 1');
        const api = await get(`/api/v1/live/watch/${someVod.watch_id}`);
        assert.strictEqual(api.status, 200, 'a known watch id answers 200');
        assert.deepStrictEqual(api.body, { kind: 'vod', id: Number(someVod.id) });
        const missing = await get('/api/v1/live/watch/zzzzzzzzzzz');
        assert.strictEqual(missing.status, 404, 'an unknown watch id is the same 404 a missing id gets');
        const numeric = await get(`/api/v1/live/watch/${someVod.id}`);
        assert.strictEqual(numeric.status, 404, 'a number is not a watch id');
        console.log('✅ GET /api/v1/:app/watch/:watch_id resolves one, and answers 404 for an unknown id');
    } finally {
        await new Promise((r) => server.close(r));
    }

    await db.close();
    console.log('\nAll watch-id checks passed.');
})().catch((err) => { console.error(err); process.exit(1); });
