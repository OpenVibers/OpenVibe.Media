'use strict';
// media.object.deleted / media.object.visibility_changed (server/events.js, the media_objects triggers
// in server/db/database.js): every deletion and visibility change of an object, whichever path makes
// it, becomes one event through Media's outbox; the events Media's own transactions cause commit in
// those transactions (projection sync, announce(), soft delete); a rolled-back change has none; the
// payload is minimal (identity and the change, no tenant data); sandbox tenants produce none.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-objevents-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
});

const stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        res.statusCode = 503; res.end('{}');             // Events down: rows stay in the outbox for the test to read
    });
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DELETED_KEYS = ['app_id', 'deleted_at', 'kind', 'legacy_ref', 'object_id'];
const VIS_KEYS = ['app_id', 'changed_at', 'kind', 'legacy_ref', 'object_id', 'previous_visibility', 'visibility'];

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const events = require('../server/events');
    db.upsertApp({ app_id: 'live', api_key: 'live-key-objevents' });
    const sandbox = db.ensureProjectTenant('prj_01TESTOBJEVENTS000000000A', 'sandbox', 1024).app_id;
    const raw = db.getDb();
    const staged = () => raw.prepare('SELECT COUNT(*) AS n FROM media_object_changes').get().n;

    // With the outbox off, changes wait staged (and the service drops them hourly).
    const v0 = Number(db.createVod({ app_id: 'live', title: 'before the outbox', file_path: path.join(tmp, 'none.mp4') }).lastInsertRowid);
    model.sync('vod', v0);
    db.setVodVisibility(v0, 'unlisted');
    assert.strictEqual(staged(), 1, 'staged by the trigger');
    assert.strictEqual(events.discardObjectChanges(), 1);

    assert.ok(events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 3600000 }));
    const outbox = () => raw.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
    const objectEvents = () => outbox().filter((e) => e.event_type.startsWith('media.object.'));

    // ── 1. A visibility change through the v1 route's path (projection sync): one event, same transaction ──
    const vodId = Number(db.createVod({ app_id: 'live', user_id: 7, title: 'Secret title', file_path: path.join(tmp, 'v.mp4'), meta: { a: 1 } }).lastInsertRowid);
    model.sync('vod', vodId);
    const obj = model.getObject(db.get('SELECT object_id FROM vods WHERE id = ?', [vodId]).object_id);
    assert.strictEqual(objectEvents().length, 0, 'creating an object is not one of these events');
    db.setVodVisibility(vodId, 'private');
    let evs = objectEvents();
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(staged(), 0, 'recorded in the sync transaction, nothing left staged');
    const e = evs[0];
    assert.strictEqual(e.event_type, 'media.object.visibility_changed');
    assert.deepStrictEqual(e.subject, { type: 'object', id: obj.id });
    assert.deepStrictEqual([e.source, e.visibility, e.priority, e.actor], ['media', 'internal', 'important', { type: 'service', id: 'media' }]);
    assert.deepStrictEqual(Object.keys(e.payload).sort(), VIS_KEYS, 'exactly the minimal payload');
    assert.deepStrictEqual([e.payload.object_id, e.payload.app_id, e.payload.kind, e.payload.legacy_ref, e.payload.visibility, e.payload.previous_visibility],
        [obj.id, 'live', 'vod', `legacy:live:vod:${vodId}`, 'private', 'public']);
    assert.ok(ISO.test(e.payload.changed_at));
    assert.ok(!JSON.stringify(e.payload).includes('Secret title') && !('owner_user_id' in e.payload), 'no tenant data');
    db.setVodVisibility(vodId, 'private');
    model.sync('vod', vodId);
    assert.strictEqual(objectEvents().length, 1, 'no event when nothing changed');
    console.log('✅ visibility change: one media.object.visibility_changed, minimal payload, committed with the change');

    // ── 2. A rolled-back change has no event ──
    assert.throws(() => raw.transaction(() => {
        raw.prepare("UPDATE media_objects SET visibility = 'public' WHERE id = ?").run(obj.id);
        events.recordObjectChanges();
        throw new Error('rollback');
    })(), /rollback/);
    assert.strictEqual(objectEvents().length, 1);
    assert.strictEqual(staged(), 0);
    assert.throws(() => events.recordObjectChanges(), /inside the transaction/);
    console.log('✅ a rolled-back change leaves neither an event nor a staged row');

    // ── 3. A row deleted inside announce(): media.object.deleted in the same transaction ──
    const { announce } = require('../server/webhooks');
    announce('live', 'vod.failed', { change: () => db.run('DELETE FROM vods WHERE id = ?', [vodId]), payload: { id: vodId } });
    evs = objectEvents();
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[1].event_type, 'media.object.deleted');
    assert.deepStrictEqual(Object.keys(evs[1].payload).sort(), DELETED_KEYS);
    assert.deepStrictEqual([evs[1].payload.object_id, evs[1].payload.kind, evs[1].payload.legacy_ref], [obj.id, 'vod', `legacy:live:vod:${vodId}`]);
    assert.ok(ISO.test(evs[1].payload.deleted_at));
    const all = outbox();
    assert.strictEqual(all[all.length - 2].event_type, 'media.vod.failed', 'queued together with the outcome');
    console.log('✅ a vods row deleted in announce(): media.object.deleted with media.vod.failed, one transaction');

    // ── 4. A native object soft-deleted through the v2 path ──
    const nativeId = model.createObject({ app_id: 'live', kind: 'file', visibility: 'unlisted', lifecycle_status: 'ready' });
    model.softDelete(model.getObject(nativeId), { by: 'test' });
    evs = objectEvents();
    assert.deepStrictEqual([evs[2].event_type, evs[2].payload.object_id, evs[2].payload.legacy_ref, evs[2].payload.kind], ['media.object.deleted', nativeId, null, 'file']);
    raw.prepare("UPDATE media_objects SET visibility = 'public' WHERE id = ?").run(nativeId);
    assert.strictEqual(staged(), 0, 'a deleted object\'s visibility is not an event');
    console.log('✅ soft delete of a native object: media.object.deleted');

    // ── 5. Any other path (a row deleted outside a transaction, operator SQL): staged, then drained ──
    const clipId = Number(db.createClip({ app_id: 'live', vod_id: null, title: 'c', file_path: path.join(tmp, 'c.webm') }).lastInsertRowid);
    const clipObj = db.get('SELECT object_id FROM clips WHERE id = ?', [clipId]).object_id;
    const before = objectEvents().length;
    db.run('DELETE FROM clips WHERE id = ?', [clipId]);
    assert.strictEqual(staged(), 1, 'the trigger staged it with the delete');
    assert.strictEqual(objectEvents().length, before);
    assert.strictEqual(events.drainObjectChanges(), 1);
    evs = objectEvents();
    assert.deepStrictEqual([evs[evs.length - 1].event_type, evs[evs.length - 1].payload.object_id, evs[evs.length - 1].payload.kind], ['media.object.deleted', clipObj, 'clip']);
    assert.strictEqual(staged(), 0);
    console.log('✅ a change made outside Media\'s transactions is staged by the trigger and drained into the outbox');

    // ── 6. Sandbox tenants produce no platform events ──
    const sb = model.createObject({ app_id: sandbox, kind: 'file', visibility: 'private', lifecycle_status: 'ready' });
    const n = objectEvents().length;
    raw.transaction(() => { raw.prepare("UPDATE media_objects SET visibility = 'unlisted' WHERE id = ?").run(sb); events.recordObjectChanges(); })();
    assert.strictEqual(objectEvents().length, n, 'none for a sandbox');
    assert.strictEqual(staged(), 0);
    console.log('✅ sandbox tenants: no events');

    events._reset();
    stub.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All object event tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
