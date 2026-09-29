'use strict';
// scripts/retire-r2.js against a fake storage engine and database: an R2 copy is removed only when its canonical copy
// is proven byte for byte, a refused row keeps its bucket key, and --execute refuses while promotion can still run.
const assert = require('assert');
const crypto = require('crypto');
const { run } = require('../scripts/retire-r2');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function world() {
    const b2 = new Map(), r2 = new Map();
    const vods = [], clips = [], locations = [], objects = new Map();
    const calls = { demoteVod: [], demoteObj: [], deleted: [] };
    const storage = {
        providerConfigured: () => true,
        keyForVod: (v) => `vods/${v.id}.mp4`,
        headObject: async (p, k) => { const m = p === 'b2' ? b2 : r2; return m.has(k) ? { size: m.get(k).length } : null; },
        sha256Object: async (p, k) => { const m = p === 'b2' ? b2 : r2; return m.has(k) ? { sha256: sha(m.get(k)), size: m.get(k).length } : null; },
        listObjects: async () => [...r2.keys()].map((key) => ({ key, size: r2.get(key).length })),
        deleteObject: async (p, k) => { calls.deleted.push(`${p}:${k}`); (p === 'b2' ? b2 : r2).delete(k); },
        demoteFromR2: async (id) => { calls.demoteVod.push(id); const v = vods.find((x) => x.id === id); r2.delete(`vods/${id}.mp4`); v.storage_provider = 'b2'; return { ok: true }; },
        getSettings: () => ({ r2Enabled: false }),
    };
    const q = (text) => text.replace(/\s+/g, ' ');
    const db = {
        all: async (text) => {
            const t = q(text);
            if (/FROM vods WHERE storage_provider = 'r2'/.test(t)) return vods.filter((v) => v.storage_provider === 'r2');
            if (/FROM clips WHERE storage_provider = 'r2'/.test(t)) return clips.filter((c) => c.storage_provider === 'r2');
            if (/FROM media_locations l JOIN media_objects/.test(t)) return locations.filter((l) => l.provider === 'r2').map((l) => ({ ...l, legacy_ref: objects.get(l.object_id).legacy_ref || null }));
            if (/SELECT key FROM media_locations WHERE provider = 'r2'/.test(t)) return locations.filter((l) => l.provider === 'r2').map((l) => ({ key: l.key }));
            throw new Error(`unexpected query: ${t}`);
        },
        get: async (text, [id] = []) => {
            const t = q(text);
            if (/content_hash FROM media_objects/.test(t) || /SELECT \* FROM media_objects/.test(t)) return objects.get(id) || null;
            if (/AS vods/.test(t)) return { vods: vods.filter((v) => v.storage_provider === 'r2').length, clips: clips.filter((c) => c.storage_provider === 'r2').length, locations: locations.filter((l) => l.provider === 'r2').length };
            throw new Error(`unexpected query: ${t}`);
        },
    };
    const held = new Set();
    const model = {
        isHeldRow: async (v) => held.has(`vod:${v.id}`),
        isHeld: async (id) => held.has(id),
        listLocations: async (id) => locations.filter((l) => l.object_id === id),
    };
    const tiering = { demote: async (id, ctx) => { calls.demoteObj.push({ id, active: ctx.settings.active }); const l = locations.find((x) => x.object_id === id && x.provider === 'r2'); r2.delete(l.key); locations.splice(locations.indexOf(l), 1); return { ok: true, outcome: 'done' }; } };
    const policy = { settings: () => ({ active: false }) };
    const gates = { closedAt: 1000, mediaStartedAt: 2000 };
    return { b2, r2, vods, clips, locations, objects, held, calls, deps: { storage, db, model, tiering, policy, gates } };
}

(async () => {
    let failed = 0;
    const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n${err.stack}`); } };
    console.log('retire-r2');

    await t('a VOD whose B2 bytes match is demoted through the engine; one whose bytes differ keeps its R2 copy', async () => {
        const w = world();
        w.vods.push({ id: 1, storage_provider: 'r2', file_size: 5 }, { id: 2, storage_provider: 'r2', file_size: 5 });
        w.b2.set('vods/1.mp4', 'aaaaa'); w.r2.set('vods/1.mp4', 'aaaaa');
        w.b2.set('vods/2.mp4', 'bbbbb'); w.r2.set('vods/2.mp4', 'bbbbX');
        const rep = await run({ execute: true, concurrency: 2 }, w.deps);
        assert.deepStrictEqual(w.calls.demoteVod, [1]);
        assert.strictEqual(rep.vods.find((v) => v.id === 2).result, 'refused: B2 and R2 bytes differ');
        assert.ok(w.r2.has('vods/2.mp4'), 'the unproven copy stays');
        assert.ok(!rep.bucket.some((b) => b.key === 'vods/2.mp4' && b.result === 'deleted'), 'the bucket pass leaves a refused row\'s key alone');
    });

    await t('held and recording VODs are refused and their keys survive the bucket pass', async () => {
        const w = world();
        w.vods.push({ id: 3, storage_provider: 'r2', file_size: 1 }, { id: 4, storage_provider: 'r2', file_size: 1, is_recording: 1 });
        for (const k of ['vods/3.mp4', 'vods/4.mp4']) { w.b2.set(k, 'x'); w.r2.set(k, 'x'); }
        w.held.add('vod:3');
        const rep = await run({ execute: true, concurrency: 1 }, w.deps);
        assert.deepStrictEqual(w.calls.demoteVod, []);
        assert.ok(w.r2.has('vods/3.mp4') && w.r2.has('vods/4.mp4'));
        assert.deepStrictEqual(rep.bucket.map((b) => b.result), ['kept: a row still on R2 references it', 'kept: a row still on R2 references it']);
    });

    await t('a native object is demoted through tiering.demote only after its canonical copy hashes to content_hash', async () => {
        const w = world();
        w.objects.set('o1', { id: 'o1', canonical_provider: 'b2', content_hash: sha('good'), size_bytes: 4 });
        w.objects.set('o2', { id: 'o2', canonical_provider: 'b2', content_hash: sha('good'), size_bytes: 4 });
        w.objects.set('o3', { id: 'o3', canonical_provider: 'b2', content_hash: sha('x'), size_bytes: 1, legacy_ref: 'vod:9' });
        w.locations.push({ id: 1, object_id: 'o1', provider: 'b2', key: 'o/1' }, { id: 2, object_id: 'o1', provider: 'r2', key: 'c/1' });
        w.locations.push({ id: 3, object_id: 'o2', provider: 'b2', key: 'o/2' }, { id: 4, object_id: 'o2', provider: 'r2', key: 'c/2' });
        w.locations.push({ id: 5, object_id: 'o3', provider: 'b2', key: 'o/3' }, { id: 6, object_id: 'o3', provider: 'r2', key: 'c/3' });
        w.b2.set('o/1', 'good'); w.r2.set('c/1', 'good');
        w.b2.set('o/2', 'bad!'); w.r2.set('c/2', 'good');   // the canonical copy is corrupt: the R2 copy may be the last good one
        w.b2.set('o/3', 'x'); w.r2.set('c/3', 'x');
        const rep = await run({ execute: true, concurrency: 1 }, w.deps);
        assert.deepStrictEqual(w.calls.demoteObj, [{ id: 'o1', active: true }]);
        assert.match(rep.objects.find((o) => o.object_id === 'o2').result, /^refused: the b2 copy does not hash/);
        assert.strictEqual(rep.objects.find((o) => o.object_id === 'o3').result, 'kept: projected from a VOD or clip row still on R2');
        assert.ok(w.r2.has('c/2') && w.r2.has('c/3'));
    });

    await t('an orphaned bucket key goes only when B2 has the same bytes', async () => {
        const w = world();
        w.r2.set('old/a', 'same'); w.b2.set('old/a', 'same');
        w.r2.set('old/b', 'only on r2');
        w.r2.set('old/c', 'diff'); w.b2.set('old/c', 'DIFF');
        const rep = await run({ execute: true, concurrency: 1 }, w.deps);
        assert.deepStrictEqual(Object.fromEntries(rep.bucket.map((b) => [b.key, b.result])), { 'old/a': 'deleted', 'old/b': 'kept: not on B2', 'old/c': 'kept: B2 bytes differ' });
    });

    await t('a dry run changes nothing', async () => {
        const w = world();
        w.vods.push({ id: 5, storage_provider: 'r2', file_size: 2 });
        w.b2.set('vods/5.mp4', 'ok'); w.r2.set('vods/5.mp4', 'ok'); w.r2.set('old/z', 'zz'); w.b2.set('old/z', 'zz');
        const rep = await run({ execute: false, concurrency: 1 }, w.deps);
        assert.deepStrictEqual([w.calls.demoteVod, w.calls.deleted], [[], []]);
        assert.strictEqual(rep.vods[0].result, 'verified');
        assert.strictEqual(rep.bucket.find((b) => b.key === 'old/z').result, 'verified');
    });

    await t('--execute refuses while promotion is open or Media has not restarted since the gates closed', async () => {
        for (const [tweak, re] of [
            [(w) => { w.deps.storage.getSettings = () => ({ r2Enabled: true }); }, /promotion is still open/],
            [(w) => { w.deps.policy.settings = () => ({ active: true }); }, /promotion is still open/],
            [(w) => { w.deps.gates = { closedAt: null, mediaStartedAt: 5 }; }, /no record of the gates closing/],
            [(w) => { w.deps.gates = { closedAt: 3000, mediaStartedAt: 2000 }; }, /has not restarted/],
        ]) {
            const w = world();
            w.r2.set('old/a', 'same'); w.b2.set('old/a', 'same');
            tweak(w);
            await assert.rejects(run({ execute: true, concurrency: 1 }, w.deps), re);
            assert.deepStrictEqual(w.calls.deleted, []);
        }
    });

    console.log(failed ? `${failed} failed` : 'retire-r2: all passed');
    process.exit(failed ? 1 : 0);
})();
