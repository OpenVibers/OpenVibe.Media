/**
 * OpenVibe.Media — the cloud storage cost table as revisioned configuration (placement F1, part 5;
 * docs/media-fabric.md §2, §4, §6).
 *
 * Every estimator that used the hard-coded `CLOUD_PRICING` constant reads this instead. The values
 * mirror the official price pages (Cloudflare R2, Backblaze B2) at the design date; revisions carry
 * the page metadata so a price change is one revision, validated, with who-and-why.
 *
 * Defaults reflect what the doc accepts as the starting point:
 *   R2 Standard       $0.015/GB-mo, $4.50/M Class A, $0.36/M Class B, 10 GB free, 1M Class A free,
 *                     10M Class B free, egress free
 *   R2 Infrequent     $0.01/GB-mo + $0.01/GB retrieval + 30-day minimum, $9/M Class A, $0.90/M Class B
 *   B2                $6.95/TB-mo ≈ $0.00695/GB-mo, free ops, 10 GB free, egress free up to 3× storage
 *                     then $0.01/GB; partnerEgressFree is OFF by default (safer assumption until
 *                     the B2-Bandwidth-Alliance egress path is confirmed by the operator)
 *   local             $0 / $0 (prepaid bandwidth on the host, counted by the platform; not billed per GB)
 *
 * `partnerEgressFree` defaults to false (the safer assumption: a presigned B2 URL to a viewer is NOT
 * necessarily going via the Alliance CDN; treat as paid egress until confirmed).
 */
'use strict';

const config = require('openvibe-shared/config');
const db = require('../db/database');

const DEFAULTS = {
    r2: {
        standard: {
            storagePerGbMonth: 0.015,
            classAPerMillion: 4.50,
            classBPerMillion: 0.36,
            egressPerGb: 0,
            freeGb: 10,
            freeClassA: 1_000_000,
            freeClassB: 10_000_000,
        },
        infrequentAccess: {
            storagePerGbMonth: 0.01,
            classAPerMillion: 9.00,
            classBPerMillion: 0.90,
            retrievalPerGb: 0.01,
            egressPerGb: 0,
            freeGb: 0,
            freeClassA: 0,
            freeClassB: 0,
            minResidencyDays: 30,
        },
    },
    b2: {
        storagePerGbMonth: 0.00695,        // $6.95/TB-month as of the design date
        classAPerMillion: 0,
        classBPerMillion: 0,
        egressPerGb: 0.01,                 // after the 3× free allowance
        freeGb: 10,                        // B2's first 10 GB free
        egressFreeMultiplier: 3,           // free egress = 3× stored bytes per day
        partnerEgressFree: false,          // see module comment: safer default
    },
    local: {
        storagePerGbMonth: 0,
        egressPerGb: 0,
        freeGb: 0,
    },
    notes: {
        r2: 'R2 Standard; Infrequent Access not used online (retrieval fee + 30-day minimum).',
        b2: 'B2 Standard; egress free up to 3× stored bytes/month, then $0.01/GB; Bandwidth Alliance path is operator-toggled.',
    },
};

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        r2: {
            type: 'object',
            additionalProperties: false,
            properties: {
                standard: providerSchema('Standard'),
                infrequentAccess: providerSchema('InfrequentAccess'),
            },
        },
        b2: providerSchema('B2'),
        local: providerSchema('local'),
        notes: {
            type: 'object',
            additionalProperties: false,
            properties: {
                r2: { type: 'string' },
                b2: { type: 'string' },
            },
        },
    },
};

function providerSchema(name) {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            storagePerGbMonth: { type: 'number', minimum: 0, maximum: 10 },
            classAPerMillion: { type: 'number', minimum: 0, maximum: 1000 },
            classBPerMillion: { type: 'number', minimum: 0, maximum: 1000 },
            egressPerGb: { type: 'number', minimum: 0, maximum: 10 },
            retrievalPerGb: { type: 'number', minimum: 0, maximum: 10 },
            freeGb: { type: 'number', minimum: 0, maximum: 1e9 },
            freeClassA: { type: 'integer', minimum: 0, maximum: 1e12 },
            freeClassB: { type: 'integer', minimum: 0, maximum: 1e12 },
            egressFreeMultiplier: { type: 'number', minimum: 0, maximum: 100 },
            partnerEgressFree: { type: 'boolean' },
            minResidencyDays: { type: 'integer', minimum: 0, maximum: 365 },
        },
    };
}

function validate(v) {
    const errs = [];
    if (v.r2.standard.storagePerGbMonth < v.r2.infrequentAccess.storagePerGbMonth) errs.push('r2.standard.storagePerGbMonth must be >= r2.infrequentAccess.storagePerGbMonth (IA is the cheaper tier on paper)');
    if (v.b2.storagePerGbMonth < 0) errs.push('b2.storagePerGbMonth must be >= 0');
    if (v.b2.egressFreeMultiplier < 0) errs.push('b2.egressFreeMultiplier must be >= 0');
    return errs.length ? errs : true;
}

let store = null;

async function init({ log = console } = {}) {
    if (store) return store;
    const s = await config.createConfigStore({
        db: db.getDb(),
        service: 'media',
        namespace: 'media.cost_tiers',
        defaults: DEFAULTS,
        schema: SCHEMA,
        validate,
        legacy: () => ({}),
        onActivate: async () => { /* no media_settings mirror; pure read-only */ },
        log: { info: (m) => console.log(`[CostTiers] ${m}`), warn: (m) => console.warn(`[CostTiers] ${m}`), error: (m) => console.error(`[CostTiers] ${m}`) },
    });
    store = s;
    return store;
}

function get() {
    if (!store) throw new Error('media.cost_tiers is not loaded yet (cost-tiers init() at boot)');
    return store;
}

// A revision may set one nested price (r2.standard.storage) and keep the rest: merge into the defaults per level,
// never shallowly (a shallow merge left sibling prices undefined and the estimates NaN).
function merge(base, over) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) {
        out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
    }
    return out;
}
function settings() {
    try { return merge(DEFAULTS, get().get()); } catch (err) { return merge(DEFAULTS, {}); }
}

module.exports = { DEFAULTS, SCHEMA, validate, init, get, settings, _reset: () => { store = null; } };