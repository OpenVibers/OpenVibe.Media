/**
 * OpenVibe.Media — a clip page's source VOD, read with the clip.
 *
 * A clip cut from a stream links back to the VOD it came from, but only while that VOD's own page
 * (/v/:id) can answer 200: the row exists, it is not a clips-only shell, it is not private, and its
 * object is playable (server/objects/readiness.js). Reading the decision as joined columns keeps the
 * page at one query, and a list of clips at one query too.
 *
 * `source_vod` is attached to the clip row as { id, visibility, is_public, clips_only, is_recording,
 * playable }; pages.renderWatchPage() never links a clip whose source VOD is missing.
 */
'use strict';

const db = require('../db/database');
const readiness = require('../objects/readiness');

/** Columns a query selects beside the clip's own: the source VOD under the alias `sv`. */
const COLUMNS = `
    sv.id AS source_vod_id,
    sv.visibility AS source_vod_visibility,
    sv.is_public AS source_vod_is_public,
    COALESCE(sv.clips_only, 0) AS source_vod_clips_only,
    COALESCE(sv.is_recording, 0) AS source_vod_is_recording,
    ${readiness.playableSql('sv.object_id')} AS source_vod_playable`;

/** Put the joined source-VOD columns on the row as one object (null when the clip has no source). */
function attach(row) {
    if (!row) return row;
    row.source_vod = row.source_vod_id == null ? null : {
        id: row.source_vod_id,
        visibility: row.source_vod_visibility,
        is_public: row.source_vod_is_public,
        clips_only: row.source_vod_clips_only,
        is_recording: row.source_vod_is_recording,
        playable: !!row.source_vod_playable,
    };
    return row;
}

/** One clip with its source VOD's linkability, for /c/:id's page (the bytes path reads the clip alone). */
async function clipForPage(id) {
    return attach(await db.get(`SELECT c.*, ${COLUMNS}
        FROM clips c LEFT JOIN vods sv ON sv.id = c.vod_id WHERE c.id = ?`, [id]));
}

module.exports = { COLUMNS, attach, clipForPage };
