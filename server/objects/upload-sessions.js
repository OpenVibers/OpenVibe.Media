'use strict';
/**
 * OpenVibe.Media — object uploads whose bytes are moving.
 *
 * An upload in flight is cut by a restart of Media: its bytes sit in a temporary file that the
 * restart loses, and the client has to send them again. The parts of a multipart upload are on
 * disk and its session is in the database, so a restart between two parts costs the client
 * nothing (it resumes), but a restart while a part streams, or while the parts are assembled into
 * the object, is lost like any other upload.
 *
 * So this registry counts the upload steps whose bytes are moving: a single-part PUT
 * (objects/routes.js putContent), a multipart part (objects/multipart.js receivePart) and the
 * assembly of a multipart upload (objects/routes.js complete).
 *
 * A step that stops making progress (a stalled client, a dropped connection) is forgotten after
 * UPLOAD_IDLE_MS, like a browser chunk session (vod/chunk-sessions.js): a stalled upload must not
 * pin ovhost's idle wait forever, and a step that never ends (the process killed) leaves the
 * registry empty on the next boot anyway.
 */
const UPLOAD_IDLE_MS = 2 * 60 * 1000;
/** The assembly of a multipart upload copies every part: it takes minutes, and it is still an upload. */
const ASSEMBLY_IDLE_MS = 30 * 60 * 1000;

/** key → { kind, lastActivityAt, idleMs } */
const sessions = new Map();

/** An upload step starts. */
function begin(key, kind = 'upload', { idleMs = UPLOAD_IDLE_MS } = {}) {
    sessions.set(String(key), { kind, lastActivityAt: Date.now(), idleMs });
}

/** A byte arrived: the step is alive. */
function touch(key) {
    const s = sessions.get(String(key));
    if (s) s.lastActivityAt = Date.now();
}

/** The step ended (done, refused or dropped). */
function end(key) {
    sessions.delete(String(key));
}

/** Upload steps whose bytes moved within their idle window. */
function countActive(now = Date.now(), idleMs = UPLOAD_IDLE_MS) {
    let n = 0;
    for (const s of sessions.values()) if (now - (s.lastActivityAt || 0) <= (s.idleMs || idleMs)) n++;
    return n;
}

module.exports = { UPLOAD_IDLE_MS, ASSEMBLY_IDLE_MS, sessions, begin, touch, end, countActive };
