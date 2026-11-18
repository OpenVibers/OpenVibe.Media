'use strict';
// The health job and a recording that needs repair but lives only in remote storage (11-18: six of the night's
// recordings, hidden as needs_repair, were asked again every idle pass, "Repair failed …: not_local", for hours).
// It is brought back to this host and repaired; one with no copy anywhere is marked missing_file, not retried forever.
const assert = require('assert');
const path = require('path');

const stub = (rel, exports) => {
    const file = require.resolve(path.join(__dirname, '..', rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const calls = [];
let local = false;          // is the file on this host yet
let remote = 'present';     // present | missing | down
stub('server/vod/vod-repair', {
    repairVod: async (vod) => { calls.push(['repair', vod.id, vod.fresh || false]); return local ? { vod, ok: true, duration: 120, recut: null } : { vod, ok: false, skipped: 'not_local' }; },
});
stub('server/vod/vod-storage', {
    moveToHot: async (id, ctx) => {
        calls.push(['moveToHot', id, ctx && ctx.trigger]);
        if (remote === 'present') { local = true; return { ok: true, bytes: 1000 }; }
        return { ok: false, error: remote === 'missing' ? 'Object missing from remote storage' : 'download stalled at 3 MB of 8 MB' };
    },
    quarantineMissing: async (id, why) => { calls.push(['quarantineMissing', id, why]); },
});
stub('server/db/database', { get: async (sql, [id]) => ({ id, health_status: 'needs_repair', file_path: '/x.mp4', fresh: true }) });
const { _scanOne } = require('../server/vod/health-job');
const quiet = console.warn; const said = console.log;
console.warn = () => {}; console.log = () => {};

(async () => {
    try {
        const vod = { id: 6615, health_status: 'needs_repair', file_path: '/x.mp4' };
        // On B2: brought back, then repaired from the fresh row.
        let out = await _scanOne(vod, { deep: true });
        assert.deepStrictEqual(out, { id: 6615, status: 'repaired' });
        assert.deepStrictEqual(calls, [['repair', 6615, false], ['moveToHot', 6615, 'health'], ['repair', 6615, true]]);

        // No copy anywhere: missing_file, never asked again as needs_repair.
        calls.length = 0; local = false; remote = 'missing';
        out = await _scanOne(vod, { deep: true });
        assert.deepStrictEqual(out, { id: 6615, status: 'missing_file' });
        assert.deepStrictEqual(calls.map((c) => c[0]), ['repair', 'moveToHot', 'quarantineMissing']);

        // A download that fails for now: still needs_repair, the next idle pass tries again.
        calls.length = 0; remote = 'down';
        out = await _scanOne(vod, { deep: true });
        assert.deepStrictEqual(out, { id: 6615, status: 'needs_repair' });
        assert.deepStrictEqual(calls.map((c) => c[0]), ['repair', 'moveToHot']);

        // While recording (not deep): deferred, nothing fetched.
        calls.length = 0;
        assert.deepStrictEqual(await _scanOne(vod, { deep: false }), { id: 6615, status: 'deferred' });
        assert.deepStrictEqual(calls, []);
        console.log = said;
        console.log('health repair remote: brought back and repaired; missing anywhere is missing_file; a failed fetch retries');
    } catch (e) { console.log = said; console.warn = quiet; console.error(e); process.exit(1); }
})();
