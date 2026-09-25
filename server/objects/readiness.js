/**
 * OpenVibe.Media — readiness levels of a media object (roadmap WS-G task 5; docs/object-model.md#readiness).
 *
 * Three facts, each read from what the database records about the object and its copies, never assumed:
 *
 *   metadata        the media_objects row exists and its metadata is readable JSON
 *   bytes_verified  at least one copy is `present` with a `verified_at`: a check of the bytes found it
 *                   (the local file at its path, sha256-checked against content_hash by the scheduled
 *                   verification when the object has one; a B2/R2 HEAD with the right size; a v2 upload
 *                   hashed on receipt), and no checksum recorded on that copy contradicts the object's
 *                   content_hash. `pending` copies (believed there, never checked), `missing` and
 *                   `corrupt` ones do not count
 *   playable        bytes_verified, a playback kind (vod, clip), and lifecycle `ready`: the recording is
 *                   finished or the clip cut, nothing failed, nothing deleted
 *
 * plus `hash_verified` (a verified copy's sha256 equals content_hash), `verified_copies` (the providers
 * of the verified copies) and `reason` (why it is not playable, null when it is).
 *
 * The public-size invariant (server/objects/invariant.js) does not gate `playable`: in code it refuses
 * oversized public v2 uploads (so such an object never becomes ready) and only reports recordings.
 *
 * It reads media_objects and media_locations only: no file is opened and no provider is asked, so it
 * answers in a restore drill too. playableSql() is the same rule as SQL (the sitemap uses it).
 */
'use strict';

const db = require('../db/database');

const PLAYBACK_KINDS = ['vod', 'clip'];

/** Why an object is not playable, in the order the watch page explains it. */
const REASONS = ['no_object', 'deleted', 'metadata_unreadable', 'failed', 'archived', 'recording', 'processing', 'verification_pending', 'no_verified_copy', 'not_playback_kind'];

function metadataOf(obj) {
    try { const md = JSON.parse(obj.metadata == null ? '{}' : obj.metadata); return md && typeof md === 'object' && !Array.isArray(md) ? md : null; } catch { return null; }
}

/** A copy counts as verified: present, checked, and no recorded checksum that disagrees with the object's hash. */
function isVerifiedCopy(obj, l) {
    return l.state === 'present' && !!l.verified_at && !(l.checksum && obj.content_hash && l.checksum !== obj.content_hash);
}

/** Readiness of one object row (null → nothing known). `locations` may be passed when already loaded. */
function compute(obj, locations = null) {
    if (!obj) return { metadata: false, bytes_verified: false, playable: false, hash_verified: false, verified_copies: [], reason: 'no_object' };
    const locs = locations || db.all('SELECT provider, state, checksum, verified_at FROM media_locations WHERE object_id = ? ORDER BY id', [obj.id]);
    const md = metadataOf(obj);
    const verified = locs.filter(l => isVerifiedCopy(obj, l));
    const bytesVerified = verified.length > 0;
    let reason = null;
    if (obj.lifecycle_status === 'deleted') reason = 'deleted';
    else if (!md) reason = 'metadata_unreadable';
    else if (obj.lifecycle_status === 'failed') reason = 'failed';
    else if (obj.lifecycle_status === 'archived') reason = 'archived';
    else if (obj.lifecycle_status !== 'ready') reason = md.recording ? 'recording' : 'processing';
    else if (!bytesVerified) reason = locs.some(l => l.state === 'pending') ? 'verification_pending' : 'no_verified_copy';
    else if (!PLAYBACK_KINDS.includes(obj.kind)) reason = 'not_playback_kind';
    return {
        metadata: !!md,
        bytes_verified: bytesVerified,
        playable: reason === null,
        hash_verified: !!obj.content_hash && verified.some(l => l.checksum === obj.content_hash),
        verified_copies: verified.map(l => l.provider),
        reason,
    };
}

/** Readiness of an inherited vods/clips row, through its object (object_id). */
function forRow(row) {
    if (!row || !row.object_id) return compute(null);
    return compute(db.get('SELECT * FROM media_objects WHERE id = ?', [row.object_id]));
}

/** SQL condition: the object named by the SQL expression `ref` is playable (the rule of compute()). */
function playableSql(ref) {
    return `EXISTS (SELECT 1 FROM media_objects ro WHERE ro.id = ${ref} AND ro.lifecycle_status = 'ready'
        AND ro.kind IN (${PLAYBACK_KINDS.map(k => `'${k}'`).join(', ')}) AND (CASE WHEN json_valid(ro.metadata) THEN json_type(ro.metadata) END) = 'object'
        AND EXISTS (SELECT 1 FROM media_locations rl WHERE rl.object_id = ro.id AND rl.state = 'present' AND rl.verified_at IS NOT NULL
                    AND (rl.checksum IS NULL OR ro.content_hash IS NULL OR rl.checksum = ro.content_hash)))`;
}

module.exports = { compute, forRow, playableSql, isVerifiedCopy, PLAYBACK_KINDS, REASONS };
