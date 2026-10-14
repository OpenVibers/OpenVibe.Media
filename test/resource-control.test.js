'use strict';
// Media's control API (ADR-048, plan T13 step 10; capability media.resource.control): OpenVibe.Services deletes a
// person's object, or an object of a project the person administers, with a first-party service token on loopback.
// The delete is the API's soft delete (restorable until the retention period ends); held and legacy objects are refused.
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
    const control = require('../server/registry/resource-control');

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    auth._setNetworkPublicKeyForTests(keys.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const tok = (over = {}) => serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub: 'svc:services', actor_type: 'service',
        aud: ['openvibe.media'], cap: ['media.resource.control'], iat: now, exp: now + 300, jti: `tok_rc_${crypto.randomBytes(6).toString('hex')}`, ...over,
    }, keys.privateKey);

    const admins = new Set();
    let networkDown = false;
    const projects = { isAdmin: async (p, s) => { if (networkDown) throw new Error('down'); return admins.has(`${p}|${s}`); } };
    const app = express();
    app.use('/api/v1/resources', control.router({ guard: guard('media.resource.control'), projects, db }));
    const server = http.createServer(app);

    const prjA = ids.newId('project'); const prjB = ids.newId('project');
    const kim = ids.newId('user'); const lee = ids.newId('user');
    await db.run("INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES (?, 'A', '', ?, 'production'), (?, 'B', '', ?, 'production')", [prjA, prjA, prjB, prjB]);
    const at = '2026-10-01 00:00:00';
    const obj = async (app, owner, { legacy = null, status = 'ready' } = {}) => {
        const id = ids.newId('media');
        await db.run("INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, visibility, lifecycle_status, legacy_ref, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, 'private', ?, ?, ?, ?)",
            [id, app, app, owner, status, legacy, at, at]);
        return id;
    };
    const statusOf = async (id) => (await db.get('SELECT lifecycle_status FROM media_objects WHERE id = ?', [id])).lifecycle_status;
    const ovrn = (id, prj = prjA) => `ovrn:media:${prj}:object/${id}`;
    const ask = (id, who, extra = {}) => ({ action: 'delete', resource: ovrn(id), project_id: prjA, idempotency_key: `k-${crypto.randomUUID()}`, on_behalf_of: { type: 'user', id: who }, ...extra });
    const valid = (body) => assert.deepStrictEqual(validate('common.resource-control-result@1', body).errors, [], JSON.stringify(body));

    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body, token = tok(), headers = {}) => {
        const r = await fetch(`${base}/api/v1/resources/control`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    let passed = 0;
    const check = async (name, fn) => { await fn(); passed++; };
    try {
        await check('a first-party service token with media.resource.control, on loopback, and nothing else', async () => {
            const id = await obj(prjA, kim);
            const body = ask(id, kim, { dry_run: true });
            assert.strictEqual((await post(body, null)).status, 401);
            assert.strictEqual((await post(body, tok({ cap: ['media.resource.read'] }))).status, 403);
            assert.ok([401, 403].includes((await post(body, tok({ sub: `app:${ids.newId('app')}`, actor_type: 'app' }))).status), 'an app token never controls');
            assert.strictEqual((await post(body, tok(), { 'x-forwarded-for': '203.0.113.9' })).status, 404, 'nothing proxied reaches it');
            assert.strictEqual((await post({ action: 'delete' })).status, 400);
        });

        await check('the owner deletes their object: a soft delete they can restore; a repeat replays the answer', async () => {
            const id = await obj(prjA, kim);
            const body = ask(id, kim);
            const first = await post(body);
            assert.strictEqual(first.status, 200);
            valid(first.body);
            assert.deepStrictEqual([first.body.state, first.body.result.status, first.body.result.changed], ['done', 'deleted', true]);
            assert.ok(Date.parse(first.body.result.restorable_until) > Date.now(), 'restorable until its retention period ends');
            assert.strictEqual(await statusOf(id), 'deleted');
            assert.deepStrictEqual((await post(body)).body, first.body, 'the same key answers the stored result');
            const conflict = await post({ ...body, dry_run: true });
            assert.deepStrictEqual([conflict.status, conflict.body.code], [409, 'control.idempotency_conflict']);
            const again = await post(ask(id, kim));
            assert.deepStrictEqual([again.body.state, again.body.result], ['done', { status: 'deleted', changed: false }]);
        });

        await check('an admin of the project deletes what its app stored; anyone else is told it does not exist', async () => {
            const id = await obj(prjA, null);
            const refused = await post(ask(id, lee));
            valid(refused.body);
            assert.deepStrictEqual([refused.body.state, refused.body.problem.code], ['refused', 'resources.unknown_resource']);
            admins.add(`${prjA}|${lee}`);
            const dry = await post(ask(id, lee, { dry_run: true }));
            assert.deepStrictEqual([dry.body.state, dry.body.result.dry_run], ['done', true]);
            assert.strictEqual(await statusOf(id), 'ready', 'a dry run applies nothing');
            networkDown = true;
            const down = await post(ask(id, lee));
            valid(down.body);
            assert.deepStrictEqual([down.body.state, down.body.problem.code], ['failed', 'identity.unavailable']);
            networkDown = false;
            assert.strictEqual((await post(ask(id, lee))).body.result.changed, true);
            admins.clear();
        });

        await check('held and legacy objects are refused; only delete; only inside the object\'s own project', async () => {
            const held = await obj(prjA, kim);
            await db.run("INSERT INTO media_holds (object_id, kind, reason) VALUES (?, 'moderation', 'report under review')", [held]);
            assert.strictEqual((await post(ask(held, kim))).body.problem.code, 'media.object.held');
            const legacy = await obj(prjA, kim, { legacy: `vod:${crypto.randomInt(1e9)}` });
            assert.strictEqual((await post(ask(legacy, kim))).body.problem.code, 'media.object.legacy_managed');
            const id = await obj(prjA, kim);
            const stop = await post({ ...ask(id, kim), action: 'stop' });
            valid(stop.body);
            assert.strictEqual(stop.body.problem.code, 'control.unsupported_action');
            const elsewhere = await obj(prjB, kim);
            assert.strictEqual((await post({ ...ask(elsewhere, kim), resource: ovrn(elsewhere, prjA) })).body.problem.code, 'resources.unknown_resource');
            for (const x of [held, legacy, id, elsewhere]) assert.strictEqual(await statusOf(x), 'ready');
        });
    } finally {
        server.close();
    }
    console.log(`resource control: ${passed} checks passed`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
