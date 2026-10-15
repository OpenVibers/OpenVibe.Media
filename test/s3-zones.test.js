'use strict';
// ADR-031 and its zone amendment, end to end with the AWS SDK for JavaScript v3 against a local Media:
// zones provisioned by Zone's revisioned PUT, access keys issued on behalf of a project admin, every supported S3
// operation (PutObject plain and aws-chunked, GetObject with ranges, HeadObject, ListObjectsV2/v1 with prefixes,
// delimiters and pages, DeleteObject, DeleteObjects, ListBuckets, HeadBucket), presigned GET and PUT, two doors
// (S3 and the native API) on one object, isolation (zone-scoped and read-only keys, other environments), quotas,
// overwrite under a hold, the NotImplemented answers, and zone deletion with no name reuse.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-s3-'));
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
    const model = require('../server/objects/model');
    const zones = require('../server/s3/zones');
    const { serviceAuth, zones: zoneContracts, ids } = require('openvibe-contracts');
    const express = require('express');
    const S3 = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const svc = (sub, cap, over = {}) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub, actor_type: 'service', aud: ['openvibe.media'], cap, iat: now, exp: now + 600, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...over }, keys.privateKey);
    const ZONE_TOKEN = svc('svc:zone', ['media.zone.provision']);
    const SERVICES_TOKEN = svc('svc:services', ['media.access_key.manage']);
    const ADMIN = `usr_${ids.ulid()}`, STRANGER = `usr_${ids.ulid()}`;
    const PRJ = `prj_${ids.ulid()}`, OTHER = `prj_${ids.ulid()}`;

    // Same mount order as server/index.js.
    const s3router = require('../server/s3/routes');
    const admin = require('../server/s3/admin-routes');
    const app = express();
    app.use((req, res, next) => (s3router.isS3Host(req) ? s3router(req, res, next) : next()));
    app.use('/internal/zones', admin.internalRouter());
    app.use('/api/v1/projects/:project/access-keys', admin.keysRouter({ projects: { isAdmin: async (p, s) => s === ADMIN && [PRJ, OTHER].includes(p) } }));
    app.put('/api/v2/:app/objects/:id/content', ...require('../server/objects/routes').contentHandlers);
    app.use(express.json());
    app.use('/api/v2/:app/objects', require('../server/objects/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    // The internal doors are reached as localhost (a different Host than the S3 one) from loopback.
    const internal = async (method, p, { token, body } = {}) => {
        const res = await fetch(`http://localhost:${port}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const zoneRecord = (projectId, env, name, over = {}) => {
        const id = over.id || `zon_${ids.ulid()}`;
        const isDefault = name === 'default';
        const z = { id, project_id: projectId, env, name, default: isDefault, access: isDefault ? 'per-object' : 'private', state: 'active',
            quota_bytes: null, revision: 1, created_at: new Date().toISOString(), ...over };
        Object.assign(z, zoneContracts.identity(z));
        return z;
    };
    const provision = async (z) => internal('PUT', `/internal/zones/${z.id}`, { token: ZONE_TOKEN, body: z });

    try {
        // ── Zones from Zone ──
        const def = zoneRecord(PRJ, 'production', 'default');
        const assets = zoneRecord(PRJ, 'production', 'assets');
        const logs = zoneRecord(PRJ, 'production', 'logs', { quota_bytes: 64 });
        const sandbox = zoneRecord(PRJ, 'sandbox', 'assets');
        const otherAssets = zoneRecord(OTHER, 'production', 'assets');
        for (const z of [def, assets, logs, sandbox, otherAssets]) {
            const r = await provision(z);
            assert.deepStrictEqual([r.status, r.body.applied, r.body.state], [200, true, 'active'], JSON.stringify(r.body));
        }
        let r = await provision(assets);
        assert.deepStrictEqual([r.status, r.body.applied], [200, false], 'a repeat (same revision) changes nothing');
        r = await provision({ ...zoneRecord(PRJ, 'production', 'assets'), revision: 1 });
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.zone.name_retired'], 'a name belongs to one zone of its environment');
        r = await provision({ ...assets, media_namespace: `app.${OTHER}.${assets.id}`, revision: 2 });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'media.zone.invalid'], 'a record naming another project\'s namespace is refused (checkObjectZone)');
        r = await internal('PUT', `/internal/zones/${assets.id}`, { token: SERVICES_TOKEN, body: assets });
        assert.strictEqual(r.status, 403, 'only media.zone.provision provisions');
        console.log('✅ zones: provisioned by revision, names never reused, identity checked, capability required');

        // ── Keys, on behalf of a project admin ──
        const issue = async (body, project = PRJ) => internal('POST', `/api/v1/projects/${project}/access-keys`, { token: SERVICES_TOKEN, body: { on_behalf_of: ADMIN, ...body } });
        r = await internal('POST', `/api/v1/projects/${PRJ}/access-keys`, { token: SERVICES_TOKEN, body: { on_behalf_of: STRANGER, env: 'production', name: 'x' } });
        assert.deepStrictEqual([r.status, r.body.code], [403, 'media.access_key.not_admin'], 'only a project admin gets keys');
        const issued = await issue({ env: 'production', name: 'ci deploys' });
        assert.strictEqual(issued.status, 201, JSON.stringify(issued.body));
        const full = issued.body;
        assert.ok(/^ovk_/.test(full.key.id) && full.secret.length === 40 && !('secret' in (await internal('GET', `/api/v1/projects/${PRJ}/access-keys?on_behalf_of=${ADMIN}`, { token: SERVICES_TOKEN })).body.keys[0]), 'the secret is shown once');
        const scoped = (await issue({ env: 'production', name: 'logs only', zones: [logs.id] })).body;
        const reader = (await issue({ env: 'production', name: 'reader', permissions: 'read' })).body;
        const sbox = (await issue({ env: 'sandbox', name: 'sandbox' })).body;
        const other = (await issue({ env: 'production', name: 'other' }, OTHER)).body;
        r = await issue({ env: 'production', name: 'bad', zones: [sandbox.id] });
        assert.deepStrictEqual([r.status, r.body.code], [404, 'media.access_key.unknown_zone'], 'a key cannot name a zone of another environment');
        console.log('✅ access keys: issued for admins only, secret once, scopes checked');

        const client = (k) => new S3.S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: k.key.id, secretAccessKey: k.secret } });
        const s3 = client(full);
        const body = Buffer.from('hello zones\n'.repeat(100));
        const md5 = crypto.createHash('md5').update(body).digest('hex');

        // ── PutObject, GetObject, HeadObject ──
        let out = await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'site/index.html', Body: body, ContentType: 'text/html', Metadata: { mtime: '1700000000' } }));
        assert.strictEqual(out.ETag, `"${md5}"`, 'the ETag is the MD5 of the bytes, as S3 makes it');
        out = await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'site/index.html' }));
        assert.deepStrictEqual([Buffer.from(await out.Body.transformToByteArray()).equals(body), out.ContentType, out.Metadata.mtime], [true, 'text/html', '1700000000']);
        out = await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'site/index.html', Range: 'bytes=6-10' }));
        assert.deepStrictEqual([await out.Body.transformToString(), out.ContentRange], ['zones', `bytes 6-10/${body.length}`]);
        out = await s3.send(new S3.HeadObjectCommand({ Bucket: 'assets', Key: 'site/index.html' }));
        assert.deepStrictEqual([out.ContentLength, out.ETag], [body.length, `"${md5}"`]);
        // A streamed body of known length goes aws-chunked with a trailing checksum (the SDK's default).
        await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'stream/a b+c.bin', Body: Readable.from([body.subarray(0, 500), body.subarray(500)]), ContentLength: body.length }));
        out = await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'stream/a b+c.bin' }));
        assert.ok(Buffer.from(await out.Body.transformToByteArray()).equals(body), 'a streamed upload with a space and + in its key round-trips');
        const raw = await fetch(`http://127.0.0.1:${port}/assets/site/index.html`);
        assert.deepStrictEqual([raw.status, raw.headers.get('content-security-policy')], [403, "sandbox; default-src 'none'"], 'unsigned requests are refused, and nothing here runs in a browser');
        console.log('✅ PutObject (plain and aws-chunked), GetObject with a range, HeadObject, metadata, unsigned refused');

        // ── Two doors: the object is an ordinary Media object ──
        const row = await db.get("SELECT * FROM media_objects WHERE zone_id = ? AND object_key = 'site/index.html' AND lifecycle_status = 'ready'", [assets.id]);
        assert.deepStrictEqual([row.namespace, row.app_id, row.content_hash, row.visibility], [assets.media_namespace, PRJ, crypto.createHash('sha256').update(body).digest('hex'), 'private']);
        const appTok = serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: `app:app_${ids.ulid()}`, actor_type: 'app', project_id: PRJ, env: 'production', aud: ['openvibe.media'], cap: ['media.object.upload', 'media.object.read', 'media.object.list', 'media.object.delete'], ns: [PRJ], iat: now, exp: now + 600, jti: 'tok_app1' }, keys.privateKey);
        const native = async (method, p, b) => { const res = await fetch(`http://localhost:${port}/api/v2/${PRJ}/objects${p}`, { method, headers: { authorization: `Bearer ${appTok}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: res.status, body: await res.json().catch(() => null) }; };
        r = await native('GET', `/${row.id}`);
        assert.deepStrictEqual([r.status, r.body.content_hash], [200, row.content_hash], 'the native API reads an object written over S3');
        r = await native('POST', '', { namespace: assets.id, kind: 'file', size_bytes: 5, mime_type: 'text/plain', visibility: 'public' });
        assert.deepStrictEqual([r.status, r.body.code], [422, 'media.zone.private'], 'a named zone takes private objects only');
        r = await native('POST', '', { namespace: assets.id, kind: 'file', size_bytes: 5, mime_type: 'text/plain' });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const nativeId = r.body.id;
        await fetch(`http://localhost:${port}/api/v2/${PRJ}/objects/${nativeId}/content`, { method: 'PUT', headers: { authorization: `Bearer ${appTok}`, 'content-type': 'text/plain' }, body: 'hello' });
        r = await native('POST', `/${nativeId}/complete`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        out = await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: nativeId }));
        assert.strictEqual(await out.Body.transformToString(), 'hello', 'S3 reads a native object of the zone under its id');
        r = await native('POST', '', { namespace: `zon_${ids.ulid()}`, kind: 'file', size_bytes: 5, mime_type: 'text/plain' });
        assert.deepStrictEqual([r.status, r.body.code], [404, 'media.zone.unknown'], 'a zone that does not exist is not created by a write');
        // The default zone lists the environment's native objects under derived keys.
        r = await native('POST', '', { kind: 'file', size_bytes: 3, mime_type: 'text/plain', namespace: 'avatars' });
        const legacyId = r.body.id;
        await fetch(`http://localhost:${port}/api/v2/${PRJ}/objects/${legacyId}/content`, { method: 'PUT', headers: { authorization: `Bearer ${appTok}`, 'content-type': 'text/plain' }, body: 'old' });
        await native('POST', `/${legacyId}/complete`, {});
        out = await s3.send(new S3.ListObjectsV2Command({ Bucket: 'default' }));
        assert.deepStrictEqual((out.Contents || []).map((c) => c.Key), [`avatars/${legacyId}`], 'the default zone lists a native object under its namespace path and id, and nothing of a named zone');
        out = await s3.send(new S3.GetObjectCommand({ Bucket: 'default', Key: `avatars/${legacyId}` }));
        assert.strictEqual(await out.Body.transformToString(), 'old');
        await assert.rejects(s3.send(new S3.PutObjectCommand({ Bucket: 'default', Key: `avatars/${legacyId}`, Body: 'x' })), /InvalidArgument|med_/, 'a derived key cannot be written over S3');
        console.log('✅ two doors: one object for S3 and the native API; named zones private; the default zone lists native objects');

        // ── Listing ──
        for (const k of ['photos/2024/a.jpg', 'photos/2024/b.jpg', 'photos/2025/c.jpg', 'photos/top.jpg', 'readme.txt']) {
            await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: k, Body: k }));
        }
        out = await s3.send(new S3.ListObjectsV2Command({ Bucket: 'assets', Prefix: 'photos/', Delimiter: '/' }));
        assert.deepStrictEqual([(out.Contents || []).map((c) => c.Key), (out.CommonPrefixes || []).map((c) => c.Prefix), out.KeyCount],
            [['photos/top.jpg'], ['photos/2024/', 'photos/2025/'], 3]);
        const seen = [];
        let token;
        do {
            out = await s3.send(new S3.ListObjectsV2Command({ Bucket: 'assets', MaxKeys: 2, ContinuationToken: token }));
            seen.push(...(out.Contents || []).map((c) => c.Key));
            token = out.NextContinuationToken;
            assert.strictEqual(!!token, !!out.IsTruncated);
        } while (token);
        assert.deepStrictEqual(seen, [nativeId, 'photos/2024/a.jpg', 'photos/2024/b.jpg', 'photos/2025/c.jpg', 'photos/top.jpg', 'readme.txt', 'site/index.html', 'stream/a b+c.bin'].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)))), 'pages of two cover every key once, in byte order');
        const v1 = await s3.send(new S3.ListObjectsCommand({ Bucket: 'assets', Delimiter: '/', MaxKeys: 2 }));
        assert.deepStrictEqual([(v1.Contents || []).map((c) => c.Key), (v1.CommonPrefixes || []).map((c) => c.Prefix), v1.IsTruncated], [[nativeId], ['photos/'], true]);
        const v1b = await s3.send(new S3.ListObjectsCommand({ Bucket: 'assets', Delimiter: '/', Marker: v1.NextMarker }));
        assert.deepStrictEqual([(v1b.Contents || []).map((c) => c.Key), (v1b.CommonPrefixes || []).map((c) => c.Prefix)], [['readme.txt'], ['site/', 'stream/']], 'ListObjects v1 resumes after a common prefix marker');
        out = await s3.send(new S3.ListBucketsCommand({}));
        assert.deepStrictEqual(out.Buckets.map((b) => b.Name), ['assets', 'default', 'logs'], 'ListBuckets: the environment\'s zones, not the sandbox\'s or another project\'s');
        await s3.send(new S3.HeadBucketCommand({ Bucket: 'assets' }));
        await assert.rejects(s3.send(new S3.HeadBucketCommand({ Bucket: 'nope' })), (e) => e.$metadata.httpStatusCode === 404);
        console.log('✅ ListObjectsV2 (prefix, delimiter, pages), ListObjects v1, ListBuckets, HeadBucket');

        // ── Presigned URLs ──
        const getUrl = await getSignedUrl(s3, new S3.GetObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }), { expiresIn: 60 });
        let res = await fetch(getUrl);
        assert.deepStrictEqual([res.status, await res.text()], [200, 'readme.txt'], 'a presigned GET reads');
        const putUrl = await getSignedUrl(s3, new S3.PutObjectCommand({ Bucket: 'assets', Key: 'up/presigned.txt' }), { expiresIn: 60 });
        res = await fetch(putUrl, { method: 'PUT', body: 'via presigned put' });
        assert.strictEqual(res.status, 200, await res.text());
        out = await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'up/presigned.txt' }));
        assert.strictEqual(await out.Body.transformToString(), 'via presigned put');
        res = await fetch(getUrl.replace('readme.txt', 'site/index.html'));
        assert.strictEqual(res.status, 403, 'a presigned URL is for its own key only');
        const expired = await getSignedUrl(s3, new S3.GetObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }), { expiresIn: 1, signingDate: new Date(Date.now() - 10_000) });
        res = await fetch(expired);
        assert.deepStrictEqual([res.status, /Request has expired/.test(await res.text())], [403, true], 'an expired URL is refused');
        console.log('✅ presigned GET and PUT; a URL reaches its own key only and expires');

        // ── A HEAD that a proxy forwarded as GET (Cloudflare does for cacheable extensions) ──
        const asGet = client(full);
        asGet.middlewareStack.addRelativeTo((next) => (args) => { args.request.method = 'GET'; return next(args); },
            { relation: 'after', toMiddleware: 'awsAuthMiddleware', name: 'headSentAsGet' });
        out = await asGet.send(new S3.HeadObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }));
        assert.strictEqual(Number(out.ContentLength), 'readme.txt'.length, 'a header-signed HEAD that arrives as GET is served');
        const asDelete = client(full);
        asDelete.middlewareStack.addRelativeTo((next) => (args) => { args.request.method = 'DELETE'; return next(args); },
            { relation: 'after', toMiddleware: 'awsAuthMiddleware', name: 'headSentAsDelete' });
        await assert.rejects(asDelete.send(new S3.HeadObjectCommand({ Bucket: 'assets', Key: 'readme.txt' })), (e) => e.$metadata.httpStatusCode === 403, 'only GET stands in as HEAD');
        await s3.send(new S3.HeadObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }));
        const headUrl = await getSignedUrl(s3, new S3.HeadObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }), { expiresIn: 60 });
        assert.strictEqual((await fetch(headUrl, { method: 'HEAD' })).status, 200, 'a presigned HEAD reads the headers');
        res = await fetch(headUrl);
        assert.deepStrictEqual([res.status, /SignatureDoesNotMatch/.test(await res.text())], [403, true], 'a presigned HEAD URL never reads the body');
        const putAsGet = client(full);
        putAsGet.middlewareStack.addRelativeTo((next) => (args) => { args.request.method = 'GET'; return next(args); },
            { relation: 'after', toMiddleware: 'awsAuthMiddleware', name: 'putSentAsGet' });
        await assert.rejects(putAsGet.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'readme.txt', Body: 'nope' })), (e) => e.$metadata.httpStatusCode === 403);
        console.log('✅ a header-signed HEAD forwarded as GET is served; presigned HEAD URLs and other methods are not');

        // ── Isolation and permissions ──
        await assert.rejects(client(scoped).send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'readme.txt' })), /AccessDenied/, 'a zone-scoped key cannot reach another zone');
        await client(scoped).send(new S3.PutObjectCommand({ Bucket: 'logs', Key: 'a.log', Body: 'x' }));
        assert.deepStrictEqual((await client(scoped).send(new S3.ListBucketsCommand({}))).Buckets.map((b) => b.Name), ['logs']);
        await assert.rejects(client(reader).send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'nope', Body: 'x' })), /AccessDenied/, 'a read key cannot write');
        assert.strictEqual(await (await client(reader).send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }))).Body.transformToString(), 'readme.txt');
        await client(sbox).send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'readme.txt', Body: 'sandbox copy' }));
        assert.strictEqual(await (await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }))).Body.transformToString(), 'readme.txt', 'the sandbox\'s assets is another bucket');
        await assert.rejects(client(other).send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'readme.txt' })), /NoSuchKey/, 'another project\'s assets is another bucket');
        const forged = new S3.S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: full.key.id, secretAccessKey: 'x'.repeat(40) } });
        await assert.rejects(forged.send(new S3.ListBucketsCommand({})), /SignatureDoesNotMatch/);
        console.log('✅ isolation: zone-scoped, read-only, sandbox and other-project keys each stay in their place; forged signatures refused');

        // ── Quotas, overwrite, holds, NotImplemented ──
        await assert.rejects(client(scoped).send(new S3.PutObjectCommand({ Bucket: 'logs', Key: 'big.log', Body: Buffer.alloc(100) })), /QuotaExceeded/, 'the zone\'s quota_bytes is enforced');
        await s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'readme.txt', Body: 'v2' }));
        assert.strictEqual(await (await s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'readme.txt' }))).Body.transformToString(), 'v2', 'an overwrite serves the new bytes');
        const versions = await db.all("SELECT lifecycle_status FROM media_objects WHERE zone_id = ? AND object_key = 'readme.txt' ORDER BY created_at", [assets.id]);
        assert.deepStrictEqual(versions.map((v) => v.lifecycle_status).sort(), ['deleted', 'ready'], 'the previous object went through the deletion path');
        const current = await db.get("SELECT * FROM media_objects WHERE zone_id = ? AND object_key = 'readme.txt' AND lifecycle_status = 'ready'", [assets.id]);
        await model.placeHold({ object_id: current.id, kind: 'evidence', reason: 'test' });
        await assert.rejects(s3.send(new S3.PutObjectCommand({ Bucket: 'assets', Key: 'readme.txt', Body: 'v3' })), /AccessDenied/, 'an overwrite of a held object is refused');
        await assert.rejects(s3.send(new S3.DeleteObjectCommand({ Bucket: 'assets', Key: 'readme.txt' })), /AccessDenied/, 'so is its deletion');
        await assert.rejects(s3.send(new S3.CreateMultipartUploadCommand({ Bucket: 'assets', Key: 'mp' })), /NotImplemented/);
        await assert.rejects(s3.send(new S3.CopyObjectCommand({ Bucket: 'assets', Key: 'copy', CopySource: 'assets/readme.txt' })), /NotImplemented/);
        await assert.rejects(s3.send(new S3.DeleteBucketCommand({ Bucket: 'assets' })), /NotImplemented|MethodNotAllowed/);
        console.log('✅ quotas, overwrite through the deletion path, holds refuse overwrite and delete, NotImplemented answers');

        // ── Deleting objects ──
        await s3.send(new S3.DeleteObjectCommand({ Bucket: 'assets', Key: 'site/index.html' }));
        await assert.rejects(s3.send(new S3.GetObjectCommand({ Bucket: 'assets', Key: 'site/index.html' })), /NoSuchKey/);
        r = await native('GET', `/${row.id}`);
        assert.strictEqual(r.body.lifecycle_status, 'deleted', 'deleted over S3, deleted for the native API too');
        out = await s3.send(new S3.DeleteObjectsCommand({ Bucket: 'assets', Delete: { Objects: [{ Key: 'photos/2024/a.jpg' }, { Key: 'photos/2024/b.jpg' }, { Key: 'missing' }] } }));
        assert.deepStrictEqual((out.Deleted || []).map((d) => d.Key).sort(), ['missing', 'photos/2024/a.jpg', 'photos/2024/b.jpg']);
        out = await s3.send(new S3.ListObjectsV2Command({ Bucket: 'assets', Prefix: 'photos/2024/' }));
        assert.strictEqual(out.KeyCount, 0);
        console.log('✅ DeleteObject and DeleteObjects: both doors answer not found');

        // ── Zone deletion: at once NoSuchBucket, objects tombstoned and purged, name retired, keys dropped ──
        await s3.send(new S3.PutObjectCommand({ Bucket: 'logs', Key: 'b.log', Body: 'y' }));
        const logsRow = await db.get("SELECT * FROM media_objects WHERE zone_id = ? AND object_key = 'b.log'", [logs.id]);
        const presignedLog = await getSignedUrl(s3, new S3.GetObjectCommand({ Bucket: 'logs', Key: 'b.log' }), { expiresIn: 600 });
        r = await provision({ ...logs, state: 'deleting', revision: 2, deletion: { requested_at: new Date().toISOString(), objects_remaining: 2, held_objects: 0, completed_at: null } });
        assert.deepStrictEqual([r.status, r.body.state], [200, 'deleting']);
        await assert.rejects(s3.send(new S3.GetObjectCommand({ Bucket: 'logs', Key: 'b.log' })), /NoSuchBucket/, 'a deleting zone answers NoSuchBucket at once');
        assert.strictEqual((await fetch(presignedLog)).status, 404, 'and so do its presigned URLs');
        const swept = await zones.sweepDeleting();
        assert.ok(swept.tombstoned >= 2 && swept.purged >= 2, JSON.stringify(swept));
        r = await internal('GET', `/internal/zones/${logs.id}`, { token: ZONE_TOKEN });
        assert.deepStrictEqual([r.body.deletion.objects_remaining, r.body.deletion.held_objects, !!r.body.deletion.completed_at], [0, 0, true], JSON.stringify(r.body));
        assert.ok(!fs.existsSync(model.objectFilePath(logsRow)), 'its bytes are gone');
        assert.strictEqual(await model.restore(await model.getObject(logsRow.id)), null, 'a zone deletion is not restorable');
        r = await provision({ ...logs, state: 'deleted', revision: 3, deletion: { requested_at: new Date().toISOString(), objects_remaining: 0, held_objects: 0, completed_at: new Date().toISOString() } });
        assert.strictEqual(r.body.state, 'deleted');
        r = await provision(zoneRecord(PRJ, 'production', 'logs'));
        assert.deepStrictEqual([r.status, r.body.code], [409, 'media.zone.name_retired'], 'the name is retired, never given to a new zone');
        assert.strictEqual((await db.get('SELECT revoked_at FROM media_access_keys WHERE id = ?', [scoped.key.id])).revoked_at != null, true, 'a key scoped only to the deleted zone is revoked');
        assert.strictEqual((await fetch(presignedLog)).status, 404, 'a URL signed for the old zone never reaches anything again');
        console.log('✅ zone deletion: NoSuchBucket at once, tombstoned and purged, no restore, name retired, scoped keys revoked');

        // ── Revocation ──
        r = await internal('DELETE', `/api/v1/projects/${PRJ}/access-keys/${reader.key.id}?on_behalf_of=${ADMIN}`, { token: SERVICES_TOKEN });
        assert.ok(r.body.revoked_at);
        await assert.rejects(client(reader).send(new S3.ListBucketsCommand({})), /InvalidAccessKeyId/, 'a revoked key is refused at once');
        console.log('✅ revocation is immediate');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('s3 surface and zones: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
