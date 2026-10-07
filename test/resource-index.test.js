'use strict';
// Media's authority resource index (ADR-048 §3, plan T13 step 8; capability media.resource.read):
// GET /api/v1/resources pages common.resource-summary@1 for the resources Media owns — its media objects
// (med_, media_objects) — and GET /api/v1/resources/:ovrn reads one by its computed ovrn. Media lists
// objects alone; v1 vods/clips/files are projections and are never listed. ?project=&kind=&cursor=&limit=
// are honoured; ?project= is the tenancy boundary (the tenant's apps.project_id), so a resource of another
// project is never returned. An ovrn is present exactly when openvibe-contracts' contracts.resources.nameOf
// composes one: only when the object's tenant is a developer project (a first-party tenant has no project).
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';

(async () => {
    const express = require('express');
    const { ids, serviceAuth, validate } = require('openvibe-contracts');
    const auth = require('../server/auth');
    const db = require('../server/db/database');
    const { guard } = require('../server/service-guard');
    const resourceIndex = require('../server/registry/resource-index');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);

    const now = Math.floor(Date.now() / 1000);
    const tok = (over = {}) => serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub: 'svc:network', actor_type: 'service',
        aud: ['openvibe.media'], cap: ['media.resource.read'], iat: now, exp: now + 300, jti: `tok_ri_${crypto.randomBytes(6).toString('hex')}`, ...over,
    }, keys.privateKey);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/resources', resourceIndex.router({ guard: guard('media.resource.read'), db }));
    const server = http.createServer(app);

    // ── Fixtures: two developer projects (A production + sandbox, B) and the first-party tenant `live` ──
    const prjA = ids.newId('project'); const prjB = ids.newId('project');
    const usrA = ids.newId('user');
    const at = '2026-10-01 00:00:00';                        // Media's stored shape; the index renders it RFC 3339
    const objA1 = ids.newId('media', 1700000001000);          // project A, production, ready, user-owned
    const objA2 = ids.newId('media', 1700000002000);          // project A, sandbox, uploading
    const objA3 = ids.newId('media', 1700000003000);          // project A, deleted
    const objB1 = ids.newId('media', 1700000004000);          // project B, file
    const objL1 = ids.newId('media', 1700000005000);          // first-party tenant: no project, no ovrn
    const objL2 = ids.newId('media', 1700000006000);          // first-party tenant, user-owned: owner but no project

    await db.run("INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES (?, 'Project A', '', ?, 'production'), (?, 'Project A sandbox', '', ?, 'sandbox'), (?, 'Project B', '', ?, 'production'), ('live', 'OpenVibe.Live', '', NULL, NULL)",
        [prjA, prjA, `${prjA}-sandbox`, prjA, prjB, prjB]);
    const INSERT_OBJECT = "INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, visibility, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'private', ?, ?, ?)";
    const insertObject = (id, app, kind, owner, lifecycle) => db.run(INSERT_OBJECT, [id, app, app, kind, owner, lifecycle, at, at]);
    await insertObject(objA1, prjA, 'vod', usrA, 'ready');
    await insertObject(objA2, `${prjA}-sandbox`, 'vod', null, 'uploading');
    await insertObject(objA3, prjA, 'clip', null, 'deleted');
    await insertObject(objB1, prjB, 'file', null, 'ready');
    await insertObject(objL1, 'live', 'file', null, 'ready');
    await insertObject(objL2, 'live', 'file', usrA, 'ready');

    const idOrder = [objA1, objA2, objA3, objB1, objL1, objL2].sort();   // one kind: (kind, id) is id order
    const all = [objA1, objA2, objA3, objB1, objL1, objL2];
    const ovrnOf = (project, id) => `ovrn:media:${project}:object/${id}`;

    (async () => {
        await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
        const base = `http://127.0.0.1:${server.address().port}`;
        const get = (url, headers) => fetch(`${base}${url}`, { headers }).then(async (y) => ({ status: y.status, headers: y.headers, body: await y.json().catch(() => null) }));
        const authHeaders = { authorization: `Bearer ${tok()}` };
        try {
            // ── Auth matrix: 401 without a token, 403 with a token lacking the capability, 200 with it ──
            assert.strictEqual((await get('/api/v1/resources')).status, 401, 'no token is 401');
            assert.strictEqual((await get('/api/v1/resources', { authorization: 'Bearer ' + tok({ cap: ['media.object.read'] }) })).status, 403, 'a token without media.resource.read is 403');
            assert.strictEqual((await get('/api/v1/resources', { authorization: 'Bearer ' + tok({ aud: ['openvibe.network'] }) })).status, 401, 'another audience is 401');
            assert.strictEqual((await get('/api/v1/resources', authHeaders)).status, 200, 'a token with media.resource.read is 200');

            const list = await get('/api/v1/resources', authHeaders);
            assert.strictEqual(list.headers.get('cache-control'), 'private, max-age=60');
            assert.deepStrictEqual(Object.keys(list.body).sort(), ['next_cursor', 'resources'], 'the page carries only the contract fields');
            const pageCheck = validate('common.resource-list-result@1', list.body);
            assert.ok(pageCheck.valid, JSON.stringify(pageCheck.errors));
            list.body.resources.forEach((s) => assert.ok(validate('common.resource-summary@1', s).valid, `${s.id}: ${JSON.stringify(validate('common.resource-summary@1', s).errors)}`));
            assert.strictEqual(list.body.next_cursor, null, 'one page holds the whole index');
            assert.deepStrictEqual(list.body.resources.map((r) => r.id), idOrder, 'every object, sorted by id');
            assert.deepStrictEqual([...new Set(list.body.resources.map((r) => r.kind))], ['media.object'], 'Media lists objects alone');
            assert.deepStrictEqual([...new Set(list.body.resources.map((r) => r.service))], ['media']);

            const byId = new Map(list.body.resources.map((r) => [r.id, r]));
            assert.strictEqual(byId.get(objA1).project_id, prjA, 'a project tenant object carries its project');
            assert.strictEqual(byId.get(objA2).project_id, prjA, 'the sandbox tenant of project A is project A');
            assert.strictEqual(byId.get(objA1).ovrn, ovrnOf(prjA, objA1), 'a project object is named');
            assert.strictEqual(byId.get(objA1).owner.id, usrA, 'a user-owned object names its owner');
            assert.strictEqual(byId.get(objA1).state, 'ready');
            assert.strictEqual(byId.get(objA2).state, 'uploading');
            assert.strictEqual(byId.get(objA3).state, 'deleted', 'the state follows lifecycle_status');
            [objL1, objL2].forEach((id) => assert.ok(!('project_id' in byId.get(id)), `${id}: a first-party tenant object has no project`));
            [objL1, objL2].forEach((id) => assert.ok(!('ovrn' in byId.get(id)), `${id}: without a project there is no name`));
            assert.strictEqual(byId.get(objL2).owner.id, usrA, 'owner is independent of project');
            assert.match(byId.get(objA1).created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'created_at is RFC 3339, converted from the stored shape');

            // ── ?project= is the tenancy boundary; ?kind= narrows; an unknown kind is an empty page ──
            const aIds = async (q, headers = authHeaders) => {
                const y = await get(`/api/v1/resources${q}`, headers);
                assert.strictEqual(y.status, 200, `${q}: ${JSON.stringify(y.body)}`);
                assert.ok(validate('common.resource-list-result@1', y.body).valid);
                y.body.resources.forEach((s) => assert.ok(validate('common.resource-summary@1', s).valid));
                return y.body.resources.map((r) => r.id);
            };
            assert.deepStrictEqual((await aIds(`?project=${prjA}`)).sort(), [objA1, objA2, objA3].sort(), 'project A: its production and sandbox objects, never B nor first-party');
            assert.deepStrictEqual(await aIds(`?project=${prjB}`), [objB1], 'project B is never mixed in');
            assert.deepStrictEqual((await aIds(`?kind=media.object`)).sort(), idOrder, 'kind = media.object lists every object');
            assert.deepStrictEqual((await aIds(`?project=${prjA}&kind=media.object`)).sort(), [objA1, objA2, objA3].sort(), 'kind narrows within the project');
            assert.deepStrictEqual(await aIds('?kind=media.unknown'), [], 'an unknown kind is an empty page, not an error');
            assert.deepStrictEqual(await aIds('?kind=vod'), [], 'a v1 kind (a projection) is not a resource kind');
            assert.deepStrictEqual(await aIds(`?project=${ids.newId('project')}`), [], 'an unknown project has no resources');
            assert.deepStrictEqual((await aIds(`?project=${prjA}&limit=1000`)).sort(), [objA1, objA2, objA3].sort(), 'a large limit still pages one result');

            // ── Keyset paging: the whole index in pages of two, no duplicates, none skipped, order preserved ──
            const seen = [];
            let cursor = null;
            let pages = 0;
            for (;;) {
                const y = await get(`/api/v1/resources?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, authHeaders);
                assert.strictEqual(y.status, 200);
                assert.ok(validate('common.resource-list-result@1', y.body).valid);
                seen.push(...y.body.resources.map((r) => r.id));
                if (y.body.next_cursor === null) { assert.strictEqual(seen.length, all.length, 'the cursor chain ends at the end'); break; }
                assert.ok(typeof y.body.next_cursor === 'string' && y.body.next_cursor !== '');
                cursor = y.body.next_cursor;
                if (++pages > 50) assert.fail('the cursor chain never ended');
            }
            assert.deepStrictEqual(seen, idOrder, 'no duplicates, none skipped, order preserved');

            // ── GET /:ovrn: found, and every miss 404s ──
            const one = await get(`/api/v1/resources/${encodeURIComponent(ovrnOf(prjA, objA1))}`, authHeaders);
            assert.strictEqual(one.status, 200, JSON.stringify(one.body));
            assert.strictEqual(one.headers.get('cache-control'), 'private, max-age=60');
            assert.ok(validate('common.resource-summary@1', one.body).valid);
            assert.deepStrictEqual(one.body, byId.get(objA1), 'the same summary the list answers');
            const oneSandbox = await get(`/api/v1/resources/${encodeURIComponent(ovrnOf(prjA, objA2))}`, authHeaders);
            assert.strictEqual(oneSandbox.status, 200, 'a sandbox object is named by its project');

            const missing = [
                ['a first-party object (no project)', ovrnOf(prjA, objL1)],
                ["another project's id", ovrnOf(prjB, objA1)],
                ['an unknown object', ovrnOf(prjA, ids.newId('media'))],
                ['a non-resource type', `ovrn:media:${prjA}:watch/${objA1}`],
                ['another service', `ovrn:watch:${prjA}:object/${objA1}`],
                ['a non-OVRN', 'nope'],
            ];
            for (const [why, name] of missing) {
                const y = await get(`/api/v1/resources/${encodeURIComponent(name)}`, authHeaders);
                assert.strictEqual(y.status, 404, why);
                assert.strictEqual(y.headers.get('content-type'), 'application/problem+json', why);
                assert.strictEqual(y.body.code, 'resources.unknown_resource', why);
            }
            assert.strictEqual((await get(`/api/v1/resources/${encodeURIComponent(ovrnOf(prjA, objA1))}`)).status, 401, 'a read without a token is 401 too');

            // ── A bad query is 400 resources.bad_query (an unknown kind stays an empty page) ──
            const bad = [['?project=nope', 'project not a prj_ id'], ['?limit=0', 'limit below one'], ['?limit=abc', 'limit not a number'], ['?limit=99999', 'limit over the cap'], ['?cursor=***', 'cursor not one this index issued']];
            for (const [q, why] of bad) {
                const y = await get(`/api/v1/resources${q}`, authHeaders);
                assert.strictEqual(y.status, 400, why);
                assert.strictEqual(y.body.code, 'resources.bad_query', why);
            }

            console.log('resource index: all tests passed');
        } finally {
            server.close();
        }
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
