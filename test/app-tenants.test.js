'use strict';
// Developer-project tenants (roadmap Wave 20, ADR-014): app tokens (sub app:app_<ULID>, project_id,
// env) with media.object.upload|read and ns [project_id] get a tenant keyed by the project id, created
// on first use with a small default quota (sandbox smaller). Production and sandbox are separate
// tenants behind the same URL; no other credential reaches them, and they reach nothing else.
// Sandbox tokens are accepted on these routes only; sandbox content is never served publicly.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-apptenants-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.FILES_PATH = dir('files');
process.env.OBJECTS_PATH = dir('objects');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret';
process.env.MEDIA_APP_TENANT_QUOTA_MB = '2';
process.env.MEDIA_APP_SANDBOX_QUOTA_MB = '1';

const db = require('../server/db/database');
const auth = require('../server/auth');
const objectRoutes = require('../server/objects/routes');
const { serviceAuth, ids } = require('openvibe-contracts');
const express = require('express');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
auth._setNetworkPublicKeyForTests(keys.publicKey);
db.upsertApp({ app_id: 'live', api_key: 'live-key' });
auth.ensureTokenOnlyApps();

const PA = `prj_${ids.ulid()}`;
const PB = `prj_${ids.ulid()}`;
const PC = `prj_${ids.ulid()}`;
const APP_A = `app_${ids.ulid()}`;
const APP_B = `app_${ids.ulid()}`;
const now = Math.floor(Date.now() / 1000);
const BOTH = ['media.object.upload', 'media.object.read'];
const appTok = ({ project = PA, app = APP_A, env = 'production', cap = BOTH, ns, ...over } = {}) => serviceAuth.signServiceToken({
    iss: 'https://openvibe.network', sub: `app:${app}`, actor_type: 'app', aud: ['openvibe.media'], cap, ns: ns || [project],
    project_id: project, env, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...over,
}, keys.privateKey);
const svcTok = (over = {}) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap: BOTH, ns: ['community'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}`, ...over }, keys.privateKey);

// Same mount order as server/index.js.
const app = express();
app.put('/api/v2/:app/objects/:id/content', ...objectRoutes.contentHandlers);
app.use(express.json());
app.use('/api/v1/:app/files', require('../server/files/routes'));
app.use('/api/v1/:app/vods', require('../server/vod/routes'));
app.use('/api/v2/:app/objects', objectRoutes);
app.use('/o', objectRoutes.publicRouter);
app.use('/', require('../server/public/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = (u) => base + String(u).replace('https://media.test', '');
    const req = async (method, p, { bearer, json, form, raw, headers = {} } = {}) => {
        const h = { ...headers };
        if (bearer) h.authorization = `Bearer ${bearer}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        if (form) body = form;
        if (raw !== undefined) body = raw;
        const r = await fetch(p.startsWith('http') ? p : base + p, { method, headers: h, body, redirect: 'manual' });
        const text = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* bytes */ }
        return { status: r.status, body: parsed, text, headers: r.headers };
    };
    const upload = (project, bearer, content = 'hello from a developer app', name = 'note.txt') => {
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from(content)], { type: 'text/plain' }), name);
        return req('POST', `/api/v1/${project}/files`, { bearer, form: fd });
    };
    const tenants = () => db.all("SELECT app_id, project_id, env, quota_bytes, api_key_hash FROM apps WHERE app_id LIKE 'prj_%' ORDER BY app_id");

    // ── First use creates the tenant; nothing exists before ──
    assert.strictEqual(tenants().length, 0);
    let r = await req('GET', `/api/v1/${PA}/files`, { bearer: appTok({ cap: ['media.object.upload'] }) });
    assert.strictEqual(r.status, 403, 'list needs media.object.read');
    assert.strictEqual(r.body.code, 'capability.denied');
    assert.strictEqual(tenants().length, 0, 'a refused call creates no tenant');
    r = await req('GET', `/api/v1/${PB}/files`, { bearer: appTok() });
    assert.strictEqual(r.status, 403, "project A's token on project B's path");
    assert.strictEqual(r.body.code, 'capability.namespace_denied');
    r = await req('GET', `/api/v1/${PB}/files`, { bearer: appTok({ ns: [PA, PB] }) });
    assert.strictEqual(r.status, 403, 'the token project_id decides, not a widened ns');
    assert.strictEqual(tenants().length, 0, 'wrong project never creates a tenant');

    r = await upload(PA, appTok());
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const prodFile = r.body;
    assert.strictEqual(prodFile.url, `/f/${prodFile.key}`, 'production app files are public like any tenant');
    assert.ok(!prodFile.sandbox);
    r = await upload(PA, appTok({ env: 'sandbox' }), 'sandbox bytes');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const sbFile = r.body;
    assert.strictEqual(sbFile.sandbox, true);
    assert.ok(/^https:\/\/media\.test\/f\/.+\?exp=\d+&sig=/.test(sbFile.url), 'sandbox files get a signed URL');
    assert.ok(sbFile.url_expires_at);

    const t = tenants();
    assert.deepStrictEqual(t.map(x => [x.app_id, x.project_id, x.env]), [[PA, PA, 'production'], [`${PA}-sandbox`, PA, 'sandbox']], 'separate production and sandbox tenants');
    assert.strictEqual(t[0].quota_bytes, 2 * 1024 * 1024);
    assert.strictEqual(t[1].quota_bytes, 1 * 1024 * 1024, 'sandbox quota is smaller');
    assert.ok(t.every(x => x.api_key_hash === ''), 'no API key for project tenants');
    assert.ok(fs.existsSync(path.join(process.env.FILES_PATH, `${PA}-sandbox`)), 'sandbox bytes live in their own tenant directory');

    // ── Separation between environments and projects ──
    r = await req('GET', `/api/v1/${PA}/files`, { bearer: appTok() });
    assert.deepStrictEqual(r.body.files.map(f => f.key), [prodFile.key], 'production sees only production');
    r = await req('GET', `/api/v1/${PA}/files`, { bearer: appTok({ env: 'sandbox' }) });
    assert.deepStrictEqual(r.body.files.map(f => f.key), [sbFile.key], 'sandbox sees only sandbox');
    r = await req('GET', `/api/v1/${PA}/files/${encodeURIComponent(prodFile.key)}`, { bearer: appTok({ env: 'sandbox' }) });
    assert.strictEqual(r.status, 404, 'sandbox token cannot read a production file');
    r = await req('DELETE', `/api/v1/${PA}/files/${encodeURIComponent(sbFile.key)}`, { bearer: appTok() });
    assert.strictEqual(r.status, 404, 'production token cannot delete a sandbox file');
    r = await req('GET', `/api/v1/${PA}-sandbox/files`, { bearer: appTok({ env: 'sandbox', ns: [PA, `${PA}-sandbox`] }) });
    assert.strictEqual(r.status, 401, 'the sandbox tenant id is not addressable by path, even with a widened ns');
    assert.strictEqual(r.body.code, 'token.sandbox_refused');
    r = await req('GET', `/api/v1/${PA}-sandbox/files`, { bearer: appTok({ ns: [PA, `${PA}-sandbox`] }) });
    assert.strictEqual(r.status, 403, 'nor with a production token');
    r = await req('GET', `/api/v1/${PA}-sandbox/files`, { bearer: svcTok({ ns: ['*'] }) });
    assert.strictEqual(r.status, 404, 'nor with a first-party service token');
    r = await req('GET', `/api/v1/${PA}/files`, { bearer: svcTok({ ns: ['*'] }) });
    assert.strictEqual(r.status, 404, 'first-party service tokens never reach project tenants');

    r = await upload(PB, appTok({ project: PB, app: APP_B }), 'project b');
    assert.strictEqual(r.status, 201);
    const bFile = r.body;
    r = await req('GET', `/api/v1/${PB}/files/${encodeURIComponent(prodFile.key)}`, { bearer: appTok({ project: PB, app: APP_B }) });
    assert.strictEqual(r.status, 404, "B cannot read A's file through its own path");
    for (const [m, p] of [['GET', `/api/v1/${PB}/files`], ['GET', `/api/v1/${PB}/files/${encodeURIComponent(bFile.key)}`], ['DELETE', `/api/v1/${PB}/files/${encodeURIComponent(bFile.key)}`]]) {
        r = await req(m, p, { bearer: appTok() });
        assert.strictEqual(r.status, 403, `A cannot ${m} ${p}`);
    }
    r = await upload(PB, appTok());
    assert.strictEqual(r.status, 403, 'A cannot upload into B');
    r = await upload(PA, appTok({ project: PB, app: APP_B }), 'same content as A', 'note.txt');
    assert.strictEqual(r.status, 403);
    // Identical bytes + name in two tenants never collide on the (global) key.
    r = await upload(PB, appTok({ project: PB, app: APP_B }));
    assert.strictEqual(r.status, 201);
    assert.notStrictEqual(r.body.key, prodFile.key, 'per-tenant key tag');

    // ── App tokens reach nothing else; sandbox tokens are refused off the app routes ──
    r = await upload('community', appTok({ ns: ['community'] }));
    assert.strictEqual(r.status, 403, 'an app token never reaches a first-party tenant');
    r = await upload('community', appTok({ env: 'sandbox', ns: ['community'] }));
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'token.sandbox_refused', 'sandbox token on a first-party tenant');
    r = await req('GET', `/api/v1/${PA}/vods`, { bearer: appTok({ env: 'sandbox' }) });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'token.sandbox_refused', 'sandbox token on a route that is not an app-tenant route');
    r = await req('GET', `/api/v1/${PA}/vods`, { bearer: appTok() });
    assert.strictEqual(r.status, 403, 'production app token on vods');
    r = await req('GET', '/api/v1/live/vods', { bearer: appTok({ ns: ['live'] }) });
    assert.strictEqual(r.status, 403);
    r = await req('GET', `/api/v1/${PA}/files`, { bearer: 'live-key' });
    assert.strictEqual(r.status, 404, "an app key never unlocks a project tenant");
    r = await req('GET', `/api/v1/${PA}/files`, { bearer: appTok({ aud: ['openvibe.events'] }) });
    assert.strictEqual(r.status, 404, 'a token for another audience is no credential here');

    // svc: tokens keep their behaviour on first-party tenants.
    r = await upload('community', svcTok(), 'community bytes');
    assert.strictEqual(r.status, 201);
    const communityFile = r.body;
    r = await upload('live', svcTok());
    assert.strictEqual(r.body.code, 'capability.namespace_denied');

    // ── Quotas ──
    r = await upload(PA, appTok({ env: 'sandbox' }), Buffer.alloc(1024 * 1024 + 10, 1).toString(), 'big.bin');
    assert.strictEqual(r.status, 413, 'sandbox quota (1 MB) enforced');
    r = await upload(PA, appTok(), Buffer.alloc(1024 * 1024 + 10, 1).toString(), 'big.bin');
    assert.strictEqual(r.status, 201, 'the production quota (2 MB) is larger');
    r = await upload(PA, appTok(), Buffer.alloc(1024 * 1024 + 10, 2).toString(), 'big2.bin');
    assert.strictEqual(r.status, 413, 'production quota enforced');
    r = await req('POST', `/api/v2/${PA}/objects`, { bearer: appTok({ env: 'sandbox' }), json: { size_bytes: 1024 * 1024 } });
    assert.strictEqual(r.status, 413, 'objects v2 counts files against the same quota');

    // ── Public serving ──
    r = await req('GET', `/f/${encodeURIComponent(prodFile.key)}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, 'hello from a developer app');
    r = await req('GET', `/f/${encodeURIComponent(communityFile.key)}`);
    assert.strictEqual(r.status, 200);
    r = await req('GET', `/f/${encodeURIComponent(sbFile.key)}`);
    assert.strictEqual(r.status, 404, 'sandbox file is not public');
    r = await req('GET', `/f/${encodeURIComponent(sbFile.key)}?exp=${now + 60}&sig=forged`);
    assert.strictEqual(r.status, 404, 'forged signature');
    r = await req('GET', local(sbFile.url));
    assert.strictEqual(r.status, 200, 'the signed URL serves it');
    assert.strictEqual(r.text, 'sandbox bytes');
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    // A download signature for an object id is not a file signature.
    const objSig = require('../server/objects/signing').signedDownloadUrl(sbFile.key);
    r = await req('GET', `/f/${encodeURIComponent(sbFile.key)}${new URL(objSig.url).search}`);
    assert.strictEqual(r.status, 404, 'purposes are separate');
    // The v2 projection of a sandbox file has no public URL either.
    const proj = db.get('SELECT object_id FROM files WHERE key = ?', [sbFile.key]);
    r = await req('GET', `/api/v2/${PA}/objects/${proj.object_id}`, { bearer: appTok({ env: 'sandbox' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.public_url, null);
    assert.strictEqual(r.body.sandbox, true);
    r = await req('GET', `/o/${proj.object_id}`);
    assert.strictEqual(r.status, 404);

    // ── Objects v2 in a sandbox tenant: public visibility still needs a signature ──
    const bytes = Buffer.from('sandbox object bytes');
    r = await req('POST', `/api/v2/${PA}/objects`, { bearer: appTok({ env: 'sandbox' }), json: { visibility: 'public', size_bytes: bytes.length, mime_type: 'text/plain' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const obj = r.body;
    assert.ok(obj.upload.url.includes(`/api/v2/${PA}/objects/`), 'upload URL addresses the project, never the internal sandbox tenant id');
    assert.ok(!obj.upload.url.includes('-sandbox'));
    r = await req('PUT', local(obj.upload.url.replace(`/api/v2/${PA}/`, `/api/v2/${PB}/`)), { raw: bytes, headers: { 'content-type': 'text/plain' } });
    assert.strictEqual(r.status, 404, 'an upload token only works under its own tenant path');
    r = await req('PUT', local(obj.upload.url), { raw: bytes, headers: { 'content-type': 'text/plain' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await req('POST', `/api/v2/${PA}/objects/${obj.id}/complete`, { bearer: appTok({ env: 'sandbox' }), json: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.public_url, null, 'no public URL for a sandbox object');
    r = await req('GET', `/o/${obj.id}`);
    assert.strictEqual(r.status, 404, 'public visibility does not make a sandbox object public');
    r = await req('GET', `/api/v2/${PA}/objects/${obj.id}/download?format=json`, { bearer: appTok({ env: 'sandbox' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.public, false);
    r = await req('GET', local(r.body.url));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, 'sandbox object bytes');
    r = await req('GET', `/api/v2/${PA}/objects/${obj.id}`, { bearer: appTok() });
    assert.strictEqual(r.status, 404, 'production cannot see the sandbox object');
    r = await req('GET', `/api/v2/${PB}/objects/${obj.id}`, { bearer: appTok({ project: PB, app: APP_B, env: 'sandbox' }) });
    assert.strictEqual(r.status, 404, 'nor can another project');
    r = await req('POST', `/api/v2/${PA}/objects/${obj.id}/holds`, { bearer: appTok({ env: 'sandbox' }), json: { kind: 'legal', reason: 'x' } });
    assert.strictEqual(r.status, 401, 'holds are not an app-tenant route (sandbox refused)');

    // Production object, public visibility: served openly.
    r = await req('POST', `/api/v2/${PC}/objects`, { bearer: appTok({ project: PC }), json: { visibility: 'public', size_bytes: 3, mime_type: 'text/plain' } });
    assert.strictEqual(r.status, 201);
    await req('PUT', local(r.body.upload.url), { raw: Buffer.from('abc'), headers: { 'content-type': 'text/plain' } });
    r = await req('POST', `/api/v2/${PC}/objects/${r.body.id}/complete`, { bearer: appTok({ project: PC }), json: {} });
    assert.ok(r.body.public_url, 'production objects keep their public URL');
    r = await req('GET', local(r.body.public_url));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, 'abc');

    // A seeded API key can never be attached to a project tenant.
    assert.throws(() => db.upsertApp({ app_id: PA, api_key: 'x' }), /developer-project tenant/);
    // The Media gallery lists first-party files only.
    const browse = await req('GET', '/browse?tab=files');
    assert.ok(!browse.text.includes(sbFile.key) && !browse.text.includes(prodFile.key), 'project files are not in the gallery');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('developer-project tenants: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
