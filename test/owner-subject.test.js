'use strict';
// Owner subjects (server/objects/owner-subject.js, server/objects/owner-subject-job.js) against an
// in-process Network stand-in that answers /oauth/token and /internal/identity/resolve-batch like Network
// does: the service token is preferred and the internal key is the fallback; and new objects get their
// subject (X-OV-Subject at creation, the reconcile job for everything else), with a re-projection to
// another owner dropping it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ids } = require('openvibe-contracts');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-owner-subject-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    const env = {
        DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), ASSETS_PATH: dir('assets'),
        MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'http://127.0.0.1:9', MEDIA_SIGNING_SECRET: 'test-signing-secret',
        INTERNAL_API_KEY: 'internal-key-0123456789abcdef', OV_OAUTH_CLIENT_ID: 'media', OV_OAUTH_CLIENT_SECRET: 'media-secret',
    };
    for (const k of ['MEDIA_B2_ENDPOINT', 'MEDIA_B2_BUCKET', 'MEDIA_R2_ENDPOINT', 'MEDIA_R2_BUCKET', 'EVENTS_URL', 'MEDIA_OWNER_SUBJECT_SYNC']) process.env[k] = '';
    Object.assign(process.env, env);

    // ── Network stand-in ─────────────────────────────────────────
    const net = {
        grant: true,                     // does 'media' hold identity.subject.resolve?
        map: new Map(),                  // 'live:<id>' -> usr_…
        calls: [],                       // { via, system, n }
        tokens: 0,
        down: false,
    };
    const network = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (net.down) return send(503, { error: 'down' });
            if (req.method === 'POST' && req.url === '/oauth/token') {
                const f = new URLSearchParams(raw);
                if (f.get('client_id') !== 'media' || f.get('client_secret') !== 'media-secret') return send(401, { error: 'invalid_client' });
                if (f.get('audience') !== 'openvibe.network' || f.get('scope') !== 'identity.subject.resolve') return send(400, { error: 'invalid_request' });
                if (!net.grant) return send(400, { error: 'invalid_scope', error_description: 'not granted: identity.subject.resolve' });
                net.tokens++;
                return send(200, { access_token: 'svc-media-token', token_type: 'Bearer', expires_in: 300, scope: 'identity.subject.resolve' });
            }
            if (req.method === 'POST' && req.url === '/internal/identity/resolve-batch') {
                const bearer = String(req.headers.authorization || '');
                const via = req.headers['x-internal-key'] === env.INTERNAL_API_KEY ? 'internal-key' : (bearer === 'Bearer svc-media-token' && net.grant ? 'service-token' : null);
                if (!via) return send(403, { error: 'Invalid or missing internal key' });
                const b = JSON.parse(raw || '{}');
                if (!Array.isArray(b.ids) || !b.ids.length || !b.system) return send(400, { code: 'identity.bad_request' });
                if (b.ids.length > 500) return send(413, { code: 'identity.too_many_entries' });
                net.calls.push({ via, system: b.system, type: b.type, n: b.ids.length });
                const results = {};
                for (const id of b.ids) {
                    const sid = net.map.get(`${b.system}:${id}`);
                    results[String(id)] = sid ? { subject: { type: 'user', id: sid }, network_user_id: 1, username: `u${id}`, legacy_ids: [] } : null;
                }
                return send(200, { results });
            }
            send(404, { error: 'Not found' });
        });
    });

    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const ownerSubject = require('../server/objects/owner-subject');
    const job = require('../server/objects/owner-subject-job');
    const config = require('../server/config');

    const obj = async (o) => await model.createObject({ app_id: 'live', owner_app: 'live', kind: 'file', lifecycle_status: 'ready', ...o });
    const row = async (id) => await db.get('SELECT * FROM media_objects WHERE id = ?', [id]);
    const subjectOf = (uid) => { const s = ids.newId('user', 1700000000000 + uid); net.map.set(`live:${uid}`, s); return s; };

    (async () => {
        await new Promise((r) => network.listen(0, '127.0.0.1', r));
        const NET = `http://127.0.0.1:${network.address().port}`;
        process.env.OV_NETWORK_INTERNAL_URL = NET;
        config.network.internalUrl = NET;

        // ── Fixture ──
        const s12 = subjectOf(12), s13 = subjectOf(13);
        const preset = ids.newId('user');
        const o = {
            a: await obj({ owner_user_id: 12 }),
            b: await obj({ owner_user_id: 12, kind: 'thumbnail' }),
            c: await obj({ owner_user_id: 13, kind: 'screenshot' }),
            presetDifferent: await obj({ owner_user_id: 12, owner_subject: preset }),   // never overwritten, even though Network says s12
            unknown: await obj({ owner_user_id: 99 }),                                  // Network has no subject for live user 99
            noOwner: await obj({ app_id: 'community', owner_app: 'community' }),
            games: await obj({ app_id: 'games', owner_app: 'games', owner_user_id: 12 }),   // no source system for games ids
        };
        // 520 more owners: more than one resolve-batch call (500 ids at most per call).
        const many = [];
        for (let uid = 1000; uid < 1520; uid++) { subjectOf(uid); many.push(await obj({ owner_user_id: uid, kind: 'clip' })); }
        const TO_FILL = 3 + many.length;

        // (The one-off backfill script ran in production on SQLite and is retired: the reconcile job below fills what is left.)
        // A token Network refuses at resolve-batch: the key answers instead.
        const resolver = ownerSubject.createResolver({ networkUrl: NET });
        net.grant = true;
        let got = await resolver.resolve('live', ['12', '99', 12]);
        assert.deepStrictEqual([...got.entries()], [['12', s12], ['99', null]]);
        assert.strictEqual(resolver.state.via, 'service-token');
        const tokenOnly = ownerSubject.createResolver({ networkUrl: NET, internalKey: '' });
        net.grant = false;
        await assert.rejects(tokenOnly.resolve('live', ['12']), /no service token/);
        net.grant = true;
        console.log('✅ Network auth: service token first, INTERNAL_API_KEY when Network has not granted it; failures are errors');

        // ── New objects: X-OV-Subject at creation ──
        const express = require('express');
        await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
        const app = express();
        app.use(express.json());
        app.use('/api/v2/:app/objects', require('../server/objects/routes'));
        const server = http.createServer(app);
        await new Promise((res) => server.listen(0, '127.0.0.1', res));
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = (headers, body) => fetch(`${base}/api/v2/live/objects`, { method: 'POST', headers: { authorization: 'Bearer live-key', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
        let p = await post({ 'x-ov-subject': `user:${s13}` }, { kind: 'file', size_bytes: 3, user_id: 13 });
        assert.strictEqual(p.status, 201, JSON.stringify(p.body));
        assert.strictEqual((await row(p.body.id)).owner_subject, s13, 'X-OV-Subject is stored at creation');
        p = await post({}, { kind: 'file', size_bytes: 3, user_id: 12 });
        const userOnly = p.body.id;
        assert.deepStrictEqual([(await row(userOnly)).owner_subject, (await row(userOnly)).owner_user_id], [null, 12]);

        // ── New objects: the reconcile job fills the rest (projections included) ──
        const clipId = (await db.createClip({ app_id: 'live', user_id: 13, channel_user_id: 12, title: 'c', file_path: path.join(env.CLIPS_PATH, 'c.webm'), start_time: 0, end_time: 5 })).lastInsertRowid;
        const clipObj = (await db.get('SELECT object_id FROM clips WHERE id = ?', [clipId])).object_id;
        assert.ok(clipObj && (await row(clipObj)).owner_subject === null && (await row(clipObj)).owner_user_id === 13);
        const other = ids.newId('user');
        await db.run('UPDATE media_objects SET owner_subject = ? WHERE id = ?', [other, o.b]);   // set by someone else: the job keeps it
        const late = await obj({ owner_user_id: 13 });                         // made after the others, no subject yet
        assert.strictEqual((await row(late)).owner_subject, null);
        net.calls.length = 0;
        const jr = await job.runOnce();
        assert.ok(jr && jr.filled >= 3, JSON.stringify(jr));
        assert.strictEqual(jr.via, 'service-token');
        assert.deepStrictEqual([(await row(userOnly)).owner_subject, (await row(clipObj)).owner_subject, (await row(late)).owner_subject], [s12, s13, s13]);
        assert.strictEqual((await row(o.a)).owner_subject, s12, 'the job fills every row it can resolve');
        assert.strictEqual((await row(o.unknown)).owner_subject, null);
        assert.strictEqual((await row(o.b)).owner_subject, other, 'never over a non-null value');
        // Network learns live user 99 later: the next run fills it.
        const s99 = subjectOf(99);
        assert.strictEqual((await job.runOnce()).filled, 1);
        assert.strictEqual((await row(o.unknown)).owner_subject, s99);
        // Nothing left to fill: a run asks Network nothing (games 12 is the only pending owner and has no source system).
        net.calls.length = 0;
        assert.deepStrictEqual(await job.runOnce(), { owners: 1, filled: 0, skipped: 0, unresolvable: 0, unsupported: 1, via: null });
        assert.strictEqual(net.calls.length, 0);
        // Network down: the run fails quietly and the next one retries.
        net.down = true;
        const quiet = console.warn; console.warn = () => {};
        await obj({ owner_user_id: 12 });
        assert.strictEqual(await job.runOnce(), null);
        console.warn = quiet;
        assert.match(job.status().last_error, /503/);
        net.down = false;
        assert.strictEqual((await job.runOnce()).filled, 1);

        // A re-projection keeps the subject; a re-projection to another owner drops it until the job resolves the new one.
        await model.sync('clip', clipId);
        assert.strictEqual((await row(clipObj)).owner_subject, s13);
        await db.run('UPDATE clips SET user_id = 12 WHERE id = ?', [clipId]);
        await model.sync('clip', clipId);
        assert.deepStrictEqual([(await row(clipObj)).owner_user_id, (await row(clipObj)).owner_subject], [12, null]);
        await job.runOnce();
        assert.strictEqual((await row(clipObj)).owner_subject, s12);
        // The v2 object's public shape carries it (what Live's lineage resolver reads: owner.subject).
        assert.strictEqual((await model.objectPublic(await row(clipObj))).owner.subject, s12);

        // MEDIA_OWNER_SUBJECT_SYNC=0 keeps the job off.
        config.ownerSubject.enabled = false;
        const said = console.log; console.log = () => {};
        assert.strictEqual(job.start(), false);
        console.log = said;
        config.ownerSubject.enabled = true;
        console.log('✅ new objects: X-OV-Subject stored at creation; the reconcile job fills the rest, re-projection keeps or drops it');

        server.close(); network.close();
        await db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('owner-subject: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
