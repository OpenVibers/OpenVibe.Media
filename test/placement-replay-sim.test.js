'use strict';
// Placement replay simulator (F1b): budgets per sweep, minimum residency, flap counting. Pure, no database.
const assert = require('assert');
const { simulate } = require('../server/placement/replay-sim');

const H = 3600 * 1000;
const T0 = Date.parse('2026-09-30T00:00:00.000Z');
let id = 0;
const row = (obj, action, hours, extra = {}) => ({
    id: ++id, decided_at: new Date(T0 + hours * H).toISOString(), object_id: obj, action, outcome: 'done',
    from_provider: action === 'promote' ? 'b2' : 'r2', to_provider: action === 'promote' ? 'r2' : 'b2',
    inputs: JSON.stringify({ kind: 'video' }), ...extra,
});

// No policy: every proposal applies, in time order, and only done/dry_run rows count.
{
    const rows = [row('b', 'promote', 2), row('a', 'promote', 1), row('c', 'promote', 1, { outcome: 'refused' }), row('d', 'demote', 3, { outcome: 'dry_run' })];
    const before = JSON.stringify(rows);
    const r = simulate({ decisions: rows, policy: {} });
    assert.deepStrictEqual(r.moves.map((m) => m.object_id), ['a', 'b', 'd']);
    assert.strictEqual(r.ignored, 1);
    assert.strictEqual(r.suppressedByBudget + r.suppressedByHysteresis + r.flaps, 0);
    assert.strictEqual(JSON.stringify(rows), before, 'input rows are not modified');
}

// Budget: two promotions per sweep; the third in the same hour is suppressed, the next hour has a fresh budget.
{
    const rows = [row('a', 'promote', 1.1), row('b', 'promote', 1.2), row('c', 'promote', 1.3), row('d', 'promote', 2.1), row('e', 'demote', 1.4)];
    const r = simulate({ decisions: rows, policy: { maxPromotionsPerSweep: 2, maxDemotionsPerSweep: 1 } });
    assert.deepStrictEqual(r.moves.map((m) => m.object_id), ['a', 'b', 'e', 'd']);
    assert.strictEqual(r.suppressedByBudget, 1);
    // An explicit sweep id wins over the time bucket.
    const s = simulate({ decisions: [row('a', 'promote', 1, { sweep: 7 }), row('b', 'promote', 5, { sweep: 7 })], policy: { maxPromotionsPerSweep: 1 } });
    assert.strictEqual(s.moves.length, 1);
    assert.strictEqual(s.suppressedByBudget, 1);
}

// Flapping object: promoted and demoted every hour for six hours.
{
    const rows = [];
    for (let h = 0; h < 6; h++) rows.push(row('flappy', h % 2 ? 'demote' : 'promote', h));
    const loose = simulate({ decisions: rows, policy: { minResidencyMs: 0 } });
    assert.strictEqual(loose.moves.length, 6);
    assert.strictEqual(loose.flaps, 5);

    // A 3 h minimum residency lets hours 0 and 3 through (a demote after a promote: one flap), and holds the rest.
    const held = simulate({ decisions: rows, policy: { minResidencyMs: 3 * H } });
    assert.deepStrictEqual(held.moves.map((m) => m.action), ['promote', 'demote']);
    assert.strictEqual(held.suppressedByHysteresis, 4);
    assert.strictEqual(held.flaps, 1);

    // A residency longer than the whole run leaves one move and no flaps.
    const frozen = simulate({ decisions: rows, policy: { minResidencyMs: 24 * H } });
    assert.strictEqual(frozen.moves.length, 1);
    assert.strictEqual(frozen.suppressedByHysteresis, 5);
    assert.strictEqual(frozen.flaps, 0);
}

// A move held by hysteresis spends no budget and does not restart the residency clock.
{
    const rows = [row('a', 'promote', 0.1), row('a', 'demote', 0.2), row('b', 'promote', 0.3), row('a', 'demote', 2.1)];
    const r = simulate({ decisions: rows, policy: { maxPromotionsPerSweep: 2, minResidencyMs: 2 * H } });
    assert.deepStrictEqual(r.moves.map((m) => m.object_id + ':' + m.action), ['a:promote', 'b:promote', 'a:demote']);
    assert.strictEqual(r.suppressedByHysteresis, 1);
    assert.strictEqual(r.suppressedByBudget, 0);
}

// Per-class policy: video is capped, everything else falls to the default (unlimited).
{
    const rows = [row('v1', 'promote', 1.1), row('v2', 'promote', 1.2), row('i1', 'promote', 1.3, { inputs: JSON.stringify({ kind: 'image' }) })];
    const r = simulate({ decisions: rows, policy: { video: { maxPromotionsPerSweep: 1 }, default: {} } });
    assert.deepStrictEqual(r.moves.map((m) => m.object_id), ['v1', 'i1']);
    assert.strictEqual(r.suppressedByBudget, 1);
}

console.log('placement-replay-sim ok');
