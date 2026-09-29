'use strict';
// Cost tiers (F1, part 5): the revisioned config namespace media.cost_tiers and its validation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const dir = (n) => { const d = path.join(os.tmpdir(), `ov-media-cost-${n}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`); fs.mkdirSync(d, { recursive: true }); return d; };
    for (const k of ['VOD_PATH', 'CLIPS_PATH', 'PASTES_PATH', 'THUMBNAILS_PATH', 'FILES_PATH', 'OBJECTS_PATH', 'ASSETS_PATH']) process.env[k] = dir(k);

    // Use a per-test PGlite (the same harness the test runner gives every file).
    const tmpPglite = dir('pglite');
    process.env.MEDIA_PGLITE_DIR = tmpPglite;
    process.env.DATABASE_URL = '';
    const db = require('../server/db/database');
    await db.initDb();
    const cost = require('../server/placement/cost-tiers');

    // Cross-key rule: the defaults pass.
    const good = JSON.parse(JSON.stringify(cost.DEFAULTS));
    assert.deepStrictEqual(cost.validate(good), true, 'defaults validate');

    // Cross-key rule fires when standard is below IA (IA is cheaper).
    const bad = JSON.parse(JSON.stringify(cost.DEFAULTS));
    bad.r2.standard.storagePerGbMonth = 0.005;
    let errs = cost.validate(bad);
    assert.ok(Array.isArray(errs) && errs.length, 'cross-key rule fires when standard < IA');

    // Boot the store and read the defaults: match the design exactly.
    await cost.init({ log: { info() {}, warn() {}, error() {} } });
    const settings = cost.settings();
    assert.strictEqual(settings.r2.standard.storagePerGbMonth, 0.015, 'R2 Standard price matches docs/media-fabric.md §2');
    assert.strictEqual(settings.r2.standard.egressPerGb, 0, 'R2 Standard egress is free');
    assert.strictEqual(settings.r2.infrequentAccess.storagePerGbMonth, 0.01, 'R2 IA price matches design');
    assert.strictEqual(settings.r2.infrequentAccess.minResidencyDays, 30, 'R2 IA 30-day minimum');
    assert.strictEqual(settings.b2.egressFreeMultiplier, 3, 'B2 3x free egress multiplier');
    assert.strictEqual(settings.b2.partnerEgressFree, false, 'B2 partnerEgressFree default is false (safer)');
    assert.strictEqual(settings.b2.storagePerGbMonth, 0.00695, 'B2 storage $6.95/TB-month');
    assert.strictEqual(settings.local.storagePerGbMonth, 0, 'local is $0/GB');

    // estimateCloudCosts reads from this config: it produces a positive total.
    const vodStorage = require('../server/vod/vod-storage');
    const costs = vodStorage.estimateCloudCosts({ b2: { configured: true, bytes: 50e9, objects: 1 }, r2: { configured: true, bytes: 500e9, objects: 5 } });
    assert.strictEqual(costs.pricing.b2.egressPerGb, 0.01, 'B2 egress from cost-tiers');
    assert.strictEqual(costs.pricing.r2.egressPerGb, 0, 'R2 egress from cost-tiers (free)');
    assert.ok(costs.totalStorageMonthly > 0, 'estimate produces a positive total');

    // Apply a revision: pass a full values object so the merged shape validates.
    const full = JSON.parse(JSON.stringify(cost.DEFAULTS));
    full.r2.standard.storagePerGbMonth = 0.02;
    const newRev = await cost.get().apply(full, { actor: { type: 'service', id: 'media-test' }, reason: 'price update' });
    assert.ok(newRev && (newRev.revision || newRev.values), 'apply returned a revision');
    assert.strictEqual(cost.settings().r2.standard.storagePerGbMonth, 0.02, 'new revision applied');

    cost._reset();
    console.log('placement-cost-tiers: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });