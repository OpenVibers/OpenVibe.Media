'use strict';
// Operator retirement of a no-good-copy object (scripts/no-good-copy-report.js --retire): the dry run prints and
// changes nothing; a stub is soft-deleted (retention metadata, restorable, media.object.deleted staged) with its v1
// VOD row hidden, and the readiness count (the same count /api/ready's object_copies check reads) goes to 0; public
// objects, objects with a good copy, objects of 1 MiB or more and held objects are refused with the reason.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-retire-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    const env = {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
        MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'http://127.0.0.1:9',
    };
    for (const k of ['MEDIA_B2_ENDPOINT', 'MEDIA_B2_BUCKET', 'MEDIA_R2_ENDPOINT', 'MEDIA_R2_BUCKET', 'EVENTS_URL', 'MEDIA_VERIFY_ENABLED']) process.env[k] = '';
    Object.assign(process.env, env);

    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const copyReport = require('../server/objects/copy-report');
    const verifyJob = require('../server/objects/verify-job');
    const vodStorage = require('../server/vod/vod-storage');
    const { runScript } = require('./helpers/run-script');
    await vodStorage.tierConfig.init(vodStorage.DEFAULTS);
    await require('../server/objects/tier-policy').init();
    const d = db.getDb();
    const MB = 1024 * 1024;

    let nextVod = 6027;
    const insertVod = d.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, duration_seconds, visibility, is_public, storage_provider, clips_only, is_recording, created_at)
        OVERRIDING SYSTEM VALUE VALUES (?, 'live', 5, ?, ?, ?, 1, ?, ?, 'local', 0, 0, '2026-11-01 00:00:00') RETURNING id`);
    /** A VOD row projected onto its object; the file exists only when `bytes` is written. */
    async function vod({ title = 'V', size = 8855, visibility = null, isPublic = 0, bytes = null }) {
        const id = nextVod++;
        const p = path.join(env.VOD_PATH, `vod-${id}.webm`);
        if (bytes != null) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 7)); }
        await insertVod.run(id, title, p, size, visibility, isPublic);
        await model.syncVod(id);
        const objectId = (await d.prepare('SELECT object_id FROM vods WHERE id = ?').get(id)).object_id;
        return { id, objectId, obj: await model.getObject(objectId) };
    }

    const script = path.join(__dirname, '..', 'scripts', 'no-good-copy-report.js');
    const run = async (a) => await runScript(script, a, { env });
    const state = async (v) => { const o = await model.getObject(v.objectId); return [o.lifecycle_status, o.visibility, o.deleted_at || null]; };

    // ── The stub (the report's shape): a 1-second, 8.6 KB recording whose only copy is gone, never public ──
    const stub = await vod({ title: 'recording stub' });
    assert.strictEqual(stub.obj.visibility, 'private');
    assert.strictEqual(await copyReport.countNoGoodCopy(db), 1);
    assert.strictEqual((await verifyJob.status()).no_good_copy, 1);

    // ── Dry run ──
    const dry = await run(['--retire', stub.objectId]);
    assert.strictEqual(dry.code, 0, dry.err);
    assert.match(dry.out, /soft delete/);
    assert.match(dry.out, /vods#6027 \(visibility private, is_public 0\)/);
    assert.match(dry.out, /dry run: nothing was changed/);
    assert.deepStrictEqual(await state(stub), ['ready', 'private', null]);
    console.log('✅ the dry run prints what it would do and writes nothing');

    // ── Apply: the stub is soft-deleted, its v1 row hidden, the readiness count is 0 ──
    const applied = await run(['--retire', stub.objectId, '--apply']);
    assert.strictEqual(applied.code, 0, applied.err);
    const gone = await model.getObject(stub.objectId);
    assert.strictEqual(gone.lifecycle_status, 'deleted');
    assert.ok(gone.deleted_at, 'deleted_at is set');
    const md = model.parseJson(gone.metadata, {});
    assert.ok(Date.parse(md.retention_until) > Date.now(), `retention_until is in the future (${md.retention_until})`);
    const row = await d.prepare('SELECT visibility, is_public FROM vods WHERE id = 6027').get();
    assert.deepStrictEqual([row.visibility, Number(row.is_public)], ['private', 0], 'the v1 VOD row is hidden');
    const change = await d.prepare("SELECT change FROM media_object_changes WHERE object_id = ? ORDER BY id DESC LIMIT 1").get(stub.objectId);
    assert.strictEqual(change && change.change, 'deleted', 'media.object.deleted is staged for the object');
    assert.strictEqual(await copyReport.countNoGoodCopy(db), 0, 'the readiness object_copies count is 0');
    assert.strictEqual((await verifyJob.status()).no_good_copy, 0);
    console.log('✅ retires the stub: soft delete, retention, hidden v1 row, media.object.deleted, readiness count 0');

    // ── Refusals: nothing is changed, the reason says why ──
    const good = await vod({ title: 'good', size: 100, bytes: 100 });
    const publicVod = await vod({ title: 'public', visibility: 'public', isPublic: 1 });
    const big = await vod({ title: 'big', size: MB });
    const held = await vod({ title: 'held' });
    await model.placeHold({ object_id: held.objectId, kind: 'admin', reason: 'test hold', created_by: 'test' });
    assert.strictEqual(await copyReport.countNoGoodCopy(db), 3, 'public, big and held; not the one with a good copy');
    for (const [v, reason] of [
        [publicVod, /it is public/],
        [good, /not in the no-good-copy report/],
        [big, /not under 1 MiB/],
        [held, /retention hold/],
    ]) {
        const before = await state(v);
        const r = await run(['--retire', v.objectId]);
        assert.strictEqual(r.code, 1, `${v.objectId} refused ${r.err || ''}`);
        assert.match(r.out, reason);
        assert.match(r.out, /Nothing was changed/);
        assert.deepStrictEqual(await state(v), before, 'a refused retirement writes nothing');
    }
    console.log('✅ refuses a public object, one with a good copy, one of 1 MiB and one under a hold, with the reason');

    // ── Restorable ──
    const back = await model.restore(await model.getObject(stub.objectId));
    assert.strictEqual(back.lifecycle_status, 'ready', 'a restore inside retention brings it back');
    assert.strictEqual(await copyReport.countNoGoodCopy(db), 4, 'and it is a no-good-copy object again');
    console.log('✅ restorable inside the retention period');

    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('retire-no-good-copy: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
