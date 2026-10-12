'use strict';
// No listening socket: real migrated PGlite rows, local files and a fake durable readback.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-timeline-cache-'));
    process.env.OBJECTS_PATH = root;
    process.env.MEDIA_HLS_ENABLED = '1';
    process.env.MEDIA_TIMELINE_LOCAL_MAX_BYTES = '8';
    process.env.MEDIA_TIMELINE_LOCAL_MIN_FREE_BYTES = '0';
    process.env.MEDIA_HLS_BACKFILL_PER_HOUR = '20';
    const config = require('../server/config');
    const db = require('../server/db/database');
    const timeline = require('../server/objects/timeline');
    const cache = require('../server/objects/timeline-cache');
    const storage = require('../server/vod/vod-storage');
    const blobs = new Map();
    const realRead = storage.sha256Object;
    storage.sha256Object = async (_provider, key) => {
        const bytes = blobs.get(key);
        return bytes ? { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } : null;
    };
    try {
        const obj = { app_id: 'live', id: 'cache-test' };
        const make = async (seq, data, durable, at) => {
            const bytes = Buffer.from(data);
            const name = timeline.segmentName(seq);
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            const key = `cache/${name}`;
            const file = timeline.localPathFor(obj, 'source', name, sha.slice(0, 12));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes);
            cache.served(file, at);
            if (durable) blobs.set(key, bytes);
            await timeline.replace(`cache-${seq}`, 'source', [{ seq, name, start_ms: 0, end_ms: 1000, key, local_path: file,
                durable_provider: durable ? 'b2' : null, packed_object_id: null, byte_offset: null,
                byte_length: bytes.length, sha256: sha, durability: durable ? 'durable' : 'local' }]);
            return file;
        };
        const old = await make(1, 'aaaaaa', true, 1000);
        const recent = await make(2, 'bbbbbb', true, 3000);
        const only = await make(3, 'cccccc', false, 500);
        assert.strictEqual(cache.status().bytes, 18);
        assert.strictEqual(cache.shouldKeepLocal(), false);
        const first = await cache.sweep();
        assert.strictEqual(first.removed, 2);
        assert.strictEqual(fs.existsSync(old), false);
        assert.strictEqual(fs.existsSync(recent), false);
        assert.strictEqual(fs.existsSync(only), true, 'the only copy stays even above budget');
        assert.strictEqual((await timeline.byName('cache-1', 'source', timeline.segmentName(1))).local_path, null);
        assert.strictEqual(cache.evictions(), 2);
        assert.strictEqual(cache.status().bytes, 6);
        const orphanReport = await require('../server/vod/orphans-report').buildStorageReport({ providers: [] });
        assert.ok(!orphanReport.unreferenced_local.some((f) => f.path.includes('.timeline/')),
            'evicted files are gone and the remaining local-only timeline file is still referenced');
        const observability = require('../server/observability');
        const gauges = new Map();
        const registry = {
            gauge: (spec) => { gauges.set(spec.name, spec.collect); return { set: () => {} }; },
            counter: () => ({ inc: () => {} }), histogram: () => ({ observe: () => {} }),
        };
        const events = { status: async () => ({ enabled: false }) };
        observability.domainMetrics(registry, { db, recorder: { activeCount: () => 0 }, events });
        assert.strictEqual(gauges.get('media_timeline_local_bytes')(), 6);
        assert.strictEqual(gauges.get('media_timeline_local_evictions')(), 2);
        for (const section of ['vod', 'pastes', 'files', 'thumbnails']) {
            if (section === 'vod') { config.vod.path = root; config.vod.clipsPath = root; }
            else config[section].path = root;
        }
        const ready = observability.createMediaReadiness({ release: null, db, config,
            auth: { jwksLoaded: () => true }, recorder: { activeCount: () => 0 }, events,
            remote: { configured: () => false } });
        let report = await ready.run();
        assert.strictEqual(report.checks.timeline_cache.status, 'ok');
        assert.strictEqual(report.checks.timeline_cache.detail.bytes, 6);
        config.hls.localMinFreeBytes = Number.MAX_SAFE_INTEGER;
        report = await ready.run();
        assert.strictEqual(report.checks.timeline_cache.status, 'fail');
        assert.ok(report.degraded.includes('timeline_cache'));
        config.hls.localMinFreeBytes = 0;
        const row = await timeline.byName('cache-1', 'source', timeline.segmentName(1));
        assert.deepStrictEqual(timeline.locationsOf(row).map((x) => x.provider), ['b2']);
        assert.deepStrictEqual(blobs.get(row.key), Buffer.from('aaaaaa'));
        // A packed row's byte range remains the same after its local chunk is evicted.
        const packed = Buffer.from('abcdef');
        const packedSha = crypto.createHash('sha256').update(packed).digest('hex');
        const packedFile = timeline.localPathFor(obj, 'source', 'p000001.m4s', packedSha.slice(0, 12));
        fs.mkdirSync(path.dirname(packedFile), { recursive: true });
        fs.writeFileSync(packedFile, packed);
        blobs.set('cache/packed', packed);
        await timeline.replace('cache-packed', 'source', [{ seq: 1, name: '000001.m4s', start_ms: 0, end_ms: 1000,
            key: 'cache/packed', local_path: packedFile, durable_provider: 'b2', packed_object_id: packedSha,
            byte_offset: 2, byte_length: 3, sha256: crypto.createHash('sha256').update('cde').digest('hex'), durability: 'durable' }]);
        config.hls.localMaxBytes = 0;
        await cache.sweep();
        const packedRow = await timeline.byName('cache-packed', 'source', '000001.m4s');
        assert.strictEqual(packedRow.local_path, null);
        assert.deepStrictEqual(blobs.get(packedRow.key).subarray(Number(packedRow.byte_offset), Number(packedRow.byte_offset) + Number(packedRow.byte_length)), Buffer.from('cde'));
        const router = require('../server/placement/router');
        const realRoute = router.route;
        const realSession = router.sessionFor;
        const realPresign = storage.presignGet;
        const realFetch = global.fetch;
        router.route = async () => ({ provider: 'b2', candidates: [{ provider: 'b2', key: packedRow.key }] });
        router.sessionFor = () => null;
        storage.presignGet = async () => 'https://durable.invalid/chunk';
        global.fetch = async (_url, opts) => {
            const m = /^bytes=(\d+)-(\d+)$/.exec(opts.headers.range);
            return new Response(packed.subarray(Number(m[1]), Number(m[2]) + 1), { status: 206 });
        };
        try {
            const req = new EventEmitter();
            req.headers = {};
            const res = { destroyed: false, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } };
            await require('../server/objects/routes').sendSegmentRow(req, res, { obj: { id: 'cache-packed' }, closed: false }, packedRow, 'source');
            assert.strictEqual(res.code, 200);
            assert.deepStrictEqual(res.body, Buffer.from('cde'), 'the segment route reads the packed range from durable storage');
        } finally {
            router.route = realRoute; router.sessionFor = realSession; storage.presignGet = realPresign; global.fetch = realFetch;
        }
        assert.strictEqual(fs.existsSync(only), true);
        console.log('timeline cache: oldest verified copies and packed range evicted; sole copy retained');

        // The CMAF publisher stages normally, verifies the upload, then publishes remote-only rows below the floor.
        const publishDir = path.join(root, 'publish');
        fs.mkdirSync(publishDir);
        fs.writeFileSync(path.join(publishDir, 'init.mp4'), 'init');
        fs.writeFileSync(path.join(publishDir, '000001.m4s'), 'media');
        const realProvider = timeline.durableProvider;
        const realAvailable = storage.providerAvailable;
        const realUpload = storage.uploadFile;
        const timelineQueue = require('../server/objects/timeline-queue');
        const realQueuePack = timelineQueue.queuePack;
        timeline.durableProvider = async () => 'b2';
        storage.providerAvailable = () => true;
        storage.uploadFile = async (_provider, key, file) => { blobs.set(key, fs.readFileSync(file)); };
        timelineQueue.queuePack = async () => null;
        config.hls.localMinFreeBytes = Number.MAX_SAFE_INTEGER;
        try {
            const published = await require('../server/jobs/segments').publishRendition({ job: { id: 'cache-publish', app_id: 'live' },
                ctx: { signal: new AbortController().signal }, src: { id: 'cache-publish', app_id: 'live' },
                rendition: 'source', out: publishDir, list: [{ name: '000001.m4s', seconds: 1 }] });
            assert.strictEqual(published.durable, 2);
            assert.strictEqual(published.local_only, 0);
            const rows = await timeline.list('cache-publish');
            assert.ok(rows.every((r) => r.local_path === null && r.durable_provider === 'b2'));
            assert.ok(rows.every((r) => blobs.has(r.key)));
        } finally {
            timeline.durableProvider = realProvider; storage.providerAvailable = realAvailable;
            storage.uploadFile = realUpload; timelineQueue.queuePack = realQueuePack;
            config.hls.localMinFreeBytes = 0;
        }
        // Packing below the floor uploads and verifies its chunk, then points every row at durable bytes only.
        const packRows = [];
        for (let seq = 1; seq <= 2; seq++) {
            const bytes = Buffer.from(seq === 1 ? 'first' : 'second');
            const name = timeline.segmentName(seq);
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            const key = `cache-pack/${name}`;
            const file = timeline.localPathFor({ app_id: 'live', id: 'cache-pack' }, 'source', name, sha.slice(0, 12));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes);
            blobs.set(key, bytes);
            packRows.push({ seq, name, start_ms: (seq - 1) * 6000, end_ms: seq * 6000, keyframe_ms: (seq - 1) * 6000,
                key, local_path: file, durable_provider: 'b2', packed_object_id: null, byte_offset: null,
                byte_length: bytes.length, sha256: sha, durability: 'durable' });
        }
        await timeline.replace('cache-pack', 'source', packRows);
        const derive = require('../server/jobs/derive');
        const realLoad = derive.loadSource;
        timeline.durableProvider = async () => 'b2';
        storage.providerAvailable = () => true;
        storage.uploadFile = async (_provider, key, file) => { blobs.set(key, fs.readFileSync(file)); };
        derive.loadSource = async () => ({ id: 'cache-pack', app_id: 'live' });
        config.hls.localMinFreeBytes = Number.MAX_SAFE_INTEGER;
        try {
            const result = await require('../server/jobs/pack').spec.run({ id: 'cache-pack-job', params: { target_seconds: 10 } },
                { signal: new AbortController().signal });
            assert.strictEqual(result.packs, 1);
            const packedRows = await timeline.list('cache-pack');
            assert.ok(packedRows.every((r) => r.local_path === null && r.packed_object_id));
            assert.ok(packRows.every((r) => !fs.existsSync(r.local_path)));
            assert.deepStrictEqual(blobs.get(packedRows[0].key), Buffer.from('firstsecond'));
        } finally {
            derive.loadSource = realLoad; timeline.durableProvider = realProvider;
            storage.providerAvailable = realAvailable; storage.uploadFile = realUpload;
            config.hls.localMinFreeBytes = 0;
        }

        const model = require('../server/objects/model');
        const queue = require('../server/jobs/queue');
        const worker = require('../server/jobs/worker');
        const realEnqueue = queue.enqueue;
        const realKick = worker.kick;
        let queued = 0;
        queue.enqueue = async () => ({ created: true, job: { id: `job-${++queued}` } });
        worker.kick = () => {};
        await db.upsertApp({ app_id: 'live', api_key: 'cache-key' });
        const queueCmaf = require('../server/objects/timeline-queue').queueCmaf;
        const base = Date.now();
        try {
            for (let n = 0; n < 21; n++) {
                const id = await model.createObject({ app_id: 'live', kind: 'vod', mime_type: 'video/mp4', lifecycle_status: 'ready', size_bytes: 10 });
                const result = await queueCmaf('live', id, { lazy: true, now: base });
                assert.strictEqual(!!result, n < 20);
            }
            assert.strictEqual(queued, 20);
            const id = await model.createObject({ app_id: 'live', kind: 'vod', mime_type: 'video/mp4', lifecycle_status: 'ready', size_bytes: 10 });
            assert.ok(await queueCmaf('live', id), 'finalize bypasses the lazy cap');
            assert.strictEqual(queued, 21);
            const realGet = db.get;
            db.get = async (sql, ...args) => sql.includes("created_by = 'system:timeline-backfill'") ? { n: 20 } : realGet(sql, ...args);
            try {
                const later = await model.createObject({ app_id: 'live', kind: 'vod', mime_type: 'video/mp4', lifecycle_status: 'ready', size_bytes: 10 });
                assert.strictEqual(await queueCmaf('live', later, { lazy: true, now: base + 3600001 }), null,
                    'persisted job count still caps lazy queues after the in-memory hour rolls over');
            } finally { db.get = realGet; }
        } finally { queue.enqueue = realEnqueue; worker.kick = realKick; }
        console.log('timeline cache: lazy queue capped at 20 per hour; finalize bypasses cap');
    } finally {
        storage.sha256Object = realRead;
        await db.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
