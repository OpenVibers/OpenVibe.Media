'use strict';
// The CMAF cache gives way to the disk's drain (2026-10-31): within its own budget it still evicts durable segments,
// least recently served first, while the VOD storage says the disk needs a drain, and stops once the drain is
// satisfied. A segment served in the last hour stays; one with no verified durable copy never goes. Without pressure
// nothing changes. No listening socket: real migrated PGlite rows, local files and a fake durable readback.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-timeline-pressure-'));
    process.env.OBJECTS_PATH = root;
    process.env.MEDIA_HLS_ENABLED = '1';
    process.env.MEDIA_TIMELINE_LOCAL_MAX_BYTES = String(1024 ** 4);   // far above what the test writes: the budget never asks
    process.env.MEDIA_TIMELINE_LOCAL_MIN_FREE_BYTES = '0';
    const timeline = require('../server/objects/timeline');
    const cache = require('../server/objects/timeline-cache');
    const storage = require('../server/vod/vod-storage');
    const blobs = new Map();
    storage.sha256Object = async (_provider, key) => {
        const bytes = blobs.get(key);
        return bytes ? { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } : null;
    };
    // The disk's drain, faked: it needs a drain, and is satisfied once `room` evictions have happened.
    let draining = false;
    let room = 0;
    storage.getSettings = () => ({});
    storage.diskUsage = () => ({ total: 100, used: 80, available: 20, usePct: 80 });
    storage.needsDrain = () => draining;
    storage.drainSatisfied = () => cache.evictions() >= room;
    try {
        const obj = { app_id: 'live', id: 'pressure-test' };
        const make = async (seq, data, durable, at) => {
            const bytes = Buffer.from(data);
            const name = timeline.segmentName(seq);
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            const key = `pressure/${name}`;
            const file = timeline.localPathFor(obj, 'source', name, sha.slice(0, 12));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes);
            cache.served(file, at);
            if (durable) blobs.set(key, bytes);
            await timeline.replace(`pressure-${seq}`, 'source', [{ seq, name, start_ms: 0, end_ms: 1000, key, local_path: file,
                durable_provider: durable ? 'b2' : null, packed_object_id: null, byte_offset: null,
                byte_length: bytes.length, sha256: sha, durability: durable ? 'durable' : 'local' }]);
            return file;
        };
        const now = Date.now();
        const hourAgo = 3600 * 1000;
        const oldest = await make(1, 'aaaaaa', true, now - 30 * hourAgo);
        const older = await make(2, 'bbbbbb', true, now - 20 * hourAgo);
        const onlyCopy = await make(3, 'cccccc', false, now - 40 * hourAgo);
        const old = await make(4, 'dddddd', true, now - 10 * hourAgo);
        const watched = await make(5, 'eeeeee', true, now - 60 * 1000);

        // No pressure: within its budget the cache keeps everything.
        let r = await cache.sweep({ now });
        assert.strictEqual(r.removed, 0, 'no drain, within budget: nothing goes');
        assert.strictEqual(r.draining, false);

        // Pressure until two files are gone: the two least recently served durable files go, oldest first.
        draining = true; room = 2;
        r = await cache.sweep({ now });
        assert.strictEqual(r.draining, true);
        assert.strictEqual(r.removed, 2, 'it stops once the drain is satisfied');
        assert.strictEqual(fs.existsSync(oldest), false);
        assert.strictEqual(fs.existsSync(older), false);
        assert.strictEqual(fs.existsSync(old), true, 'the drain was satisfied before this one');
        assert.strictEqual(fs.existsSync(onlyCopy), true, 'a file with no verified durable copy never goes');
        assert.strictEqual((await timeline.byName('pressure-1', 'source', timeline.segmentName(1))).local_path, null, 'the row now points at its durable copy only');

        // Pressure that is never satisfied: everything durable goes except what was served in the last hour.
        room = Infinity;
        r = await cache.sweep({ now });
        assert.strictEqual(fs.existsSync(old), false);
        assert.strictEqual(fs.existsSync(watched), true, 'a segment someone watched in the last hour stays');
        assert.strictEqual(fs.existsSync(onlyCopy), true);
        console.log('timeline cache under disk pressure: gives way oldest first, stops when satisfied, keeps the watched and the only copies ok');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        await require('../server/db/database').close?.();
    }
})().catch((e) => { console.error(e); process.exit(1); });
