/**
 * OpenVibe.Media — public object-size invariant (roadmap W4 deliverable 5)
 *
 * No public playback object above MEDIA_PUBLIC_OBJECT_MAX_MB (default 500),
 * target MEDIA_PUBLIC_OBJECT_TARGET_MB (256), warn at MEDIA_PUBLIC_OBJECT_WARN_MB
 * (384). Policy, not a constant: the thresholds are configuration, the
 * validator is pure, and violations are recorded in media_invariant_violations
 * (one row per object, resolved when it drops back under). This pass reports
 * and refuses new oversized public uploads; it never re-encodes.
 */
'use strict';

const db = require('../db/database');
const config = require('../config');

const MB = 1024 * 1024;
const PLAYBACK_KINDS = ['vod', 'clip'];

function thresholds(cfg = config.objects) {
    return { targetBytes: cfg.publicTargetMb * MB, warnBytes: cfg.publicWarnMb * MB, maxBytes: cfg.publicMaxMb * MB };
}

/** ok ≤ target < above_target ≤ warn < warn-level ≤ max < violation */
function classify(sizeBytes, t = thresholds()) {
    const n = Number(sizeBytes) || 0;
    if (n > t.maxBytes) return 'violation';
    if (n > t.warnBytes) return 'warn';
    if (n > t.targetBytes) return 'above_target';
    return 'ok';
}

/** Playback bytes anyone with the link can fetch: ready vods/clips that are public or unlisted. */
function isPublicPlayback(obj) {
    return !!obj && PLAYBACK_KINDS.includes(obj.kind) && obj.visibility !== 'private' && obj.lifecycle_status === 'ready';
}

/** Would an object of this kind/visibility/size break the invariant (a public playback object above max)? */
function wouldViolate({ kind, visibility, size_bytes }, t = thresholds()) {
    return PLAYBACK_KINDS.includes(kind) && visibility !== 'private' && classify(size_bytes, t) === 'violation';
}

function validate(obj, t = thresholds()) {
    const level = classify(obj.size_bytes, t);
    const threshold = level === 'violation' ? t.maxBytes : level === 'warn' ? t.warnBytes : level === 'above_target' ? t.targetBytes : null;
    return { object_id: obj.id, kind: obj.kind, visibility: obj.visibility, size_bytes: Number(obj.size_bytes) || 0,
        level, threshold_bytes: threshold, public_playback: isPublicPlayback(obj) };
}

/** Upsert (warn/violation) or resolve this object's violation row. Returns the level recorded, or null. */
function record(obj, t = thresholds()) {
    if (!obj) return null;
    const v = validate(obj, t);
    const open = db.get('SELECT * FROM media_invariant_violations WHERE object_id = ?', [obj.id]);
    if (v.public_playback && (v.level === 'warn' || v.level === 'violation')) {
        if (open) {
            db.run(`UPDATE media_invariant_violations SET level = ?, size_bytes = ?, threshold_bytes = ?, last_seen_at = CURRENT_TIMESTAMP,
                           resolved_at = NULL, detected_at = CASE WHEN resolved_at IS NULL THEN detected_at ELSE CURRENT_TIMESTAMP END
                    WHERE id = ?`, [v.level, v.size_bytes, v.threshold_bytes, open.id]);
        } else {
            db.run('INSERT INTO media_invariant_violations (object_id, level, size_bytes, threshold_bytes) VALUES (?, ?, ?, ?)',
                [obj.id, v.level, v.size_bytes, v.threshold_bytes]);
        }
        return v.level;
    }
    if (open && !open.resolved_at) db.run('UPDATE media_invariant_violations SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?', [open.id]);
    return null;
}

/**
 * Scan every public playback object. Returns { thresholds, counts, objects } where
 * objects lists everything above target (largest first). record=false is a dry run.
 */
function scan({ record: write = true, appId = null } = {}) {
    const t = thresholds();
    const rows = db.all(`SELECT * FROM media_objects WHERE kind IN ('vod', 'clip') AND visibility != 'private' AND lifecycle_status = 'ready'
                         ${appId ? 'AND app_id = ?' : ''} ORDER BY size_bytes DESC`, appId ? [appId] : []);
    const counts = { ok: 0, above_target: 0, warn: 0, violation: 0 };
    const objects = [];
    for (const obj of rows) {
        const v = validate(obj, t);
        counts[v.level]++;
        if (v.level !== 'ok') objects.push({ ...v, app_id: obj.app_id, legacy_ref: obj.legacy_ref });
        if (write) record(obj, t);
    }
    // Objects that stopped being public playback (made private, deleted) resolve too.
    if (write) {
        const stale = db.all(`SELECT o.*, v.id AS violation_id FROM media_invariant_violations v LEFT JOIN media_objects o ON o.id = v.object_id
                              WHERE v.resolved_at IS NULL`);
        for (const s of stale) if (!isPublicPlayback(s)) db.run('UPDATE media_invariant_violations SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?', [s.violation_id]);
    }
    return { thresholds: t, counts, objects };
}

module.exports = { thresholds, classify, isPublicPlayback, wouldViolate, validate, record, scan, MB };
