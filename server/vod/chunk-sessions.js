'use strict';
/**
 * OpenVibe.Media — browser MediaRecorder chunk sessions.
 *
 * Live's recorder sends a WebM slice every 30 s (`ss.vodRecorder.start(30000)`,
 * public/js/broadcast.js) and proxies it to POST /api/v1/:app/vods/:id/chunks. A session is open
 * while chunks keep arriving; finalization removes it, and one that has not received a chunk for
 * CHUNK_SESSION_IDLE_MS is treated as closed. Five minutes is ten Live slices: a stall (a background
 * tab whose timer is throttled, a slow network) stays protected, while a browser that vanished
 * without finalizing stops pinning ovhost's idle wait forever.
 *
 * ovhost's Media probe refuses or waits while a recording is in progress, so these sessions must be
 * counted with the ffmpeg recordings (server/vod/recorder.js activeCount); /api/ready reports both.
 */
const CHUNK_SESSION_IDLE_MS = 5 * 60 * 1000;

/** vodId → { filePath, startTime, chunkCount, currentSegmentId, currentSegmentPath, lastChunkAt } */
const sessions = new Map();

/** Record that a chunk arrived for a session (creation or append). */
function markChunk(rec, now = Date.now()) {
    rec.lastChunkAt = now;
    return rec;
}

/** Open chunked recordings: not finalized, and a chunk arrived within the idle window. */
function countActive(now = Date.now()) {
    let n = 0;
    for (const rec of sessions.values()) {
        if (now - (rec.lastChunkAt || 0) <= CHUNK_SESSION_IDLE_MS) n++;
    }
    return n;
}

module.exports = { CHUNK_SESSION_IDLE_MS, sessions, markChunk, countActive };
