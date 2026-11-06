'use strict';
// The protected sessions a restart of Media would cut (server/protected-sessions.js): a recording
// the database still holds that no session in memory knows, and whose file is still growing (a
// chunked upload that resumed after a restart), and the uploads whose bytes are moving right now
// (server/objects/upload-sessions.js). ovhost's Media probe reads these counts and holds the
// restart while they are not zero.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-protected-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
    ASSETS_PATH: dir('assets'),
});

(async () => {
    const db = require('../server/db/database');
    const protectedSessions = require('../server/protected-sessions');
    const uploadSessions = require('../server/objects/upload-sessions');
    const chunkSessions = require('../server/vod/chunk-sessions');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-protected' });

    // ── The upload registry: the bytes are moving ──
    assert.strictEqual(uploadSessions.countActive(), 0, 'nothing is uploading');
    uploadSessions.begin('obj-1', 'object');
    assert.strictEqual(uploadSessions.countActive(), 1, 'a single-part upload in flight counts');
    uploadSessions.begin('mup-1:2', 'part');
    assert.strictEqual(uploadSessions.countActive(), 2, 'a multipart part in flight counts too');
    uploadSessions.end('mup-1:2');
    assert.strictEqual(uploadSessions.countActive(), 1);
    // A step that stopped making progress is forgotten: a stalled client must not pin ovhost's wait.
    const stale = Date.now() - uploadSessions.UPLOAD_IDLE_MS - 1000;
    uploadSessions.sessions.get('obj-1').lastActivityAt = stale;
    assert.strictEqual(uploadSessions.countActive(), 0, 'a step silent past the idle window does not count');
    uploadSessions.touch('obj-1');
    assert.strictEqual(uploadSessions.countActive(), 1, 'a byte arrived: the step is alive again');
    uploadSessions.end('obj-1');
    assert.strictEqual(uploadSessions.countActive(), 0, 'the step ended');
    console.log('✅ an upload counts while its bytes move, and is forgotten when it stalls');

    // ── A recording the database holds that no session in memory knows ──
    const file = path.join(tmp, 'vods', 'vod-live-1.webm');
    fs.writeFileSync(file, 'growing');
    const vod = await db.createVod({ app_id: 'live', title: 'protected' });
    const id = Number(vod.lastInsertRowid);
    await db.run('UPDATE vods SET is_recording = 1, file_path = ? WHERE id = ?', [file, id]);

    const emptyRecorder = { activeCount: () => 0, activeRecordings: new Map() };
    assert.strictEqual(await protectedSessions.untrackedRecordings({ db, recorder: emptyRecorder, chunkSessions }), 1,
        'a recording whose file is still growing is protected, even when no session in memory knows it');

    // The orphan sweep leaves a recording alone for as long as its file grows (the same grace): a
    // file that has not changed for longer is an orphan, not a protected session.
    const old = new Date(Date.now() - (protectedSessions.graceMs() + 60_000));
    fs.utimesSync(file, old, old);
    assert.strictEqual(await protectedSessions.untrackedRecordings({ db, recorder: emptyRecorder, chunkSessions }), 0,
        'a file that stopped growing is an orphan, not a protected session');
    fs.utimesSync(file, new Date(), new Date());

    // A recording a session in memory holds is counted there, not twice.
    const withRecorder = { activeCount: () => 1, activeRecordings: new Map([[id, {}]]) };
    assert.strictEqual(await protectedSessions.untrackedRecordings({ db, recorder: withRecorder, chunkSessions }), 0,
        'an ffmpeg recording is counted by the recorder, not again as untracked');
    chunkSessions.sessions.set(id, { lastChunkAt: Date.now() });
    assert.strictEqual(await protectedSessions.untrackedRecordings({ db, recorder: emptyRecorder, chunkSessions }), 0,
        'a browser chunk session is counted by its own session, not again as untracked');
    chunkSessions.sessions.clear();

    // ── Every count together ──
    const counts = await protectedSessions.counts({ db, recorder: emptyRecorder, chunkSessions, uploadSessions });
    assert.deepStrictEqual(counts, { recordings: 0, chunked: 0, untracked: 1, uploads: 0 },
        'the four counts do not overlap');
    console.log('✅ the protected counts do not overlap, and a growing recording counts once');

    await db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [id]);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ protected-session tests passed');
})().catch((err) => { console.error('❌', err); process.exit(1); });
