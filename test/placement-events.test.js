'use strict';
// Replica decisions and provider transitions use the durable placement outbox.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-placement-events-'));
    const dir = (name) => { const p = path.join(tmp, name); fs.mkdirSync(p, { recursive: true }); return p; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
    });
    const stub = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
            res.statusCode = 503; res.end('{}'); // Keep every envelope in the outbox for inspection.
        });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));

    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const storage = require('../server/vod/vod-storage');
    const policy = require('../server/objects/tier-policy');
    const tiering = require('../server/objects/tiering');
    const providers = require('../server/placement/providers');
    const events = require('../server/events');
    const base = `http://127.0.0.1:${stub.address().port}`;
    const copies = new Map();
    let corrupt = false;
    storage.providerAvailable = () => true;
    storage.providerConfigured = () => true;
    storage.bucketFor = () => 'r2-bucket';
    storage.uploadFile = async (_provider, key, file) => {
        const bytes = fs.readFileSync(file);
        if (corrupt) bytes[0] ^= 0xff;
        copies.set(key, bytes);
    };
    storage.headObject = async (_provider, key) => copies.has(key) ? { size: copies.get(key).length } : null;
    storage.sha256Object = async (_provider, key) => copies.has(key)
        ? { sha256: crypto.createHash('sha256').update(copies.get(key)).digest('hex') } : null;
    storage.deleteObject = async (_provider, key) => { copies.delete(key); };

    await policy.init();
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-placement-events' });
    const sandbox = (await db.ensureProjectTenant('prj_01TESTPLACEVENTS000000001', 'sandbox', 1024)).app_id;
    const enabled = { ...policy.settings(), active: true };
    const disabled = { ...enabled, active: false };
    const raw = db.getDb();
    const placementRows = async () => (await raw.prepare('SELECT envelope FROM event_outbox ORDER BY id').all())
        .map((row) => typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope)
        .filter((event) => events.PLACEMENT_TYPES.has(event.event_type));
    const rowsFor = async (id) => (await placementRows()).filter((event) => event.subject.id === id);
    const waitFor = async (test) => {
        for (let i = 0; i < 100; i++) {
            if (await test()) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('timed out waiting for a placement event');
    };
    const addObject = async (app = 'live') => {
        const bytes = Buffer.from('a verified video object for placement events');
        const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
        const id = await model.createObject({ app_id: app, kind: 'file', visibility: 'public', lifecycle_status: 'ready',
            mime_type: 'video/mp4', size_bytes: bytes.length, content_hash: checksum, canonical_provider: 'local' });
        const file = path.join(process.env.OBJECTS_PATH, app, id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        await model.updateObject(id, { canonical_key: file });
        await model.upsertLocation(id, { provider: 'local', key: file, state: 'present', size_bytes: bytes.length, checksum, verified: true });
        return { id, bytes };
    };

    assert.ok(events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 3600000 }));
    assert.strictEqual(events.PLACEMENT_TYPES.size, 11);
    await assert.rejects(events.recordPlacement('not.a.placement', null, { type: 'provider', id: 'r2' }, {}), /unknown placement event/);

    // 1. Promotion records the intent before copying, then the verified replica with its exact payload.
    const promoted = await addObject();
    assert.strictEqual((await tiering.promote(promoted.id, { settings: enabled })).outcome, 'done');
    let rows = await rowsFor(promoted.id);
    assert.deepStrictEqual(rows.map((e) => e.event_type), ['media.replica.requested', 'media.replica.ready']);
    for (const e of rows) {
        assert.deepStrictEqual(e.subject, { type: 'object', id: promoted.id });
        assert.deepStrictEqual([e.priority, e.visibility, e.payload.class], ['low', 'internal', 'video']);
    }
    assert.deepStrictEqual(Object.keys(rows[0].payload).sort(), ['action', 'app_id', 'class', 'from', 'object_id', 'provider', 'to']);
    assert.deepStrictEqual(Object.keys(rows[1].payload).sort(), ['action', 'app_id', 'bytes', 'class', 'key', 'object_id', 'provider', 'replica_since']);
    assert.deepStrictEqual([rows[0].payload.from, rows[0].payload.to, rows[1].payload.bytes], ['local', 'r2', promoted.bytes.length]);
    console.log('✅ promote: requested then ready, with object subject and verified video payload');

    // 2. Gate off is a dry run and writes no placement event.
    const dry = await addObject();
    assert.strictEqual((await tiering.promote(dry.id, { settings: disabled })).outcome, 'dry_run');
    assert.deepStrictEqual(await rowsFor(dry.id), []);
    console.log('✅ gate off: dry_run without placement events');

    // 3. A bad copied checksum leaves only the request.
    const failed = await addObject();
    corrupt = true;
    assert.strictEqual((await tiering.promote(failed.id, { settings: enabled })).outcome, 'failed');
    corrupt = false;
    assert.deepStrictEqual((await rowsFor(failed.id)).map((e) => e.event_type), ['media.replica.requested']);
    console.log('✅ failed verification: requested without ready');

    // 4. Demotion announces draining before deletion and eviction after the location is removed.
    assert.strictEqual((await tiering.demote(promoted.id, { settings: enabled })).outcome, 'done');
    rows = await rowsFor(promoted.id);
    assert.deepStrictEqual(rows.map((e) => e.event_type),
        ['media.replica.requested', 'media.replica.ready', 'media.replica.draining', 'media.replica.evicted']);
    for (const e of rows.slice(2)) {
        assert.deepStrictEqual(e.subject, { type: 'object', id: promoted.id });
        assert.deepStrictEqual(Object.keys(e.payload).sort(), ['action', 'app_id', 'class', 'key', 'object_id', 'provider']);
        assert.deepStrictEqual([e.payload.action, e.payload.class, e.payload.provider], ['demote', 'video', 'r2']);
    }
    console.log('✅ demote: draining then evicted');

    // 5. Sandbox placement is refused and has no outbox row.
    const sandboxed = await addObject(sandbox);
    assert.strictEqual((await tiering.promote(sandboxed.id, { settings: enabled })).outcome, 'refused');
    assert.strictEqual(await raw.tx(async () => await events.recordPlacement('media.replica.requested', sandbox,
        { type: 'object', id: sandboxed.id }, { object_id: sandboxed.id })), null);
    assert.deepStrictEqual(await rowsFor(sandboxed.id), []);
    console.log('✅ sandbox tenant: zero placement rows');

    // 6. With the outbox disabled, a normal move still succeeds and writes no event.
    events._reset();
    assert.strictEqual(events.init({ eventsUrl: '', clientSecret: '' }), null);
    const off = await addObject();
    assert.strictEqual((await tiering.promote(off.id, { settings: enabled })).outcome, 'done');
    assert.deepStrictEqual(await rowsFor(off.id), []);
    console.log('✅ outbox off: successful move and zero placement rows');

    // 7. A healthy-to-unhealthy flip and a capability loss each emit once, not once per tick.
    events._reset();
    events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 3600000 });
    providers.reset();
    let healthy = true;
    storage.probeProvider = async () => { if (!healthy) throw new Error('test outage'); };
    assert.strictEqual((await providers.liveHealth('r2')).healthy, true);
    healthy = false;
    assert.strictEqual((await providers.liveHealth('r2')).healthy, false);
    await waitFor(async () => (await rowsFor('r2')).some((e) => e.event_type === 'media.provider.health_degraded'));
    await providers.liveHealth('r2');
    assert.strictEqual((await rowsFor('r2')).filter((e) => e.event_type === 'media.provider.health_degraded').length, 1);
    providers._setCapabilities('r2', { passed: true, capabilities: { range: true, range_206: true } });
    providers._setCapabilities('r2', { passed: true, capabilities: { range: true, range_206: false } });
    await waitFor(async () => (await rowsFor('r2')).some((e) => e.event_type === 'media.provider.capacity_warning'));
    providers._setCapabilities('r2', { passed: true, capabilities: { range: true, range_206: false } });
    rows = await rowsFor('r2');
    assert.deepStrictEqual(rows.map((e) => e.event_type), ['media.provider.health_degraded', 'media.provider.capacity_warning']);
    assert.deepStrictEqual(rows.map((e) => e.subject), [{ type: 'provider', id: 'r2' }, { type: 'provider', id: 'r2' }]);
    assert.deepStrictEqual(rows[1].payload, { app_id: null, provider: 'r2', classes: [], previous_classes: ['online-hot'] });
    console.log('✅ provider transitions: one health degradation and one class-loss warning');

    providers.reset();
    events._reset();
    stub.close();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('placement-events: all seven cases passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
