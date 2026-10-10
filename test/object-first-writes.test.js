'use strict';
// Object-first writes (WS-G task 1, C-75 retired 2026-10-10): every write to an inherited
// vods/clips/files row makes or updates its media_object in the SAME PostgreSQL transaction
// (objects/model.js withObject). For each main write path the object is there, linked and agreeing
// with the row as soon as the write returns; when the object cannot be written, the row write
// rolls back with it (neither row).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-object-first-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_PUBLIC_URL: 'https://media.test',
    });

    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const tools = require('../server/vod/media-tools');
    const thumbService = require('../server/thumbnails/thumbnail-service');
    const cutter = require('../server/vod/clip-cutter');
    const vodStorage = require('../server/vod/vod-storage');
    // The revisioned tier policies load once the database is open (server/index.js does this at boot).
    await vodStorage.tierConfig.init(vodStorage.DEFAULTS);
    await require('../server/objects/tier-policy').init();
    const clipJobs = require('../server/vod/clip-jobs');
    const { finalizeVod } = require('../server/vod/finalize');

    await db.upsertApp({ app_id: 'live', api_key: 'live-key-object-first' });
    const raw = db.getDb();
    const count = async (table) => (await raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;

    // No ffmpeg in these paths: the thumbnail generators and the probes answer as a real file would.
    thumbService.generateVodThumbnail = async () => null;
    thumbService.generateClipThumbnail = async () => null;
    tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 30, error: null });
    tools.probeDuration = async () => ({ ok: true, seconds: 30, format: {}, streams: [], error: null });
    tools.remuxForSeeking = async () => true;
    tools.probeVodInfo = async () => ({ duration: 12 });

    /** The row, and the object its object_id names; asserts the pair agrees on every field a sync writes. */
    async function linked(table, keyCol, key, label) {
        const row = await db.get(`SELECT * FROM ${table} WHERE ${keyCol} = ?`, [key]);
        assert.ok(row, `${label}: row exists`);
        assert.ok(row.object_id, `${label}: row names its object`);
        const obj = await model.getObject(row.object_id);
        assert.ok(obj, `${label}: object exists right after the write`);
        const p = { vods: model.vodProjection, clips: model.clipProjection, files: model.fileProjection }[table](row);
        for (const [field, value] of Object.entries({ kind: p.kind, visibility: p.visibility, lifecycle_status: p.lifecycle_status, size_bytes: Number(p.size_bytes) || 0, legacy_ref: p.legacy_ref, app_id: p.app_id, owner_app: p.owner_app || p.app_id, owner_user_id: p.owner_user_id })) {
            assert.strictEqual(String(obj[field] ?? ''), String(value ?? ''), `${label}: object ${field}`);
        }
        return { row, obj };
    }

    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    app.use('/api/v1/:app/files', require('../server/files/routes'));
    app.use('/api/v1/:app/thumbnails', require('../server/thumbnails/routes'));
    const server = http.createServer(app);

    (async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}/api/v1/live`;
        const auth = { authorization: 'Bearer live-key-object-first' };
        const call = async (method, p, body) => {
            const headers = { ...auth };
            if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json';
            const r = await fetch(base + p, { method, headers, body: body && !(body instanceof FormData) ? JSON.stringify(body) : body });
            return { status: r.status, body: await r.json().catch(() => null) };
        };
        const form = (field, bytes, type, name, extra = {}) => {
            const f = new FormData();
            for (const [k, v] of Object.entries(extra)) f.append(k, String(v));
            f.append(field, new Blob([bytes], { type }), name);
            return f;
        };
        const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#3366ff' } }).png().toBuffer();

        // ── 1. VOD: create, chunk upload, metadata/visibility, finalize, thumbnail, health, tier move ──
        let r = await call('POST', '/vods', { title: 'First', user_id: 7, visibility: 'unlisted' });
        assert.strictEqual(r.status, 201);
        const vodId = r.body.id;
        let { obj } = await linked('vods', 'id', vodId, 'vod create');
        assert.deepStrictEqual([obj.kind, obj.visibility, obj.lifecycle_status, obj.legacy_ref], ['vod', 'unlisted', 'uploading', `legacy:live:vod:${vodId}`]);

        r = await call('POST', '/vods', { title: 'Clips only', clips_only: true });
        assert.strictEqual(r.status, 201);
        const clipsOnly = await db.get('SELECT * FROM vods WHERE id = ?', [r.body.id]);
        assert.strictEqual(clipsOnly.clips_only, 1, 'clips_only written with the row');
        assert.strictEqual(clipsOnly.object_id, null, 'a clips-only recording has no object (skipped by design)');

        r = await call('POST', `/vods/${vodId}/chunks`, form('chunk', Buffer.alloc(40000, 1), 'video/webm', 'a.webm'));
        assert.strictEqual(r.body.status, 'created');
        ({ obj } = await linked('vods', 'id', vodId, 'first chunk'));
        const loc = async () => (await model.listLocations(obj.id)).find(l => l.provider === 'local');
        assert.strictEqual((await loc()).state, 'present', 'the recording file is a present local copy at once');
        assert.strictEqual(obj.size_bytes, 40000);
        r = await call('POST', `/vods/${vodId}/chunks`, form('chunk', Buffer.alloc(8000, 2), 'video/webm', 'b.webm'));
        assert.strictEqual(r.body.status, 'appended');
        ({ obj } = await linked('vods', 'id', vodId, 'chunk progress'));
        assert.strictEqual(obj.size_bytes, 48000, 'progress updates carry the object size with them');

        r = await call('PUT', `/vods/${vodId}`, { title: 'Renamed', visibility: 'private' });
        assert.strictEqual(r.status, 200);
        ({ obj } = await linked('vods', 'id', vodId, 'vod update'));
        assert.strictEqual(obj.visibility, 'private');
        assert.strictEqual(model.parseJson(obj.metadata, {}).title, 'Renamed');

        const done = await finalizeVod(vodId);
        assert.ok(done && done.health_status === 'ok');
        ({ obj } = await linked('vods', 'id', vodId, 'finalize'));
        assert.strictEqual(obj.lifecycle_status, 'ready', 'the ready transition commits with its object');
        assert.strictEqual(model.parseJson(obj.metadata, {}).duration_seconds, 30);

        r = await call('POST', `/thumbnails/vod/${vodId}`, { image: png.toString('base64') });
        assert.strictEqual(r.status, 200);
        ({ obj } = await linked('vods', 'id', vodId, 'thumbnail'));
        const thumbName = path.basename(r.body.url);
        const thumbObj = await model.getObjectByLegacyRef(`legacy:live:thumbnail:${thumbName}`);
        assert.ok(thumbObj, 'the thumbnail object is written with the row');
        assert.strictEqual((await model.getVariant(obj.id, 'thumbnail')).derived_object_id, thumbObj.id);
        assert.deepStrictEqual([thumbObj.visibility, thumbObj.size_bytes], ['unlisted', png.length], 'a private VOD\'s thumbnail is unlisted');

        await db.updateVodHealth(vodId, { status: 'corrupt', issues: ['test'], quarantine: true });
        assert.strictEqual((await linked('vods', 'id', vodId, 'health')).obj.lifecycle_status, 'failed');
        await db.updateVodHealth(vodId, { status: 'ok', issues: [] });

        await model.afterTierMove(vodId, ['b2'], async () => await db.run("UPDATE vods SET storage_provider = 'b2', storage_key = 'vods/x.webm' WHERE id = ?", [vodId]));
        ({ obj } = await linked('vods', 'id', vodId, 'tier move'));
        assert.strictEqual(obj.canonical_provider, 'b2');
        assert.strictEqual((await model.listLocations(obj.id)).find(l => l.provider === 'b2').state, 'present', 'the verified copy is marked with the flip');

        // A ghost row (a recording that never produced a file) gets its object as it is quarantined.
        await raw.prepare("INSERT INTO vods (id, app_id, title, created_at) OVERRIDING SYSTEM VALUE VALUES (500, 'live', 'ghost', datetime('now', '-2 hours')) RETURNING id").run();
        assert.strictEqual(await vodStorage.reconcileGhosts(), 1);
        assert.strictEqual((await linked('vods', 'id', 500, 'ghost quarantine')).obj.lifecycle_status, 'failed');
        console.log('✅ VOD writes (create, chunks, update, finalize, thumbnail, health, tier move, ghost quarantine) commit with their object');

        // ── 2. Clips: upload, create + re-cut (processing -> ready | failed), update, delete ──
        r = await call('POST', '/clips', form('video', Buffer.alloc(5000, 3), 'video/webm', 'c.webm', { title: 'Up', vod_id: vodId, visibility: 'private' }));
        assert.strictEqual(r.status, 201);
        const upId = r.body.id;
        ({ obj } = await linked('clips', 'id', upId, 'clip upload'));
        assert.deepStrictEqual([obj.kind, obj.visibility, obj.lifecycle_status, obj.size_bytes], ['clip', 'private', 'ready', 5000]);

        const cutId = Number((await db.createClip({ app_id: 'live', vod_id: vodId, user_id: 7, title: 'Cut', start_time: 1, end_time: 6, duration_seconds: 5, visibility: 'unlisted', status: 'processing' })).lastInsertRowid);
        ({ obj } = await linked('clips', 'id', cutId, 'clip create'));
        assert.deepStrictEqual([obj.visibility, obj.lifecycle_status], ['unlisted', 'uploading']);
        const cutFile = path.join(process.env.CLIPS_PATH, 'cut.webm');
        fs.writeFileSync(cutFile, Buffer.alloc(6000, 4));
        const realResolve = vodStorage.resolveMediaSource;
        const realCut = cutter.cutClipFile;
        vodStorage.resolveMediaSource = async () => ({ kind: 'file', value: '/src.webm' });
        cutter.cutClipFile = async () => ({ ok: true, filePath: cutFile, duration: 5 });
        assert.strictEqual((await clipJobs.recutClip(cutId)).ok, true);
        ({ obj } = await linked('clips', 'id', cutId, 'clip ready'));
        assert.deepStrictEqual([obj.lifecycle_status, obj.size_bytes], ['ready', 6000], 'the ready transition (announce) commits with its object');
        vodStorage.resolveMediaSource = async () => null;
        assert.strictEqual((await clipJobs.recutClip(cutId)).ok, false);
        assert.strictEqual((await linked('clips', 'id', cutId, 'clip failed')).obj.lifecycle_status, 'failed');
        vodStorage.resolveMediaSource = realResolve;
        cutter.cutClipFile = realCut;

        r = await call('PUT', `/clips/${upId}`, { title: 'Better', visibility: 'public', auto_generated: 1 });
        assert.strictEqual(r.status, 200);
        ({ obj } = await linked('clips', 'id', upId, 'clip update'));
        assert.strictEqual(obj.visibility, 'public');
        assert.deepStrictEqual([model.parseJson(obj.metadata, {}).title, model.parseJson(obj.metadata, {}).auto_generated], ['Better', true]);

        const doomedFile = path.join(process.env.CLIPS_PATH, 'doomed.webm');
        fs.writeFileSync(doomedFile, Buffer.alloc(700, 5));
        const doomed = Number((await db.createClip({ app_id: 'live', vod_id: vodId, title: 'Doomed', file_path: doomedFile, status: 'ready' })).lastInsertRowid);
        const doomedObj = (await linked('clips', 'id', doomed, 'clip to delete')).obj.id;
        assert.strictEqual((await call('DELETE', `/clips/${doomed}`)).status, 200);
        assert.strictEqual((await model.getObject(doomedObj)).lifecycle_status, 'deleted', 'a deleted row takes its object with it (trigger, same statement)');
        console.log('✅ clip writes (upload, create, re-cut ready/failed, update, delete) commit with their object');

        // ── 3. Files ──
        r = await call('POST', '/files', form('file', Buffer.from('hello object model'), 'text/plain', 'notes.txt'));
        assert.strictEqual(r.status, 201);
        const fileKey = r.body.key;
        ({ obj } = await linked('files', 'key', fileKey, 'file upload'));
        assert.strictEqual(obj.content_hash, crypto.createHash('sha256').update('hello object model').digest('hex'));
        const spare = await call('POST', '/files', form('file', Buffer.from('spare'), 'text/plain', 'spare.txt'));
        const spareObj = (await linked('files', 'key', spare.body.key, 'file to delete')).obj.id;
        assert.strictEqual((await call('DELETE', `/files/${encodeURIComponent(spare.body.key)}`)).status, 200);
        assert.strictEqual((await model.getObject(spareObj)).lifecycle_status, 'deleted');

        console.log('✅ file writes commit with their object; deletes mark it deleted');

        // ── 4. Atomicity: an object write that fails takes the row write with it ──
        // Every object write fails (as a trigger refusing it would): the model's INSERT/UPDATE of media_objects throws.
        const realRun = db.run;
        db.run = async (sql, params) => {
            if (/^\s*(INSERT INTO|UPDATE) media_objects\b/.test(sql)) throw new Error('object write refused (test)');
            return await realRun(sql, params);
        };
        const before = { vods: await count('vods'), clips: await count('clips'), files: await count('files'), objects: await count('media_objects') };
        const unchanged = async (label) => assert.deepStrictEqual({ vods: await count('vods'), clips: await count('clips'), files: await count('files'), objects: await count('media_objects') }, before, label);

        await assert.rejects(async () => await db.createVod({ app_id: 'live', title: 'No object' }), /object write refused/);
        await unchanged('createVod: neither row');
        assert.strictEqual((await call('POST', '/vods', { title: 'No object' })).status, 500);
        await unchanged('POST /vods: neither row');
        await assert.rejects(async () => await db.createClip({ app_id: 'live', vod_id: vodId, title: 'No object', status: 'processing' }), /object write refused/);
        await unchanged('createClip: neither row');
        assert.strictEqual((await call('POST', '/files', form('file', Buffer.from('never stored'), 'text/plain', 'never.txt'))).status, 500);
        await unchanged('POST /files: neither row');

        // Updates: the row keeps its old values when its object cannot follow.
        await assert.rejects(async () => await db.setVodVisibility(vodId, 'public'), /object write refused/);
        assert.strictEqual((await db.get('SELECT visibility FROM vods WHERE id = ?', [vodId])).visibility, 'private', 'visibility change rolled back');
        assert.strictEqual((await call('PUT', `/clips/${upId}`, { title: 'Lost' })).status, 500);
        assert.strictEqual((await db.get('SELECT title FROM clips WHERE id = ?', [upId])).title, 'Better', 'clip title rolled back');
        // The announce() path: a finalize whose object cannot be written commits no ready transition (and no event).
        await raw.prepare("UPDATE vods SET is_recording = 1, health_status = 'unknown' WHERE id = ?").run(vodId);
        await assert.rejects(finalizeVod(vodId, { fromJob: true }), /object write refused/);
        assert.strictEqual((await db.get('SELECT is_recording FROM vods WHERE id = ?', [vodId])).is_recording, 1, 'ready transition rolled back with its object');

        // A write that throws after its projection insert leaves neither row.
        await assert.rejects(async () => await db.withObject('vod', (x) => x.lastInsertRowid, async () => {
            await db.run("INSERT INTO vods (app_id, title) VALUES ('live', 'half') RETURNING id");
            throw new Error('crash after the insert');
        }), /crash after the insert/);
        await unchanged('thrown after the insert: neither row');
        db.run = realRun;
        await finalizeVod(vodId, { fromJob: true });
        console.log('✅ a write whose object cannot be written leaves neither row (inserts, updates, announce path, a throw after the insert)');

        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('✅ All object-first write tests passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
