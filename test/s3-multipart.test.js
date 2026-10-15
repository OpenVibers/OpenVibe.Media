'use strict';
// S3 multipart uploads on Media's S3 surface (server/s3/multipart.js) with the AWS SDK v3: the SDK's Upload helper
// (parallel parts) round-trips an 11 MiB object; the raw commands follow S3's rules (5 MiB minimum but for the last
// part, ascending order, matching ETags, a re-sent part replaces the earlier one); the ETag is the MD5 of the parts'
// MD5s; ListParts and ListMultipartUploads; Abort removes the parts; quotas count every part; uploads expire.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-s3mp-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.OV_NETWORK_URL = 'https://openvibe.network';
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
    process.env.MEDIA_S3_KEY_SECRET = 'k'.repeat(40);                 // a test value: 32+ characters
    process.env.MEDIA_S3_HOSTS = '127.0.0.1';
    process.env.MEDIA_APP_TENANT_QUOTA_MB = '40';

    const db = require('../server/db/database');
    const auth = require('../server/auth');
    const mp = require('../server/s3/multipart');
    const { serviceAuth, zones: zoneContracts, ids } = require('openvibe-contracts');
    const express = require('express');
    const S3 = require('@aws-sdk/client-s3');
    const { Upload } = require('@aws-sdk/lib-storage');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const svc = (sub, cap) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub, actor_type: 'service', aud: ['openvibe.media'], cap, iat: now, exp: now + 600, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey);
    const ADMIN = `usr_${ids.ulid()}`;
    const PRJ = `prj_${ids.ulid()}`;

    const s3router = require('../server/s3/routes');
    const admin = require('../server/s3/admin-routes');
    const app = express();
    app.use((req, res, next) => (s3router.isS3Host(req) ? s3router(req, res, next) : next()));
    app.use('/internal/zones', admin.internalRouter());
    app.use('/api/v1/projects/:project/access-keys', admin.keysRouter({ projects: { isAdmin: async (_p, s) => s === ADMIN } }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const internal = async (method, p, token, body) => {
        const res = await fetch(`http://localhost:${port}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const zone = (name, over = {}) => {
        const z = { id: `zon_${ids.ulid()}`, project_id: PRJ, env: 'production', name, default: false, access: 'private', state: 'active', quota_bytes: null, revision: 1, created_at: new Date().toISOString(), ...over };
        return Object.assign(z, zoneContracts.identity(z));
    };
    const MiB = 1024 * 1024;

    try {
        const big = zone('big');
        const small = zone('small', { quota_bytes: 7 * MiB });
        for (const z of [big, small]) assert.strictEqual((await internal('PUT', `/internal/zones/${z.id}`, svc('svc:zone', ['media.zone.provision']), z)).status, 200);
        const issued = (await internal('POST', `/api/v1/projects/${PRJ}/access-keys`, svc('svc:services', ['media.access_key.manage']), { env: 'production', name: 'mp', on_behalf_of: ADMIN })).body;
        const s3 = new S3.S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: issued.key.id, secretAccessKey: issued.secret } });

        // ── The SDK's Upload helper: 11 MiB in parts of 5 MiB, sent in parallel ──
        const body = crypto.randomBytes(11 * MiB);
        const done = await new Upload({ client: s3, params: { Bucket: 'big', Key: 'videos/clip.bin', Body: body, ContentType: 'video/mp4', Metadata: { origin: 'camera' } }, partSize: 5 * MiB, queueSize: 3 }).done();
        const partMd5s = [0, 1, 2].map((i) => crypto.createHash('md5').update(body.subarray(i * 5 * MiB, Math.min((i + 1) * 5 * MiB, body.length))).digest());
        const want = `"${crypto.createHash('md5').update(Buffer.concat(partMd5s)).digest('hex')}-3"`;
        assert.strictEqual(done.ETag, want, 'the multipart ETag is the MD5 of the parts\' MD5s, then -3');
        let out = await s3.send(new S3.GetObjectCommand({ Bucket: 'big', Key: 'videos/clip.bin' }));
        assert.ok(Buffer.from(await out.Body.transformToByteArray()).equals(body), 'the joined object is the bytes sent');
        assert.deepStrictEqual([out.ContentType, out.Metadata.origin, out.ETag], ['video/mp4', 'camera', want]);
        const row = await db.get("SELECT * FROM media_objects WHERE zone_id = ? AND object_key = 'videos/clip.bin' AND lifecycle_status = 'ready'", [big.id]);
        assert.strictEqual(row.content_hash, crypto.createHash('sha256').update(body).digest('hex'), 'the object\'s sha256 is the whole object\'s');
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_s3_uploads')).n, 0, 'a completed upload leaves nothing behind');
        console.log('✅ the SDK\'s Upload helper round-trips 11 MiB in three parallel parts; S3\'s multipart ETag');

        // ── The raw commands and S3's rules ──
        const create = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket: 'big', Key: 'raw.bin' }));
        const UploadId = create.UploadId;
        assert.ok(/^mpu_/.test(UploadId));
        const p1 = Buffer.alloc(5 * MiB, 1), p2a = Buffer.alloc(1024, 2), p2b = Buffer.alloc(2048, 3), tiny = Buffer.alloc(10, 4);
        const e1 = (await s3.send(new S3.UploadPartCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, PartNumber: 1, Body: p1 }))).ETag;
        await s3.send(new S3.UploadPartCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, PartNumber: 2, Body: p2a }));
        const e2 = (await s3.send(new S3.UploadPartCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, PartNumber: 2, Body: p2b }))).ETag;
        const eT = (await s3.send(new S3.UploadPartCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, PartNumber: 3, Body: tiny }))).ETag;
        const listed = await s3.send(new S3.ListPartsCommand({ Bucket: 'big', Key: 'raw.bin', UploadId }));
        assert.deepStrictEqual(listed.Parts.map((p) => [p.PartNumber, p.Size]), [[1, 5 * MiB], [2, 2048], [3, 10]], 'a re-sent part replaces the earlier one');
        const uploads = await s3.send(new S3.ListMultipartUploadsCommand({ Bucket: 'big' }));
        assert.deepStrictEqual(uploads.Uploads.map((u) => u.UploadId), [UploadId]);
        await assert.rejects(s3.send(new S3.CompleteMultipartUploadCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 2, ETag: e2 }, { PartNumber: 1, ETag: e1 }] } })), /InvalidPartOrder/);
        await assert.rejects(s3.send(new S3.CompleteMultipartUploadCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: e1 }, { PartNumber: 2, ETag: '"00000000000000000000000000000000"' }] } })), /InvalidPart/);
        await assert.rejects(s3.send(new S3.CompleteMultipartUploadCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: e1 }, { PartNumber: 2, ETag: e2 }, { PartNumber: 3, ETag: eT }] } })), /EntityTooSmall/, 'every part but the last is at least 5 MiB');
        out = await s3.send(new S3.CompleteMultipartUploadCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: e1 }, { PartNumber: 2, ETag: e2 }] } }));
        assert.ok(out.ETag.endsWith('-2"'));
        out = await s3.send(new S3.GetObjectCommand({ Bucket: 'big', Key: 'raw.bin' }));
        assert.ok(Buffer.from(await out.Body.transformToByteArray()).equals(Buffer.concat([p1, p2b])), 'only the named parts, in order');
        await assert.rejects(s3.send(new S3.UploadPartCommand({ Bucket: 'big', Key: 'raw.bin', UploadId, PartNumber: 4, Body: tiny })), /NoSuchUpload/, 'a completed upload takes no more parts');
        console.log('✅ CreateMultipartUpload, UploadPart (replace), ListParts, ListMultipartUploads, Complete with S3\'s rules');

        // ── Abort, quota, other keys and zones, expiry ──
        const ab = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket: 'big', Key: 'gone.bin' }));
        await s3.send(new S3.UploadPartCommand({ Bucket: 'big', Key: 'gone.bin', UploadId: ab.UploadId, PartNumber: 1, Body: tiny }));
        await s3.send(new S3.AbortMultipartUploadCommand({ Bucket: 'big', Key: 'gone.bin', UploadId: ab.UploadId }));
        assert.ok(!fs.existsSync(path.join(process.env.OBJECTS_PATH, '.tmp', 's3mp', ab.UploadId)), 'abort removes the parts');
        await assert.rejects(s3.send(new S3.ListPartsCommand({ Bucket: 'big', Key: 'gone.bin', UploadId: ab.UploadId })), /NoSuchUpload/);
        await assert.rejects(s3.send(new S3.ListPartsCommand({ Bucket: 'small', Key: 'raw.bin', UploadId })), /NoSuchUpload/, 'an upload belongs to its zone and key');
        const q = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket: 'small', Key: 'q.bin' }));
        await s3.send(new S3.UploadPartCommand({ Bucket: 'small', Key: 'q.bin', UploadId: q.UploadId, PartNumber: 1, Body: Buffer.alloc(5 * MiB) }));
        await assert.rejects(s3.send(new S3.UploadPartCommand({ Bucket: 'small', Key: 'q.bin', UploadId: q.UploadId, PartNumber: 2, Body: Buffer.alloc(3 * MiB) })), /QuotaExceeded/, 'parts count toward the zone\'s quota as they arrive');
        await db.run('UPDATE media_s3_uploads SET expires_at = 1 WHERE id = ?', [q.UploadId]);
        assert.strictEqual(await mp.sweep(), 1, 'an expired upload is swept');
        assert.ok(!fs.existsSync(path.join(process.env.OBJECTS_PATH, '.tmp', 's3mp', q.UploadId)));
        console.log('✅ abort, an upload bound to its zone and key, quota across parts, expiry');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('s3 multipart: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
