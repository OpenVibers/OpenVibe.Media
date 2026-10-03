'use strict';
// Value per dollar (F2.2, server/placement/value.js): hotter scores higher, a costlier tier lower, a free tier stays
// finite, and the score is monotone in demand and in every cost. Pure, no database.
const assert = require('assert');
const { score, dollars, GB, MIN_DOLLARS } = require('../server/placement/value');

// R2 Standard as cost-tiers.js prices it: $0.015/GB-month, $0.36 per million reads, no retrieval fee.
const r2 = { storageCost: 0.015, requestCost: 0.36e-6, retrievalCost: 0, residencyCost: 0, latencyValue: 1 };
const base = { ...r2, requests: 1000, bytes: GB };

// Each case: [what, higher, lower] — the first input must score strictly higher than the second.
const ordered = [
    ['hotter object scores higher', { ...base, requests: 5000 }, base],
    ['smaller object at equal demand scores higher', { ...base, bytes: GB / 10 }, base],
    ['costlier storage scores lower', base, { ...base, storageCost: 0.03 }],
    ['request fee scores lower', base, { ...base, requestCost: 4.5e-6 }],
    ['retrieval fee scores lower', base, { ...base, retrievalCost: 0.01 }],
    ['minimum residency scores lower', base, { ...base, residencyCost: 0.01 }],
    ['latency worth more scores higher', { ...base, latencyValue: 2 }, base],
];
for (const [what, hi, lo] of ordered) assert.ok(score(hi) > score(lo), `${what}: ${score(hi)} > ${score(lo)}`);
console.log(`✅ ordering: ${ordered.length} cases (hotter higher, costlier tier lower)`);

// Exact values: [inputs, expected dollars, expected score].
const exact = [
    [base, 0.015 + 1000 * 0.36e-6, 1000 / (0.015 + 1000 * 0.36e-6)],
    [{ ...base, requests: 0 }, 0.015, 0],
    [{ ...base, latencyValue: 0 }, 0.015 + 1000 * 0.36e-6, 0],
    [{ requests: 10, bytes: 2 * GB, storageCost: 0.01, requestCost: 0, retrievalCost: 0.01, residencyCost: 0.01, latencyValue: 1 }, 0.02 + 0.2 + 0.02, 10 / 0.24],
];
for (const [inputs, d, s] of exact) {
    assert.ok(Math.abs(dollars(inputs) - d) < 1e-12, `dollars ${dollars(inputs)} != ${d}`);
    assert.ok(Math.abs(score(inputs) - s) / Math.max(s, 1) < 1e-9, `score ${score(inputs)} != ${s}`);
}
console.log('✅ exact: value = requests × latencyValue over storage + requests + retrieval + residency');

// Zero, missing and bad costs: never a division by zero, never NaN or Infinity, never negative.
const edges = [
    ['free tier', { requests: 100, bytes: GB, storageCost: 0, requestCost: 0, retrievalCost: 0, residencyCost: 0, latencyValue: 1 }, 100 / MIN_DOLLARS],
    ['no costs given', { requests: 100, bytes: GB, latencyValue: 1 }, 100 / MIN_DOLLARS],
    ['nothing given', {}, 0],
    ['no argument', undefined, 0],
    ['negative and NaN count as 0', { requests: 100, bytes: -5, storageCost: NaN, requestCost: -1, retrievalCost: 'x', residencyCost: null, latencyValue: 1 }, 100 / MIN_DOLLARS],
    ['zero-byte object pays only per request', { ...r2, requests: 100, bytes: 0 }, 100 / (100 * 0.36e-6)],
];
for (const [what, inputs, s] of edges) {
    const got = score(inputs);
    assert.ok(Number.isFinite(got) && got >= 0, `${what}: finite and >= 0 (${got})`);
    assert.ok(Math.abs(got - s) / Math.max(s, 1) < 1e-9, `${what}: ${got} != ${s}`);
}
assert.ok(score({ ...edges[0][1], requests: 200 }) > score(edges[0][1]), 'a free tier still ranks by demand');
console.log(`✅ edges: ${edges.length} zero/missing/bad cost cases stay finite`);

// Monotonicity: non-decreasing in requests (strictly while storage or residency costs something), non-increasing
// in every cost, across a grid of sizes and tiers.
const steps = [0, 1, 10, 100, 1e3, 1e4, 1e6];
const EPS = 1e-12;   // a constant ratio (no per-byte cost) may differ in the last float bit
for (const bytes of [0, 1024, 100 * 1024 * 1024, GB, 50 * GB]) {
    for (const tier of [r2, { ...r2, storageCost: 0.00695, requestCost: 0 }, { ...r2, storageCost: 0.01, requestCost: 0.9e-6, retrievalCost: 0.01, residencyCost: 0.01 }]) {
        let prev = -1;
        for (const requests of steps) {
            const s = score({ ...tier, bytes, requests });
            assert.ok(s >= prev * (1 - EPS), `non-decreasing in requests (${bytes} B, ${requests} req): ${s} >= ${prev}`);
            if (bytes && requests > 1 && tier.storageCost) assert.ok(s > prev, `strictly increasing in requests (${bytes} B, ${requests} req)`);
            prev = s;
        }
        for (const cost of ['storageCost', 'requestCost', 'retrievalCost', 'residencyCost']) {
            let last = Infinity;
            for (const c of [0, 1e-7, 1e-4, 0.01, 1]) {
                const s = score({ ...tier, bytes, requests: 1000, [cost]: c });
                assert.ok(s <= last * (1 + EPS), `non-increasing in ${cost} (${bytes} B, ${c}): ${s} <= ${last}`);
                last = s;
            }
        }
    }
}
console.log('✅ monotone: never down as requests rise, never up as a cost rises');
console.log('\n✅ All placement value tests passed');
