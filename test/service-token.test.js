'use strict';
// Service-principal tokens on Media's tenant API (roadmap Wave 1/5): accepted only on routes that name
// their capability and only for granted :app namespaces; the token-only 'community' tenant; and the
// paste export bundle Community imports.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-svc-'));
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.FILES_PATH = path.join(tmp, 'files');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';

const db = require('../server/db/database');
const auth = require('../server/auth');
const { serviceAuth } = require('openvibe-contracts');
const express = require('express');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
auth._setNetworkPublicKeyForTests(keys.publicKey);
db.upsertApp({ app_id: 'live', api_key: 'live-key' });
auth.ensureTokenOnlyApps();
auth.ensureTokenOnlyApps();   // idempotent
const community = db.getApp('community');
assert.ok(community && community.api_key_hash === '' && community.quota_bytes > 0, 'token-only community tenant with a quota');

const now = Math.floor(Date.now() / 1000);
const tok = (over = {}) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap: ['media.object.upload'], ns: ['community'], iat: now, exp: now + 300, jti: 'tok_test12345', ...over }, keys.privateKey);

const app = express();
app.use('/api/v1/:app/files', require('../server/files/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const upload = (appId, bearer) => {
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from('\x89PNG\r\n\x1a\nfake')], { type: 'image/png' }), 'shot.png');
        return fetch(`${base}/api/v1/${appId}/files`, { method: 'POST', headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, body: fd })
            .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    };

    let r = await upload('community', tok());
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.key && r.body.url, 'upload answers key + url');
    r = await upload('live', tok());
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.namespace_denied', 'a community token cannot write the live namespace');
    r = await upload('community', tok({ cap: ['media.object.read'] }));
    assert.strictEqual(r.body.code, 'capability.denied');
    r = await upload('community', tok({ aud: ['openvibe.network'] }));
    assert.strictEqual(r.status, 401, 'wrong audience is not a service credential here');
    r = await upload('community', serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap: ['media.object.upload'], ns: ['community'], iat: now, exp: now + 300, jti: 'tok_forged123' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey));
    assert.strictEqual(r.status, 401, 'forged token refused');
    r = await upload('community', '');
    assert.strictEqual(r.status, 401);
    r = await upload('community', 'live-key');
    assert.strictEqual(r.status, 403, "live's key is not valid for the community tenant");
    let list = await fetch(`${base}/api/v1/community/files`, { headers: { authorization: `Bearer ${tok()}` } });
    assert.strictEqual(list.status, 403, 'listing needs media.object.read');
    list = await fetch(`${base}/api/v1/community/files`, { headers: { authorization: `Bearer ${tok({ cap: ['media.object.upload', 'media.object.read'] })}` } });
    assert.strictEqual(list.status, 200, 'listing with media.object.read');
    assert.strictEqual((await list.json()).files.length, 1);
    server.close();

    // ── Paste export bundle ──
    const d = db.getDb();
    d.prepare("INSERT INTO pastes (id, app_id, slug, user_id, type, title, content, visibility, screenshot_path, metadata, ip_address, ai_tags) VALUES (1, 'live', 'a-a-1', 5, 'paste', 'A', 'x', 'public', NULL, '{\"k\":1}', '10.0.0.1', 'one,two'), (2, 'live', 'b-b-2', NULL, 'screenshot', 'B', '', 'unlisted', '/data/s.png', NULL, '10.0.0.2', NULL), (3, 'tools', 'c-c-3', 1, 'paste', 'C', 'y', 'public', NULL, NULL, NULL, NULL)").run();
    d.prepare("INSERT INTO paste_comments (id, paste_id, user_id, anon_name, message, ip_address) VALUES (1, 1, NULL, 'anon', 'hi', '10.0.0.3')").run();
    d.prepare('INSERT INTO paste_likes (paste_id, user_id) VALUES (1, 7)').run();
    const outFile = path.join(tmp, 'bundle.json');
    execFileSync(process.execPath, [path.join(__dirname, '../scripts/export-pastes.js'), '--app', 'live', '--out', outFile, '--db', process.env.DB_PATH], { env: { ...process.env } });
    const b = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.strictEqual(b.format, 'openvibe.media.pastes-export');
    assert.deepStrictEqual(b.counts, { pastes: 2, comments: 1, likes: 1 }, 'only the requested app');
    assert.strictEqual(b.sha256, crypto.createHash('sha256').update(JSON.stringify({ pastes: b.pastes, comments: b.comments, likes: b.likes })).digest('hex'));
    assert.ok(!JSON.stringify(b).includes('10.0.0.'), 'no IP addresses leave Media');
    assert.strictEqual(b.pastes[1].screenshot_url, 'https://media.test/p/b-b-2/screenshot');
    assert.deepStrictEqual(b.pastes[0].metadata, { k: 1 });
    assert.deepStrictEqual(b.pastes[0].ai_tags, ['one', 'two']);
    assert.strictEqual((fs.statSync(outFile).mode & 0o777), 0o600, 'bundle is private');
    execFileSync(process.execPath, [path.join(__dirname, '../scripts/export-pastes.js'), '--app', 'live', '--out', outFile, '--since-id', '1', '--db', process.env.DB_PATH]);
    const inc = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.deepStrictEqual(inc.pastes.map((p) => p.id), [2], 'incremental export');
    assert.strictEqual(inc.counts.comments, 1, 'comments always included');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('service tokens + paste export: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
