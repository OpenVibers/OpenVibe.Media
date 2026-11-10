'use strict';
// Avatars that a person's profile points at (incident 2026-11-06: a cleanup of public screenshot copies deleted
// eleven pictures people were using as avatars). A profile's picture is a native avatar object owned by them, and
// the object it points at cannot be soft-deleted while the reference stands:
//   - a screenshot object becomes an avatar object (a copy, local bytes, no self-fetch), owned by the subject;
//   - deleting the screenshot afterwards leaves the avatar working;
//   - deleting the avatar is 409 media.object.avatar_in_use until the profile releases the reference;
//   - replacing the picture releases the previous reference with the new one (the old object then deletes);
//   - ingesting the person's own avatar again reuses it instead of copying;
//   - shape 'banner' keeps a wide crop;
//   - erasing an account releases its references first, so its own avatar is deleted.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const sharp = require('sharp');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-avatar-guard-'));
    process.env.OBJECTS_PATH = path.join(tmp, 'objects');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';

    const { ids } = require('openvibe-contracts');
    const db = require('../server/db/database');
    const config = require('../server/config');
    const model = require('../server/objects/model');
    const namespaces = require('../server/objects/namespaces');
    const ingest = require('../server/avatars/ingest');

    await db.upsertApp({ app_id: 'live', name: 'OpenVibe.Live', api_key: 'live-key' });
    await db.ensureRootNamespace(await db.getApp('live'));
    await namespaces.ensure(await db.getApp('live'), 'live.avatars');
    await require('../server/events').initWriter();

    const ANA = `usr_${ids.ulid()}`;
    const png = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#3b82f6' } }).png().toBuffer();
    const store = async (o, bytes) => {
        const id = await model.createObject({ app_id: 'live', namespace: 'live.avatars', visibility: 'public', lifecycle_status: 'ready',
            mime_type: 'image/png', size_bytes: bytes.length, createdMs: Date.now(), ...o });
        const key = model.objectFilePath(await model.getObject(id));
        fs.mkdirSync(path.dirname(key), { recursive: true }); fs.writeFileSync(key, bytes);
        await model.upsertLocation(id, { provider: 'local', key, state: 'present', size_bytes: bytes.length, verified: true });
        await model.updateObject(id, { canonical_provider: 'local', canonical_key: key });
        return id;
    };

    // The screenshot a person picked as their picture: someone else's object, in a product that may clean it up.
    const shotId = await store({ kind: 'screenshot', owner_subject: `usr_${ids.ulid()}`, metadata: { filename: 'paste.png' } }, png);

    const app = express();
    app.use(express.json());
    app.post('/internal/avatar-ingest', ingest.createIngestHandler({ db, config }));
    app.post('/internal/avatar-adopt', ingest.createAdoptHandler());
    app.post('/internal/avatar-release', ingest.createReleaseHandler());
    app.use('/api/v2/:app/objects', require('../server/objects/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = (method, p, body) => fetch(`http://127.0.0.1:${server.address().port}${p}`, {
        method, headers: { 'content-type': 'application/json', authorization: 'Bearer live-key' }, body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    try {
        // 1) A screenshot becomes an avatar object owned by the person, read from local bytes (no network fetch).
        const first = await call('POST', '/internal/avatar-ingest', { url: `${config.publicUrl}/o/${shotId}`, user_id: 513, subject: ANA, product: 'network', ref: '513' });
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        const avatarId = first.body.object_id;
        assert.match(avatarId, /^med_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.notStrictEqual(avatarId, shotId, 'a copy, not the screenshot itself');
        const av = await model.getObject(avatarId);
        assert.deepStrictEqual([av.kind, av.owner_subject, av.visibility, av.lifecycle_status], ['avatar', ANA, 'unlisted', 'ready']);
        const ref = await model.avatarRef(avatarId);
        assert.deepStrictEqual([ref.product, ref.ref, ref.subject], ['network', '513', ANA]);
        const avatarFile = async (id) => (await model.listLocations(id)).find((l) => l.provider === 'local').key;
        const avBytes = fs.readFileSync(await avatarFile(avatarId));
        assert.deepStrictEqual(['webp', 512, 512], await sharp(avBytes).metadata().then((m) => [m.format, m.width, m.height]));

        // 2) Deleting the screenshot afterwards leaves the avatar working: it is a copy.
        const delShot = await call('DELETE', `/api/v2/live/objects/${shotId}`);
        assert.strictEqual(delShot.status, 200, JSON.stringify(delShot.body));
        assert.strictEqual((await model.getObject(avatarId)).lifecycle_status, 'ready');
        assert.ok(fs.existsSync(await avatarFile(avatarId)), 'the avatar bytes are still there');

        // 3) The avatar the profile points at cannot be deleted, with a code that says why.
        const refused = await call('DELETE', `/api/v2/live/objects/${avatarId}`);
        assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
        assert.strictEqual(refused.body.code, 'media.object.avatar_in_use');
        assert.strictEqual((await model.getObject(avatarId)).lifecycle_status, 'ready');

        // 4) Replacing the picture releases the previous reference; the old object then deletes.
        const second = await call('POST', '/internal/avatar-ingest', { url: `${config.publicUrl}/o/${avatarId}`, user_id: 513, subject: ANA, product: 'network', ref: '513' });
        assert.strictEqual(second.body.reused, true, 'the person\'s own avatar is reused, not copied');
        assert.strictEqual(second.body.object_id, avatarId);
        const nextShot = await store({ kind: 'screenshot', owner_subject: ANA }, png);
        const replaced = await call('POST', '/internal/avatar-ingest', { url: `${config.publicUrl}/o/${nextShot}`, user_id: 513, subject: ANA, product: 'network', ref: '513' });
        assert.strictEqual(replaced.status, 200, JSON.stringify(replaced.body));
        assert.strictEqual(replaced.body.duplicate, true, 'identical avatar bytes reuse the existing object');
        assert.strictEqual(replaced.body.object_id, avatarId);
        assert.ok(await model.avatarRef(avatarId), 'the reused avatar remains referenced by the profile');
        assert.strictEqual((await call('DELETE', `/api/v2/live/objects/${avatarId}`)).status, 409);

        // 5) An explicit release lets the picture go too.
        const released = await call('POST', '/internal/avatar-release', { product: 'network', ref: '513' });
        assert.deepStrictEqual([released.status, released.body.released], [200, 1]);
        assert.strictEqual((await call('DELETE', `/api/v2/live/objects/${replaced.body.object_id}`)).status, 200);

        // 6) A banner keeps its wide shape (an avatar is square).
        const bannerShot = await store({ kind: 'screenshot', owner_subject: ANA }, png);
        const banner = await call('POST', '/internal/avatar-ingest', { url: `${config.publicUrl}/o/${bannerShot}`, user_id: 461, subject: ANA, product: 'live', ref: '461', shape: 'banner' });
        assert.strictEqual(banner.status, 200, JSON.stringify(banner.body));
        const bm = await sharp(fs.readFileSync(await avatarFile(banner.body.object_id))).metadata();
        assert.deepStrictEqual([bm.width, bm.height], [1600, 500]);

        // 7) Erasing the account releases the references first, so its own avatar is deleted, not stranded.
        const erase = require('../server/account-data');
        const out = await erase.erase(db.getDb(), [ANA]);
        assert.strictEqual((await model.getObject(banner.body.object_id)).lifecycle_status, 'deleted');
        assert.ok(out.erased.objects >= 1, JSON.stringify(out));
        assert.ok(!await model.avatarRef(banner.body.object_id));

        console.log('avatar guard: all checks passed');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
