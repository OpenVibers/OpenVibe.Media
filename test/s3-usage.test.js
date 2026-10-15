'use strict';
// ADR-031 section 8: Media counts each zone's use of the S3 surface and sends every closed hour as media.usage.recorded
// (common.usage-recorded@1): writes, lists, reads and egress as they are answered, stored bytes as byte_hours sampled
// each minute, refusals by code. Late counts raise a sent hour's revision and it is sent again.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-s3u-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    process.env.MEDIA_S3_KEY_SECRET = 'k'.repeat(40);           // a test value: 32+ characters
    process.env.MEDIA_S3_HOSTS = '127.0.0.1';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const events = require('../server/events');
    const usage = require('../server/s3/usage');
    const { serviceAuth, zones: zoneContracts, ids, validate } = require('openvibe-contracts');
    const express = require('express');
    const S3 = require('@aws-sdk/client-s3');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const svc = (sub, cap) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub, actor_type: 'service', aud: ['openvibe.media'], cap, iat: now, exp: now + 600, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey);
    const ZONE_TOKEN = svc('svc:zone', ['media.zone.provision']);
    const SERVICES_TOKEN = svc('svc:services', ['media.access_key.manage']);
    const ADMIN = `usr_${ids.ulid()}`;
    const PRJ = `prj_${ids.ulid()}`;

    const s3router = require('../server/s3/routes');
    const admin = require('../server/s3/admin-routes');
    const app = express();
    app.use((req, res, next) => (s3router.isS3Host(req) ? s3router(req, res, next) : next()));
    app.use('/internal/zones', admin.internalRouter());
    app.use('/api/v1/projects/:project/access-keys', admin.keysRouter({ projects: { isAdmin: async (p, s) => s === ADMIN && p === PRJ } }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const internal = async (method, p, { token, body } = {}) => {
        const res = await fetch(`http://localhost:${port}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const zoneRecord = (env, name) => {
        const z = { id: `zon_${ids.ulid()}`, project_id: PRJ, env, name, default: name === 'default', access: name === 'default' ? 'per-object' : 'private', state: 'active',
            quota_bytes: null, revision: 1, created_at: new Date().toISOString() };
        return Object.assign(z, zoneContracts.identity(z));
    };
    const rows = async (zoneId) => db.all('SELECT * FROM media_s3_usage WHERE zone_id = ? ORDER BY capability, unit', [zoneId]);
    const row = (list, capability, unit) => list.find((r) => r.capability === capability && r.unit === unit);

    // What the outbox would store: the rollups, as recordUsage receives them inside its transaction.
    const sent = [];
    events.recordUsage = async (payload) => { sent.push(payload); return { event_id: `evt_${ids.ulid()}` }; };

    try {
        const assets = zoneRecord('production', 'assets');
        const scratch = zoneRecord('sandbox', 'scratch');
        for (const z of [zoneRecord('production', 'default'), assets, zoneRecord('sandbox', 'default'), scratch]) {
            assert.strictEqual((await internal('PUT', `/internal/zones/${z.id}`, { token: ZONE_TOKEN, body: z })).status, 200);
        }
        const issue = async (env) => (await internal('POST', `/api/v1/projects/${PRJ}/access-keys`, { token: SERVICES_TOKEN, body: { on_behalf_of: ADMIN, env, name: env } })).body;
        const k = await issue('production');
        const ks = await issue('sandbox');
        const client = (key) => new S3.S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: key.key.id, secretAccessKey: key.secret } });
        const s3 = client(k);

        // ── Requests count as they are answered ──
        const body = crypto.randomBytes(3000);
        await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'a.bin', Body: body }));
        await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'b.txt', Body: 'hello' }));
        const got = await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'a.bin' }));
        assert.strictEqual(Buffer.from(await got.Body.transformToByteArray()).length, 3000);
        await s3.send(new S3.HeadObjectCommand({ Bucket: 'assets', Key: 'b.txt' }));
        await assert.rejects(s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'missing' })), /NoSuchKey/);
        await s3.send(new S3.ListObjectsV2Command({ Bucket: 'assets' }));
        await s3.send(new S3.DeleteObjectCommand({ Bucket: 'assets', Key: 'b.txt' }));
        await assert.rejects(s3.send(new S3.GetObjectCommand({ Bucket: 'nope', Key: 'x' })), /NoSuchBucket/);
        await client(ks).send(new S3.PutObjectCommand({ Bucket: 'scratch', Key: 's.txt', Body: 'sandbox' }));
        await new Promise((r) => setImmediate(r));
        assert.ok(usage._pending().size > 0, 'counted in memory first');
        await usage.flush();
        assert.strictEqual(usage._pending().size, 0, 'and flushed');
        let list = await rows(assets.id);
        assert.strictEqual(Number(row(list, 'media.object.upload', 'requests').quantity), 2, 'two writes');
        const reads = row(list, 'media.object.read', 'requests');
        assert.deepStrictEqual([Number(reads.quantity), Number(reads.errors)], [3, 1], 'three reads (GET, HEAD, a missing key), one refused');
        assert.deepStrictEqual(JSON.parse(reads.error_codes), { 'media.s3.no_such_key': 1 }, 'refusals by code');
        assert.strictEqual(JSON.parse(reads.samples)[0].status, 404);
        assert.strictEqual(Number(row(list, 'media.object.read', 'egress_bytes').quantity), 3000, 'egress: the bytes of the GET that succeeded');
        assert.strictEqual(Number(row(list, 'media.object.list', 'requests').quantity), 1);
        assert.strictEqual(Number(row(list, 'media.object.delete', 'requests').quantity), 1);
        assert.ok(!(await db.all("SELECT * FROM media_s3_usage WHERE capability LIKE '%' AND zone_id NOT IN (?, ?)", [assets.id, scratch.id])).length,
            'a request that names no zone of the key (NoSuchBucket) counts nowhere');
        assert.strictEqual(Number(row(await rows(scratch.id), 'media.object.upload', 'requests').quantity), 1, 'the sandbox zone counts on its own');
        console.log('✅ writes, reads, lists, deletes and egress counted per zone as they are answered; refusals by code');

        // ── Stored bytes: one minute of byte_hours per sample ──
        await usage.sample();
        await usage.flush();
        list = await rows(assets.id);
        assert.strictEqual(Number(row(list, 'media.object.upload', 'byte_hours').quantity), Math.round(3000 / 60), 'live bytes / 60 a minute');
        console.log('✅ stored bytes sampled each minute as byte_hours');

        // ── Closed hours go out once, as media.usage.recorded ──
        assert.strictEqual(await usage.emit(), 0, 'the current hour is not closed');
        const later = Date.now() + 3600 * 1000;
        const n = await usage.emit({ now: later });
        assert.ok(n >= 8, `every series of both zones (${n})`);
        for (const p of sent) {
            const v = validate('media.usage.recorded@1', p);
            assert.ok(v.valid, JSON.stringify(v.errors));
            assert.ok(events.checkUsage(p).valid, 'and its resource is a zone of its project');
        }
        const readRollup = sent.find((p) => p.dimension === assets.id.toLowerCase() && p.capability === 'media.object.read' && p.unit === 'requests');
        assert.strictEqual(readRollup.resource, `ovrn:zone:${PRJ}:object-zone/${assets.id}`, 'the zone named twice: its OVRN');
        assert.deepStrictEqual([readRollup.quantity, readRollup.errors, readRollup.window, readRollup.env], [3, 1, 'hour', 'production']);
        assert.ok(sent.some((p) => p.env === 'sandbox' && p.dimension === scratch.id.toLowerCase()), 'sandbox zones are rolled up too');
        assert.ok(!sent.some((p) => /usr_|ovk_|a\.bin|127\.0\.0\.1/.test(JSON.stringify(p))), 'no subject, key, object key or address in a rollup');
        const before = sent.length;
        assert.strictEqual(await usage.emit({ now: later }), 0, 'a sent hour is not sent again');
        assert.strictEqual(sent.length, before);
        console.log('✅ each closed hour sent once as media.usage.recorded (valid, OVRN and dimension, sandbox included, no names)');

        // ── A late count corrects the hour: revision 2 ──
        const window = Number(readRollup.window_start ? Date.parse(readRollup.window_start) : 0);
        usage.count({ id: assets.id, project_id: PRJ, env: 'production' }, 'media.object.read', 'requests', 1, { now: window + 1000 });
        await usage.flush();
        assert.strictEqual(await usage.emit({ now: later }), 1, 'the corrected hour goes out again');
        const fixed = sent[sent.length - 1];
        assert.deepStrictEqual([fixed.quantity, fixed.revision, fixed.capability], [4, 2, 'media.object.read'], 'with its new total and revision');
        console.log('✅ late counts raise the revision and the hour is re-sent with its total');

        // ── An invalid rollup stays unsent ──
        await db.run(`INSERT INTO media_s3_usage (zone_id, project_id, env, window_start, capability, unit, quantity, errors, revision, updated_at)
            VALUES (?, ?, 'production', ?, 'not a capability', 'requests', 1, 0, 1, ?)`, [assets.id, PRJ, window, Date.now()]);
        const quiet = console.error;
        const logged = [];
        console.error = (...a) => logged.push(a.join(' '));
        try { await usage.emit({ now: later }); } finally { console.error = quiet; }
        assert.ok(logged.some((l) => /stays unsent/.test(l)), 'it is logged');
        assert.ok((await db.get("SELECT sent_revision FROM media_s3_usage WHERE capability = 'not a capability'")).sent_revision == null, 'and not marked sent');
        await db.run("DELETE FROM media_s3_usage WHERE capability = 'not a capability'");
        console.log('✅ a rollup that does not match the contract stays unsent');

        // ── Prune: sent rows past the retention go ──
        assert.strictEqual(await usage.prune({ now: later + 41 * 24 * 3600 * 1000 }) > 0, true);
        assert.strictEqual((await rows(assets.id)).length, 0);
        console.log('✅ sent rows are pruned after 40 days');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('s3 usage: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
