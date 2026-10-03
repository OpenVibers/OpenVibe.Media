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
const DEFAULTS = {
    classes: Object.fromEntries(CLASSES.map((name) => [name, { ...BASE }])),
};

const CLASS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        maxPromotionsPerSweep: { type: 'integer', minimum: 0, maximum: 100 },
        maxDemotionsPerSweep: { type: 'integer', minimum: 0, maximum: 500 },
        minResidencyMs: { type: 'integer', minimum: 0 },
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

let store = null;

async function init() {
    if (store) return store;
    store = await config.createConfigStore({
        db: db.getDb(), service: 'media', namespace: 'media.storage_policy',
        defaults: DEFAULTS, schema: SCHEMA,
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
    for (const name of CLASSES) classes[name] = { ...BASE, ...configured.classes?.[name] };
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

module.exports = { DEFAULTS, SCHEMA, CLASSES, init, get, set, settings, classOf, budgetFor, mayMove, _reset: () => { store = null; } };
