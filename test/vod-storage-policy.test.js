'use strict';

// Regression tests for the VOD offload policy in server/vod/vod-storage.js.
//
// Background (2026-08-29): the disk sat at 96% for weeks while the sweep logged
// "draining" every 15 minutes and never uploaded a byte, because ~350 VOD rows with
// no file matched the candidate query and filled its LIMIT ahead of the real
// recordings. These tests pin the pieces that prevent a repeat: candidate
// selection, the free-space budget, the re-run cadence, and the upload deadline.

const assert = require('assert');

(async () => {
    process.env.MEDIA_B2_ENDPOINT = process.env.MEDIA_B2_ENDPOINT || '';
    const storage = require('../server/vod/vod-storage');
    // The revisioned tier policies load once the database is open (server/index.js does this at boot).
    await storage.tierConfig.init(storage.DEFAULTS);
    await require('../server/objects/tier-policy').init();
    const { DEFAULTS, OFFLOADABLE_WHERE, needsDrain, drainSatisfied, isCritical, planNextDelayMs, uploadTimeoutMs } = storage;

    const GB = 1024 * 1024 * 1024;
    const disk = (usePct, freeGb, totalGb = 96) => ({ total: totalGb * GB, used: (totalGb - freeGb) * GB, available: freeGb * GB, usePct, mount: '/' });

    // ── Candidate selection: only rows with a real, non-quarantined local file ──
    // A database of its own with just the columns the rule reads (PGlite).
    const db = require('openvibe-sdk/db').createDb({ pglite: true, service: 'policy-test' });
    await db.exec(`CREATE TABLE vods (
        id bigint PRIMARY KEY, file_path text, file_size bigint, storage_provider text,
        is_recording bigint, health_status text, view_count bigint, last_accessed_at text,
        created_at text DEFAULT to_char((now() AT TIME ZONE 'UTC') - interval '2 days', 'YYYY-MM-DD HH24:MI:SS')
    )`);
    const ins = db.prepare('INSERT INTO vods (id, file_path, file_size, storage_provider, is_recording, health_status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id');
    await ins.run(1, '/data/vods/real-a.mp4', 15 * GB, 'local', 0, 'ok');          // real recording
    await ins.run(2, '/data/vods/real-b.webm', 2 * GB, null, 0, null);              // real, provider/health NULL (legacy rows)
    await ins.run(3, null, 0, 'local', 0, null);                                    // ghost: never got a file
    await ins.run(4, '/opt/hobostreamer/data/vods/old.webm', 0, 'local', 0, 'missing_file'); // quarantined legacy path
    await ins.run(5, '/data/vods/zero.webm', 0, 'local', 0, 'zero_byte');           // quarantined zero-byte
    await ins.run(6, '/data/vods/live.mp4', 1 * GB, 'local', 1, 'ok');              // still recording
    await ins.run(7, '/data/vods/cold.mp4', 8 * GB, 'b2', 0, 'ok');                 // already offloaded

    const picked = (await db.prepare(`SELECT id FROM vods WHERE ${OFFLOADABLE_WHERE} ORDER BY id`).all()).map(r => r.id);
    assert.deepStrictEqual(picked, [1, 2], `only real local finished files are offload candidates, got ${picked}`);
    console.log('✅ ghost / quarantined / recording / offloaded rows are never offload candidates');

    // ── Free-space budget: percent OR GB floor triggers, both must be satisfied to stop ──
    assert.strictEqual(needsDrain(disk(96, 4), DEFAULTS), true, '96% full must drain');
    assert.strictEqual(needsDrain(disk(50, 48), DEFAULTS), false, 'half-empty disk is fine');
    assert.strictEqual(needsDrain(disk(65, 20), DEFAULTS), true, 'below the percent ceiling but under the GB floor still drains');
    assert.strictEqual(needsDrain(disk(75, 400, 1600), DEFAULTS), true, 'percent ceiling applies even with lots of absolute space');
    assert.strictEqual(needsDrain({ total: 0, available: 0, usePct: 0 }, DEFAULTS), false, 'unknown disk never drains');

    assert.strictEqual(drainSatisfied(disk(60, 38), DEFAULTS), false, 'at the percent low-water but under the GB target keeps draining');
    assert.strictEqual(drainSatisfied(disk(55, 43), DEFAULTS), true, 'both targets met stops the drain');
    assert.strictEqual(drainSatisfied(disk(70, 500, 1600), DEFAULTS), false, 'above the percent low-water keeps draining on big disks');

    assert.strictEqual(isCritical(disk(90, 9), DEFAULTS), true);
    assert.strictEqual(isCritical(disk(89, 10), DEFAULTS), false);
    console.log('✅ free-space budget: percent ceiling OR GB floor start a drain; both targets end it');

    // ── Cadence: come back quickly while a drain is making (or could make) progress ──
    assert.strictEqual(planNextDelayMs({ stillNeedsDrain: true, migrated: 3 }, DEFAULTS), DEFAULTS.pressureRetryMs, 'progress under pressure → soon');
    assert.strictEqual(planNextDelayMs({ stillNeedsDrain: true, migrated: 0, skippedBackoff: 2 }, DEFAULTS), DEFAULTS.pressureRetryMs, 'candidates in back-off → soon');
    assert.strictEqual(planNextDelayMs({ stillNeedsDrain: true, migrated: 0, errors: [{ id: 1 }] }, DEFAULTS), DEFAULTS.pressureRetryMs, 'failed uploads → retry soon');
    assert.strictEqual(planNextDelayMs({ stillNeedsDrain: true, migrated: 0 }, DEFAULTS), DEFAULTS.sweepIntervalMs, 'nothing eligible → no point hammering');
    assert.strictEqual(planNextDelayMs({ stillNeedsDrain: false, migrated: 5 }, DEFAULTS), DEFAULTS.sweepIntervalMs, 'drain satisfied → regular interval');
    assert.strictEqual(planNextDelayMs(null, DEFAULTS), DEFAULTS.sweepIntervalMs, 'skipped/failed sweep → regular interval');
    assert.ok(DEFAULTS.pressureRetryMs < DEFAULTS.sweepIntervalMs);
    console.log('✅ sweep re-runs within minutes while a drain is still needed');

    // ── Upload deadline scales with size so a hung 15 GB multipart cannot hold the sweep forever ──
    const t100mb = uploadTimeoutMs(100 * 1024 * 1024, DEFAULTS);
    const t15gb = uploadTimeoutMs(15 * GB, DEFAULTS);
    assert.ok(t100mb >= DEFAULTS.uploadTimeoutFloorMs && t100mb < DEFAULTS.uploadTimeoutFloorMs + 2 * 60 * 1000, 'small file ≈ floor');
    assert.ok(t15gb > 2 * 60 * 60 * 1000 && t15gb < 4 * 60 * 60 * 1000, `15 GB at 2 MB/s ≈ 2–3 h, got ${Math.round(t15gb / 60000)} min`);
    console.log('✅ upload deadline = floor + size / minimum throughput');

    // ── Status surface exists for dashboards / health checks ──
    assert.ok(typeof storage.getStatus === 'function');
    console.log('✅ policy helpers exported for status reporting');

    console.log('\n✅ All VOD storage policy tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
