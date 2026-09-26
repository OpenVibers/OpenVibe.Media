/**
 * OpenVibe.Media — the tiering policy for native v2 objects as revisioned configuration (roadmap WS-G task 11;
 * docs/object-model.md#tiering-of-native-objects).
 *
 * The namespace `media.object_tier` of openvibe-shared/config, beside the VOD policy (`media.storage_tier`,
 * server/vod/tier-config.js): every change is a revision with who and why, validated as a whole before it
 * applies (types, ranges, and the order the thresholds need), with history and rollback through the admin
 * config routes (GET/POST /api/v1/:app/admin/storage/config/media.object_tier…).
 *
 *   active                      the site-level activation gate. Off (the default): the sweep moves nothing and
 *                               only records what it would do (outcome dry_run)
 *   promoteMinUniqueViewers7d   unique viewers over the last 7 UTC days (server/objects/popularity.js) to promote
 *   promoteRecentAccessDays     …and viewed within this many days (today included)
 *   promoteMinSizeMb / MaxSizeMb  size bounds: small objects are cheap to serve locally; the upper bound caps
 *                               the bytes one promotion reads back from R2 to verify its sha256
 *   maxPromotionsPerSweep       moves (and would-be moves) per sweep
 *   demoteIdleDays              no viewer for this many days (and in R2 at least that long): demote
 *   maxDemotionsPerSweep
 *
 * Revision 1 sets nothing (every key is its built-in default, so a release that changes a default is not
 * pinned to the old one); nothing is mirrored anywhere: no earlier release reads these keys.
 */
'use strict';
const config = require('openvibe-shared/config');
const db = require('../db/database');

const DEFAULTS = {
    active: false,
    promoteMinUniqueViewers7d: 500,
    promoteRecentAccessDays: 3,
    promoteMinSizeMb: 16,
    promoteMaxSizeMb: 4096,
    maxPromotionsPerSweep: 3,
    demoteIdleDays: 14,
    maxDemotionsPerSweep: 10,
};

// Daily counts are kept 30 days (popularity.KEEP_DAYS): a longer look-back would see nothing.
const MAX_LOOKBACK_DAYS = 30;

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        active: { type: 'boolean' },
        promoteMinUniqueViewers7d: { type: 'integer', minimum: 1, maximum: 1e9 },
        promoteRecentAccessDays: { type: 'integer', minimum: 1, maximum: MAX_LOOKBACK_DAYS },
        promoteMinSizeMb: { type: 'number', minimum: 0, maximum: 1048576 },
        promoteMaxSizeMb: { type: 'number', minimum: 1, maximum: 1048576 },
        maxPromotionsPerSweep: { type: 'integer', minimum: 0, maximum: 100 },
        demoteIdleDays: { type: 'integer', minimum: 1, maximum: MAX_LOOKBACK_DAYS },
        maxDemotionsPerSweep: { type: 'integer', minimum: 0, maximum: 500 },
    },
};

/** Rules across keys: a size window that is not empty, and no object both promoted and demoted (flapping). */
function validate(v) {
    const errors = [];
    if (v.promoteMinSizeMb >= v.promoteMaxSizeMb) errors.push('promoteMinSizeMb must be below promoteMaxSizeMb');
    if (v.demoteIdleDays <= v.promoteRecentAccessDays) errors.push('demoteIdleDays must be above promoteRecentAccessDays (an object viewed recently enough to promote would also be idle enough to demote)');
    return errors.length ? errors : true;
}

let store = null;

/** The store (created on first use, once the database is open). */
function get() {
    if (store) return store;
    store = config.createConfigStore({
        db: db.getDb(), service: 'media', namespace: 'media.object_tier',
        defaults: DEFAULTS, schema: SCHEMA, validate,
        // Revision 1 is empty: the defaults apply, and a key set later shows as a setting.
        legacy: () => ({}),
        log: { info: (m) => console.log(`[ObjectTiers] ${m}`), warn: (m) => console.warn(`[ObjectTiers] ${m}`), error: (m) => console.error(`[ObjectTiers] ${m}`) },
    });
    return store;
}

/** Every key's effective value (the defaults under the active revision). */
function settings() {
    try { return { ...DEFAULTS, ...get().get() }; } catch (err) { console.warn('[ObjectTiers] config unavailable:', err.message); return { ...DEFAULTS }; }
}

/** Change some keys: one validated revision merged over the active one → the new snapshot (throws ConfigError 422/409). */
function set(updates, { actor = null, reason = null } = {}) {
    return get().apply(updates, { merge: true, actor, reason });
}

/** Keys the active revision sets explicitly (anything else is its default). */
function explicitKeys() {
    const s = get();
    if (s.revision() == null) return new Set();
    const snap = s.snapshot(s.revision());
    return new Set(Object.keys((snap && snap.values) || {}));
}

/** Each key as { value, default, source: default | setting }. */
function thresholds(values = settings()) {
    let explicit = new Set();
    try { explicit = explicitKeys(); } catch { /* defaults only */ }
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = { value: values[k], default: DEFAULTS[k], source: explicit.has(k) ? 'setting' : 'default' };
    return out;
}

/** The rules the sweep applies, in words. */
function describe(v = settings()) {
    return {
        gate: v.active ? 'active: the sweep moves objects' : 'off (active = false): the sweep moves nothing and records what it would do as dry_run decisions',
        promote: `a ready native (v2) object of a non-sandbox tenant with at least promoteMinUniqueViewers7d (${v.promoteMinUniqueViewers7d}) unique viewers over the last 7 UTC days, `
            + `viewed within promoteRecentAccessDays (${v.promoteRecentAccessDays} days), between promoteMinSizeMb (${v.promoteMinSizeMb}) and promoteMaxSizeMb (${v.promoteMaxSizeMb}) MB, `
            + 'whose canonical copy is verified (present, checked, sha256 on record) and not under a hold; the canonical copy is hashed again, copied to R2, and the R2 copy '
            + `checked (size and sha256) before it becomes the playback source; at most maxPromotionsPerSweep (${v.maxPromotionsPerSweep}) per sweep`,
        demote: `an R2 copy of a native object that is no longer ready (deleted, failed, archived), or whose object has had no viewer for demoteIdleDays (${v.demoteIdleDays} days) `
            + `and has been in R2 at least that long; removed only after the canonical copy is confirmed good (hashed again), so the last good copy is never the one removed, `
            + `and never under a hold; at most maxDemotionsPerSweep (${v.maxDemotionsPerSweep}) per sweep`,
    };
}

module.exports = { DEFAULTS, SCHEMA, validate, get, settings, set, explicitKeys, thresholds, describe, _reset: () => { store = null; } };
