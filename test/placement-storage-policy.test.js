'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const dir = (name) => { const d = path.join(os.tmpdir(), `ov-media-policy-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`); fs.mkdirSync(d, { recursive: true }); return d; };
    for (const key of ['VOD_PATH', 'CLIPS_PATH', 'PASTES_PATH', 'THUMBNAILS_PATH', 'FILES_PATH', 'OBJECTS_PATH', 'ASSETS_PATH']) process.env[key] = dir(key);
    process.env.MEDIA_PGLITE_DIR = dir('pglite');
    process.env.DATABASE_URL = '';

    const db = require('../server/db/database');
    await db.initDb();
    const policy = require('../server/placement/storage-policy');
    await policy.init();

    assert.strictEqual(policy.get().revision(), 1);
    for (const name of policy.CLASSES) {
        assert.deepStrictEqual(policy.DEFAULTS.classes[name], {
            maxPromotionsPerSweep: 3, maxDemotionsPerSweep: 10, minResidencyMs: 0,
        });
        assert.deepStrictEqual(policy.budgetFor(name), { maxPromotionsPerSweep: 3, maxDemotionsPerSweep: 10 });
    }
    assert.strictEqual(policy.mayMove({ class: 'video', lastMovedAt: 1000, now: 1000 }), true, 'zero residency is off');
    assert.throws(() => policy.budgetFor('unknown'), RangeError);
    const cls = (kind, mime_type) => policy.classOf({ kind, mime_type });
    assert.deepStrictEqual([cls('vod'), cls('clip'), cls('file', 'audio/mpeg'), cls('file', 'Video/MP4'), cls('asset', 'video/webm')], Array(5).fill('video'));
    assert.deepStrictEqual([cls('thumbnail'), cls('screenshot'), cls('avatar'), cls('file', 'image/png')], Array(4).fill('image'));
    assert.deepStrictEqual([cls('file', 'application/zip'), cls('file'), cls('asset', null), policy.classOf(null)], Array(4).fill('download'));

    await policy.set({ classes: { image: { maxPromotionsPerSweep: 2, maxDemotionsPerSweep: 4, minResidencyMs: 60_000 } } },
        { actor: { type: 'service', id: 'media-test' }, reason: 'test image placement policy' });
    assert.strictEqual(policy.get().revision(), 2, 'set creates a new revision');
    assert.deepStrictEqual(policy.budgetFor('image'), { maxPromotionsPerSweep: 2, maxDemotionsPerSweep: 4 });
    assert.deepStrictEqual(policy.budgetFor('video'), { maxPromotionsPerSweep: 3, maxDemotionsPerSweep: 10 }, 'other classes keep defaults');
    assert.strictEqual(policy.mayMove({ class: 'image', lastMovedAt: 1000, now: 60_999 }), false);
    assert.strictEqual(policy.mayMove({ class: 'image', lastMovedAt: 1000, now: 61_000 }), true, 'boundary is inclusive');
    assert.strictEqual(policy.mayMove({ class: 'image', lastMovedAt: null, now: 1000 }), true, 'first move has no residency');
    assert.strictEqual(policy.mayMove({ class: 'image', lastMovedAt: 'invalid', now: 61_000 }), false);
    assert.strictEqual(policy.mayMove({ class: 'image', lastMovedAt: '2026-10-02 00:00:00', now: '2026-10-02T00:01:00Z' }), true);

    await policy.set({ classes: { video: { maxPromotionsPerSweep: 1 } } },
        { actor: { type: 'service', id: 'media-test' }, reason: 'test a second partial update' });
    assert.strictEqual(policy.get().revision(), 3);
    assert.deepStrictEqual(policy.budgetFor('image'), { maxPromotionsPerSweep: 2, maxDemotionsPerSweep: 4 }, 'second revision preserves image settings');
    assert.deepStrictEqual(policy.budgetFor('video'), { maxPromotionsPerSweep: 1, maxDemotionsPerSweep: 10 });

    policy._reset();
    console.log('placement-storage-policy: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
