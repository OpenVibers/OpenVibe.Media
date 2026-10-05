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
    const bands = { image: [300, 30], download: [30, 3] };
    for (const name of policy.CLASSES) {
        const [promoteReadsPerHour, demoteReadsPerHour] = bands[name] || [60, 6];
        assert.deepStrictEqual(policy.DEFAULTS.classes[name], {
            maxPromotionsPerSweep: 3, maxDemotionsPerSweep: 10, minResidencyMs: 0, promoteReadsPerHour, demoteReadsPerHour,
        });
        assert.deepStrictEqual(policy.budgetFor(name), { maxPromotionsPerSweep: 3, maxDemotionsPerSweep: 10 });
        assert.deepStrictEqual(policy.bandFor(name), { promoteReadsPerHour, demoteReadsPerHour });
        assert.ok(demoteReadsPerHour < promoteReadsPerHour, `${name}: hysteresis`);
    }
    assert.strictEqual(policy.mayMove({ class: 'video', lastMovedAt: 1000, now: 1000 }), true, 'zero residency is off');
    assert.throws(() => policy.budgetFor('unknown'), RangeError);
    const cls = (kind, mime_type, metadata) => policy.classOf({ kind, mime_type, metadata });
    assert.deepStrictEqual([cls('vod'), cls('clip'), cls('file', 'audio/mpeg'), cls('file', 'Video/MP4'), cls('asset', 'video/webm')], Array(5).fill('video'));
    assert.deepStrictEqual([cls('thumbnail'), cls('screenshot'), cls('avatar'), cls('file', 'image/png')], Array(4).fill('image'));
    assert.deepStrictEqual([cls('file', 'application/zip'), cls('file'), cls('asset', null), policy.classOf(null)], Array(4).fill('download'));

    // Every class acts: an app declares its object's role in the object's metadata (class, or the explicit
    // media_class / placement_class). A declaration is honoured only when kind and mime type would say
    // download, and only for game-asset / attachment / backup: content alone decides video and image.
    assert.deepStrictEqual([
        cls('file', 'application/zip', { class: 'attachment' }),
        cls('file', null, { class: 'backup' }),
        cls('asset', null, { media_class: 'game-asset' }),
        cls('file', 'video/mp4', { placement_class: 'game-asset' }),
        cls('file', 'application/octet-stream', { class: 'Video' }),
    ], ['attachment', 'backup', 'game-asset', 'video', 'download']);
    assert.strictEqual(policy.classOf({ kind: 'file', metadata: JSON.stringify({ class: 'backup' }) }), 'backup', 'metadata read as its JSON text too');
    assert.deepStrictEqual([cls('file', 'application/zip', { class: 'nope' }), cls('file', null, { class: 7 }),
        cls('file', null, 'not json metadata'), cls('file', null, { class: ['attachment'] })], Array(4).fill('download'),
    'an unknown, non-string or unreadable declaration is ignored and kind/mime decide');
    // Class escape: a declaration can never override content, so one app cannot bill a large video (or an
    // image) to another class's global budget, hysteresis band or R2 ceiling.
    assert.strictEqual(cls('file', 'video/mp4', { class: 'backup' }), 'video', 'a declared backup does not steal video');
    assert.strictEqual(cls('vod', null, { class: 'attachment' }), 'video', 'a VOD kind stays video');
    assert.strictEqual(cls('file', 'image/png', { placement_class: 'attachment' }), 'image', 'an image stays image');
    assert.strictEqual(cls('thumbnail', null, { media_class: 'game-asset' }), 'image', 'a thumbnail stays image');
    assert.strictEqual(cls('file', 'application/zip', { class: 'backup' }), 'backup', 'a download may be a backup');
    assert.strictEqual(cls('file', 'application/zip', { class: 'video' }), 'download', 'but never declared video');
    assert.strictEqual(cls('file', 'application/zip', { class: 'image' }), 'download', 'nor declared image');
    assert.deepStrictEqual([policy.budgetFor('attachment'), policy.hotCeilingFor('backup'), policy.bandFor('game-asset')],
        [{ maxPromotionsPerSweep: 3, maxDemotionsPerSweep: 10 }, null, { promoteReadsPerHour: 60, demoteReadsPerHour: 6 }],
        'the classes an app declares have their own policy like any other');

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

    // The hysteresis band: demote below promote, refused as a whole revision otherwise.
    await assert.rejects(policy.set({ classes: { video: { demoteReadsPerHour: 60 } } }, { reason: 'test: an empty band' }), /demoteReadsPerHour must be below promoteReadsPerHour/);
    assert.strictEqual(policy.get().revision(), 3, 'a refused band changes nothing');
    await policy.set({ classes: { video: { promoteReadsPerHour: 120, demoteReadsPerHour: 20 } } }, { reason: 'test: a wider video band' });
    assert.deepStrictEqual(policy.bandFor('video'), { promoteReadsPerHour: 120, demoteReadsPerHour: 20 });
    assert.deepStrictEqual(policy.budgetFor('video'), { maxPromotionsPerSweep: 1, maxDemotionsPerSweep: 10 }, 'the band keeps the budget');

    // The monthly R2 storage ceiling (F2.6): absent = none; a revision sets it per class.
    assert.strictEqual(policy.hotCeilingFor('video'), null, 'no ceiling by default');
    await policy.set({ classes: { video: { maxHotUsdPerMonth: 12.5 } } }, { reason: 'test: a video storage ceiling' });
    assert.deepStrictEqual([policy.hotCeilingFor('video'), policy.hotCeilingFor('image')], [12.5, null]);
    await assert.rejects(policy.set({ classes: { video: { maxHotUsdPerMonth: -1 } } }, { reason: 'test: a negative ceiling' }));
    assert.strictEqual(policy.hotCeilingFor('video'), 12.5, 'a refused ceiling changes nothing');

    policy._reset();
    console.log('placement-storage-policy: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
