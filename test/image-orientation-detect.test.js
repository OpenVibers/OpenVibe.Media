'use strict';
// The model-backed detector: a picture whose EXIF did not settle it is marked unknown, asked about at 256 px, and
// turned only above the owner's confidence; below it nothing changes and the receipt is still kept.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-detect-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods'); process.env.FILES_PATH = dir('files'); process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails'); process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_SIGNING_SECRET = 'test-signing-secret'; process.env.MEDIA_OBJECT_MAX_MB = '1';

    const db = require('../server/db/database');
    const config = require('../server/config');
    const model = require('../server/objects/model');
    const { createDetector } = require('../server/images/ai-orientation');
    await db.initDb();
    await db.upsertApp({ app_id: 'media-hub', api_key: 'mh-key' });
    const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

    let answer = { rotation: 90, confidence: 0.9 };
    const fetchImpl = async (url) => {
        if (String(url).includes('/oauth/token')) {
            return new Response(JSON.stringify({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ method: 'vision', answered: true, ...answer, setting: { confidence: 0.8 }, model: 'see', receipt_id: 'rcpt_test', cost_usd: 0.0001 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const detector = createDetector({ config: { ...config, ai: { internalUrl: 'http://ai.test', clientSecret: 's', clientId: 'media', audience: 'openvibe.ai', timeoutMs: 5000 }, orientation: { enabled: true } }, db, fetchImpl, log: { warn: () => {} } });

    async function picture() {
        const file = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#3c3' } }).jpeg().toBuffer();
        const id = await model.createObject({ app_id: 'media-hub', namespace: 'media-hub', kind: 'file', owner_subject: SUBJECT, visibility: 'private', lifecycle_status: 'ready', mime_type: 'image/jpeg', size_bytes: file.length, content_hash: sha(file) });
        const key = path.join(config.objects.path, `${id}.jpg`);
        fs.writeFileSync(key, file);
        await model.updateObject(id, { canonical_provider: 'local', canonical_key: key });
        await model.upsertLocation(id, { provider: 'local', key, state: 'present', size_bytes: file.length, checksum: sha(file), verified: true });
        return { id, key, obj: await model.getObject(id) };
    }

    try {
        // Above the confidence: marked unknown first, then turned, with the model's answer and receipt kept.
        const a = await picture();
        const out = await detector.detect(a.obj);
        assert.strictEqual(out.status, 'turned', JSON.stringify(out));
        assert.strictEqual(out.rotation, 90);
        const md = model.parseJson((await model.getObject(a.id)).metadata, {});
        assert.strictEqual(md.orientation_status, 'orientation applied by model');
        assert.strictEqual(md.orientation_model_rotation, 90);
        assert.strictEqual(md.orientation_model_confidence, 0.9);
        assert.strictEqual(md.orientation_receipt, 'rcpt_test');
        assert.strictEqual(md.rotation, 90);
        const turned = await sharp(a.key).metadata();
        assert.deepStrictEqual([turned.width, turned.height], [20, 30]);

        // Below the confidence: the answer is kept, the picture is not turned, and it stays unknown for another look.
        answer = { rotation: 180, confidence: 0.4 };
        const b = await picture();
        const low = await detector.detect(b.obj);
        assert.deepStrictEqual([low.status, low.turned, low.rotation], ['below_confidence', false, 180]);
        const lowMd = model.parseJson((await model.getObject(b.id)).metadata, {});
        assert.strictEqual(lowMd.orientation_status, 'orientation unknown');
        assert.strictEqual(lowMd.orientation_model_confidence, 0.4);
        const untouched = await sharp(b.key).metadata();
        assert.deepStrictEqual([untouched.width, untouched.height], [30, 20]);
        console.log('image orientation detector: 256 px ask, confidence gate, receipt kept');
    } finally {
        await db.close().catch(() => {});
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
