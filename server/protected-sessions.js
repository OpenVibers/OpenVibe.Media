'use strict';
/**
 * OpenVibe.Media — the protected sessions a restart of Media would cut.
 *
 * ovhost's Media probe (OpenVibe.Host lib/probes.js) asks /api/ready how many protected sessions
 * there are and holds the restart while the answer is not zero. Four kinds count:
 *
 *   recordings       an ffmpeg recording (RTMP pull, RTP ingest) — the recorder's own map.
 *   chunked          a browser MediaRecorder session (vod/chunk-sessions.js): a chunk arrived in
 *                    the last five minutes.
 *   untracked        a recording the database still holds (vods.is_recording = 1) that no session
 *                    in memory knows, and whose file is still growing. It is the recording a
 *                    chunked upload resumed after a restart of Media: the session is rebuilt on
 *                    the next chunk, but until then the recording is open, and the orphan sweep
 *                    (jobs/vod-finalize.js) leaves it alone for exactly as long as its file grows.
 *   uploads          an object upload whose bytes are moving right now
 *                    (objects/upload-sessions.js): a single-part PUT, a multipart part, the
 *                    assembly of a multipart upload.
 *
 * The four counts do not overlap: the untracked ones are the recordings no in-memory session
 * holds. A count that cannot be answered is null, never zero: ovhost reads null as unknown and
 * treats it as active, so a database that cannot answer holds the restart instead of cutting it.
 */
const fs = require('fs');
const db = require('./db/database');
const recorder = require('./vod/recorder');
const chunkSessions = require('./vod/chunk-sessions');
const uploadSessions = require('./objects/upload-sessions');

/** The window a recording file counts as still growing (the orphan sweep's own grace). */
function graceMs() {
    const s = Number(process.env.MEDIA_FINALIZE_ORPHAN_GRACE_S);
    return (Number.isFinite(s) && s > 0 ? s : 180) * 1000;
}

/** The ids Media is writing right now: an ffmpeg recording or a browser chunk session. */
function knownIds(rec, sessions) {
    const ids = new Set();
    const recs = (rec && rec.activeRecordings && typeof rec.activeRecordings.keys === 'function') ? rec.activeRecordings.keys() : [];
    for (const id of recs) ids.add(Number(id));
    for (const id of (sessions && sessions.sessions ? sessions.sessions.keys() : [])) ids.add(Number(id));
    return ids;
}

/**
 * Recordings the database still holds that Media is not writing in memory, and whose file is
 * still growing. A file that has not changed for the grace window is an orphan, and the sweep
 * finalizes it: it is not a protected session.
 */
async function untrackedRecordings({ db: dbi = db, recorder: rec = recorder, chunkSessions: sessions = chunkSessions, now = Date.now() } = {}) {
    const known = knownIds(rec, sessions);
    const rows = await dbi.all('SELECT id, file_path FROM vods WHERE is_recording = 1');
    let n = 0;
    for (const row of rows) {
        if (known.has(Number(row.id))) continue;
        let mtime = 0;
        try { mtime = row.file_path ? fs.statSync(row.file_path).mtimeMs : 0; } catch { mtime = 0; }
        if (!mtime || now - mtime >= graceMs()) continue;
        n++;
    }
    return n;
}

/** Every protected session Media can see: { recordings, chunked, untracked, uploads }. */
async function counts({ db: dbi = db, recorder: rec = recorder, chunkSessions: sessions = chunkSessions, uploadSessions: uploads = uploadSessions, now = Date.now() } = {}) {
    return {
        recordings: rec.activeCount(),
        chunked: sessions.countActive(now),
        untracked: await untrackedRecordings({ db: dbi, recorder: rec, chunkSessions: sessions, now }),
        uploads: uploads.countActive(now),
    };
}

module.exports = { counts, untrackedRecordings, graceMs, knownIds };
