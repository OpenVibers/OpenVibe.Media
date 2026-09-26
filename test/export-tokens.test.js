'use strict';
// Project export tokens (OpenVibe.Network, roadmap WS-N task 9): OpenVibe.Codes lists a project's
// objects, namespaces and download URLs for its owner or admin with a token Network mints as an app
// token of the project's export principal: sub app:app_<project ULID>, cap [media.object.list,
// media.object.read], ns [project_id, app.<project_id>.*], env, on_behalf_of, purpose export.
// Media takes it with no change of its own; this pins that it lists and reads the project's tenant
// for the token's environment (signed URLs for private and sandbox objects) and writes nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-export-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.FILES_PATH = dir('files');
process.env.OBJECTS_PATH = dir('objects');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';

const express = require('express');
const { serviceAuth, ids } = require('openvibe-contracts');
const db = require('../server/db/database');
const auth = require('../server/auth');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
auth._setNetworkPublicKeyForTests(keys.publicKey);
const P = `prj_${ids.ulid()}`;
const OTHER = `prj_${ids.ulid()}`;

/** A token shaped exactly as Network's mintExportToken shapes it. */
function exportToken(env, { project = P, cap = ['media.object.list', 'media.object.read'] } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: 'https://openvibe.network', sub: `app:app_${project.replace(/^prj_/, '')}`, actor_type: 'app', aud: ['openvibe.media'], cap,
        ns: [project, `app.${project}.*`], project_id: project, env, on_behalf_of: ids.newId('user'), purpose: 'export',
        iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`,
    }, keys.privateKey);
}

db.getDb();
const prod = db.ensureProjectTenant(P, 'production', 1e9);
const sbx = db.ensureProjectTenant(P, 'sandbox', 1e8);
const otherTenant = db.ensureProjectTenant(OTHER, 'production', 1e9);
const put = (tenant, ns, visibility, status = 'ready') => {
    const id = `med_${ids.ulid()}`;
    db.run("INSERT INTO media_objects (id, app_id, namespace, kind, lifecycle_status, size_bytes, visibility, mime_type) VALUES (?, ?, ?, 'file', ?, 5, ?, 'text/plain')", [id, tenant.app_id, ns, status, visibility]);
    return id;
};
const O = {
    pub: put(prod, `app.${P}`, 'public'),
    priv: put(prod, `app.${P}`, 'private'),
    deleted: put(prod, `app.${P}`, 'private', 'deleted'),
    sandbox: put(sbx, `app.${P}.sandbox`, 'public'),
    other: put(otherTenant, `app.${OTHER}`, 'public'),
};

const app = express();
app.use(express.json());
app.use('/api/v2/:app/objects', require('../server/objects/routes'));
app.use('/api/v2/:app/namespaces', require('../server/objects/namespace-routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, token, body) => {
        const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: r.status, body: json, text };
    };
    const tp = exportToken('production');
    const ts = exportToken('sandbox');

    // Lists: the token's environment picks the tenant; deleted objects when asked; nothing of another project.
    let r = await call('GET', `/api/v2/${P}/objects?limit=200&include_deleted=1`, tp);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.objects.map((o) => o.id).sort(), [O.pub, O.priv, O.deleted].sort());
    assert.strictEqual(r.body.objects.find((o) => o.id === O.pub).public_url, `https://media.test/o/${O.pub}`);
    r = await call('GET', `/api/v2/${P}/objects?limit=200`, ts);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.objects.map((o) => o.id), [O.sandbox], 'the sandbox token sees the sandbox tenant only');
    assert.strictEqual(r.body.objects[0].public_url, null, 'sandbox objects are never public');
    r = await call('GET', `/api/v2/${P}/namespaces`, tp);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.namespaces.map((n) => n.namespace), [`app.${P}`]);
    console.log('✅ an export token lists the project\'s objects and namespaces, per environment');

    // Download URLs: signed for private and sandbox objects (up to an hour), refused for deleted ones.
    r = await call('GET', `/api/v2/${P}/objects/${O.priv}/download?format=json&ttl=3600`, tp);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.public, false);
    assert.match(r.body.url, new RegExp(`^https://media\\.test/o/${O.priv}\\?exp=\\d+&sig=`));
    assert.ok(Date.parse(r.body.expires_at) - Date.now() > 3500 * 1000);
    r = await call('GET', `/api/v2/${P}/objects/${O.sandbox}/download?format=json&ttl=3600`, ts);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.public, false);
    r = await call('GET', `/api/v2/${P}/objects/${O.deleted}/download?format=json`, tp);
    assert.strictEqual(r.status, 410);
    r = await call('GET', `/api/v2/${P}/objects/${O.sandbox}/download?format=json`, tp);
    assert.strictEqual(r.status, 404, 'a production token does not reach the sandbox tenant');
    console.log('✅ download URLs: signed for private and sandbox objects');

    // Nothing else: no upload, no delete, no other project.
    r = await call('POST', `/api/v2/${P}/objects`, tp, { kind: 'file', size_bytes: 5, mime_type: 'text/plain' });
    assert.strictEqual(r.status, 403, r.text);
    r = await call('DELETE', `/api/v2/${P}/objects/${O.pub}`, tp);
    assert.strictEqual(r.status, 403, r.text);
    r = await call('GET', `/api/v2/${OTHER}/objects`, tp);
    assert.strictEqual(r.status, 403, 'another project\'s tenant');
    r = await call('GET', `/api/v2/${OTHER}/objects/${O.other}/download?format=json`, tp);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM media_objects').n, 5, 'nothing written');
    console.log('✅ an export token writes nothing and reaches no other project');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('export tokens: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
