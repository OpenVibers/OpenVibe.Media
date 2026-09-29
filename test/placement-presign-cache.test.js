'use strict';
// Presigned-URL LRU (F1, part 4): hit, miss, expiry, bounded.
const assert = require('assert');

(async () => {
    const cache = require('../server/placement/presign-cache');
    let incs = [];
    cache.bindMetric((name, labels) => incs.push({ name, labels }));
    cache.clear();

    assert.strictEqual(cache.get('b2', 'k1', 'video/webm', '', 900), null, 'first get → miss');
    cache.put('b2', 'k1', 'video/webm', '', 900, 'https://example.com/signed');
    assert.strictEqual(cache.get('b2', 'k1', 'video/webm', '', 900).url, 'https://example.com/signed', 'second get → hit');
    assert.strictEqual(cache.size(), 1, 'one entry');

    // Different disposition / content-type → different cache key.
    assert.strictEqual(cache.get('b2', 'k1', 'video/webm', 'attachment; filename="x"', 900), null, 'different disposition → miss');

    // Bound: fill to MAX_ENTRIES and check eviction.
    for (let i = 0; i < cache.MAX_ENTRIES + 100; i++) cache.put('r2', `k${i}`, '', '', 900, `https://example/${i}`);
    assert.ok(cache.size() <= cache.MAX_ENTRIES, `bounded: ${cache.size()} <= ${cache.MAX_ENTRIES}`);

    // Expiry: put a TTL with a very short window. After 60 s safety margin, the entry is dropped.
    cache.clear();
    cache.put('r2', 'kexp', '', '', 60, 'soon-expired');
    await new Promise((r) => setTimeout(r, 100));   // safety margin is 60 s; we can't wait 60 s in a test, but we can simulate by calling put with ttl=0 and waiting briefly.
    cache.put('r2', 'kexp2', '', '', 1, 'expired-now');
    await new Promise((r) => setTimeout(r, 1100));
    assert.strictEqual(cache.get('r2', 'kexp2', '', '', 1), null, 'expired entry → miss and dropped');

    // Metrics were incremented: at least one hit and one miss.
    const hits = incs.filter((i) => i.name === 'media_presign_cache_total' && i.labels.result === 'hit').length;
    const misses = incs.filter((i) => i.name === 'media_presign_cache_total' && i.labels.result === 'miss').length;
    assert.ok(hits >= 1, `hits recorded: ${hits}`);
    assert.ok(misses >= 1, `misses recorded: ${misses}`);

    cache.clear();
    console.log('placement-presign-cache: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });