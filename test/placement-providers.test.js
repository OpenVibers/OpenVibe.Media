'use strict';
// Provider registry (F1, part 1): declared classes, capability snapshot, eligibility. The actual
// network probe is exercised in the boot path (server/index.js calls probeAll()), which a real
// boot of the server covers; here we verify the in-memory contract.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-plprov-'));
    Object.assign(process.env, {
        VOD_PATH: path.join(tmp, 'vods'), CLIPS_PATH: path.join(tmp, 'clips'), PASTES_PATH: path.join(tmp, 'pastes'),
        THUMBNAILS_PATH: path.join(tmp, 'thumbnails'), FILES_PATH: path.join(tmp, 'files'), OBJECTS_PATH: path.join(tmp, 'objects'),
        ASSETS_PATH: path.join(tmp, 'assets'), MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'http://127.0.0.1:9',
        RELEASE_COMMIT: 'abcdef1234567',
    });
    for (const k of ['VOD_PATH', 'CLIPS_PATH', 'PASTES_PATH', 'THUMBNAILS_PATH', 'FILES_PATH', 'OBJECTS_PATH', 'ASSETS_PATH']) fs.mkdirSync(process.env[k], { recursive: true });
    for (const k of ['MEDIA_B2_ENDPOINT', 'MEDIA_B2_BUCKET', 'MEDIA_R2_ENDPOINT', 'MEDIA_R2_BUCKET', 'EVENTS_URL']) process.env[k] = '';

    const providers = require('../server/placement/providers');
    providers.reset();

    // Local is always regional-cache.
    assert.deepStrictEqual(providers.providerClasses('local'), ['regional-cache']);
    assert.deepStrictEqual(providers.eligibleClasses('local'), ['regional-cache']);

    // Capability requirements per class.
    assert.ok(providers.CLASS_REQUIREMENTS['online-canonical'].length > 0);
    assert.ok(providers.CLASS_REQUIREMENTS['online-hot'].length > 0);
    assert.deepStrictEqual(providers.CLASS_REQUIREMENTS['regional-cache'], []);

    // Capability snapshot before a probe: passed is null.
    const before = providers.capabilities('b2');
    assert.strictEqual(before.passed, null);
    assert.deepStrictEqual(before.capabilities, {});

    // Inject a known capability result.
    providers._setCapabilities && providers._setCapabilities('b2', { provider: 'b2', passed: true, capabilities: { range: true, range_206: true, etag: true, if_range: true }, lastChecked: Date.now(), lastError: null });
    providers._setCapabilities && providers._setCapabilities('r2', { provider: 'r2', passed: true, capabilities: { range: true, range_206: true }, lastChecked: Date.now(), lastError: null });

    // The classes are the design's assignment (docs/media-fabric.md §2): B2 canonical, R2 hot, local edge.
    assert.deepStrictEqual(providers.providerClasses('b2'), ['online-canonical']);
    assert.deepStrictEqual(providers.providerClasses('r2'), ['online-hot']);
    assert.ok(providers.eligibleClasses('b2').includes('online-canonical'), 'b2 canonical class enabled');
    assert.ok(providers.eligibleClasses('r2').includes('online-hot'), 'r2 hot class enabled');
    assert.ok(!providers.eligibleClasses('r2').includes('online-canonical'), 'r2 NOT in canonical class (hot only)');

    // Report mode (the default): a missing capability is recorded but takes nothing out of routing.
    providers._setCapabilities('b2', { provider: 'b2', passed: true, capabilities: { range: true, range_206: true, etag: false, if_range: false }, lastChecked: Date.now(), lastError: null });
    assert.strictEqual(providers.gateMode(), 'report');
    assert.deepStrictEqual(providers.eligibleClasses('b2'), ['online-canonical'], 'report mode: B2 keeps routing');
    assert.deepStrictEqual(providers.measuredClasses('b2'), [], 'report mode still shows what the probe found');
    // Enforce mode: a capability the class needs is missing → the provider leaves that class.
    process.env.MEDIA_CAPABILITY_GATE = 'enforce';
    assert.deepStrictEqual(providers.eligibleClasses('b2'), [], 'no if_range/etag → B2 leaves online-canonical');
    providers._setCapabilities('b2', { provider: 'b2', passed: true, capabilities: { range: true, range_206: true, etag: true, if_range: true }, lastChecked: Date.now(), lastError: null });
    assert.ok(providers.eligibleClasses('b2').includes('online-canonical'), 'passing again restores the class');

    // A probe that completed and found range broken removes the class; a probe that could not complete (no
    // snapshot yet) decides nothing: live health is the breaker's job.
    providers._setCapabilities('r2', { provider: 'r2', passed: true, capabilities: { range: false, range_206: false }, lastChecked: Date.now(), lastError: null });
    assert.deepStrictEqual(providers.eligibleClasses('r2'), [], 'failed capability removes all classes');
    providers._setCapabilities('r2', { provider: 'r2', passed: false, capabilities: {}, lastChecked: Date.now(), lastError: 'timeout' });
    assert.deepStrictEqual(providers.eligibleClasses('r2'), ['online-hot'], 'an incomplete probe removes nothing');
    delete process.env.MEDIA_CAPABILITY_GATE;

    // The placement gate (F2.6) holds whatever the read gate's mode: a completed probe that found a capability the
    // class needs missing, or an open breaker, refuses a move; a probe not run or not completed decides nothing.
    const signals = require('../server/placement/signals');
    const gate = (name, cls) => { const g = providers.placementGate(name, cls); return [g.eligible, g.probe, g.breaker]; };
    assert.deepStrictEqual(gate('r2', 'online-hot'), [true, 'incomplete', 'closed'], 'an incomplete probe does not block placement');
    providers._setCapabilities('r2', { provider: 'r2', passed: true, capabilities: { range: true, range_206: false }, lastChecked: Date.now(), lastError: null });
    assert.deepStrictEqual(providers.placementGate('r2', 'online-hot'), { provider: 'r2', class: 'online-hot', eligible: false, breaker: 'closed', probe: 'failed',
        missing: ['range_206'], reason: 'r2 is not eligible for online-hot: the capability probe found range_206 missing' });
    providers._setCapabilities('r2', { provider: 'r2', passed: true, capabilities: { range: true, range_206: true }, lastChecked: Date.now(), lastError: null });
    assert.deepStrictEqual(gate('r2', 'online-hot'), [true, 'passed', 'closed']);
    signals.openBreaker('r2');
    assert.deepStrictEqual([...gate('r2', 'online-hot'), providers.placementGate('r2', 'online-hot').reason], [false, 'passed', 'open', 'r2 is not eligible for online-hot: its circuit breaker is open']);
    signals.closeBreaker('r2');
    assert.strictEqual(providers.placementGate('r2', 'online-canonical').eligible, false, 'a class the provider does not declare');
    assert.deepStrictEqual(gate('local', 'regional-cache'), [true, 'passed', 'closed'], 'the local disk is always eligible as the regional cache');

    // isConfigured: false when env is empty, true for local.
    assert.strictEqual(providers.isConfigured('local'), true);
    assert.strictEqual(providers.isConfigured('b2'), false);
    assert.strictEqual(providers.isConfigured('r2'), false);

    providers.reset();
    console.log('placement-providers: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });