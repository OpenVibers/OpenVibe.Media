'use strict';
// Account export and deletion → Media (roadmap WS-B task 7, ADR-033): through POST /internal/events (signed),
// network.account.export_requested sends Media's part to Network (the subject's objects, VODs and clips, no storage or
// stream keys), and network.account.deleted erases what the subject and its merged-in aliases own: native objects are
// soft-deleted, VODs, clips and files removed with their bytes, thumbnails marked deleted; held media is kept and counted. Media confirms with counts; a redelivery sends nothing twice, and a failed
// confirmation is retried without erasing again.
//   node test/account-data.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-account-data-'));
    process.env.MEDIA_INBOUND_EVENTS_SECRET = 'm'.repeat(40);
    const log = console.log;
    console.log = (...a) => { if (!/^\[/.test(String(a[0]))) log(...a); };
    console.warn = () => {};
    const { validate } = require('openvibe-contracts');
    const accountData = require('../server/account-data');
    const db = require('../server/db/database').getDb();

    const DANA = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', OLD = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4', XENA = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2C5';
    const obj = db.prepare("INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, visibility, lifecycle_status, legacy_ref) VALUES (?, 'live', 'live', ?, ?, 'public', 'ready', ?)");
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D1', 'file', DANA, null);                          // native: soft-deleted
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D2', 'file', OLD, null);                           // native, merged-in alias: soft-deleted
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D3', 'file', DANA, null);                          // held: kept
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D4', 'vod', DANA, 'legacy:live:vod:7');            // VOD: removed
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D5', 'clip', DANA, 'legacy:live:clip:9');          // clip: removed
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D6', 'thumbnail', DANA, 'legacy:live:thumb:7');    // thumbnail: marked deleted
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D7', 'screenshot', DANA, 'legacy:live:paste:abc'); // legacy screenshot object: deleted
    await obj.run('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D8', 'file', XENA, null);                          // someone else's
    await db.prepare("INSERT INTO media_holds (object_id, kind, reason) VALUES ('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D3', 'moderation', 'report under review') RETURNING id").run();
    const vodFile = path.join(tmp, 'vod7.mp4'); fs.writeFileSync(vodFile, 'x');
    const clipFile = path.join(tmp, 'clip9.mp4'); fs.writeFileSync(clipFile, 'y');
    await db.prepare("INSERT INTO vods (id, app_id, user_id, title, stream_key, storage_key, file_path, object_id) OVERRIDING SYSTEM VALUE VALUES (7, 'live', 20, 'my stream', 'sk_secret', 'b2/secret/key', ?, 'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D4') RETURNING id").run(vodFile);
    await db.prepare("INSERT INTO clips (id, app_id, user_id, vod_id, title, file_path, object_id) OVERRIDING SYSTEM VALUE VALUES (9, 'live', 20, 7, 'my clip', ?, 'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2D5') RETURNING id").run(clipFile);

    const ev = (type, payload) => ({ event_id: 'evt_01J8Z3Q4R5S6T7V8W9X0Y1Z2E1', event_type: type, version: 1, source: 'network', visibility: 'internal', timestamp: new Date().toISOString(), payload });

    (async () => {
        const sent = [];
        let failNext = false;
        const send = async (p, body) => { if (failNext) { failNext = false; return { ok: false, status: 503 }; } sent.push({ path: p, body }); return { ok: true, status: 200 }; };
        try {
            assert.ok(require('../server/revocations').TOPICS.includes('network.account.deleted'), 'Media subscribes');
            // ── Export ──
            const exp = ev('network.account.export_requested', { export_id: 'exp_01J8Z3Q4R5S6T7V8W9X0Y1Z2F1', subject: DANA, requested_at: new Date().toISOString(), deadline: new Date(Date.now() + 1800000).toISOString() });
            assert.strictEqual(await accountData.apply({ ...exp, source: 'live' }, { send }), 'ignored:source');
            assert.strictEqual(await accountData.apply(exp, { send }), 'exported');
            const part = sent[0].body;
            assert.ok(validate('network.account-export-part@1', part).valid, JSON.stringify(validate('network.account-export-part@1', part).errors));
            const files = Object.fromEntries(part.files.map((f) => [f.name, f.content]));
            assert.strictEqual(files['objects.json'].length, 6, "the subject's own objects only");
            assert.deepStrictEqual(files['vods.json'].map((v) => v.title), ['my stream']);
            assert.ok(!JSON.stringify(part).includes('sk_secret') && !JSON.stringify(part).includes('b2/secret/key'), 'no stream or storage keys');
            assert.strictEqual(await accountData.apply(exp, { send }), 'unchanged');
            assert.strictEqual(sent.length, 1);

            // ── Deletion ──
            const del = ev('network.account.deleted', { deletion_id: 'del_01J8Z3Q4R5S6T7V8W9X0Y1Z2G1', subject: DANA, aliases: [OLD], requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() });
            failNext = true;
            await assert.rejects(accountData.apply(del, { send }), /confirmation refused: 503/);
            const state = Object.fromEntries((await db.prepare('SELECT id, lifecycle_status AS s FROM media_objects').all()).map((r) => [r.id.slice(-2), r.s]));
            assert.deepStrictEqual(state, { D1: 'deleted', D2: 'deleted', D3: 'ready', D4: 'deleted', D5: 'deleted', D6: 'deleted', D7: 'deleted', D8: 'ready' });
            assert.ok(!fs.existsSync(vodFile) && !fs.existsSync(clipFile), 'the bytes are gone');
            assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM vods').get()).n + (await db.prepare('SELECT COUNT(*) AS n FROM clips').get()).n, 0);
            assert.strictEqual(await accountData.apply(del, { send }), 'confirmed', 'the retry confirms without erasing again');
            const conf = sent[1];
            assert.strictEqual(conf.path, '/internal/account-deletions/del_01J8Z3Q4R5S6T7V8W9X0Y1Z2G1/confirmations');
            assert.ok(validate('network.account-deletion-confirmation@1', conf.body).valid, JSON.stringify(validate('network.account-deletion-confirmation@1', conf.body).errors));
            assert.deepStrictEqual(conf.body.erased, { objects: 3, vods: 1, clips: 1, thumbnails: 1 });
            assert.deepStrictEqual(conf.body.retained, { held_media: 1 });
            assert.strictEqual(await accountData.apply(del, { send }), 'unchanged');
            assert.strictEqual(sent.length, 2);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
        console.log('media account export and deletion: all checks passed');
    })().catch((e) => { console.error(e); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
