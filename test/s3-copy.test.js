'use strict';
// CopyObject and UploadPartCopy on Media's S3 surface (ADR-031): a server-side copy reads the source with the same key
// (a zone of its environment it may read) and writes the destination through the one commit path (quota, holds,
// deletion of the previous object). COPY keeps the source's type and metadata, REPLACE takes the request's; a copy
// onto itself must change something; the copy-source conditions hold; UploadPartCopy takes byte ranges.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-s3c-'));
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
    const usage = require('../server/s3/usage');
    const { serviceAuth, zones: zoneContracts, ids } = require('openvibe-contracts');
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
    const zoneRecord = (env, name, over = {}) => {
        const z = { id: `zon_${ids.ulid()}`, project_id: PRJ, env, name, default: name === 'default', access: name === 'default' ? 'per-object' : 'private', state: 'active',
            quota_bytes: null, revision: 1, created_at: new Date().toISOString(), ...over };
        return Object.assign(z, zoneContracts.identity(z));
    };
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

    try {
        const assets = zoneRecord('production', 'assets');
        const backup = zoneRecord('production', 'backup');
        const tiny = zoneRecord('production', 'tiny', { quota_bytes: 64 });
        const sandboxZone = zoneRecord('sandbox', 'assets');
        for (const z of [zoneRecord('production', 'default'), assets, backup, tiny, zoneRecord('sandbox', 'default'), sandboxZone]) {
            assert.strictEqual((await internal('PUT', `/internal/zones/${z.id}`, { token: ZONE_TOKEN, body: z })).status, 200);
        }
        const issue = async (body) => (await internal('POST', `/api/v1/projects/${PRJ}/access-keys`, { token: SERVICES_TOKEN, body: { on_behalf_of: ADMIN, env: 'production', ...body } })).body;
        const full = await issue({ name: 'full' });
        const backupOnly = await issue({ name: 'backup only', zones: [backup.id] });
        const reader = await issue({ name: 'reader', permissions: 'read' });
        const client = (k) => new S3.S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: k.key.id, secretAccessKey: k.secret } });
        const s3 = client(full);
        // An answer's Cache-Control is always private, no-store (the edge never keeps one): the stored value is read here.
        const storedCache = async (zone, key) => {
            const row = await db.get("SELECT metadata FROM media_objects WHERE zone_id = ? AND object_key = ? AND lifecycle_status = 'ready'", [zone.id, key]);
            const md = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            return md.cache_control;
        };
        const read = async (Bucket, Key, zone = assets) => {
            const o = await s3.send(new S3.GetObjectCommand({ Bucket, Key }));
            return { body: Buffer.from(await o.Body.transformToByteArray()), type: o.ContentType, meta: o.Metadata, cache: await storedCache(zone, Key), etag: o.ETag };
        };

        // ── CopyObject: COPY keeps the source's type and metadata ──
        const body = crypto.randomBytes(4000);
        await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'docs/report.pdf', Body: body, ContentType: 'application/pdf', CacheControl: 'max-age=60', Metadata: { owner: 'finance' } }));
        let out = await s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'docs/report-copy.pdf', CopySource: 'assets/docs/report.pdf' }));
        assert.strictEqual(out.CopyObjectResult.ETag, `"${md5(body)}"`, 'the copy\'s ETag is the MD5 of its bytes');
        assert.ok(out.CopyObjectResult.LastModified instanceof Date);
        let got = await read('assets', 'docs/report-copy.pdf');
        assert.deepStrictEqual([sha(got.body), got.type, got.meta, got.cache], [sha(body), 'application/pdf', { owner: 'finance' }, 'max-age=60'], 'bytes, type and metadata copied');
        out = await s3.send(new S3.CopyObjectCommand({ Bucket: 'backup', Key: '2026/report.pdf', CopySource: encodeURIComponent('/assets/docs/report.pdf') }));
        assert.strictEqual(sha((await read('backup', '2026/report.pdf', backup)).body), sha(body), 'across zones, with a leading slash and URL-encoded');
        console.log('✅ CopyObject (COPY): bytes, type, metadata and ETag; across zones; both copy-source spellings');

        // ── REPLACE takes the request's; a copy onto itself must change something ──
        await s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'docs/report-copy.pdf', CopySource: 'assets/docs/report.pdf', MetadataDirective: 'REPLACE', ContentType: 'application/octet-stream', Metadata: { owner: 'ops' } }));
        got = await read('assets', 'docs/report-copy.pdf');
        assert.deepStrictEqual([got.type, got.meta, got.cache], ['application/octet-stream', { owner: 'ops' }, undefined], 'REPLACE: the request\'s type and metadata');
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'docs/report.pdf', CopySource: 'assets/docs/report.pdf' })), /InvalidRequest/, 'a copy onto itself changing nothing is refused');
        await s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'docs/report.pdf', CopySource: 'assets/docs/report.pdf', MetadataDirective: 'REPLACE', ContentType: 'application/pdf', Metadata: { owner: 'finance', reviewed: 'yes' } }));
        got = await read('assets', 'docs/report.pdf');
        assert.deepStrictEqual([sha(got.body), got.meta], [sha(body), { owner: 'finance', reviewed: 'yes' }], 'onto itself with REPLACE: the metadata changes, the bytes stay');
        const versions = await db.all("SELECT lifecycle_status FROM media_objects WHERE zone_id = ? AND object_key = 'docs/report.pdf'", [assets.id]);
        assert.deepStrictEqual(versions.map((v) => v.lifecycle_status).sort(), ['deleted', 'ready'], 'the previous object went through the deletion path');
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'x', CopySource: 'assets/docs/report.pdf', MetadataDirective: 'MERGE' })), /InvalidArgument/);
        console.log('✅ REPLACE; a copy onto itself must change something, and then replaces through the deletion path');

        // ── Conditions, missing sources, scopes and permissions ──
        const etag = `"${md5(body)}"`;
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c1', CopySource: 'assets/docs/report.pdf', CopySourceIfMatch: '"0000"' })), /PreconditionFailed/);
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c1', CopySource: 'assets/docs/report.pdf', CopySourceIfNoneMatch: etag })), /PreconditionFailed/);
        await s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c1', CopySource: 'assets/docs/report.pdf', CopySourceIfMatch: etag }));
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c2', CopySource: 'assets/docs/report.pdf', CopySourceIfModifiedSince: new Date(Date.now() + 3600e3) })), /PreconditionFailed/);
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c2', CopySource: 'assets/nope.pdf' })), /NoSuchKey/);
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c2', CopySource: 'assets' })), /InvalidArgument/);
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c2', CopySource: 'nowhere/docs/report.pdf' })), /NoSuchBucket/);
        await assert.rejects(client(backupOnly).send(new S3.CopyObjectCommand({ Bucket: 'backup', Key: 'stolen.pdf', CopySource: 'assets/docs/report.pdf' })), /AccessDenied/, 'a key scoped to its zone cannot read another as the source');
        await assert.rejects(client(reader).send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'c3', CopySource: 'assets/docs/report.pdf' })), /AccessDenied/, 'a read key cannot write the copy');
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'tiny', Key: 'big', CopySource: 'assets/docs/report.pdf' })), /QuotaExceeded/, 'the destination\'s quota holds');
        console.log('✅ copy-source conditions; missing sources and buckets; zone scopes, read-only keys and quotas hold');

        // ── UploadPartCopy: byte ranges into a multipart upload ──
        const big = crypto.randomBytes(6 * 1024 * 1024 + 123);
        await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'big.bin', Body: big }));
        const { UploadId } = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket: 'backup', Key: 'big-copy.bin' }));
        const FIVE = 5 * 1024 * 1024;
        const p1 = await s3.send(new S3.UploadPartCopyCommand({ Bucket: 'backup', Key: 'big-copy.bin', UploadId, PartNumber: 1, CopySource: 'assets/big.bin', CopySourceRange: `bytes=0-${FIVE - 1}` }));
        assert.strictEqual(p1.CopyPartResult.ETag, `"${md5(big.subarray(0, FIVE))}"`);
        const p2 = await s3.send(new S3.UploadPartCopyCommand({ Bucket: 'backup', Key: 'big-copy.bin', UploadId, PartNumber: 2, CopySource: 'assets/big.bin', CopySourceRange: `bytes=${FIVE}-${big.length - 1}` }));
        await assert.rejects(s3.send(new S3.UploadPartCopyCommand({ Bucket: 'backup', Key: 'big-copy.bin', UploadId, PartNumber: 3, CopySource: 'assets/big.bin', CopySourceRange: `bytes=0-${big.length}` })), /InvalidArgument/, 'a range past the source is refused');
        await s3.send(new S3.CompleteMultipartUploadCommand({ Bucket: 'backup', Key: 'big-copy.bin', UploadId,
            MultipartUpload: { Parts: [{ PartNumber: 1, ETag: p1.CopyPartResult.ETag }, { PartNumber: 2, ETag: p2.CopyPartResult.ETag }] } }));
        assert.strictEqual(sha((await read('backup', 'big-copy.bin', backup)).body), sha(big), 'the parts copied by range make the source again');
        const { UploadId: u2 } = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket: 'backup', Key: 'small.bin' }));
        const whole = await s3.send(new S3.UploadPartCopyCommand({ Bucket: 'backup', Key: 'small.bin', UploadId: u2, PartNumber: 1, CopySource: 'assets/docs/report.pdf' }));
        assert.strictEqual(whole.CopyPartResult.ETag, etag, 'without a range, the whole source is the part');
        await assert.rejects(s3.send(new S3.UploadPartCopyCommand({ Bucket: 'backup', Key: 'small.bin', UploadId: 'mpu_01JZ0000000000000000000000', PartNumber: 1, CopySource: 'assets/docs/report.pdf' })), /NoSuchUpload/);
        console.log('✅ UploadPartCopy: ranges, the whole source, a range past the end refused, completes to the source\'s bytes');

        // ── A copy counts as a write of the destination zone ──
        usage._reset();
        await s3.send(new S3.CopyObjectCommand({ Bucket: 'backup', Key: 'counted.pdf', CopySource: 'assets/docs/report.pdf' }));
        await new Promise((r) => setImmediate(r));
        const counted = [...usage._pending().values()];
        assert.ok(counted.some((b) => b.zone.id === backup.id && b.capability === 'media.object.upload' && b.unit === 'requests' && b.quantity === 1), 'one write in the destination zone');
        assert.ok(!counted.some((b) => b.zone.id === assets.id), 'the source zone is not charged a read');
        console.log('✅ a copy counts as one write of the destination zone');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('s3 copies: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
