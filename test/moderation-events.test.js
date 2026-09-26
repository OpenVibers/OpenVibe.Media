'use strict';
// Staff holds are moderation actions (media.moderation.action, ADR-022, WS-D task 1): placing and
// releasing a hold on someone else's media queues exactly one valid common.moderation-action@1 in the same
// transaction, with the staff subject as actor when one is named; a creator's own pin, a second release
// and a sandbox tenant queue nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-modevents-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
});
const stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.statusCode = 404; res.end('{}'); }); });

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const contracts = require('openvibe-contracts');
    const db = require('../server/db/database');
    const conn = db.getDb();
    db.upsertApp({ app_id: 'live', api_key: 'live-key-modev' });
    const events = require('../server/events');
    events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 });
    const model = require('../server/objects/model');
    const moderation = () => conn.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => e.event_type === 'media.moderation.action');

    const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', STAFF = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const obj = model.createObject({ app_id: 'live', kind: 'vod', owner_subject: OWNER, lifecycle_status: 'ready', mime_type: 'video/webm', size_bytes: 1 });

    const hold = model.placeHold({ object_id: obj, kind: 'moderation', reason: 'reported for review', placed_by: STAFF, note: 'ticket 12' });
    let ev = moderation();
    assert.strictEqual(ev.length, 1, 'one event for the placed hold');
    const e = ev[0];
    assert.ok(contracts.validate('media.moderation.action@1', e.payload).valid, JSON.stringify(contracts.validate('media.moderation.action@1', e.payload).errors));
    assert.deepStrictEqual(e.payload.target, { type: 'vod', id: obj, owner_subject: OWNER });
    assert.deepStrictEqual([e.payload.action, e.payload.actor_subject, e.payload.reason, e.payload.details.kind, e.payload.details.hold_id], ['hold.placed', STAFF, 'reported for review', 'moderation', hold.id]);
    assert.deepStrictEqual([e.actor, e.subject, e.visibility], [{ type: 'user', id: STAFF }, { type: 'moderation_action', id: `vod:${obj}` }, 'internal']);
    assert.ok(!JSON.stringify(e.payload).includes('ticket 12'), 'the staff note stays in Media');

    model.releaseHold(hold.id, 'app:live');
    ev = moderation();
    assert.strictEqual(ev.length, 2);
    assert.deepStrictEqual([ev[1].payload.action, ev[1].payload.actor_subject, ev[1].payload.details.by, ev[1].actor], ['hold.released', null, 'app:live', { type: 'service', id: 'media' }]);
    model.releaseHold(hold.id, STAFF);
    assert.strictEqual(moderation().length, 2, 'releasing twice announces once');

    model.placeHold({ object_id: obj, kind: 'creator_pin', reason: 'my favourite', placed_by: OWNER });
    assert.strictEqual(moderation().length, 2, "a creator's own pin is not moderation");

    // A developer sandbox tenant announces nothing.
    db.upsertApp({ app_id: 'app.p_sandbox', api_key: 'sandbox-key' });
    const sandbox = db.isSandboxTenant('app.p_sandbox');
    if (sandbox) {
        const so = model.createObject({ app_id: 'app.p_sandbox', kind: 'file', lifecycle_status: 'ready', size_bytes: 1 });
        model.placeHold({ object_id: so, kind: 'admin', reason: 'x', placed_by: STAFF });
        assert.strictEqual(moderation().length, 2, 'sandbox tenants produce no platform events');
    }

    events._reset();
    stub.close();
    console.log('moderation events: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
