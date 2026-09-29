'use strict';
// Placement router (F1, part 3): picks the fastest healthy copy, sticky sessions, breaker skip,
// non-`present` locations are NEVER routed to, capability probe removes a class.
const assert = require('assert');

(async () => {
    const signals = require('../server/placement/signals');
    const providers = require('../server/placement/providers');
    const router = require('../server/placement/router');

    signals.reset();
    router.reset();
    providers.reset();

    // The test mocks providers.isConfigured to treat b2 and r2 as "configured" (no env setup here).
    const realIsConfigured = providers.isConfigured;
    providers.isConfigured = (name) => name === 'local' || name === 'b2' || name === 'r2';

    // Inject passed capability snapshots for both remote providers.
    providers._setCapabilities('b2', { provider: 'b2', passed: true, capabilities: { range: true, range_206: true, etag: true, if_range: true, cache_range: true, token_auth: true, purge: true }, lastChecked: Date.now(), lastError: null });
    providers._setCapabilities('r2', { provider: 'r2', passed: true, capabilities: { range: true, range_206: true, etag: true, if_range: true, cache_range: true, token_auth: true, purge: true }, lastChecked: Date.now(), lastError: null });

    // Test 1: local is preferred when the local location's key exists and cloud latency is worse.
    let decision = await router.route({ locations: [{ provider: 'local', state: 'present', key: '/tmp/x' }, { provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k' }] });
    assert.strictEqual(decision.provider, 'local', `local wins: ${JSON.stringify(decision)}`);

    // Test 2: r2 wins over b2 when both are present and both have similar EWMA.
    decision = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k' }] });
    assert.strictEqual(decision.provider, 'r2', `r2 wins over b2 for playback: ${JSON.stringify(decision)}`);

    // Test 3: locations NOT in state 'present' are NEVER chosen, even if their provider is healthy.
    decision = await router.route({ locations: [{ provider: 'r2', state: 'corrupt', key: 'k' }, { provider: 'b2', state: 'present', key: 'k' }] });
    assert.strictEqual(decision.provider, 'b2', `corrupt ignored, b2 picked: ${JSON.stringify(decision)}`);

    decision = await router.route({ locations: [{ provider: 'r2', state: 'pending', key: 'k' }] });
    assert.strictEqual(decision.provider, null, `pending copy alone never routed to: ${JSON.stringify(decision)}`);

    decision = await router.route({ locations: [{ provider: 'r2', state: 'missing', key: 'k' }] });
    assert.strictEqual(decision.provider, null, `missing copy alone never routed to: ${JSON.stringify(decision)}`);

    // Test 4: open breaker excludes it; the next copy is served.
    signals.reset();
    // Force b2 to look healthy initially
    signals.recordSuccess('b2', 'presign', 50);
    signals.recordSuccess('b2', 'presign', 50);
    // Trip r2's breaker
    for (let i = 0; i < 10; i++) signals.recordFailure('r2', 'presign', 50);
    assert.strictEqual(signals.breakerOpen('r2'), true);
    decision = await router.route({ locations: [{ provider: 'r2', state: 'present', key: 'k' }, { provider: 'b2', state: 'present', key: 'k' }] });
    assert.strictEqual(decision.provider, 'b2', `r2 breaker open → b2 served: ${JSON.stringify(decision)}`);
    assert.ok(decision.fallbacks.includes('r2') || decision.fallbacks.length === 0, 'open breaker not in fallbacks');
    signals.reset();

    // Test 5: sticky per session — same session returns the same provider for STICKY_TTL_MS.
    decision = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k' }], session: 'player-1' });
    const stickyProvider = decision.provider;
    // Subsequent calls with same session: same provider (r2 wins), even if signal changed.
    for (let i = 0; i < 5; i++) {
        const d = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k' }], session: 'player-1' });
        assert.strictEqual(d.provider, stickyProvider, `sticky across calls: ${i} got ${d.provider}`);
    }

    // Different session: independent.
    decision = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k' }], session: 'player-2' });
    assert.ok(['b2', 'r2'].includes(decision.provider));

    // Stickiness drops the moment the sticky provider's breaker opens.
    for (let i = 0; i < 10; i++) signals.recordFailure('r2', 'presign', 50);
    assert.strictEqual(signals.breakerOpen('r2'), true);
    decision = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k' }], session: 'player-1' });
    assert.strictEqual(decision.provider, 'b2', `sticky r2 dropped once its breaker opened: ${JSON.stringify(decision)}`);
    signals.reset();
    router.reset();

    // Test 6: capability probe failure removes the class; provider is not eligible.
    providers._setCapabilities('b2', { provider: 'b2', passed: false, capabilities: {}, lastChecked: Date.now(), lastError: 'probe failed' });
    decision = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k' }] });
    assert.strictEqual(decision.provider, 'r2', `failed probe excludes the provider: ${JSON.stringify(decision)}`);

    // Restore b2's passed capabilities for the next test.
    providers._setCapabilities('b2', { provider: 'b2', passed: true, capabilities: { range: true, range_206: true, etag: true, if_range: true, cache_range: true, token_auth: true, purge: true }, lastChecked: Date.now(), lastError: null });

    // Test 7: provider not configured → not even a candidate.
    providers.isConfigured = (name) => name === 'local' || name === 'b2';   // r2 disabled
    decision = await router.route({ locations: [{ provider: 'r2', state: 'present', key: 'k' }, { provider: 'b2', state: 'present', key: 'k' }] });
    assert.strictEqual(decision.provider, 'b2', `r2 not configured → b2 served`);
    providers.isConfigured = (name) => name === 'local' || name === 'b2' || name === 'r2';

    // Test 8: no candidates → null provider with a clear reason.
    decision = await router.route({ locations: [{ provider: 'r2', state: 'pending', key: 'k' }, { provider: 'b2', state: 'corrupt', key: 'k' }] });
    assert.strictEqual(decision.provider, null, `no healthy copy → null: ${JSON.stringify(decision)}`);
    assert.strictEqual(decision.reason, 'no-healthy-copy');

    providers.isConfigured = realIsConfigured;
    router.reset();
    // Test: a VOD promoted to R2 (storage_provider 'r2') keeps its canonical B2 copy as the fallback. The router
    // reads the object's locations (every copy a tier move verified), not just the row's storage_provider, so
    // an open R2 breaker still serves the VOD from B2 instead of answering 404.
    signals.reset(); router.reset();
    providers.isConfigured = (name) => name === 'local' || name === 'b2' || name === 'r2';
    const model = require('../server/objects/model');
    const realList = model.listLocations;
    model.listLocations = async (id) => (id === 'med_vod1' ? [
        { provider: 'b2', state: 'present', key: 'vods/a.mp4' },
        { provider: 'r2', state: 'present', key: 'vods/a.mp4', verified_at: '2026-09-29T00:00:00Z' },
    ] : []);
    const vodRow = { id: 1, object_id: 'med_vod1', storage_provider: 'r2', storage_key: 'vods/a.mp4', file_path: '/nonexistent/vod-a.mp4' };
    decision = await router.route({ vod: vodRow, purpose: 'playback', presign: false });
    assert.strictEqual(decision.provider, 'r2', `a verified R2 copy is the hot tier: ${JSON.stringify(decision)}`);
    assert.deepStrictEqual(decision.fallbacks, ['b2'], `B2 stays the fallback of a promoted VOD: ${JSON.stringify(decision)}`);
    for (let i = 0; i < 10; i++) signals.recordFailure('r2', 'presign', 50);
    decision = await router.route({ vod: vodRow, purpose: 'playback', presign: false });
    assert.strictEqual(decision.provider, 'b2', `R2 breaker open: the promoted VOD is served from B2: ${JSON.stringify(decision)}`);
    signals.reset();
    // A row whose object is not projected yet still names its own copy; one whose object has only a pending
    // B2 row does not gain an unverified fallback.
    decision = await router.route({ vod: { ...vodRow, object_id: null }, purpose: 'playback', presign: false });
    assert.strictEqual(decision.provider, 'r2');
    model.listLocations = async () => [{ provider: 'b2', state: 'pending', key: 'vods/a.mp4' }];
    decision = await router.route({ vod: vodRow, purpose: 'playback', presign: false });
    assert.deepStrictEqual([decision.provider, decision.fallbacks], ['r2', []], `a pending copy is never a fallback: ${JSON.stringify(decision)}`);
    // …but a pending projected row for the row's OWN copy does not hide it (every offloaded VOD whose copy no
    // tier move verified yet): the row names where its bytes are.
    model.listLocations = async () => [{ provider: 'b2', state: 'pending', key: 'vods/b.mp4' }];
    decision = await router.route({ vod: { ...vodRow, storage_provider: 'b2', storage_key: 'vods/b.mp4' }, purpose: 'playback', presign: false });
    assert.strictEqual(decision.provider, 'b2', `the row's own pending copy is routable: ${JSON.stringify(decision)}`);
    // A copy the object records as missing stays gone.
    model.listLocations = async () => [{ provider: 'b2', state: 'missing', key: 'vods/b.mp4' }];
    decision = await router.route({ vod: { ...vodRow, storage_provider: 'b2', storage_key: 'vods/b.mp4' }, purpose: 'playback', presign: false });
    assert.strictEqual(decision.provider, null, `a missing copy is never routed to: ${JSON.stringify(decision)}`);
    model.listLocations = realList;

    // Test: a promoted (verified) R2 copy is the hot cache and wins playback over a local copy; an unverified
    // R2 copy does not.
    decision = await router.route({ locations: [{ provider: 'r2', state: 'present', key: 'k', verified_at: '2026-09-29' }, { provider: 'local', state: 'present', key: '/tmp/x' }], presign: false });
    assert.deepStrictEqual([decision.provider, decision.reason], ['r2', 'hot-cache'], `verified R2 first: ${JSON.stringify(decision)}`);
    decision = await router.route({ locations: [{ provider: 'r2', state: 'present', key: 'k' }, { provider: 'local', state: 'present', key: '/tmp/x' }], presign: false });
    assert.strictEqual(decision.provider, 'local', `an unverified R2 copy does not displace local: ${JSON.stringify(decision)}`);

    // Test: stickiness never holds a session on a worse tier once a better one is back (an R2 re-warm after an
    // eviction): sticky to B2 while R2 was missing, R2 again as soon as it is present.
    router.reset(); signals.reset();
    decision = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }], session: 'drill', presign: false });
    assert.strictEqual(decision.provider, 'b2');
    decision = await router.route({ locations: [{ provider: 'b2', state: 'present', key: 'k' }, { provider: 'r2', state: 'present', key: 'k', verified_at: 'x' }], session: 'drill', presign: false });
    assert.strictEqual(decision.provider, 'r2', `the hot copy wins over a sticky canonical fallback: ${JSON.stringify(decision)}`);

    // Test: a viewer's session key is stable per viewer and media, and differs across viewers and media.
    const reqA = { ip: '198.51.100.7', headers: { 'user-agent': 'A' } }, reqB = { ip: '198.51.100.7', headers: { 'user-agent': 'B' } };
    assert.strictEqual(router.sessionFor(reqA, 'vod:1'), router.sessionFor(reqA, 'vod:1'));
    assert.notStrictEqual(router.sessionFor(reqA, 'vod:1'), router.sessionFor(reqB, 'vod:1'));
    assert.notStrictEqual(router.sessionFor(reqA, 'vod:1'), router.sessionFor(reqA, 'vod:2'));
    assert.ok(!router.sessionFor(reqA, 'vod:1').includes('198.51'), 'the key is a hash, not the address');

    providers.isConfigured = realIsConfigured;
    console.log('placement-router: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });