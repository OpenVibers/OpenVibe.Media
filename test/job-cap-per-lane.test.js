'use strict';
// The per-tenant job cap counts one lane. On 2026-10-13 the heavy lane waited out a day of back-to-back recordings
// (worker.js runs no transcode while a recording does) with 30 object.cmaf and 20 object.pack jobs queued: they held the
// whole tenant-wide cap of 50, so every thumbnail and content hash of the new recordings was refused with 429 for hours.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-jobcap-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
    MEDIA_INVARIANT_SCAN_HOURS: '0',
});

(async () => {
    const stub = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-jobcap' });
    await db.upsertApp({ app_id: 'games', api_key: 'games-key-jobcap' });
    require('../server/events').init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 });
    const queue = require('../server/jobs/queue');
    // Nothing runs these: no worker is started, so they stay queued like the paused heavy lane.
    queue.register('test.cap.heavy', { lane: 'heavy', run: async () => ({}) });
    queue.register('test.cap.light', { lane: 'light', run: async () => ({}) });
    const cap = queue.MAX_ACTIVE_PER_TENANT;

    assert.ok(queue.typesInLane('heavy').includes('object.cmaf') && queue.typesInLane('heavy').includes('object.pack'), 'transcodes are heavy');
    assert.ok(queue.typesInLane('light').includes('thumbnail.regenerate') && !queue.typesInLane('light').includes('object.cmaf'), 'thumbnails are light');

    for (let i = 0; i < cap; i++) await queue.enqueue({ appId: 'live', type: 'test.cap.heavy', params: { n: i } });
    await assert.rejects(queue.enqueue({ appId: 'live', type: 'test.cap.heavy', params: { n: cap } }),
        (e) => e.code === 'media.job.too_many' && e.status === 429 && /heavy jobs/.test(e.message), 'the heavy lane is full');
    const light = await queue.enqueue({ appId: 'live', type: 'test.cap.light', params: { n: 0 } });
    assert.ok(light.created, 'a full heavy lane does not stop a light job');
    assert.ok((await queue.enqueue({ appId: 'games', type: 'test.cap.heavy', params: { n: 0 } })).created, 'another tenant has its own lanes');
    // A proposal is not counted and is still accepted with a full lane.
    assert.ok((await queue.enqueue({ appId: 'live', type: 'test.cap.heavy', params: { n: 'p' }, status: 'proposed' })).created, 'a proposal is not capped');

    for (let i = 1; i < cap; i++) await queue.enqueue({ appId: 'live', type: 'test.cap.light', params: { n: i } });
    await assert.rejects(queue.enqueue({ appId: 'live', type: 'test.cap.light', params: { n: cap } }),
        (e) => e.code === 'media.job.too_many' && /light jobs/.test(e.message), 'the light lane has the same cap of its own');

    console.log('job-cap-per-lane: ok');
    stub.close();
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
