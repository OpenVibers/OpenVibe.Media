'use strict';
/**
 * Value per dollar of keeping one object in a tier (docs/media-fabric.md §6, decision rule): what serving its
 * expected requests from that tier is worth, against what the tier charges for it. Pure: no I/O, no clock.
 *
 * Units (one month is the horizon every figure is taken over):
 *   requests        expected requests served from the tier in a month (a count)
 *   bytes           the object's size in bytes (GB below is bytes / 1024³)
 *   storageCost     $ per GB-month the tier charges to keep it
 *   requestCost     $ per request (read operation) the tier charges
 *   retrievalCost   $ per GB read out of the tier (each request reads the whole object)
 *   residencyCost   $ per GB committed by a minimum residency beyond the month (a policy or provider minimum)
 *   latencyValue    $ a request is worth when the tier serves it (1 makes the score requests per dollar)
 *
 *   value   = requests × latencyValue
 *   dollars = GB × storageCost + requests × requestCost + requests × GB × retrievalCost + GB × residencyCost
 *   score   = value / max(dollars, MIN_DOLLARS)            (dimensionless: $ of value per $ spent)
 *
 * The benefit is per request and the cost mostly per byte, so a hotter object scores higher and, at equal demand,
 * a bigger one or one in a costlier tier scores lower: the greedy order of a size-aware cache (GDSF), which the
 * per-class knapsack takes highest first. The score never falls as requests rise (the value grows at least as
 * fast as the per-request costs) and never rises as any cost rises. A missing, negative or non-finite input
 * counts as 0; a free tier (dollars 0) is floored at MIN_DOLLARS so the score stays finite and ordered by demand.
 */

const GB = 1024 * 1024 * 1024;
const MIN_DOLLARS = 1e-9;

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The dollars a month of keeping and serving the object in the tier costs (see the header). */
function dollars({ requests, bytes, storageCost, requestCost, retrievalCost, residencyCost } = {}) {
    const r = num(requests), gb = num(bytes) / GB;
    return gb * num(storageCost) + r * num(requestCost) + r * gb * num(retrievalCost) + gb * num(residencyCost);
}

/** Value per dollar (see the header). → a finite number >= 0 */
function score(inputs = {}) {
    return (num(inputs.requests) * num(inputs.latencyValue)) / Math.max(dollars(inputs), MIN_DOLLARS);
}

module.exports = { score, dollars, GB, MIN_DOLLARS };
