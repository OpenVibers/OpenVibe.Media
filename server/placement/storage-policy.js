/**
 * Revisioned placement budgets and residency policy (docs/media-fabric.md §6, §10).
 * The object sweep (server/objects/tiering.js) takes its per-class budgets and residency from here.
 */
'use strict';

const config = require('openvibe-shared/config');
const db = require('../db/database');

// The defaults match media.object_tier's per-sweep limits (server/objects/tier-policy.js).
const BASE = { maxPromotionsPerSweep: 3, maxDemotionsPerSweep: 10, minResidencyMs: 0 };
const CLASSES = ['video', 'image', 'download', 'game-asset', 'attachment', 'backup'];
// The sweep's hysteresis band (F2.5): reads in the last hour for the deployment's region (placement/demand.js
// hotness()) at or above promoteReadsPerHour promote, below demoteReadsPerHour demote, in between nothing moves.
// Images are small and cheap to serve locally, so they need more reads; downloads are large, so fewer.
const HYSTERESIS = { promoteReadsPerHour: 60, demoteReadsPerHour: 6 };
const CLASS_HYSTERESIS = {
    image: { promoteReadsPerHour: 300, demoteReadsPerHour: 30 },
    download: { promoteReadsPerHour: 30, demoteReadsPerHour: 3 },
};
const DEFAULTS = {
    classes: Object.fromEntries(CLASSES.map((name) => [name, { ...BASE, ...HYSTERESIS, ...CLASS_HYSTERESIS[name] }])),
};

const CLASS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        maxPromotionsPerSweep: { type: 'integer', minimum: 0, maximum: 100 },
        maxDemotionsPerSweep: { type: 'integer', minimum: 0, maximum: 500 },
        minResidencyMs: { type: 'integer', minimum: 0 },
        promoteReadsPerHour: { type: 'integer', minimum: 1, maximum: 1e9 },
        demoteReadsPerHour: { type: 'integer', minimum: 0, maximum: 1e9 },
    },
};
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        classes: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(CLASSES.map((name) => [name, CLASS_SCHEMA])),
        },
    },
};

/** Each class's band is a band: demoteReadsPerHour below promoteReadsPerHour (an object never both promotes and demotes). */
function validate(v) {
    const errors = [];
    for (const name of CLASSES) {
        const c = { ...DEFAULTS.classes[name], ...v.classes?.[name] };
        if (c.demoteReadsPerHour >= c.promoteReadsPerHour) errors.push(`classes.${name}: demoteReadsPerHour must be below promoteReadsPerHour`);
    }
    return errors.length ? errors : true;
}

let store = null;

async function init() {
    if (store) return store;
    store = await config.createConfigStore({
        db: db.getDb(), service: 'media', namespace: 'media.storage_policy',
        defaults: DEFAULTS, schema: SCHEMA, validate,
        legacy: () => ({}),
        onActivate: async () => {},
        log: { info: (m) => console.log(`[StoragePolicy] ${m}`), warn: (m) => console.warn(`[StoragePolicy] ${m}`), error: (m) => console.error(`[StoragePolicy] ${m}`) },
    });
    return store;
}

function get() {
    if (!store) throw new Error('media.storage_policy is not loaded yet (storage-policy init() at boot)');
    return store;
}

async function set(updates, { actor = null, reason = null } = {}) {
    // Build a complete value: the shared store's merge does not promise to merge nested class fields.
    return get().apply(merge(settings(), updates), { actor, reason });
}

function merge(base, updates) {
    const out = { ...base };
    for (const [key, value] of Object.entries(updates || {})) {
        out[key] = value && typeof value === 'object' && !Array.isArray(value)
            && base[key] && typeof base[key] === 'object' ? merge(base[key], value) : value;
    }
    return out;
}

function settings() {
    let configured;
    try { configured = get().get(); } catch { configured = {}; }
    const classes = {};
    for (const name of CLASSES) classes[name] = { ...DEFAULTS.classes[name], ...configured.classes?.[name] };
    return { classes };
}

function classPolicy(name) {
    if (!CLASSES.includes(name)) throw new RangeError(`Unknown media class: ${name}`);
    return settings().classes[name];
}

/** The placement class of a native object: video/audio → video, image/thumbnail → image, everything else → download. */
function classOf(obj) {
    const kind = obj && obj.kind;
    if (kind === 'vod' || kind === 'clip') return 'video';
    if (kind === 'thumbnail' || kind === 'screenshot' || kind === 'avatar') return 'image';
    const major = String((obj && obj.mime_type) || '').toLowerCase().split('/')[0];
    if (major === 'video' || major === 'audio') return 'video';
    if (major === 'image') return 'image';
    return 'download';
}

function budgetFor(name) {
    const { maxPromotionsPerSweep, maxDemotionsPerSweep } = classPolicy(name);
    return { maxPromotionsPerSweep, maxDemotionsPerSweep };
}

/** The class's hourly promote and demote thresholds (hysteresis: demote < promote). */
function bandFor(name) {
    const { promoteReadsPerHour, demoteReadsPerHour } = classPolicy(name);
    return { promoteReadsPerHour, demoteReadsPerHour };
}

function timestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return NaN;
    const trimmed = value.trim();
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(trimmed) ? trimmed : `${trimmed.replace(' ', 'T')}Z`);
}

function mayMove({ class: name, lastMovedAt, now = Date.now() }) {
    const { minResidencyMs } = classPolicy(name);
    if (minResidencyMs === 0 || lastMovedAt == null) return true;
    const last = timestamp(lastMovedAt);
    const current = timestamp(now);
    return Number.isFinite(last) && Number.isFinite(current) && current - last >= minResidencyMs;
}

module.exports = { DEFAULTS, SCHEMA, CLASSES, init, get, set, settings, classOf, budgetFor, bandFor, mayMove, _reset: () => { store = null; } };
