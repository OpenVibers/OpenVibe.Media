'use strict';
// Media → OpenVibe.Events (roadmap Wave 3): webhook outcomes are also queued in the outbox and
// relayed with a service token; storage alerts are queued once, not once per app; disabled
// without EVENTS_URL. Stub Network token endpoint + stub Events.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-events-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.FILES_PATH = dir('files');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');

const published = [];
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        if (req.url === '/api/v1/events') {
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
            const results = list.map((e) => { published.push(e); return { event_id: e.event_id, seq: published.length, duplicate: false }; });
            return res.end(JSON.stringify(parsed.events ? { results } : results[0]));
        }
        res.statusCode = 404; res.end('{}');
    });
});

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    db.getDb();
    const events = require('../server/events');
    const { sendWebhook } = require('../server/webhooks');

    assert.strictEqual(events.init({ eventsUrl: '', clientSecret: '' }), null, 'off without EVENTS_URL');
    assert.strictEqual(events.emit('vod.ready', 'live', { id: 1 }), null);

    const outbox = events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 50 });
    assert.ok(outbox);

    // A webhook to an app with no webhook URL still queues the durable event.
    await sendWebhook('no-such-app', 'vod.ready', { id: 42, title: 'Stream', meta: { big: 'x'.repeat(100000) }, ai_overview: 'long text' });
    await sendWebhook('no-such-app', 'clip.failed', { id: 7, status: 'failed' });
    await sendWebhook('no-such-app', 'unknown.event', { id: 1 });
    await outbox.flush();
    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[0].event_type, 'media.vod.ready');
    assert.deepStrictEqual(published[0].subject, { type: 'vod', id: '42' });
    assert.strictEqual(published[0].source, 'media');
    assert.strictEqual(published[0].visibility, 'internal');
    assert.strictEqual(published[0].payload.app_id, 'no-such-app');
    assert.ok(!('meta' in published[0].payload) && !('ai_overview' in published[0].payload), 'free text stays behind the API');
    assert.strictEqual(published[1].event_type, 'media.clip.failed');
    assert.strictEqual(published[1].priority, 'important');

    // Storage alerts: queued once by the storage module, never per app by sendWebhook.
    await sendWebhook('no-such-app', 'storage.alert', { kind: 'disk' });
    await outbox.flush();
    assert.strictEqual(published.length, 2);
    events.emit('storage.alert', null, { kind: 'disk', free_gb: 3 });
    await outbox.flush();
    assert.strictEqual(published.length, 3);
    assert.deepStrictEqual(published[2].subject, { type: 'storage', id: 'disk' });

    assert.strictEqual(events.status().enabled, true);
    events._reset();
    stub.close();
    console.log('✅ media events: outbox, relay, storage alerts once, off by default');
})().catch((err) => { console.error(err); process.exit(1); });
