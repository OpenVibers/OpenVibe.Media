'use strict';
// Namespaces and grants (roadmap WS-G task 2; server/objects/namespaces.js, server/auth.js VERBS):
//   - the backfill on open: developer-project objects move to app.<project_id>[.sandbox], every tenant
//     and every namespace an object names gets a row, uploads in progress get a reservation (once);
//   - five verbs per namespace (read, list, write, delete, transform), the older ids still granting the
//     newer verbs, strict_verbs refusing them; child namespaces and grants that name only a child;
//   - developer app tokens: their legacy ns [prj_…] means app.<project_id>.*, the new ns works the same;
//   - quotas per namespace (bytes and objects, up to the tenant), reserved at init, re-reserved with the
//     bytes stored, settled at complete, released at abort, swept at expiry; the policy's kinds,
//     visibilities and max_object_bytes; the owner's read of namespaces and usage.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-namespaces-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.FILES_PATH = dir('files');
process.env.OBJECTS_PATH = dir('objects');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
process.env.MEDIA_NAMESPACE_MAX_CHILDREN = '6';
process.env.MEDIA_MULTIPART_MIN_PART_MB = '1';
process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';

const { serviceAuth, ids } = require('openvibe-contracts');
const PA = `prj_${ids.ulid()}`;
const PB = `prj_${ids.ulid()}`;
const APP_A = `app_${ids.ulid()}`;

// ── A database from before namespaces were rows ──
{
    const h = new Database(process.env.DB_PATH);
    h.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8'));
    h.exec('ALTER TABLE apps ADD COLUMN project_id TEXT; ALTER TABLE apps ADD COLUMN env TEXT;');
    h.prepare("INSERT INTO apps (app_id, name, api_key_hash, quota_bytes) VALUES ('live', 'Live', ?, 0)").run(crypto.createHash('sha256').update('live-key').digest('hex'));
    h.prepare("INSERT INTO apps (app_id, name, api_key_hash, quota_bytes, project_id, env) VALUES (?, 'p', '', 1000000, ?, 'production')").run(PA, PA);
    h.prepare("INSERT INTO apps (app_id, name, api_key_hash, quota_bytes, project_id, env) VALUES (?, 'p', '', 1000000, ?, 'sandbox')").run(`${PA}-sandbox`, PA);
    const put = h.prepare("INSERT INTO media_objects (id, app_id, namespace, kind, lifecycle_status, size_bytes) VALUES (?, ?, ?, 'file', ?, ?)");
    put.run(`med_${ids.ulid()}`, PA, PA, 'ready', 10);
    put.run(`med_${ids.ulid()}`, `${PA}-sandbox`, `${PA}-sandbox`, 'ready', 20);
    put.run(`med_${ids.ulid()}`, 'live', 'live.legacy.old', 'ready', 30);
    put.run('med_01M0PRE0UPLOAD0000000000AA', 'live', 'live', 'uploading', 100);
    h.close();
}

const db = require('../server/db/database');
const auth = require('../server/auth');
const namespaces = require('../server/objects/namespaces');
const model = require('../server/objects/model');
const objectRoutes = require('../server/objects/routes');
const express = require('express');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
auth._setNetworkPublicKeyForTests(keys.publicKey);
const now = Math.floor(Date.now() / 1000);
const jti = () => `tok_${crypto.randomBytes(6).toString('hex')}`;
const svc = (cap, ns = ['community']) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap, ns, iat: now, exp: now + 300, jti: jti() }, keys.privateKey);
const appTok = ({ cap = ['media.object.upload', 'media.object.read'], ns = [PA], env = 'production', project = PA } = {}) => serviceAuth.signServiceToken({
    iss: 'https://openvibe.network', sub: `app:${APP_A}`, actor_type: 'app', aud: ['openvibe.media'], cap, ns, project_id: project, env, iat: now, exp: now + 300, jti: jti(),
}, keys.privateKey);

// ── 1. The backfill on open ──
{
    db.getDb();
    const nsOf = (app) => db.all('SELECT namespace FROM media_objects WHERE app_id = ? ORDER BY namespace', [app]).map(r => r.namespace);
    assert.deepStrictEqual(nsOf(PA), [`app.${PA}`], 'a project object moves to app.<project_id>');
    assert.deepStrictEqual(nsOf(`${PA}-sandbox`), [`app.${PA}.sandbox`], 'its sandbox object to app.<project_id>.sandbox');
    const rows = Object.fromEntries(db.all('SELECT * FROM media_namespaces').map(r => [r.namespace, r]));
    assert.deepStrictEqual([rows.live.owner, rows.live.parent, rows[`app.${PA}`].owner, rows[`app.${PA}.sandbox`].app_id], ['service:live', null, `project:${PA}`, `${PA}-sandbox`]);
    assert.deepStrictEqual([rows['live.legacy'].parent, rows['live.legacy.old'].parent], ['live', 'live.legacy'], 'a child an object names gets a row, with the chain up to its root');
    const pre = namespaces.reservation('med_01M0PRE0UPLOAD0000000000AA');
    assert.ok(pre && pre.bytes === 100 && pre.namespace === 'live', 'an upload already in progress holds its declared size');
    assert.ok(Date.parse(pre.expires_at.replace(' ', 'T') + 'Z') > Date.now() + 70 * 3600e3, 'for the full reservation window from now');
    // Idempotent, and the reservation seed runs once: a released reservation does not come back.
    namespaces.settle('med_01M0PRE0UPLOAD0000000000AA');
    db.close();
    db.getDb();
    assert.strictEqual(namespaces.reservation('med_01M0PRE0UPLOAD0000000000AA'), undefined, 'the seed ran once');
    assert.deepStrictEqual(nsOf(PA), [`app.${PA}`]);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM media_namespaces').n, Object.keys(rows).length, 'no duplicate rows on a second open');
    db.run("UPDATE media_objects SET lifecycle_status = 'failed' WHERE id = 'med_01M0PRE0UPLOAD0000000000AA'");
    console.log('✅ backfill: project objects under app.<project_id>, a row per namespace, reservations seeded once');
}

db.upsertApp({ app_id: 'tiny', api_key: 'tiny-key', quota_bytes: 100 });
auth.ensureTokenOnlyApps();
assert.ok(namespaces.get('tiny') && namespaces.get('community'), 'new tenants get their root row');

const app = express();
app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
app.put('/api/v2/:app/objects/:id/multipart/:uploadId/parts/:n', ...objectRoutes.partHandlers);
app.use(express.json());
app.use('/api/v1/:app/files', require('../server/files/routes'));
app.use('/api/v2/:app/objects', objectRoutes);
app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
app.use('/api/v2/:app/namespaces', require('../server/objects/namespace-routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = (u) => base + String(u).replace('https://media.test', '');
    const call = async (method, p, { bearer = 'live-key', body, raw, headers = {} } = {}) => {
        const h = { ...headers };
        if (bearer) h.authorization = `Bearer ${bearer}`;
        let payload;
        if (raw !== undefined) payload = raw;
        else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
        const res = await fetch(p.startsWith('http') ? p : base + p, { method, headers: h, body: payload, redirect: 'manual' });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, body: json, text };
    };
    const C = '/api/v2/community/objects';
    // init → PUT → complete; returns the ready object (or the failing answer).
    const store = async (url, bearer, bytes, extra = {}) => {
        let r = await call('POST', url, { bearer, body: { kind: 'file', mime_type: 'application/octet-stream', size_bytes: bytes.length, ...extra } });
        if (r.status !== 201) return r;
        const id = r.body.id;
        r = await call('PUT', local(r.body.upload.url), { bearer: null, raw: bytes, headers: { 'content-type': 'application/octet-stream' } });
        if (r.status !== 200) return r;
        return call('POST', `${url}/${id}/complete`, { bearer, body: {} });
    };

    // ── 2. Five verbs; the older ids keep granting the newer ones ──
    const UP = ['media.object.upload'];
    let r = await store(C, svc([...UP, 'media.object.read']), Buffer.from('root object'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const rootObj = r.body;
    assert.strictEqual(rootObj.namespace, 'community', 'the root namespace by default');
    r = await call('GET', C, { bearer: svc(['media.object.read']) });
    assert.strictEqual(r.status, 200, 'read still lists (tokens from before the split)');
    r = await call('GET', C, { bearer: svc(['media.object.list']) });
    assert.deepStrictEqual([r.status, r.body.objects.map(o => o.id)], [200, [rootObj.id]], 'media.object.list lists');
    r = await call('GET', `${C}/${rootObj.id}`, { bearer: svc(['media.object.list']) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'list is not read');
    r = await call('POST', C, { bearer: svc(['media.object.delete']), body: { kind: 'file' } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'delete is not write');
    r = await call('DELETE', `${C}/${rootObj.id}`, { bearer: svc(['media.object.read']) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'read does not delete');
    r = await call('DELETE', `${C}/${rootObj.id}`, { bearer: svc(['media.object.delete']) });
    assert.deepStrictEqual([r.status, r.body.lifecycle_status], [200, 'deleted'], 'media.object.delete deletes');
    r = await call('POST', `${C}/${rootObj.id}/restore`, { bearer: svc(UP) });
    assert.deepStrictEqual([r.status, r.body.lifecycle_status], [200, 'ready'], 'upload still restores (and deletes)');
    r = await call('POST', '/api/v2/community/jobs', { bearer: svc(['media.object.read']), body: { type: 'invariant.scan' } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'transform needs its grant');
    r = await call('POST', '/api/v2/community/jobs', { bearer: svc(['media.derivative.create']), body: { type: 'invariant.scan' } });
    assert.strictEqual(r.status, 202, `media.derivative.create transforms: ${JSON.stringify(r.body)}`);
    const job = r.body.job;
    r = await call('POST', `/api/v2/community/jobs/${job.id}/cancel`, { bearer: svc(UP) });
    assert.strictEqual(r.status, 200, 'upload still transforms');
    r = await call('GET', '/api/v2/community/jobs', { bearer: svc(['media.object.list']) });
    assert.strictEqual(r.status, 200, 'jobs are listed with list');
    r = await call('GET', `/api/v1/community/files`, { bearer: svc(['media.object.list']) });
    assert.strictEqual(r.status, 200, 'v1 files list with list');
    r = await call('POST', C, { bearer: svc(UP, ['live']), body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied'], 'another tenant\'s namespace');

    // strict_verbs: only the verb's own id counts in that namespace.
    db.run(`UPDATE media_namespaces SET policy = '{"strict_verbs":true}' WHERE namespace = 'community'`);
    r = await call('GET', C, { bearer: svc(['media.object.read']) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'strict: read no longer lists');
    r = await call('DELETE', `${C}/${rootObj.id}`, { bearer: svc(UP) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.denied'], 'strict: upload no longer deletes');
    r = await call('GET', C, { bearer: svc(['media.object.list']) });
    assert.strictEqual(r.status, 200);
    db.run("UPDATE media_namespaces SET policy = '{}' WHERE namespace = 'community'");
    console.log('✅ verbs: read, list, write, delete, transform; older ids still grant; strict_verbs refuses them');

    // ── 3. Child namespaces; grants that name only a child ──
    r = await store(C, svc(UP, ['community.*']), Buffer.from('an avatar'), { namespace: 'avatars' });
    assert.deepStrictEqual([r.status, r.body.namespace], [200, 'community.avatars'], 'a relative name lands below the root');
    const avatar = r.body;
    assert.strictEqual(namespaces.get('community.avatars').parent, 'community');
    r = await call('POST', C, { bearer: svc(UP), body: { namespace: 'avatars' } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied'], 'a grant of the root alone is not its children');
    for (const bad of ['Avatars', 'a..b', 'a.b.c.d', '../x', 'live', '-x']) {
        r = await call('POST', C, { bearer: svc(UP, ['community.*']), body: { namespace: bad } });
        if (bad === 'live') { assert.deepStrictEqual([r.status, r.body.namespace === undefined], [201, true]); continue; }   // relative: community.live
        assert.deepStrictEqual([r.status, r.body.code], [400, 'media.namespace.invalid'], bad);
    }
    assert.ok(namespaces.get('community.live'), '"live" is relative to the tenant');
    const onlyAvatars = (cap) => svc(cap, ['community.avatars']);
    r = await call('POST', C, { bearer: onlyAvatars(UP), body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied'], 'a child grant does not write the root');
    r = await store(C, onlyAvatars(UP), Buffer.from('another avatar'), { namespace: 'community.avatars' });
    assert.deepStrictEqual([r.status, r.body.namespace], [200, 'community.avatars'], 'the full name works too');
    r = await call('GET', C, { bearer: onlyAvatars(['media.object.list']) });
    assert.ok(r.body.objects.length === 2 && r.body.objects.every(o => o.namespace === 'community.avatars'), 'a child grant lists only its namespace');
    r = await call('GET', `${C}/${rootObj.id}`, { bearer: onlyAvatars(['media.object.read']) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied'], 'nor reads the root');
    r = await call('GET', `${C}?namespace=avatars`, { bearer: svc(['media.object.list'], ['community.*']) });
    assert.ok(r.body.objects.length === 2 && r.body.objects.every(o => o.namespace === 'community.avatars'), '?namespace= narrows the list');
    r = await call('GET', `${C}?namespace=community`, { bearer: onlyAvatars(['media.object.list']) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied']);
    r = await call('POST', '/api/v2/community/jobs', { bearer: onlyAvatars(['media.derivative.create']), body: { type: 'object.hash', object_id: avatar.id } });
    assert.ok(r.status === 202 || r.status === 400, `transform on an object in the granted child: ${JSON.stringify(r.body)}`);
    assert.notStrictEqual(r.body.code, 'capability.namespace_denied');
    r = await call('POST', '/api/v2/community/jobs', { bearer: onlyAvatars(['media.derivative.create']), body: { type: 'invariant.scan' } });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied'], 'a tenant-wide job is the root\'s');
    // At most MEDIA_NAMESPACE_MAX_CHILDREN (6) below a root: avatars, live, then four more.
    for (const n of ['c1', 'c2', 'c3.d']) {
        r = await call('POST', C, { bearer: svc(UP, ['community.*']), body: { namespace: n } });
        assert.strictEqual(r.status, 201, `${n}: ${JSON.stringify(r.body)}`);
    }
    r = await call('POST', C, { bearer: svc(UP, ['community.*']), body: { namespace: 'c4' } });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.quota.namespaces_exceeded']);
    console.log('✅ child namespaces: created by the first upload, granted and listed per namespace, bounded per tenant');

    // ── 4. Developer app tokens: app.<project_id>.* ──
    const A = `/api/v2/${PA}/objects`;
    r = await store(A, appTok(), Buffer.from('legacy ns'), { namespace: 'uploads' });
    assert.deepStrictEqual([r.status, r.body.namespace], [200, `app.${PA}.uploads`], 'a legacy ns [project_id] means the whole project');
    r = await store(A, appTok({ ns: [PA, `app.${PA}.*`] }), Buffer.from('new ns'));
    assert.deepStrictEqual([r.status, r.body.namespace], [200, `app.${PA}`], 'the ns Network issues now');
    r = await call('POST', A, { bearer: appTok({ ns: [`app.${PA}.uploads`] }), body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied'], 'a token for one child of the project');
    r = await call('POST', A, { bearer: appTok({ ns: [`app.${PA}.uploads`] }), body: { namespace: 'uploads' } });
    assert.strictEqual(r.status, 201);
    r = await call('POST', A, { bearer: appTok({ ns: [`app.${PB}.*`] }), body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied'], 'another project\'s namespace');
    r = await call('POST', A, { bearer: appTok(), body: { namespace: 'sandbox' } });
    assert.deepStrictEqual([r.status, r.body.code], [400, 'media.namespace.invalid'], 'the sandbox tenant is not a child of production');
    r = await store(A, appTok({ env: 'sandbox' }), Buffer.from('sandbox'), { namespace: 'uploads' });
    assert.deepStrictEqual([r.status, r.body.namespace], [200, `app.${PA}.sandbox.uploads`], 'sandbox tokens work in the sandbox tenant');
    r = await call('GET', `/api/v2/${PA}/namespaces`, { bearer: appTok() });
    assert.deepStrictEqual(r.body.namespaces.map(n => n.namespace), [`app.${PA}`, `app.${PA}.uploads`], 'the owner reads its production namespaces');
    const rootNs = r.body.namespaces[0];
    assert.deepStrictEqual([rootNs.root, rootNs.owner, rootNs.quota.bytes, rootNs.quota.bytes_from, rootNs.usage.used_objects, rootNs.usage.used_bytes],
        [true, `project:${PA}`, 1000000, 'tenant', 3, 10 + 9 + 6], 'root usage covers the tenant; the quota is the tenant\'s');
    assert.strictEqual(r.body.namespaces[1].usage.reserved_objects, 1, 'the open upload in uploads is a reservation');
    r = await call('GET', `/api/v2/${PA}/namespaces/uploads`, { bearer: appTok({ cap: ['media.object.read'] }) });
    assert.deepStrictEqual([r.status, r.body.namespace, r.body.usage.used_bytes], [200, `app.${PA}.uploads`, 9]);
    r = await call('GET', `/api/v2/${PA}/namespaces`, { bearer: appTok({ env: 'sandbox' }) });
    assert.deepStrictEqual(r.body.namespaces.map(n => [n.namespace, n.sandbox]), [[`app.${PA}.sandbox`, true], [`app.${PA}.sandbox.uploads`, true]]);
    r = await call('GET', `/api/v2/${PA}/namespaces/nope`, { bearer: appTok() });
    assert.deepStrictEqual([r.status, r.body.code], [404, 'media.namespace.not_found']);
    r = await call('GET', '/api/v2/community/namespaces', { bearer: onlyAvatars(['media.object.list']) });
    assert.deepStrictEqual(r.body.namespaces.map(n => n.namespace), ['community.avatars'], 'a child grant sees its namespace only');
    r = await call('GET', '/api/v2/community/namespaces/community', { bearer: onlyAvatars(['media.object.read']) });
    assert.deepStrictEqual([r.status, r.body.code], [403, 'capability.namespace_denied']);
    r = await call('GET', '/api/v2/live/namespaces');
    assert.deepStrictEqual(r.body.namespaces.map(n => n.namespace), ['live', 'live.legacy', 'live.legacy.old'], 'the app key reads every namespace of its tenant');
    console.log('✅ developer tenants: app.<project_id>.* (legacy and new ns), sandbox apart; owner reads namespaces and usage');

    // ── 5. Quotas: per namespace, reserved at init, reconciled at complete, released, swept ──
    const T = '/api/v2/tiny/objects';
    db.run("INSERT INTO media_namespaces (namespace, app_id, parent, owner, quota_bytes, quota_objects) VALUES ('tiny.box', 'tiny', 'tiny', 'service:tiny', 30, 2)");
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', size_bytes: 31 } });
    assert.deepStrictEqual([r.status, r.body.code, r.body.namespace, r.body.quota_bytes], [413, 'media.quota.exceeded', 'tiny.box', 30], 'the child\'s own byte quota');
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', size_bytes: 20 } });
    assert.strictEqual(r.status, 201);
    const boxed = r.body;
    assert.strictEqual(namespaces.reservation(boxed.id).bytes, 20, 'init reserves the declared size');
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', size_bytes: 11 } });
    assert.strictEqual(r.status, 413, 'the reservation counts');
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', size_bytes: 5 } });
    assert.strictEqual(r.status, 201);
    const second = r.body;
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', size_bytes: 1 } });
    assert.deepStrictEqual([r.status, r.body.code, r.body.quota_objects], [413, 'media.quota.objects_exceeded', 2], 'the child\'s object quota');
    r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 76 } });
    assert.deepStrictEqual([r.status, r.body.namespace], [413, 'tiny'], 'the tenant quota (100) covers its children\'s reservations (25)');
    // The bytes replace the declared size; complete settles the reservation, and the ready object counts.
    r = await call('PUT', local(boxed.upload.url), { bearer: null, raw: Buffer.alloc(20, 1) });
    assert.strictEqual(r.status, 200);
    r = await call('POST', `${T}/${boxed.id}/complete`, { bearer: 'tiny-key', body: {} });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(namespaces.reservation(boxed.id), undefined, 'settled at complete');
    let box = namespaces.get('tiny.box');
    assert.deepStrictEqual([box.used_bytes, box.used_objects, box.reserved_bytes, box.reserved_objects], [20, 1, 5, 1], 'the snapshot is reconciled at complete');
    // Complete checks the real size: an undeclared upload that grew past the room is refused there.
    r = await call('POST', T, { bearer: 'tiny-key', body: {} });
    const grow = r.body;
    r = await call('PUT', `${T}/${grow.id}/content`, { bearer: 'tiny-key', raw: Buffer.alloc(76, 2) });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.quota.exceeded'], 'the stored bytes are checked (20 + 5 + 76 > 100)');
    r = await call('PUT', `${T}/${grow.id}/content`, { bearer: 'tiny-key', raw: Buffer.alloc(40, 2) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(namespaces.reservation(grow.id).bytes, 40, 're-reserved with the bytes stored');
    db.run("UPDATE apps SET quota_bytes = 60 WHERE app_id = 'tiny'");
    r = await call('POST', `${T}/${grow.id}/complete`, { bearer: 'tiny-key', body: {} });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.quota.exceeded'], 'and reconciled again at complete (20 + 5 + 40 > 60)');
    db.run("UPDATE apps SET quota_bytes = 100 WHERE app_id = 'tiny'");
    r = await call('POST', `${T}/${grow.id}/complete`, { bearer: 'tiny-key', body: {} });
    assert.strictEqual(r.status, 200);
    // Deleting an upload in progress frees its reservation.
    r = await call('DELETE', `${T}/${second.id}`, { bearer: 'tiny-key' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(namespaces.reservation(second.id), undefined, 'a deleted upload holds nothing');
    box = namespaces.get('tiny.box');
    assert.deepStrictEqual([box.reserved_bytes, box.reserved_objects], [0, 0]);

    // Multipart: the session holds the declared size; abort releases it; a new session reserves again.
    db.run("UPDATE apps SET quota_bytes = ? WHERE app_id = 'tiny'", [3 * 1024 * 1024]);
    db.run("UPDATE media_namespaces SET quota_bytes = NULL, quota_objects = NULL WHERE namespace = 'tiny.box'");
    const MB = 1024 * 1024;
    r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 2 * MB, multipart: true, part_size: MB } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const mp = r.body;
    r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 2 * MB } });
    assert.strictEqual(r.status, 413, 'the open session holds its 2 MB');
    r = await call('DELETE', local(mp.upload.multipart.abort_url), { bearer: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(namespaces.reservation(mp.id), undefined, 'abort released it');
    r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 2 * MB, multipart: true, part_size: MB } });
    assert.strictEqual(r.status, 201, 'the room is back');
    const other = r.body;
    r = await call('POST', `${T}/${mp.id}/multipart`, { bearer: 'tiny-key', body: { part_size: MB } });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.quota.exceeded'], 'a new session for the aborted upload is checked again');
    r = await call('DELETE', local(other.upload.multipart.abort_url), { bearer: null });
    r = await call('POST', `${T}/${mp.id}/multipart`, { bearer: 'tiny-key', body: { part_size: MB } });
    assert.strictEqual(r.status, 201, 'and reserves again when there is room');
    assert.strictEqual(namespaces.reservation(mp.id).bytes, 2 * MB);

    // Expiry: an abandoned upload is failed and its bytes freed; an open session keeps its upload.
    r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 3 } });
    const abandoned = r.body;
    await call('PUT', local(abandoned.upload.url), { bearer: null, raw: Buffer.from('abc') });
    const file = model.objectFilePath(model.getObject(abandoned.id));
    assert.ok(fs.existsSync(file));
    db.run("UPDATE media_quota_reservations SET expires_at = datetime('now', '-1 hour') WHERE object_id IN (?, ?)", [abandoned.id, mp.id]);
    const swept = namespaces.expireReservations();
    assert.deepStrictEqual(swept, { expired: 1, dropped: 0 }, 'only the upload with no open session');
    const gone = model.getObject(abandoned.id);
    assert.deepStrictEqual([gone.lifecycle_status, JSON.parse(gone.metadata).failure, fs.existsSync(file), namespaces.reservation(abandoned.id)],
        ['failed', 'upload_expired', false, undefined]);
    assert.ok(namespaces.reservation(mp.id), 'the multipart upload keeps its reservation while its session is open');
    r = await call('PUT', local(abandoned.upload.url), { bearer: null, raw: Buffer.from('abc') });
    assert.deepStrictEqual([r.status, r.body.code], [409, 'media.object.not_uploading'], 'an expired upload takes no more bytes');

    // v1 files count against the root's quotas, objects included.
    db.run("UPDATE media_namespaces SET quota_objects = 1 WHERE namespace = 'tiny'");
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('v1 bytes')], { type: 'text/plain' }), 'x.txt');
    const f = await fetch(`${base}/api/v1/tiny/files`, { method: 'POST', headers: { authorization: 'Bearer tiny-key' }, body: fd });
    const fb = await f.json();
    assert.deepStrictEqual([f.status, fb.code, fb.namespace], [413, 'media.quota.objects_exceeded', 'tiny'], 'the v1 answer keeps its shape and says why');
    db.run("UPDATE media_namespaces SET quota_objects = NULL WHERE namespace = 'tiny'");

    // Policy: kinds, visibilities and max_object_bytes, children inheriting and overriding.
    db.run(`UPDATE media_namespaces SET policy = '{"kinds":["file","asset"],"max_object_bytes":10}' WHERE namespace = 'tiny'`);
    db.run(`UPDATE media_namespaces SET policy = '{"visibilities":["private"],"max_object_bytes":0}' WHERE namespace = 'tiny.box'`);
    r = await call('POST', T, { bearer: 'tiny-key', body: { kind: 'vod' } });
    assert.deepStrictEqual([r.status, r.body.code], [422, 'media.namespace.policy_denied'], 'kinds');
    r = await call('POST', T, { bearer: 'tiny-key', body: { size_bytes: 11 } });
    assert.deepStrictEqual([r.status, r.body.code], [413, 'media.object.too_large'], 'max_object_bytes');
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', size_bytes: 11, visibility: 'private' } });
    assert.strictEqual(r.status, 201, 'a child overrides max_object_bytes');
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', kind: 'vod', visibility: 'private' } });
    assert.strictEqual(r.status, 422, 'and inherits kinds');
    r = await call('POST', T, { bearer: 'tiny-key', body: { namespace: 'box', visibility: 'public' } });
    assert.deepStrictEqual([r.status, r.body.code], [422, 'media.namespace.policy_denied'], 'visibilities');
    assert.ok(namespaces.validatePolicy({ kinds: ['file'], strict_verbs: true }).policy);
    assert.ok(namespaces.validatePolicy({ nope: 1 }).error && namespaces.validatePolicy({ kinds: ['x'] }).error && namespaces.validatePolicy({ max_object_bytes: -1 }).error);

    // The snapshot follows the rows when reconciled.
    db.run("UPDATE media_namespaces SET used_bytes = 999 WHERE namespace = 'tiny'");
    assert.ok(namespaces.reconcileAll() >= 3);
    assert.strictEqual(namespaces.get('tiny').used_bytes, model.usedBytes('tiny') - namespaces.get('tiny').reserved_bytes, 'the root\'s snapshot is the tenant\'s usage');
    console.log('✅ quotas: per namespace and tenant, bytes and objects; reserved, re-reserved, settled, released, swept; policy enforced');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('namespaces and grants: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
