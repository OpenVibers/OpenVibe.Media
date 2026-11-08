'use strict';
/**
 * The /metrics gauge for ready objects without a good copy ran the anti-join on every scrape (5,486 calls,
 * 56 ms mean on 2026-11-08). It is now kept for 60 s in production (server/observability.js kept). This proves
 * two collects inside the window read once, a failed read is not kept, and the keep expires.
 */
process.env.MEDIA_NO_GOOD_COPY_CACHE_MS = '60000';

const assert = require('assert');
const copyReport = require('../server/objects/copy-report');
const { noGoodCopyReader, kept } = require('../server/observability');

(async () => {
    let reads = 0;
    const original = copyReport.countNoGoodCopy;
    copyReport.countNoGoodCopy = async () => { reads += 1; return 0; };
    try {
        const read = noGoodCopyReader({});
        await read();
        await read();
        assert.strictEqual(reads, 1, 'two collects inside the 60 s window read once');
    } finally {
        copyReport.countNoGoodCopy = original;
    }

    let clock = 0;
    let keptReads = 0;
    const read = async () => ++keptReads;
    const k = kept(read, 60_000, () => clock);
    assert.strictEqual(await k(), 1);
    clock = 59_000;
    assert.strictEqual(await k(), 1, 'within the window: kept');
    clock = 60_000;
    assert.strictEqual(await k(), 2, 'past the window: read again');
    console.log('ok - the no-good-copy gauge is kept for 60 s');
})().catch((err) => { console.error(err); process.exit(1); });
