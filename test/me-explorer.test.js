'use strict';
// The object explorer (roadmap WS-G task 12; server/me/): a signed-in person's own objects across
// tenants (/api/v2/me/objects, /usage, /me pages) and the operator views (/api/v2/me/ops, /me/ops,
// /api/v1/:app/admin/storage/ops).
//   - owner scoping: only objects whose owner_subject is the caller's subject, never another person's
//     (list, filters, detail, page), and only a person's access token for this site identifies them;
//   - signed out: the API answers 401, the page is a sign-in prompt;
//   - cursor pagination, filters, upload progress (multipart parts, stored bytes, a PUT streaming),
//     derivatives, holds (only whether), usage per tenant and namespace with no quota;
//   - the page renders without JavaScript (rows, pager, usage), escapes what it shows, is noindex,
//     is left out of the sitemap and disallowed in robots.txt;
//   - operator views for staff.site.view only; the recompute for staff.site.configure, same-origin
//     only; the app-key twin in the admin routes (never acting for a user).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-me-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    OBJECTS_PATH: dir('objects'), THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'),
    MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'https://openvibe.network',
});
for (const k of Object.keys(process.env)) if (/^MEDIA_(B2|R2)_/.test(k)) delete process.env[k];
delete process.env.MEDIA_DRILL;

const { ids } = require('openvibe-contracts');
const db = require('../server/db/database');
require('../server/views/service').ensureSchema();
const model = require('../server/objects/model');
const namespaces = require('../server/objects/namespaces');
const { createMeRoutes, personFromClaims } = require('../server/me/routes');
const express = require('express');

db.upsertApp({ app_id: 'live', name: 'OpenVibe.Live', api_key: 'live-key' });
db.upsertApp({ app_id: 'tools', name: 'OpenVibe.Tools', api_key: 'tools-key' });
for (const a of ['live', 'tools']) db.ensureRootNamespace(db.getApp(a));
namespaces.ensure(db.getApp('live'), 'live.avatars');

const ANA = `usr_${ids.ulid()}`;
const BEN = `usr_${ids.ulid()}`;
const ALEX = `usr_${ids.ulid()}`;
const base = Date.now() - 3600e3;
let tick = 0;
const make = (o) => model.createObject({ app_id: 'live', kind: 'file', visibility: 'private', lifecycle_status: 'ready', mime_type: 'text/plain', size_bytes: 100, createdMs: base + (tick++) * 1000, ...o });
const present = (id, bytes, key = path.join(process.env.OBJECTS_PATH, id)) => model.upsertLocation(id, { provider: 'local', key, state: 'present', size_bytes: bytes, verified: true });

// ── Fixtures: Ana's objects ──
const anaReady = [];
for (let i = 0; i < 30; i++) {
    const id = make({ owner_subject: ANA, metadata: { filename: `note-${i}.txt` }, size_bytes: 1000 + i });
    present(id, 1000 + i);
    anaReady.push(id);
}
const tricky = make({ owner_subject: ANA, visibility: 'public', metadata: { filename: '<script>alert(1)</script>.txt' }, size_bytes: 7 });
present(tricky, 7);
const avatar = make({ owner_subject: ANA, namespace: 'live.avatars', kind: 'avatar', mime_type: 'image/png', metadata: { filename: 'me.png' }, size_bytes: 500 });
present(avatar, 500);
const inTools = make({ app_id: 'tools', owner_subject: ANA, metadata: { filename: 'result.json' }, mime_type: 'application/json', size_bytes: 2048 });
present(inTools, 2048);
// Uploading, multipart: 2 of 4 parts of 1 MiB received.
const multi = make({ owner_subject: ANA, lifecycle_status: 'uploading', mime_type: 'video/mp4', kind: 'vod', metadata: { filename: 'big.mp4' }, size_bytes: 4 * 1048576 });
namespaces.reserve(model.getObject(multi), 4 * 1048576);
db.run("INSERT INTO media_uploads (id, object_id, app_id, part_size, total_size, parts_expected, status, expires_at) VALUES ('mup_TEST', ?, 'live', 1048576, ?, 4, 'active', datetime('now', '+1 day'))", [multi, 4 * 1048576]);
for (const n of [1, 3]) db.run("INSERT INTO media_upload_parts (upload_id, part_number, size_bytes, sha256) VALUES ('mup_TEST', ?, 1048576, 'x')", [n]);
// Uploading, single part, bytes stored and waiting for complete.
const stored = make({ owner_subject: ANA, lifecycle_status: 'uploading', metadata: { filename: 'stored.txt' }, size_bytes: 300 });
present(stored, 300);
// Uploading, a PUT still streaming (a temp file under OBJECTS_PATH/.tmp).
const streaming = make({ owner_subject: ANA, lifecycle_status: 'uploading', metadata: { filename: 'streaming.txt' }, size_bytes: 1000 });
fs.mkdirSync(path.join(process.env.OBJECTS_PATH, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(process.env.OBJECTS_PATH, '.tmp', `${streaming}-abcd1234`), Buffer.alloc(250));
const deleted = make({ owner_subject: ANA, lifecycle_status: 'deleted', metadata: { filename: 'gone.txt', retention_until: new Date(Date.now() + 864e5).toISOString() }, size_bytes: 40 });
const failed = make({ owner_subject: ANA, lifecycle_status: 'failed', metadata: { filename: 'expired.txt', failure: 'upload_expired' }, size_bytes: 60 });
// A derivative (waveform variant) of one of Ana's, and a held one.
const wave = make({ owner_subject: ANA, kind: 'asset', mime_type: 'image/png', metadata: { derived_from: anaReady[0] }, size_bytes: 10 });
present(wave, 10);
model.setRelationship(wave, 'derived_from', anaReady[0], {});
model.setVariant(anaReady[0], 'waveform', wave, 'object.waveform@1');
model.placeHold({ object_id: anaReady[1], kind: 'evidence', reason: 'SECRET-HOLD-REASON', created_by: 'staff:x', note: 'SECRET-NOTE' });
// ── Ben's objects (must never show up for Ana) ──
const benIds = [];
for (let i = 0; i < 3; i++) { const id = make({ owner_subject: BEN, metadata: { filename: `ben-${i}.txt` }, size_bytes: 999999 }); present(id, 999999); benIds.push(id); }
const benUploading = make({ owner_subject: BEN, lifecycle_status: 'uploading', size_bytes: 5 });
// An object with no subject at all.
make({ owner_subject: null, owner_user_id: 5, metadata: { filename: 'nobody.txt' } });
// A failed job, for the operator views.
db.run(`INSERT INTO media_jobs (id, app_id, object_id, job_type, status, error, error_code, attempts, max_attempts, finished_at)
        VALUES ('mjob_TESTFAILED', 'live', ?, 'object.sprite', 'failed', 'ffmpeg exited 1', 'no_video', 1, 3, CURRENT_TIMESTAMP)`, [anaReady[2]]);
// A missing copy and a no-good-copy object.
const lost = make({ owner_subject: BEN, size_bytes: 1 });
model.upsertLocation(lost, { provider: 'b2', key: 'k/lost', state: 'missing', size_bytes: 1, verified: true });

// ── Tokens: what auth.verify (the JWKS-backed verifier) would answer ──
const AUD = ['openvibe.live', 'openvibe.media', 'openvibe.network'];
const CLAIMS = {
    ana: { sub: 7, subject_id: ANA, username: 'ana', role: 'user', aud: AUD },
    ben: { sub: 8, subject_id: BEN, username: 'ben', role: 'user', aud: AUD },
    admin: { sub: 1, subject_id: ALEX, username: 'alex', role: 'admin', aud: AUD },
    mod: { sub: 2, subject_id: `usr_${ids.ulid()}`, username: 'mo', role: 'global_mod', aud: AUD },
    liveOnly: { sub: 7, subject_id: ANA, username: 'ana', aud: ['openvibe.live'] },
    service: { sub: 'svc:community', subject_id: ANA, aud: AUD, actor_type: 'service' },
    fedcm: { sub: 7, subject_id: ANA, aud: AUD, typ: 'fedcm' },
    noSubject: { sub: 7, username: 'ana', aud: AUD },
};
const auth = { verify: async (token) => CLAIMS[token] || null };

const app = express();
app.use((req, _res, next) => {   // as server/index.js parses cookies
    req.cookies = {};
    for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const me = createMeRoutes({ auth });
app.use('/api/v2/me', me.api);
app.use('/me', me.pages);
app.use('/api/v1/:app/admin/storage', require('../server/admin/routes'));
app.use('/', require('../server/public/crawl'));
app.use(require('../server/not-found').notFound);

(async () => {
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const call = (method, p, { token = null, cookie = null, headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
        const data = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (cookie) h.cookie = `ov_token=${cookie}`;
        if (data) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = Buffer.byteLength(data); }
        const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method, headers: h }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text: b, json }); });
        });
        rq.on('error', reject);
        rq.end(data);
    });
    const all = async (token, qs = '') => {
        const seen = [];
        let cursor = null, pages = 0;
        do {
            const r = await call('GET', `/api/v2/me/objects?limit=7${qs}${cursor ? `&cursor=${cursor}` : ''}`, { token });
            assert.strictEqual(r.status, 200, r.text);
            seen.push(...r.json.objects);
            cursor = r.json.next_cursor;
            assert.ok(++pages < 50);
        } while (cursor);
        return seen;
    };
    try {
        // ── Signed out ──
        let r = await call('GET', '/api/v2/me/objects');
        assert.deepStrictEqual([r.status, r.json.code], [401, 'auth.required']);
        assert.strictEqual(r.headers['cache-control'], 'private, no-store');
        assert.strictEqual((await call('GET', '/api/v2/me/usage')).status, 401);
        assert.strictEqual((await call('GET', `/api/v2/me/objects/${anaReady[0]}`)).status, 401);
        r = await call('GET', '/me');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('href="/auth/login?next=%2Fme"'), 'the sign-in prompt comes back to /me');
        assert.ok(r.text.includes('<meta name="robots" content="noindex, nofollow">'));
        assert.ok(r.headers['x-robots-tag'].includes('noindex') && r.headers['cache-control'] === 'private, no-store');
        assert.ok(!r.text.includes(anaReady[0]) && !r.text.includes('<table'), 'nothing of anyone is shown');
        assert.ok(r.text.includes('navbar.js') && r.text.includes('"sessionUrl":"/auth/me"'), 'in the OpenVibe Frame');
        console.log('✅ signed out: the API answers 401, /me is a sign-in prompt in the Frame');

        // ── Only a person's access token for this site identifies them ──
        assert.strictEqual((await call('GET', '/api/v2/me/objects', { token: 'forged' })).json.code, 'auth.invalid');
        for (const t of ['liveOnly', 'service', 'fedcm']) {
            r = await call('GET', '/api/v2/me/objects', { token: t });
            assert.deepStrictEqual([r.status, r.json.code], [401, 'auth.invalid'], t);
        }
        assert.strictEqual((await call('GET', '/api/v2/me/objects', { token: 'noSubject' })).json.code, 'auth.no_subject');
        assert.ok(personFromClaims(CLAIMS.ana).person && !personFromClaims(null).person);
        r = await call('GET', '/me', { cookie: 'noSubject' });
        assert.ok(r.text.includes('no network subject') && r.text.includes('/auth/login'), 'a sign-in without a subject is asked to sign in again');
        console.log('✅ identity: audience openvibe.media, a person (no principals, no FedCM assertions) with a usr_ subject');

        // ── Owner scoping and pagination ──
        const anaAll = await all('ana', '&status=all');
        const anaIds = anaAll.map(o => o.id);
        assert.strictEqual(new Set(anaIds).size, anaIds.length, 'no object twice across pages');
        assert.deepStrictEqual([...anaIds].sort().reverse(), anaIds, 'newest first');
        const expected = db.all('SELECT id FROM media_objects WHERE owner_subject = ? ORDER BY id DESC', [ANA]).map(x => x.id);
        assert.deepStrictEqual(anaIds, expected, 'every one of her objects, in every tenant and status');
        for (const b of [...benIds, benUploading, lost]) assert.ok(!anaIds.includes(b), 'never another person\'s object');
        const benAll = await all('ben', '&status=all');
        assert.deepStrictEqual(benAll.map(o => o.id).sort(), [...benIds, benUploading, lost].sort());
        r = await call('GET', `/api/v2/me/objects/${benIds[0]}`, { token: 'ana' });
        assert.deepStrictEqual([r.status, r.json.code], [404, 'media.object.not_found'], 'another person\'s object is not found');
        assert.strictEqual((await call('GET', `/me/objects/${benIds[0]}`, { cookie: 'ana' })).status, 404, 'nor its page');
        r = await call('GET', '/api/v2/me/objects?limit=10', { token: 'ana' });
        assert.strictEqual(r.json.objects.length, 10);
        assert.strictEqual(r.json.next_cursor, r.json.objects[9].id);
        const page2 = await call('GET', `/api/v2/me/objects?limit=10&cursor=${r.json.next_cursor}`, { token: 'ana' });
        assert.ok(page2.json.objects.every(o => o.id < r.json.next_cursor));
        assert.strictEqual((await call('GET', '/api/v2/me/objects?cursor=nope', { token: 'ana' })).status, 400);
        assert.strictEqual((await call('GET', '/api/v2/me/objects?limit=1000', { token: 'ana' })).json.limit, 100);
        assert.strictEqual((await call('GET', '/api/v2/me/objects?status=gone', { token: 'ana' })).status, 400);
        const byDefault = await all('ana');
        assert.ok(!byDefault.some(o => o.lifecycle_status === 'deleted') && byDefault.length === anaIds.length - 1, 'deleted objects only on request');
        console.log(`✅ scoping + pagination: ${anaIds.length} of Ana's objects over pages of 7, none of Ben's; another person's id is a 404`);

        // ── Filters ──
        r = await call('GET', '/api/v2/me/objects?status=uploading', { token: 'ana' });
        assert.deepStrictEqual(r.json.objects.map(o => o.id).sort(), [multi, stored, streaming].sort());
        r = await call('GET', '/api/v2/me/objects?app=tools', { token: 'ana' });
        assert.deepStrictEqual(r.json.objects.map(o => o.id), [inTools]);
        assert.deepStrictEqual([r.json.objects[0].tenant.name, r.json.objects[0].app_id], ['OpenVibe.Tools', 'tools']);
        r = await call('GET', '/api/v2/me/objects?kind=avatar', { token: 'ana' });
        assert.deepStrictEqual(r.json.objects.map(o => [o.id, o.namespace]), [[avatar, 'live.avatars']]);
        r = await call('GET', '/api/v2/me/objects?q=NOTE-2', { token: 'ana' });
        assert.deepStrictEqual(r.json.objects.map(o => o.filename).sort(), ['note-2.txt', 'note-20.txt', 'note-21.txt', 'note-22.txt', 'note-23.txt', 'note-24.txt', 'note-25.txt', 'note-26.txt', 'note-27.txt', 'note-28.txt', 'note-29.txt']);
        r = await call('GET', `/api/v2/me/objects?q=${benIds[0]}`, { token: 'ana' });
        assert.deepStrictEqual(r.json.objects, [], 'searching for someone else\'s id finds nothing');
        r = await call('GET', '/api/v2/me/objects?q=ben-', { token: 'ana' });
        assert.deepStrictEqual(r.json.objects, []);
        console.log('✅ filters: status, tenant, kind, search (name, title, type, id), all within her own objects');

        // ── Upload progress, derivatives, holds ──
        const byId = Object.fromEntries(anaAll.map(o => [o.id, o]));
        assert.deepStrictEqual(
            (({ method, waiting_for, received_bytes, parts_received, parts_expected, declared_bytes, percent }) => ({ method, waiting_for, received_bytes, parts_received, parts_expected, declared_bytes, percent }))(byId[multi].upload),
            { method: 'multipart', waiting_for: 'parts', received_bytes: 2 * 1048576, parts_received: 2, parts_expected: 4, declared_bytes: 4 * 1048576, percent: 50 });
        assert.ok(byId[multi].upload.expires_at && byId[multi].upload.session_expires_at, 'when the upload fails if unfinished');
        assert.deepStrictEqual([byId[stored].upload.waiting_for, byId[stored].upload.received_bytes, byId[stored].upload.percent], ['complete', 300, 100]);
        assert.deepStrictEqual([byId[streaming].upload.streaming, byId[streaming].upload.received_bytes, byId[streaming].upload.percent], [true, 250, 25]);
        assert.strictEqual(byId[anaReady[0]].upload, null);
        assert.strictEqual(byId[anaReady[0]].derivatives, 1, 'the waveform counts as a derivative');
        assert.strictEqual(byId[anaReady[3]].derivatives, 0);
        assert.strictEqual(byId[anaReady[1]].held, true);
        assert.strictEqual(byId[failed].failure, 'upload_expired');
        assert.ok(byId[deleted].deleted.retention_until && byId[deleted].deleted.purged === false);
        assert.strictEqual(byId[tricky].public_url, `https://media.test/o/${tricky}`, 'a public ready object links to its bytes');
        assert.strictEqual(byId[anaReady[0]].public_url, null, 'a private one does not');
        assert.deepStrictEqual(byId[anaReady[0]].readiness, { metadata: true, bytes_verified: true, playable: false, reason: 'not_playback_kind' });
        const listText = JSON.stringify(anaAll);
        for (const secret of ['SECRET-HOLD-REASON', 'SECRET-NOTE', 'staff:x', 'evidence', process.env.OBJECTS_PATH, 'canonical_key']) {
            assert.ok(!listText.includes(secret), `the owner's view never carries ${secret}`);
        }
        r = await call('GET', `/api/v2/me/objects/${anaReady[0]}`, { token: 'ana' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json.derivative_list.map(d => [d.id, d.name, d.kind, d.mine]), [[wave, 'waveform', 'asset', true]]);
        assert.deepStrictEqual(r.json.locations.map(l => [l.provider, l.state, l.canonical]), [['local', 'present', false]]);
        assert.deepStrictEqual(r.json.jobs, []);
        r = await call('GET', `/api/v2/me/objects/${wave}`, { token: 'ana' });
        assert.deepStrictEqual(r.json.source, { id: anaReady[0], relation: 'derived_from' });
        r = await call('GET', `/api/v2/me/objects/${anaReady[2]}`, { token: 'ana' });
        assert.deepStrictEqual(r.json.jobs.map(j => [j.id, j.type, j.status, j.error_code]), [['mjob_TESTFAILED', 'object.sprite', 'failed', 'no_video']]);
        assert.ok(!JSON.stringify(r.json).includes('ffmpeg exited'), 'job error text stays with operators');
        console.log('✅ uploads (multipart parts, stored bytes, a PUT streaming), derivatives, holds (only whether), no keys or staff notes');

        // ── Usage ──
        r = await call('GET', '/api/v2/me/usage', { token: 'ana' });
        assert.strictEqual(r.status, 200);
        const u = r.json;
        const sum = (list) => list.reduce((a, id) => a + Number(model.getObject(id).size_bytes), 0);
        const readyLive = [...anaReady, tricky, wave];
        assert.strictEqual(u.totals.stored_bytes, sum([...readyLive, avatar, inTools]));
        assert.strictEqual(u.totals.objects, anaIds.length - 1, 'deleted objects are not counted as objects');
        assert.deepStrictEqual(u.totals.by_status.uploading, { objects: 3, bytes: 4 * 1048576 + 300 + 1000 });
        assert.deepStrictEqual(u.totals.by_status.deleted, { objects: 1, bytes: 40 });
        assert.deepStrictEqual(u.tenants.map(t => t.app_id), ['live', 'tools']);
        const live = u.tenants[0];
        assert.deepStrictEqual(live.namespaces.map(n => n.namespace), ['live', 'live.avatars']);
        assert.strictEqual(live.namespaces[0].stored_bytes, sum(readyLive));
        assert.strictEqual(live.namespaces[1].stored_bytes, 500);
        assert.strictEqual(u.tenants[1].stored_bytes, 2048);
        assert.strictEqual(u.quotas, null);
        assert.ok(!/quota_bytes|quota_objects|used_bytes/.test(JSON.stringify(u)), 'no tenant quota or tenant totals');
        const ub = (await call('GET', '/api/v2/me/usage', { token: 'ben' })).json;
        assert.strictEqual(ub.totals.stored_bytes, 3 * 999999 + 1, 'Ben\'s usage is his own');
        console.log('✅ usage: her objects and bytes per tenant and namespace, by status; no quotas');

        // ── The page, without JavaScript ──
        r = await call('GET', '/me', { cookie: 'ana' });
        assert.strictEqual(r.status, 200);
        const rows = r.text.match(/<tr data-id="med_/g) || [];
        assert.strictEqual(rows.length, 25, 'the first page of objects is in the HTML');
        assert.ok(r.text.includes('Signed in as <strong>@ana</strong>'));
        assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;.txt') && !r.text.includes('<script>alert(1)'), 'names are escaped');
        const next = /id="me-next" rel="next" href="([^"]+)"/.exec(r.text);
        assert.ok(next && /cursor=med_/.test(next[1]) && !/me-next[^>]*hidden/.test(r.text.slice(r.text.indexOf('id="me-next"') - 40, r.text.indexOf('id="me-next"') + 200)), 'a next-page link');
        assert.ok(/<script src="\/me\/app\.js\?v=[0-9a-f]{12}" defer><\/script>/.test(r.text), 'the enhancement is a same-origin script');
        assert.ok(r.text.includes('Read-only.') && r.text.includes('class="grid stack usage"') && r.text.includes('live.avatars'));
        assert.ok(r.text.includes('<progress max="100" value="50"'), 'upload progress without JavaScript');
        for (const b of benIds) assert.ok(!r.text.includes(b));
        assert.ok(/<label for="f-q">/.test(r.text) && /<caption class="sr">/.test(r.text), 'labelled filters, captioned tables');
        assert.ok(!/\bfree\b/i.test(r.text), 'no cost claims in served HTML');
        assert.ok(r.text.includes('"menu":{"before":[{"id":"media-mine","label":"Your media","href":"/me"'), 'the account menu links /me');
        assert.ok(!r.text.includes('href="/me/ops"'), 'no operator link for a user');
        assert.ok((await call('GET', '/me', { cookie: 'admin' })).text.includes('href="/me/ops"'), 'staff get one');
        r = await call('GET', next[1].replace(/&amp;/g, '&'), { cookie: 'ana' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((r.text.match(/<tr data-id="med_/g) || []).length, anaIds.length - 1 - 25, 'the second page');
        assert.ok(r.text.includes('>Newest</a>'));
        r = await call('GET', '/me/?kind=avatar&app=live', { cookie: 'ana' });
        assert.strictEqual((r.text.match(/<tr data-id="med_/g) || []).length, 1, '/me/ and filters as a GET form');
        assert.ok(r.text.includes('<option value="avatar" selected>'));
        r = await call('GET', `/me/objects/${anaReady[0]}`, { cookie: 'ana' });
        assert.ok(r.status === 200 && r.text.includes('waveform') && r.text.includes('Copies') && r.text.includes('noindex'));
        r = await call('GET', `/me/objects/${multi}`, { cookie: 'ana' });
        assert.ok(r.text.includes('data-upload=') && r.text.includes('/me/app.js'), 'an upload in progress is polled on its page');
        r = await call('GET', '/me/app.js?v=x');
        assert.ok(r.status === 200 && /javascript/.test(r.headers['content-type']) && r.text.includes('/api/v2/me/objects'));
        assert.ok(!/innerHTML/.test(r.text), 'the script builds nodes, never markup');
        console.log('✅ /me without JavaScript: first page, pager, filters, usage, progress; escaped; detail pages');

        // ── Crawlers ──
        r = await call('GET', '/sitemap.xml');
        const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        assert.ok(r.status === 200 && locs.length && locs.every(l => !/^https:\/\/media\.test\/me([/?]|$)/.test(l)), 'the sitemap never lists /me');
        r = await call('GET', '/robots.txt');
        assert.ok(/^Disallow: \/me$/m.test(r.text), 'robots.txt keeps crawlers out of /me');
        console.log('✅ /me is not in the sitemap and is disallowed in robots.txt');

        // ── Operator views ──
        r = await call('GET', '/api/v2/me/ops', { token: 'ana' });
        assert.deepStrictEqual([r.status, r.json.code], [403, 'capability.denied']);
        assert.strictEqual((await call('GET', '/api/v2/me/ops', { token: 'mod' })).status, 403, 'a global_mod does not hold staff.site.view');
        assert.strictEqual((await call('GET', '/api/v2/me/ops')).status, 401);
        r = await call('GET', '/me/ops', { cookie: 'ana' });
        assert.ok(r.status === 403 && r.text.includes('staff.site.view') && !r.text.includes('mjob_TESTFAILED'));
        r = await call('GET', '/api/v2/me/ops', { token: 'admin' });
        assert.strictEqual(r.status, 200, r.text);
        const rep = r.json;
        assert.strictEqual(rep.scope, 'all');
        assert.deepStrictEqual(rep.jobs.failed.recent.map(j => [j.id, j.error_code, j.error]), [['mjob_TESTFAILED', 'no_video', 'ffmpeg exited 1']]);
        assert.deepStrictEqual(rep.jobs.failed.last_7_days, [{ type: 'object.sprite', error_code: 'no_video', count: 1 }]);
        assert.ok(rep.missing.no_good_copy.objects.some(o => o.id === lost), 'a ready object whose only copy is missing');
        assert.ok(rep.missing.locations.missing_or_corrupt.some(l => l.object_id === lost && l.provider === 'b2'));
        assert.ok(rep.backfill.unprojected && rep.backfill.owner_subject.missing >= 1);
        assert.ok(rep.tiering.objects.some(o => o.origin === 'native') && rep.tiering.sweep && 'pending_offload' in rep.tiering);
        assert.ok(rep.namespaces.some(n => n.namespace === 'live.avatars'));
        r = await call('GET', '/api/v2/me/ops?app=tools', { token: 'admin' });
        assert.deepStrictEqual([r.json.scope, r.json.jobs.failed.total, r.json.namespaces.map(n => n.namespace)], ['tools', 0, ['tools']]);
        r = await call('GET', '/me/ops', { cookie: 'admin' });
        assert.ok(r.status === 200 && r.text.includes('mjob_TESTFAILED') && r.text.includes('action="/me/ops/recompute"') && r.text.includes('noindex'));
        console.log('✅ operator views: staff.site.view only (not users, not global mods); failed jobs, missing media, backfill, tiering, namespaces');

        // ── Recompute: staff.site.configure, same-origin ──
        db.run("UPDATE media_namespaces SET used_bytes = 0, used_objects = 0, reconciled_at = NULL WHERE namespace = 'live'");
        assert.strictEqual((await call('POST', '/api/v2/me/ops/recompute', { cookie: 'admin' })).status, 403, 'a cookie-borne write needs this site as its origin');
        assert.strictEqual((await call('POST', '/api/v2/me/ops/recompute', { cookie: 'admin', headers: { origin: 'https://evil.test' } })).status, 403);
        assert.strictEqual((await call('POST', '/api/v2/me/ops/recompute', { cookie: 'admin', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://media.test' } })).status, 403);
        assert.strictEqual((await call('POST', '/api/v2/me/ops/recompute', { token: 'ana' })).status, 403, 'users cannot recompute');
        assert.strictEqual(db.get("SELECT used_bytes FROM media_namespaces WHERE namespace = 'live'").used_bytes, 0, 'nothing ran');
        r = await call('POST', '/api/v2/me/ops/recompute', { cookie: 'admin', headers: { origin: 'https://media.test' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.json.namespaces, r.json.scope], [db.get('SELECT COUNT(*) AS n FROM media_namespaces').n, 'all']);
        const liveRow = db.get("SELECT * FROM media_namespaces WHERE namespace = 'live'");
        assert.strictEqual(liveRow.used_bytes, namespaces.usage(db.getApp('live'), 'live').used_bytes);
        assert.ok(liveRow.used_bytes > 0 && liveRow.reconciled_at, 'the snapshot is counted again from the rows');
        r = await call('POST', '/me/ops/recompute?app=tools', { cookie: 'admin', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
        assert.deepStrictEqual([r.status, r.headers.location], [303, '/me/ops?app=tools&recomputed=1'], 'the form posts and comes back to the page');
        r = await call('POST', '/api/v2/me/ops/recompute', { token: 'admin' });
        assert.strictEqual(r.status, 200, 'a bearer token is not a cookie: no cross-site risk');
        console.log('✅ recompute: staff.site.configure, same-origin for the cookie, refreshes the snapshot; the page form redirects back');

        // ── The app-key twin in the admin routes ──
        r = await call('GET', '/api/v1/live/admin/storage/ops', { token: 'live-key' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.scope, 'live');
        assert.ok(r.json.namespaces.every(n => n.app_id === 'live'));
        assert.strictEqual((await call('GET', '/api/v1/live/admin/storage/ops', { token: 'live-key', headers: { 'x-ov-user-id': '5' } })).status, 403, 'never acting for a user');
        assert.strictEqual((await call('GET', '/api/v1/live/admin/storage/ops', { token: 'ana' })).status, 401);
        r = await call('POST', '/api/v1/tools/admin/storage/ops/recompute', { token: 'tools-key' });
        assert.deepStrictEqual([r.status, r.json.scope, r.json.namespaces], [200, 'tools', 1]);
        console.log('✅ /api/v1/:app/admin/storage/ops: the same report for the app key, scoped to its tenant');

        // ── Routes under /api/v2/me are the explorer's only ──
        r = await call('GET', '/api/v2/me/namespaces', { token: 'ana' });
        assert.deepStrictEqual([r.status, r.json.code], [404, 'media.not_found']);
        console.log('me-explorer: all checks passed');
    } finally {
        server.close();
        try { db.close(); } catch { /* */ }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
