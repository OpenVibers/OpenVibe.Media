/**
 * OpenVibe.Media — the storage-tier policy as revisioned configuration (roadmap WS-C task 7).
 *
 * The thresholds vod-storage.js tiers by (DEFAULTS there: offload ages, disk pressure, R2 popularity…)
 * live in the namespace `media.storage_tier` of openvibe-shared/config: every change is a revision with
 * who and why, it is validated (types from the defaults, ranges, and the order the thresholds need) before
 * it applies, the last good revision is kept and restored when applying fails, and history and rollback
 * come with it (GET/POST /api/v1/:app/admin/config…, admin routes).
 *
 * Revision 1 is what media_settings held (storage_tier.* rows), or the defaults. Every activation still
 * writes the values through to media_settings, so a release that reads those rows (a rollback within the
 * supported window) sees the same policy; the rows go in the ADR-028 contract step. Activation then
 * restarts the tiering sweep if it is running, as the old PUT /tiers/settings did.
 */
'use strict';
const config = require('openvibe-shared/config');
const db = require('../db/database');

let store = null;
let onApplied = null;      // vod-storage: restart the sweep when it is running

const PCT = new Set(['hotDiskPressurePct', 'localLowWaterPct', 'criticalDiskPct']);
const MS_FLOOR = { sweepIntervalMs: 60000, pressureRetryMs: 10000, uploadTimeoutFloorMs: 60000, alertCooldownMs: 60000 };

/** A JSON Schema for the defaults: each key's type, non-negative numbers, percentages 1–100, sane intervals. */
function schemaFor(defaults) {
    const properties = {};
    for (const [k, v] of Object.entries(defaults)) {
        if (typeof v === 'boolean') properties[k] = { type: 'boolean' };
        else if (typeof v === 'number') {
            properties[k] = { type: 'number', minimum: MS_FLOOR[k] || 0 };
            if (PCT.has(k)) Object.assign(properties[k], { minimum: 1, maximum: 100 });
        } else properties[k] = { type: typeof v };
    }
    return { type: 'object', additionalProperties: false, properties };
}

/** Rules across keys: the drain stops below where it starts, and the free-space budget is ordered. */
function validate(v) {
    const errors = [];
    if (v.localLowWaterPct >= v.hotDiskPressurePct) errors.push('localLowWaterPct must be below hotDiskPressurePct (the drain stops below where it starts)');
    if (v.hotDiskPressurePct > v.criticalDiskPct) errors.push('hotDiskPressurePct must not be above criticalDiskPct');
    if (v.minFreeGb > v.targetFreeGb) errors.push('minFreeGb must not be above targetFreeGb');
    return errors.length ? errors : true;
}

function legacyRows() {
    const rows = db.all("SELECT key, value FROM media_settings WHERE key LIKE 'storage_tier.%'") || [];
    if (!rows.length) return {};                       // nothing overridden: revision 1 sets nothing (the defaults apply)
    return config.fromRows(rows.map((r) => ({ key: r.key, value: r.value, type: 'json' })), { prefix: 'storage_tier.' });
}

/** media_settings mirrors the active revision exactly: its explicit keys as rows, every other storage_tier.* row gone. */
function writeThrough(values, defaults) {
    const h = db.getDb();
    const up = h.prepare('INSERT INTO media_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const del = h.prepare('DELETE FROM media_settings WHERE key = ?');
    h.transaction(() => {
        for (const k of Object.keys(defaults)) {
            if (values[k] !== undefined) up.run(`storage_tier.${k}`, JSON.stringify(values[k]));
            else del.run(`storage_tier.${k}`);
        }
    })();
}

/** The store (created on first use, once the database is open). */
function get(defaults) {
    if (store) return store;
    const known = Object.keys(defaults);
    store = config.createConfigStore({
        db: db.getDb(), service: 'media', namespace: 'media.storage_tier',
        defaults, schema: schemaFor(defaults), validate,
        // Stored revisions only carry known keys: a key a later release dropped is ignored, not refused.
        // Revision 1 holds exactly what was overridden, so "set explicitly" stays distinguishable from a default.
        legacy: () => { const l = legacyRows(); const out = {}; for (const k of known) if (l[k] !== undefined) out[k] = l[k]; return out; },
        onActivate: async (values, _previous, { revision }) => {
            writeThrough(explicitValues(revision, values), defaults);
            if (onApplied) onApplied(values);
        },
        log: { info: (m) => console.log(`[Tiers] ${m}`), warn: (m) => console.warn(`[Tiers] ${m}`), error: (m) => console.error(`[Tiers] ${m}`) },
    });
    return store;
}

/** The values a revision sets explicitly (written through to media_settings; defaults stay rowless). */
function explicitValues(revision, effective) {
    const snap = store && revision != null ? store.snapshot(revision) : null;
    const out = {};
    for (const k of Object.keys((snap && snap.values) || {})) out[k] = effective[k];
    return out;
}

/** Which keys the active revision sets explicitly (anything else is its default). */
function explicitKeys() {
    if (!store || store.revision() == null) return new Set();
    const snap = store.snapshot(store.revision());
    return new Set(Object.keys((snap && snap.values) || {}));
}

module.exports = { get, explicitKeys, schemaFor, validate, setOnApplied: (fn) => { onApplied = fn; }, _reset: () => { store = null; } };
