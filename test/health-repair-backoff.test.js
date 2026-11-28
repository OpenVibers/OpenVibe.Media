'use strict';
// A failed repair is not tried again on every idle pass (11-28: vod 6666 failed "Error muxing a packet" 72 times in six
// hours). Each failure doubles the wait from ten minutes to a day; while it waits the VOD stays needs_repair and no
// repair runs; a success clears the wait.
const assert = require('assert');
const path = require('path');

const stub = (rel, exports) => {
    const file = require.resolve(path.join(__dirname, '..', rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
let ok = false;
const calls = [];
stub('server/vod/vod-repair', {
    repairVod: async (vod) => { calls.push(vod.id); return ok ? { vod, ok: true, duration: 60, recut: null } : { vod, ok: false, error: 'encode_failed: Error muxing a packet' }; },
});
stub('server/vod/vod-storage', { moveToHot: async () => ({ ok: false }), quarantineMissing: async () => {} });
stub('server/db/database', { get: async (sql, [id]) => ({ id, health_status: 'needs_repair', file_path: '/x.mp4' }) });
const job = require('../server/vod/health-job');

(async () => {
    const vod = { id: 6666, health_status: 'needs_repair', file_path: '/x.mp4' };
    const warn = console.warn; console.warn = () => {};
    try {
        assert.deepStrictEqual(await job._scanOne(vod, { deep: true }), { id: 6666, status: 'needs_repair' });
        assert.strictEqual(calls.length, 1, 'the first failure ran the repair');
        const waiting = await job._scanOne(vod, { deep: true });
        assert.deepStrictEqual(waiting, { id: 6666, status: 'needs_repair', waiting: true });
        assert.strictEqual(calls.length, 1, 'the next pass waits: no repair ran');

        // The waits double from ten minutes and stop at a day.
        const t0 = 1_000_000;
        job._repairBackoff.clear();
        const waits = [1, 2, 3, 4, 10, 20].map(() => job._repairFailed('x', t0).wait / 60000);
        assert.deepStrictEqual(waits, [10, 20, 40, 80, 160, 320], 'minutes, doubling');
        assert.strictEqual(job._repairWaiting('x', t0 + 5 * 3600e3), true);
        assert.strictEqual(job._repairWaiting('x', t0 + 6 * 3600e3), false, 'the sixth failure waits 320 minutes');
        for (let i = 0; i < 10; i++) job._repairFailed('x', t0);
        assert.strictEqual(job._repairWaiting('x', t0 + 24 * 3600e3 + 1), false, 'never more than a day');

        // Once its wait is over a success clears it.
        job._repairBackoff.clear();
        ok = true;
        assert.deepStrictEqual(await job._scanOne(vod, { deep: true }), { id: 6666, status: 'repaired' });
        assert.strictEqual(job._repairBackoff.has('6666'), false);
    } finally { console.warn = warn; }
    console.log('health-repair-backoff: a failed repair waits, doubling from 10 minutes to a day; a success clears it');
})().catch((e) => { console.error(e); process.exit(1); });
