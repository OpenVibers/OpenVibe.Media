'use strict';
// Roadmap Wave 3 (audit item 7): Media's outbox row is written in the SAME SQLite transaction as
// the state change it describes. An outcome is never lost (the change committed, the event did
// not) and never a phantom (the event exists, the change rolled back). The webhook for the same
// outcome follows the commit and carries the event's id, so a consumer reading both paths
// handles it once. Covers webhooks.announce() and the real call sites for clip.failed
// (clip-jobs) and vod.failed (finalize), with an outbox insert that fails and a change that fails.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-outbox-tx-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.FILES_PATH = dir('files');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');

const hooks = [];
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        if (req.url === '/api/v1/events') {
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
            const results = list.map((e, i) => ({ event_id: e.event_id, seq: i + 1, duplicate: false }));
            return res.end(JSON.stringify(parsed.events ? { results } : results[0]));
        }
        if (req.url === '/hook') {
            hooks.push({ body, signature: req.headers['x-ovmedia-signature'] });
            return res.end('{"ok":true}');
        }
        res.statusCode = 404; res.end('{}');
    });
});

const waitFor = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
    return false;
};

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    const db = require('../server/db/database');
    const raw = db.getDb();
    db.upsertApp({ app_id: 'live', api_key: 'k', webhook_url: `${base}/hook`, webhook_secret: 'hook-secret' });

    const events = require('../server/events');
    const { announce } = require('../server/webhooks');
    // A long relay interval: the test reads the outbox table, the relay is not under test here.
    assert.ok(events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 }));
    const outboxRows = () => raw.prepare('SELECT event_id, envelope FROM event_outbox ORDER BY id').all().map((r) => ({ id: r.event_id, env: JSON.parse(r.envelope) }));
    const failOutboxInserts = (on) => raw.exec(on
        ? "CREATE TEMP TRIGGER outbox_boom BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'outbox insert failed'); END"
        : 'DROP TRIGGER IF EXISTS temp.outbox_boom');

    raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, duration_seconds)
                 VALUES (10, 'live', 5, 'Source', ?, 1, 60)`).run(path.join(process.env.VOD_PATH, 'missing.webm'));
    const clipId = Number(db.createClip({ app_id: 'live', vod_id: 10, user_id: 5, channel_user_id: 5, title: 'A clip', file_path: '', start_time: 1, end_time: 5, duration_seconds: 4, status: 'processing' }).lastInsertRowid);
    const { clipPublic } = require('../server/vod/clips-routes');
    const clipStatus = () => raw.prepare('SELECT status FROM clips WHERE id = ?').get(clipId).status;

    // 1. The change and its event commit together; the webhook carries the same event_id.
    const out = announce('live', 'clip.ready', {
        change: () => db.run("UPDATE clips SET status = 'ready' WHERE id = ?", [clipId]),
        payload: () => clipPublic(db.getClipById(clipId)),
    });
    assert.strictEqual(clipStatus(), 'ready');
    let rows = outboxRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].env.event_type, 'media.clip.ready');
    assert.deepStrictEqual(rows[0].env.subject, { type: 'clip', id: String(clipId) });
    assert.strictEqual(rows[0].env.payload.status, 'ready', 'payload is the row as committed');
    assert.strictEqual(out.eventId, rows[0].id);
    assert.ok(await waitFor(() => hooks.length === 1), 'webhook sent after the commit');
    const hook = JSON.parse(hooks[0].body);
    assert.strictEqual(hook.event, 'clip.ready');
    assert.strictEqual(hook.event_id, rows[0].id, 'the webhook names the durable event');
    const sig = 'sha256=' + crypto.createHmac('sha256', 'hook-secret').update(hooks[0].body).digest('hex');
    assert.strictEqual(hooks[0].signature, sig, 'the signature covers event_id');

    // 2. No phantom: a change that fails leaves no event and sends no webhook.
    assert.throws(() => announce('live', 'clip.failed', {
        change: () => { db.run("UPDATE clips SET status = 'failed' WHERE id = ?", [clipId]); throw new Error('disk full'); },
        payload: () => clipPublic(db.getClipById(clipId)),
    }), /disk full/);
    assert.strictEqual(clipStatus(), 'ready', 'the change rolled back');
    assert.strictEqual(outboxRows().length, 1, 'no event for a rolled-back change');

    // 3. Never lost: an outbox insert that fails rolls the change back with it.
    failOutboxInserts(true);
    assert.throws(() => announce('live', 'clip.failed', {
        change: () => db.run("UPDATE clips SET status = 'failed' WHERE id = ?", [clipId]),
        payload: () => clipPublic(db.getClipById(clipId)),
    }), /outbox insert failed/);
    failOutboxInserts(false);
    assert.strictEqual(clipStatus(), 'ready', 'no committed change without its event');

    // 4. Outside a transaction the outbox refuses (nothing can enqueue "after the commit" again).
    assert.throws(() => events.record('clip.ready', 'live', { id: clipId }), /inside the transaction/);

    // 5. Real call site: a re-cut whose source is gone commits status=failed with media.clip.failed.
    const clipJobs = require('../server/vod/clip-jobs');
    db.run("UPDATE clips SET status = 'failed', cut_attempts = 1 WHERE id = ?", [clipId]);
    failOutboxInserts(true);
    await assert.rejects(clipJobs.recutClip(clipId, { reason: 'test' }), /outbox insert failed/);
    failOutboxInserts(false);
    assert.strictEqual(raw.prepare('SELECT cut_error FROM clips WHERE id = ?').get(clipId).cut_error, null, 'the failure was not recorded without its event');
    assert.strictEqual(outboxRows().length, 1);
    const r = await clipJobs.recutClip(clipId, { reason: 'test' });
    assert.strictEqual(r.ok, false);
    rows = outboxRows();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].env.event_type, 'media.clip.failed');
    assert.strictEqual(rows[1].env.payload.status, 'failed');
    assert.match(raw.prepare('SELECT cut_error FROM clips WHERE id = ?').get(clipId).cut_error, /unavailable/);

    // 6. Real call site: finalizing a VOD with no recording file deletes the row and queues
    // media.vod.failed in one transaction; if the event cannot be queued the row stays.
    const { finalizeVod } = require('../server/vod/finalize');
    raw.prepare(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, is_recording)
                 VALUES (20, 'live', 5, 'Ghost', ?, 1, 1)`).run(path.join(process.env.VOD_PATH, 'never-written.webm'));
    failOutboxInserts(true);
    await finalizeVod(20);
    failOutboxInserts(false);
    assert.ok(raw.prepare('SELECT 1 FROM vods WHERE id = 20').get(), 'not deleted without its vod.failed event');
    assert.strictEqual(outboxRows().length, 2);
    await finalizeVod(20);
    assert.ok(!raw.prepare('SELECT 1 FROM vods WHERE id = 20').get(), 'deleted');
    rows = outboxRows();
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[2].env.event_type, 'media.vod.failed');
    assert.deepStrictEqual(rows[2].env.subject, { type: 'vod', id: '20' });
    assert.strictEqual(rows[2].env.priority, 'important');
    assert.ok(await waitFor(() => hooks.some((h) => JSON.parse(h.body).event_id === rows[2].id)), 'vod.failed webhook names the event');

    events._reset();
    stub.close();
    console.log('✅ media outbox: state change and event commit together (no lost or phantom outcome), webhook carries event_id');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
