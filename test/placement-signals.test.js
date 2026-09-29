'use strict';
// Signals + breaker (placement F1, part 2): EWMA, error rate, p95, breaker open/half-open/close.
const assert = require('assert');

(async () => {
    const signals = require('../server/placement/signals');

    // Reset to a clean slate.
    signals.reset();

    // A clean slate means a closed breaker.
    assert.strictEqual(signals.breakerOpen('b2'), false);
    assert.strictEqual(signals.breakerOpen('r2'), false);

    // A single success updates the EWMA; latency reported.
    signals.recordSuccess('b2', 'presign', 120);
    const ewma = signals.latencyEWMA('b2', 'presign');
    assert.ok(ewma >= 100 && ewma <= 140, `ewma within band, got ${ewma}`);

    // Error rate over 1 min with one failure, one success: 50% but only 2 samples — under the
    // minSamples threshold (5), so the breaker stays closed.
    for (let i = 0; i < 4; i++) signals.recordSuccess('b2', 'presign', 100);
    signals.recordFailure('b2', 'presign', 50);
    const stats = { total: 0, errors: 0, errorRate: signals.errorRate('b2', '1m') };
    assert.strictEqual(signals.breakerOpen('b2'), false, `breaker still closed (only ${stats.errorRate.toFixed(2)} error rate over a few samples)`);

    // Push enough errors to cross BOTH 5-sample minimum AND 50% rate.
    for (let i = 0; i < 10; i++) signals.recordFailure('b2', 'presign', 50);
    assert.strictEqual(signals.breakerOpen('b2'), true, 'breaker opens after sustained 1m error rate >= 50%');

    // p95 latency on a different provider drives the second open rule.
    signals.reset();
    for (let i = 0; i < 20; i++) signals.recordSuccess('r2', 'presign', 6000);   // 6 s, over the 5 s threshold
    assert.strictEqual(signals.breakerOpen('r2'), true, 'breaker opens when 5m p95 > 5 s');

    // Half-open: after 60 s exactly one trial is allowed; a success closes the breaker, a failure
    // re-opens it. The clock is virtual (`_advance`) so no real sleep is needed.
    signals.reset();
    for (let i = 0; i < 10; i++) signals.recordFailure('b2', 'presign', 50);
    assert.strictEqual(signals.breakerState('b2'), 'open');
    signals._advance(61_000);
    assert.strictEqual(signals.breakerState('b2'), 'half-open', 'half-open 60 s after opening');
    assert.strictEqual(signals.halfOpenClaim('b2'), true, 'the one trial is claimed');
    assert.strictEqual(signals.halfOpenClaim('b2'), false, 'a concurrent second trial is refused');
    signals.recordSuccess('b2', 'presign', 80);
    assert.strictEqual(signals.breakerState('b2'), 'closed', 'a successful trial closes the breaker');

    for (let i = 0; i < 10; i++) signals.recordFailure('r2', 'presign', 50);
    signals._advance(61_000);
    assert.strictEqual(signals.breakerState('r2'), 'half-open');
    signals.halfOpenClaim('r2');
    signals.recordFailure('r2', 'presign', 50);
    assert.strictEqual(signals.breakerState('r2'), 'open', 'a failed trial re-opens the breaker');

    // Snapshot exposes both providers' state, with p50 and p95 per window (the admin view and /metrics).
    signals.reset();
    signals.recordSuccess('b2', 'presign', 100);
    signals.recordSuccess('r2', 'presign', 100);
    signals.recordSuccess('r2', 'presign', 400);
    const snap = signals.snapshot();
    assert.ok(snap.providers.b2 && snap.providers.r2);
    assert.ok(snap.breakers.b2 && snap.breakers.r2);
    for (const win of signals.WINDOWS) {
        assert.ok(snap.providers.r2.windows[win], `window ${win} present`);
        assert.strictEqual(typeof snap.providers.r2.windows[win].p50Ms, 'number', `p50 in ${win}`);
        assert.strictEqual(typeof snap.providers.r2.windows[win].p95Ms, 'number', `p95 in ${win}`);
    }
    assert.strictEqual(snap.providers.r2.windows['5m'].total, 2, 'both r2 samples in the 5-minute window');

    signals.reset();
    console.log('placement-signals: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });