'use strict';
// The storage-tier policy as revisioned configuration (WS-C task 7; server/vod/tier-config.js on
// openvibe-shared/config): revision 1 is what media_settings held, PUT /tiers/settings is one validated
// revision (the rules across thresholds included; a refused change changes nothing), media_settings mirrors
// the active revision for older releases, the admin config routes list, show history and roll back, and
// a policy change never reads the database per setting.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-tiercfg-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
});

(async () => {
    const db = require('../server/db/database');
    db.upsertApp({ app_id: 'live', api_key: 'live-key-tiercfg' });
    // An operator had overridden one threshold before this release.
    db.run("INSERT INTO media_settings (key, value) VALUES ('storage_tier.minAgeDays', '10')");
    const storage = require('../server/vod/vod-storage');
    const row = (k) => { const r = db.get('SELECT value FROM media_settings WHERE key = ?', [`storage_tier.${k}`]); return r ? JSON.parse(r.value) : undefined; };

    // ── Revision 1: exactly what media_settings held ──
    assert.strictEqual(storage.getSettings().minAgeDays, 10, 'the override carries over');
    assert.strictEqual(storage.getSettings().maxViewsForCold, storage.DEFAULTS.maxViewsForCold, 'everything else is its default');
    const cfg = storage.tierConfig.get(storage.DEFAULTS);
    assert.strictEqual(cfg.revision(), 1);
    assert.deepStrictEqual(cfg.snapshot(1).values, { minAgeDays: 10 });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/admin/storage', require('../server/admin/routes'));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = async (method, p, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { authorization: 'Bearer live-key-tiercfg', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };

    // ── PUT /tiers/settings: one validated revision, merged, recorded with the app and the reason ──
    let r = await call('PUT', '/api/v1/live/admin/storage/tiers/settings', { r2MinViews: '30', r2Enabled: 'false', reason: 'fewer promotions' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.revision, 2);
    assert.deepStrictEqual([r.body.settings.r2MinViews, r.body.settings.r2Enabled, r.body.settings.minAgeDays], [30, false, 10], 'coerced, and merged over the active revision');
    assert.deepStrictEqual([row('r2MinViews'), row('r2Enabled'), row('minAgeDays'), row('maxViewsForCold')], [30, false, 10, undefined], 'media_settings mirrors the revision (defaults stay rowless)');

    // A change that breaks a rule across thresholds is refused whole, and nothing changes.
    r = await call('PUT', '/api/v1/live/admin/storage/tiers/settings', { localLowWaterPct: 80, r2MinViews: 40 });
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'config.invalid');
    assert.ok(JSON.stringify(r.body.errors).includes('localLowWaterPct must be below hotDiskPressurePct'), JSON.stringify(r.body.errors));
    assert.deepStrictEqual([cfg.revision(), storage.getSettings().r2MinViews, row('r2MinViews')], [2, 30, 30]);
    r = await call('PUT', '/api/v1/live/admin/storage/tiers/settings', { hotDiskPressurePct: 150 });
    assert.strictEqual(r.status, 422, 'a percentage above 100');
    r = await call('PUT', '/api/v1/live/admin/storage/tiers/settings', {});
    assert.strictEqual(r.status, 400, 'nothing to change');

    // The policy endpoint says where each threshold comes from.
    r = await call('GET', '/api/v1/live/admin/storage/tiers/policy');
    assert.deepStrictEqual(r.body.r2.thresholds.r2MinViews, { value: 30, default: storage.DEFAULTS.r2MinViews, source: 'setting' });
    assert.strictEqual(r.body.r2.thresholds.r2MaxIdleDays.source, 'default');

    // ── The configuration model's routes: list, history, rollback ──
    r = await call('GET', '/api/v1/live/admin/storage/config');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const ns = r.body.namespaces.find((n) => n.namespace === 'media.storage_tier');
    assert.deepStrictEqual([ns.revision, ns.last_known_good && ns.last_known_good.revision], [2, 2]);
    r = await call('GET', '/api/v1/live/admin/storage/config/media.storage_tier/history');
    assert.deepStrictEqual(r.body.snapshots.map((x) => [x.revision, x.state]), [[2, 'active'], [1, 'superseded']]);
    assert.deepStrictEqual(r.body.snapshots[0].created_by, { type: 'service', id: 'live' });
    assert.strictEqual(r.body.snapshots[0].reason, 'fewer promotions');
    r = await call('POST', '/api/v1/live/admin/storage/config/media.storage_tier/rollback', { reason: 'back to what it was' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.revision, 3);
    assert.deepStrictEqual([storage.getSettings().r2MinViews, storage.getSettings().r2Enabled, storage.getSettings().minAgeDays], [storage.DEFAULTS.r2MinViews, true, 10], 'revision 1 again, as a new revision');
    assert.deepStrictEqual([row('r2MinViews'), row('r2Enabled'), row('minAgeDays')], [undefined, undefined, 10], 'and media_settings with it');
    assert.strictEqual((await call('GET', '/api/v1/live/admin/storage/config/other.namespace')).status, 404);

    // ── A restart reads the same active revision ──
    storage.tierConfig._reset();
    assert.deepStrictEqual([storage.tierConfig.get(storage.DEFAULTS).revision(), storage.getSettings().minAgeDays], [3, 10]);

    server.close();
    console.log('tier config: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
