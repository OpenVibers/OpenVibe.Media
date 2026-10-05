'use strict';
// Shared segment locations and their reference counts (F3.4; docs/media-fabric.md §3/§4): any number of media_timeline
// rows — of any number of objects (a source and the clips over it) — may name one location, and a location's bytes are
// deleted only when no row names it. A clip object's rows name its source's locations; removing the clip leaves the
// source's files and durable keys, removing the source keeps the locations the clip still names, and in either order the
// bytes go when the last naming object does. object.pack re-keys every row that names a packed segment's old location
// (same sha256) to the chunk in one transaction, so a clip follows its source into the chunk and its playlist serves the
// chunk ranges; the old location is then freed. A row whose sha256 differs is left alone and keeps the location named.
// Migration 0003 adds the two location indexes and applies on a database that already has rows.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-timeline-refs-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.OBJECTS_PATH = dir('objects');
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.MEDIA_HLS_ENABLED = '1';
    for (const p of ['B2', 'R2']) for (const k of ['ENDPOINT', 'BUCKET', 'KEY_ID', 'APP_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) process.env[`MEDIA_${p}_${k}`] = '';

    (async () => {
        const config = require('../server/config');
        const db = require('../server/db/database');
        const timeline = require('../server/objects/timeline');
        const vodStorage = require('../server/vod/vod-storage');
        const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

        // The durable providers, stubbed: bytes in a Map, uploads kept, and deletes recorded only when a key actually
        // went (a delete of bytes already gone is a success, as S3's is — so a concurrent double delete records once).
        const blobs = new Map();
        const deletes = [];
        const failDeletes = new Set();   // keys whose durable delete fails once (returns false), for the retry case
        Object.assign(vodStorage, {
            providerConfigured: (p) => ['b2', 'r2'].includes(p),
            providerAvailable: (p) => ['b2', 'r2'].includes(p),
            uploadFile: async (p, key, file) => { blobs.set(`${p}:${key}`, fs.readFileSync(file)); },
            sha256Object: async (p, key) => (blobs.has(`${p}:${key}`) ? { sha256: sha(blobs.get(`${p}:${key}`)), size: blobs.get(`${p}:${key}`).length } : null),
            deleteObject: async (p, key) => {
                if (failDeletes.has(`${p}:${key}`)) return false;
                if (blobs.delete(`${p}:${key}`)) deletes.push(`${p}:${key}`);
                return true;
            },
            presignGet: async () => null,
        });

        const insert = async (objectId, r) => db.run(
            `INSERT INTO media_timeline (object_id, rendition, seq, name, start_ms, end_ms, keyframe_ms, key, local_path,
                durable_provider, packed_object_id, byte_offset, byte_length, sha256, durability, job_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            [objectId, 'source', r.seq, r.name, r.start_ms, r.end_ms, r.keyframe_ms ?? null, r.key, r.local_path,
                r.durable_provider, r.packed_object_id ?? null, r.byte_offset ?? null, r.byte_length, r.sha256, r.durability]);

        /** One object's rows (init + three media segments), with this node's file and the durable copy really written. */
        const seedSource = async (id) => {
            const obj = { app_id: 'live', id };
            const payloads = [Buffer.from('init-bytes'), Buffer.from('segment-one-bytes'), Buffer.from('segment-two-bytes'), Buffer.from('segment-three-bytes')];
            const rows = [];
            for (let seq = 0; seq < payloads.length; seq++) {
                const bytes = payloads[seq];
                const s = sha(bytes);
                const name = timeline.segmentName(seq);
                const key = timeline.keyFor(id, 'source', name, s.slice(0, 12));
                const local = timeline.localPathFor(obj, 'source', name, s.slice(0, 12));
                fs.mkdirSync(path.dirname(local), { recursive: true });
                fs.writeFileSync(local, bytes);
                blobs.set(`b2:${key}`, bytes);
                const r = { seq, name, start_ms: seq ? (seq - 1) * 3000 : 0, end_ms: seq * 3000, keyframe_ms: seq ? (seq - 1) * 3000 : null,
                    key, local_path: local, durable_provider: 'b2', byte_length: bytes.length, sha256: s, durability: 'durable' };
                await insert(id, r);
                rows.push(r);
            }
            return rows;
        };

        /** A clip's row naming a source row's location: the location (key, local_path, durable provider, sha, byte
         * length) is the source's, the seq and times are the clip's, exactly as timeline.clipRows leaves them. */
        const clipRow = (src, seq, { sha256 = src.sha256 } = {}) => ({ seq, name: src.name, start_ms: src.start_ms, end_ms: src.end_ms,
            keyframe_ms: src.keyframe_ms, key: src.key, local_path: src.local_path, durable_provider: src.durable_provider,
            byte_length: src.byte_length, sha256, durability: src.durability });

        // ── The migration: the two location indexes exist, and it applies again on a database that already has rows ──
        await seedSource('idx-A');
        const indexes = (await db.all(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'media_timeline'`)).map((r) => r.indexname);
        assert.ok(indexes.includes('media_timeline_location_durable') && indexes.includes('media_timeline_location_local'), `migration 0003 applied: ${indexes.join(', ')}`);
        const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0003_media_timeline_locations.sql'), 'utf8');
        await db.getDb().query(migration);   // CREATE INDEX IF NOT EXISTS: a no-op on the row-filled database, never an error
        await timeline.removeObject('idx-A');
        deletes.length = 0;

        // ── namedElsewhere: another object's rows, and only another object's ──
        const A = await seedSource('ref-A');
        const B = A.slice(1).map((r, i) => clipRow(r, i + 1));
        for (const r of B) await insert('ref-B', r);
        const loc = { provider: 'b2', key: A[1].key };
        assert.strictEqual(await timeline.namedElsewhere(loc, 'ref-A'), true, 'the clip names the source location');
        assert.strictEqual(await timeline.namedElsewhere(loc, 'ref-B'), true, 'the source names it');
        assert.strictEqual(await timeline.namedElsewhere({ localPath: A[1].local_path }, 'ref-A'), true, 'the local location too');
        assert.strictEqual(await timeline.namedElsewhere({ provider: 'b2', key: 'nobody' }, 'ref-A'), false, 'an unnamed key is not');
        assert.strictEqual(await timeline.namedElsewhere(loc, null), true, 'isNamed counts every object');

        // ── Case 1: removeObject(clip) keeps the source's bytes; removeObject(source) then deletes them ──
        assert.deepStrictEqual(await timeline.removeObject('ref-B'), { removed: B.length, pending: 0 });
        assert.strictEqual((await timeline.list('ref-B')).length, 0, 'the clip\'s rows are gone');
        assert.ok(A.every((r) => fs.existsSync(r.local_path)), 'the source\'s files stay');
        assert.ok(A.every((r) => blobs.has(`b2:${r.key}`)), 'the source\'s durable keys stay');
        assert.deepStrictEqual(deletes, [], 'nothing was deleted while the source still names them');
        assert.deepStrictEqual(await timeline.removeObject('ref-A'), { removed: A.length, pending: 0 });
        assert.ok(A.every((r) => !fs.existsSync(r.local_path)), 'the source\'s files go with the last naming object');
        assert.ok(A.every((r) => !blobs.has(`b2:${r.key}`)), 'and its durable keys');

        // ── Case 2: removeObject(source) first keeps the locations the clip still names; removeObject(clip) deletes them ──
        const A2 = await seedSource('ref-A2');
        for (const [i, r] of A2.slice(1).entries()) await insert('ref-B2', clipRow(r, i + 1));
        assert.deepStrictEqual(await timeline.removeObject('ref-A2'), { removed: A2.length, pending: 0 });
        assert.ok(A2.slice(1).every((r) => fs.existsSync(r.local_path)) && A2.slice(1).every((r) => blobs.has(`b2:${r.key}`)), 'the source is gone, the segments the clip names are kept');
        assert.ok(!fs.existsSync(A2[0].local_path) && !blobs.has(`b2:${A2[0].key}`), 'the init segment, named by no clip row, went with the source');
        assert.ok(deletes.includes(`b2:${A2[0].key}`) && !deletes.includes(`b2:${A2[1].key}`), 'only the unshared location was deleted');
        assert.strictEqual((await timeline.list('ref-B2')).length, A2.length - 1, 'the clip keeps its rows');
        assert.deepStrictEqual(await timeline.removeObject('ref-B2'), { removed: A2.length - 1, pending: 0 });
        assert.ok(A2.slice(1).every((r) => !fs.existsSync(r.local_path)) && A2.slice(1).every((r) => !blobs.has(`b2:${r.key}`)), 'the last naming object deletes them');

        // ── Pack: a clip follows its source into the chunk, in the same transaction; the old locations are freed ──
        const derive = require('../server/jobs/derive');
        const pack = require('../server/jobs/pack');
        derive.loadSource = async (job) => ({ id: job.object_id, app_id: 'live', kind: 'video', mime_type: 'video/mp4', lifecycle_status: 'ready' });
        timeline.durableProvider = async () => 'b2';
        const packA = await seedSource('pack-A');
        const packB = packA.slice(1).map((r, i) => clipRow(r, i + 1));
        for (const r of packB) await insert('pack-B', r);
        const job = { id: 'mjob_REFS', app_id: 'live', object_id: 'pack-A', params: { target_seconds: 60 } };
        const out = await pack.spec.run(job, { signal: new AbortController().signal });
        assert.deepStrictEqual([out.packs, out.segments, out.left_behind], [1, 3, 0], JSON.stringify(out));
        const packedA = await timeline.list('pack-A');
        const chunkId = packedA[1].packed_object_id;
        const chunkKey = packedA[1].key;
        const chunk = blobs.get(`b2:${chunkKey}`);
        assert.ok(chunk && sha(chunk) === chunkId, 'the chunk is one object of the three segments');
        const packedB = await timeline.list('pack-B');
        for (const [i, r] of packedA.slice(1).entries()) {
            const b = packedB[i];
            assert.deepStrictEqual([b.name, b.start_ms, b.end_ms, b.sha256, Number(b.byte_length)], [r.name, r.start_ms, r.end_ms, r.sha256, Number(r.byte_length)], 'the clip keeps its identity');
            assert.deepStrictEqual([b.key, b.durable_provider, b.packed_object_id, Number(b.byte_offset), b.local_path], [chunkKey, 'b2', chunkId, Number(r.byte_offset), r.local_path], 'the clip names the same chunk range');
            assert.strictEqual(sha(chunk.subarray(Number(b.byte_offset), Number(b.byte_offset) + Number(b.byte_length))), b.sha256, `${b.name} plays from the chunk range its own playlist names`);
        }
        assert.strictEqual(packB.length, 3, 'three clip rows');
        const bPlaylist = timeline.mediaPlaylist(packedB);
        assert.ok(bPlaylist.includes('000001.m4s') && bPlaylist.includes('000003.m4s'), 'the clip\'s playlist is written from its (re-keyed) rows');
        assert.ok(packA.slice(1).every((r) => !fs.existsSync(r.local_path)) && packA.slice(1).every((r) => !blobs.has(`b2:${r.key}`)), 'the per-segment locations are freed once every row names the chunk');

        // ── A row with a mismatched sha256 is left alone and keeps the location named ──
        const misA = await seedSource('mis-A');
        await insert('mis-B', { ...clipRow(misA[1], 1), sha256: 'f'.repeat(64) });
        assert.deepStrictEqual(await timeline.removeObject('mis-A'), { removed: misA.length, pending: 0 });
        assert.ok(fs.existsSync(misA[1].local_path) && blobs.has(`b2:${misA[1].key}`), 'the location the mismatched row names is kept');
        assert.ok(!deletes.includes(`b2:${misA[1].key}`), 'it was not deleted while the mismatched row names it');
        assert.ok(deletes.includes(`b2:${misA[2].key}`), 'the locations no row names were deleted');
        assert.deepStrictEqual((await timeline.list('mis-B')).map((r) => [r.seq, r.key, r.sha256]),
            [[1, misA[1].key, 'f'.repeat(64)]], 'the mismatched row is untouched');
        assert.deepStrictEqual(await timeline.removeObject('mis-B'), { removed: 1, pending: 0 });
        assert.ok(!fs.existsSync(misA[1].local_path) && !blobs.has(`b2:${misA[1].key}`), 'removing the last naming object frees it');

        // ── Pack leaves a mismatched row alone and keeps the old location ──
        const pmA = await seedSource('pmis-A');
        await insert('pmis-B', { ...clipRow(pmA[1], 1), sha256: 'e'.repeat(64) });
        const pout = await pack.spec.run({ id: 'mjob_REFS2', app_id: 'live', object_id: 'pmis-A', params: { target_seconds: 60 } }, { signal: new AbortController().signal });
        assert.strictEqual(pout.packs, 1, JSON.stringify(pout));
        const pmPacked = await timeline.list('pmis-A');
        const pmChunk = pmPacked[1];
        assert.deepStrictEqual((await timeline.list('pmis-B')).map((r) => [r.key, r.sha256, r.packed_object_id]), [[pmA[1].key, 'e'.repeat(64), null]], 'the mismatched row did not follow the pack');
        assert.ok(fs.existsSync(pmA[1].local_path) && blobs.has(`b2:${pmA[1].key}`), 'so the old location it names is kept');
        assert.ok(pmA.slice(2).every((r) => !blobs.has(`b2:${r.key}`)), 'the other segments (no mismatched row) were freed');
        assert.ok(pmChunk.packed_object_id);

        // ── Concurrent removal of two objects over one shared location: the last committer deletes it, no orphan ──
        const ccA = await seedSource('cc-A');
        for (const [i, r] of ccA.slice(1).entries()) await insert('cc-B', clipRow(r, i + 1));
        deletes.length = 0;
        const [ccRa, ccRb] = await Promise.all([timeline.removeObject('cc-A'), timeline.removeObject('cc-B')]);
        assert.deepStrictEqual(ccRa, { removed: ccA.length, pending: 0 }, 'the source rows all went');
        assert.deepStrictEqual(ccRb, { removed: ccA.length - 1, pending: 0 }, 'the clip rows all went');
        assert.strictEqual((await timeline.list('cc-A')).length + (await timeline.list('cc-B')).length, 0, 'no row is left');
        assert.ok(!await timeline.isNamed({ provider: 'b2', key: ccA[1].key }), 'no row names the shared location afterwards');
        assert.ok(!blobs.has(`b2:${ccA[1].key}`), 'the shared bytes are gone, not orphaned');
        assert.strictEqual(deletes.filter((d) => d === `b2:${ccA[1].key}`).length, 1, 'and they were deleted exactly once');
        assert.ok(ccA.slice(1).every((r) => !fs.existsSync(r.local_path)), 'the shared local files are gone too');

        // ── A pack whose source was re-cut must not commit on a clip's same-sha row alone ──
        const rcA = await seedSource('rcut-A');
        await insert('rcut-B', clipRow(rcA[1], 1));
        const rcStale = await timeline.list('rcut-A');       // the rows the pack reads before the re-cut
        // The re-cut: the source's own row now names different bytes (a new key and sha); the clip's row is unchanged.
        await db.run(`UPDATE media_timeline SET key = ?, sha256 = ?, local_path = ? WHERE object_id = ? AND rendition = ? AND seq = ?`,
            ['rcut-A/source/000001.m4s/v2', 'b'.repeat(64), timeline.localPathFor({ app_id: 'live', id: 'rcut-A' }, 'source', '000001.m4s', 'v2'), 'rcut-A', 'source', 1]);
        const realList = timeline.list;
        timeline.list = async (id, rendition) => (id === 'rcut-A' ? rcStale : realList.call(timeline, id, rendition));
        let conflict = null;
        try {
            await pack.spec.run({ id: 'mjob_REFS3', app_id: 'live', object_id: 'rcut-A', params: { target_seconds: 60 } }, { signal: new AbortController().signal });
        } catch (err) { conflict = err; } finally { timeline.list = realList; }
        assert.ok(conflict && conflict.code === 'media.timeline.changed', `pack refused a re-cut source: ${conflict && conflict.message}`);
        const rcNow = await timeline.list('rcut-A');
        assert.strictEqual(rcNow[1].sha256, 'b'.repeat(64), 'the source row is still the re-cut one');
        assert.strictEqual(rcNow[1].packed_object_id, null, 'and was not packed without the source');
        assert.deepStrictEqual((await timeline.list('rcut-B')).map((r) => [r.key, r.sha256, r.packed_object_id]),
            [[rcA[1].key, rcA[1].sha256, null]], 'the clip row is untouched');
        assert.ok(await timeline.isNamed({ provider: 'b2', key: rcA[1].key }) && blobs.has(`b2:${rcA[1].key}`), 'the old location the clip names survives');

        // ── A shared location whose durable delete fails is retried and deleted once unnamed ──
        const rtA = await seedSource('rt-A');
        for (const [i, r] of rtA.slice(1).entries()) await insert('rt-B', clipRow(r, i + 1));
        assert.deepStrictEqual(await timeline.removeObject('rt-A'), { removed: rtA.length, pending: 0 }, 'the source goes; the bytes stay');
        assert.ok(rtA.slice(1).every((r) => blobs.has(`b2:${r.key}`)), 'the shared locations survive while the clip names them');
        failDeletes.add(`b2:${rtA[1].key}`);
        assert.deepStrictEqual(await timeline.removeObject('rt-B'), { removed: 3, pending: 1 }, 'the failed delete leaves its row behind');
        assert.deepStrictEqual((await timeline.list('rt-B')).map((r) => [Number(r.seq), r.key, r.durable_provider]),
            [[1, rtA[1].key, 'b2']], 'the row survives with its key');
        assert.ok(blobs.has(`b2:${rtA[1].key}`), 'the bytes are still there');
        assert.ok(!blobs.has(`b2:${rtA[2].key}`), 'the other shared locations were deleted');
        failDeletes.clear();
        assert.deepStrictEqual(await timeline.removeObject('rt-B'), { removed: 1, pending: 0 }, 'the retry deletes it once unnamed');
        assert.ok(!blobs.has(`b2:${rtA[1].key}`) && !fs.existsSync(rtA[1].local_path), 'the bytes are gone');
        assert.strictEqual((await timeline.list('rt-B')).length, 0, 'and its row is dropped');

        console.log('timeline-refs: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
