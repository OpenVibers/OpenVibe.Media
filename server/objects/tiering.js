/**
 * OpenVibe.Media — tiering of native v2 objects (roadmap WS-G task 11; docs/object-model.md#tiering-of-native-objects).
 *
 * A native object (uploaded through /api/v2: legacy_ref NULL) keeps its canonical copy where the upload put it
 * (local disk, OBJECTS_PATH; a B2 canonical copy is handled the same way). A popular one also gets a copy in
 * the Cloudflare R2 popularity cache, which becomes its playback source (GET /o/:id redirects there while R2
 * is available; the canonical copy is the fallback), and loses it when it goes idle or stops being ready.
 * Popularity is ./popularity.js (unique viewers per UTC day, no identifiers); the thresholds and the
 * site-level activation gate are the revisioned policy media.object_tier (./tier-policy.js).
 * The thresholds say who may move; value per dollar (../placement/value.js, R2 Standard prices from
 * ../placement/cost-tiers.js) says who moves first: each class spends its per-sweep budget
 * (../placement/storage-policy.js) on its highest-scoring promotions and its lowest-scoring demotions.
 * Demand (F2.5): the sweep's eligibility reads each object's reads in the last hour for this deployment's region
 * (../placement/demand.js hotness(), one MGET per page of objects) against its class's hysteresis band
 * (promoteReadsPerHour / demoteReadsPerHour, media.storage_policy): at or above the first it may promote, below the
 * second it may demote, in between nothing moves. Without Valkey, or when a read fails or times out, the whole sweep
 * reads the daily PostgreSQL counts instead (the thresholds above), logged once and counted in
 * media_sweep_demand_source_total{source}. Each decision's inputs.demand says which source and value drove it.
 * Constraints (F2.6): a promotion needs R2 eligible for the online-hot class, and the demotion of a ready object needs
 * its canonical copy's provider eligible for its class (../placement/providers.js placementGate(): breaker not open,
 * no failed capability), else it is refused and the copies stay where they are; each decision's inputs.provider_gate
 * records the gate it saw. A class with maxHotUsdPerMonth (media.storage_policy) promotes only while its R2 copies'
 * list-price storage (media.cost_tiers) stays within it: the first promotion that would pass it is refused
 * (inputs.budget) and closes the class's promotions for the sweep, so a cheaper, lower-ranked object never jumps
 * the value-per-dollar queue.
 *
 *   runSweep({ trigger })   one pass: rotate the popularity counts, then promote and demote by the policy.
 *                           Step 4 of the storage sweep (server/vod/vod-storage.js runSweep), which a restore
 *                           drill never starts (and this refuses under MEDIA_DRILL anyway)
 *   promote(id, ctx)        add a verified R2 copy: the canonical copy is hashed again (sha256 = content_hash),
 *                           uploaded (or copied from B2), and the R2 copy HEADed and read back (size and sha256)
 *                           before it is recorded present, which makes it the playback source
 *   demote(id, ctx)         remove the R2 copy, after the canonical copy is confirmed good (hashed again)
 *   candidates({ appId })   what the policy would promote now, and what would refuse it (database only)
 *   report({ appId })       the operator views' part (database only)
 *
 * The gate: while `active` is false nothing moves, here or through promote()/demote(); the sweep records what
 * it would do as dry_run decisions. A hold freezes placement: a held object is never promoted or demoted
 * (refused). Only an object whose canonical copy is verified on record (present, checked, sha256 on record)
 * is promoted, and a demotion never removes the last good copy: the canonical copy must check out first.
 * Every decision (done, already, refused, failed, dry_run) goes to media_object_tier_decisions with its
 * inputs and the policy in force, and counts in media_tier_decisions_24h{target="object"} on /metrics. A
 * refusal or dry run the sweep would repeat is logged once a day per object (a repeated dry run does not use
 * up the sweep's budget, so over a day the log shows what successive sweeps would move); an object whose move
 * failed waits FAILED_BACKOFF_H hours before the sweep tries it again.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');
const drill = require('../drill');
const policy = require('./tier-policy');
const storagePolicy = require('../placement/storage-policy');
const costTiers = require('../placement/cost-tiers');
const value = require('../placement/value');
const providers = require('../placement/providers');
const popularity = require('./popularity');

const MB = 1024 * 1024;
const FAILED_BACKOFF_H = 6;
const OUTCOMES = ['done', 'already', 'refused', 'failed', 'dry_run'];
const DAY_MS = 864e5;
const MONTH_DAYS = 30;               // value.js prices a month
const LATENCY_VALUE = 1;             // $ a request served from R2 is worth: no revisioned figure yet, so the score is requests per dollar

const vodStorage = () => require('../vod/vod-storage');
const model = () => require('./model');
const events = () => require('../events');
const subjectOf = (obj) => ({ type: 'object', id: obj.id });

const sweepState = { running: false, lastRunAt: null, lastResult: null };

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', (d) => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

/** Epoch ms from a `YYYY-MM-DD HH:MM:SS` (UTC) text timestamp, as the migrations store them, or ISO (NaN when unreadable). */
function msOf(t) {
    const s = String(t || '');
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

// ── The canonical copy ───────────────────────────────────────

function canonicalLocation(obj, locs) {
    return locs.find((l) => l.provider === (obj.canonical_provider || 'local')) || null;
}

/** Is the canonical copy verified on record (no I/O)? → null, or why not. */
function canonicalUnverified(obj, locs) {
    const l = canonicalLocation(obj, locs);
    if (!l) return 'no canonical copy on record';
    if (l.provider === 'r2') return 'the canonical copy is the R2 cache';
    if (!obj.content_hash) return 'no sha256 on record to check a copy against (the object.hash job has not reached it)';
    if (l.state !== 'present' || !l.verified_at) return `the canonical ${l.provider} copy is ${l.state}${l.verified_at ? '' : ' and was never checked'}`;
    if (l.checksum && l.checksum !== obj.content_hash) return `the canonical ${l.provider} copy's checksum contradicts the object's sha256`;
    return null;
}

/**
 * Check the canonical copy now: a local file must exist with the object's size and sha256; a B2 copy must
 * answer a HEAD with the object's size. → { ok, why, source: { file } | { b2key } }
 */
async function confirmCanonical(obj, loc) {
    if (!loc) return { ok: false, why: 'no canonical copy on record' };
    if (!obj.content_hash) return { ok: false, why: 'no sha256 on record to check the canonical copy against' };
    const size = Number(obj.size_bytes);
    if (loc.provider === 'local') {
        let st = null;
        try { st = fs.statSync(loc.key); } catch { /* missing */ }
        if (!st || !st.isFile()) return { ok: false, why: 'the canonical local file is missing' };
        if (st.size !== size) return { ok: false, why: `the canonical local file is ${st.size} bytes, not ${size}` };
        const sum = await sha256File(loc.key).catch(() => null);
        if (sum !== obj.content_hash) return { ok: false, why: sum ? 'the canonical local file does not match the sha256 on record' : 'the canonical local file could not be read' };
        return { ok: true, source: { file: loc.key } };
    }
    if (loc.provider === 'b2') {
        const head = await vodStorage().headObject('b2', loc.key).catch((err) => ({ error: err.message }));
        if (!head) return { ok: false, why: 'the canonical B2 copy is missing' };
        if (head.error) return { ok: false, why: `the canonical B2 copy could not be checked: ${head.error}` };
        if (head.size !== size) return { ok: false, why: `the canonical B2 copy is ${head.size} bytes, not ${size}` };
        return { ok: true, source: { b2key: loc.key } };
    }
    return { ok: false, why: `a canonical copy in ${loc.provider} cannot be checked here` };
}

/** Where the R2 copy goes: the canonical key for a B2 canonical copy (copied key to key), else objects/<app>/<id>. */
function r2KeyFor(obj, canon) {
    return canon && canon.provider === 'b2' ? canon.key : `objects/${obj.app_id}/${obj.id}`;
}

// ── Provider classes and the storage ceiling (F2.6) ──────────

/** The class a canonical copy serves: the Media host's disk is the regional cache, a remote provider the online canonical. */
const canonicalClass = (provider) => (provider === 'local' ? 'regional-cache' : 'online-canonical');

/** R2 Standard's list price of keeping `bytes` for a month (media.cost_tiers). */
function hotUsdPerMonth(bytes) {
    return (Number(bytes) || 0) / value.GB * (Number(costTiers.settings().r2.standard.storagePerGbMonth) || 0);
}

const fmtUsd = (v) => `$${Number(Number(v).toPrecision(4))}`;

/** What each class's present R2 copies cost a month at list price, gross of R2's account-wide free tier: { video: 0.12, image: 0, ... }. */
async function hotSpend() {
    const out = Object.fromEntries(storagePolicy.CLASSES.map((c) => [c, 0]));
    const rows = await db.all(`SELECT o.kind, o.mime_type, SUM(COALESCE(l.size_bytes, o.size_bytes, 0))::bigint AS bytes
        FROM media_locations l JOIN media_objects o ON o.id = l.object_id
        WHERE l.provider = 'r2' AND l.state = 'present' GROUP BY o.kind, o.mime_type`);
    for (const r of rows) out[storagePolicy.classOf(r)] += hotUsdPerMonth(r.bytes);
    return out;
}

// ── Decisions ────────────────────────────────────────────────

function thresholdSnapshot(settings) {
    const out = {};
    for (const [k, t] of Object.entries(policy.thresholds(settings))) out[k] = { value: t.value, source: t.source };
    return out;
}

/** What a decision saw: the object's popularity, size, lifecycle, copies, hold and the gate. */
async function inputsOf(obj, { locs, pop, held, settings }) {
    const canon = canonicalLocation(obj, locs);
    const r2 = locs.find((l) => l.provider === 'r2');
    return {
        unique_viewers_7d: pop ? pop.unique_viewers : 0,
        last_viewed_day: pop ? pop.last_viewed_day : await popularity.lastViewedDay(obj.id),
        size_bytes: Number(obj.size_bytes) || 0,
        kind: obj.kind, class: storagePolicy.classOf(obj), visibility: obj.visibility, lifecycle_status: obj.lifecycle_status,
        content_hash: !!obj.content_hash,
        canonical: canon ? { provider: canon.provider, state: canon.state, verified_at: canon.verified_at || null,
            checksum_matches: !!(canon.checksum && obj.content_hash && canon.checksum === obj.content_hash) } : null,
        held,
        r2: r2 ? { state: r2.state, since: r2.created_at || null } : null,
        gate_active: !!settings.active,
        r2_available: vodStorage().providerAvailable('r2'),
    };
}

/** Log one decision. Never throws: the move already happened (or did not). → the row id, or null */
async function recordDecision({ obj, action, from, to, outcome, trigger, reason, inputs, settings, error = null }) {
    try {
        return (await db.run(`INSERT INTO media_object_tier_decisions (object_id, app_id, action, from_provider, to_provider, outcome, trigger, reason, inputs, thresholds, error)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [obj.id, obj.app_id || null, action, from || null, to || null, outcome, String(trigger || 'manual').slice(0, 40), String(reason || '').slice(0, 1000),
            JSON.stringify(inputs || {}), JSON.stringify(thresholdSnapshot(settings)), error == null ? null : String(error).slice(0, 500)])).lastInsertRowid;
    } catch (err) {
        console.warn(`[ObjectTiers] decision for ${obj && obj.id} not logged: ${err.message}`);
        return null;
    }
}

/** The sweep logged the same outcome for this object and action within the last day. */
async function loggedToday(objectId, action, outcome) {
    return !!await db.get(`SELECT 1 AS x FROM media_object_tier_decisions WHERE object_id = ? AND action = ? AND outcome = ? AND trigger = 'sweep'
                     AND decided_at >= ov_now_iso('-1 day') LIMIT 1`, [objectId, action, outcome]);
}

/** A move of this object failed within the back-off window. */
async function inBackoff(objectId, action) {
    return !!await db.get(`SELECT 1 AS x FROM media_object_tier_decisions WHERE object_id = ? AND action = ? AND outcome = 'failed'
                     AND decided_at >= ov_now_iso(?) LIMIT 1`, [objectId, action, `-${FAILED_BACKOFF_H} hours`]);
}

/**
 * Shared frame of promote()/demote(): loads the object and its facts, and returns log(outcome, reason, extra)
 * which records the decision (the sweep's repeated refusals and dry runs once a day) and shapes the answer.
 */
async function frame(objectId, action, ctx) {
    const settings = ctx.settings || policy.settings();
    const obj = await model().getObject(String(objectId || ''));
    if (!obj) return { missing: true };
    const locs = await model().listLocations(obj.id);
    const pop = ctx.pop !== undefined ? ctx.pop : ((await popularity.stats({ ids: [obj.id], now: ctx.now })).get(obj.id) || null);
    const held = await model().isHeld(obj.id);
    const inputs = await inputsOf(obj, { locs, pop, held, settings });
    if (ctx.valuePerDollar != null) inputs.value_per_dollar = ctx.valuePerDollar;
    if (ctx.demand) inputs.demand = ctx.demand;
    if (ctx.budget) inputs.budget = ctx.budget;
    const canon = canonicalLocation(obj, locs);
    // The provider class the move relies on: R2 as online-hot for a promotion, the canonical copy's provider for a demotion.
    const gate = action === 'promote' ? providers.placementGate('r2', 'online-hot')
        : canon && canon.provider !== 'r2' ? providers.placementGate(canon.provider, canonicalClass(canon.provider)) : null;
    if (gate) inputs.provider_gate = gate;
    const trigger = ctx.trigger || 'manual';
    const why = ctx.reason || 'requested';
    const from = action === 'promote' ? (canon ? canon.provider : null) : 'r2';
    const to = action === 'promote' ? 'r2' : (canon ? canon.provider : null);
    const log = async (outcome, reason, extra = {}) => {
        const repeat = trigger === 'sweep' && (outcome === 'refused' || outcome === 'dry_run') && await loggedToday(obj.id, action, outcome);
        if (!repeat) await recordDecision({ obj, action, from, to, outcome, trigger, reason, inputs, settings, error: extra.error });
        return { ok: outcome === 'done' || outcome === 'already', outcome, object_id: obj.id, repeat, ...extra };
    };
    return { obj, locs, canon, held, settings, why, log, gate };
}

/** Why an object may not be promoted at all, from the record (no I/O), or null. */
async function promoteRefusal(obj, { locs, held }) {
    if (held) return 'under a retention hold (a hold freezes placement)';
    if (obj.legacy_ref) return 'not a native object (projected objects tier with their VOD)';
    if (obj.lifecycle_status !== 'ready') return `the object is ${obj.lifecycle_status}`;
    if (await db.isSandboxTenant(obj.app_id)) return 'developer sandbox objects are never tiered';
    return canonicalUnverified(obj, locs);
}

// ── Moves ────────────────────────────────────────────────────

/**
 * Promote one native object to the R2 popularity cache and log the decision. ctx { trigger, reason, settings, pop }.
 * → { ok, outcome: done | already | refused | failed | dry_run, error?, bytes? }
 */
async function promote(objectId, ctx = {}) {
    const f = await frame(objectId, 'promote', ctx);
    if (f.missing) return { ok: false, outcome: 'refused', error: 'object not found' };
    const { obj, locs, canon, held, settings, why, log, gate } = f;
    if (ctx.residency) return await log('refused', `${why}; refused: ${ctx.residency}`, { error: ctx.residency });
    if (held) return await log('refused', `${why}; refused: under a retention hold (a hold freezes placement)`, { error: 'held', held: true });
    const r2Now = locs.find((l) => l.provider === 'r2');
    if (r2Now && r2Now.state === 'present' && r2Now.verified_at) return await log('already', `${why}; the R2 copy is already present`);
    const refusal = await promoteRefusal(obj, { locs, held });
    if (refusal) return await log('refused', `${why}; refused: ${refusal}`, { error: refusal });
    if (!gate.eligible) return await log('refused', `${why}; refused: ${gate.reason} (provider class gate)`, { error: gate.reason, blocked: 'provider' });
    if (ctx.overBudget) return await log('refused', `${why}; refused: ${ctx.overBudget}`, { error: ctx.overBudget, blocked: 'budget' });
    const vs = vodStorage();
    if (!settings.active) return await log('dry_run', `gate off (active = false): would promote: ${why}${vs.providerAvailable('r2') ? '' : ' (R2 is not available now)'}`);
    if (!vs.providerAvailable('r2')) return await log('refused', `${why}; refused: R2 is not available`, { error: 'R2 not available' });

    await db.getDb().tx(async () => {
        await events().recordPlacement('media.replica.requested', obj.app_id, subjectOf(obj), {
            object_id: obj.id, app_id: obj.app_id || null, class: storagePolicy.classOf(obj), action: 'promote',
            from: canon ? canon.provider : null, to: 'r2', provider: 'r2', ...(ctx.demand ? { demand: ctx.demand } : {}),
        });
    });
    events().kick();
    const check = await confirmCanonical(obj, canon);
    if (!check.ok) return await log('refused', `${why}; refused: ${check.why}`, { error: check.why });
    const key = r2KeyFor(obj, canon);
    const size = Number(obj.size_bytes);
    try {
        if (check.source.file) await vs.uploadFile('r2', key, check.source.file, obj.mime_type || 'application/octet-stream');
        else await vs.copyBetweenProviders('b2', 'r2', key);
        const head = await vs.headObject('r2', key);
        if (!head || head.size !== size) throw new Error(`the R2 copy is ${head ? `${head.size} bytes` : 'missing'}, not ${size} bytes`);
        const read = await vs.sha256Object('r2', key);
        if (!read || read.sha256 !== obj.content_hash) throw new Error('the R2 copy read back does not match the sha256 on record');
    } catch (err) {
        await vs.deleteObject('r2', key).catch(() => {});      // never leave an unrecorded or unverified copy behind
        return await log('failed', `${why}; the copy to R2 did not verify`, { error: err.message });
    }

    // A hold placed (or a delete made) while the bytes were copied wins: the new copy was never recorded, so
    // removing it moves nothing anyone could see.
    const now = await model().getObject(obj.id);
    if (!now || await model().isHeld(obj.id) || now.lifecycle_status !== 'ready') {
        await vs.deleteObject('r2', key).catch(() => {});
        return await log('refused', `${why}; refused: the object was ${!now ? 'removed' : now.lifecycle_status !== 'ready' ? now.lifecycle_status : 'put under a hold'} during the copy (the copy was removed)`,
            { error: 'changed during the copy' });
    }
    await db.getDb().tx(async () => {
        // A fresh row: its created_at is when the object entered R2 (the demotion's "in R2 at least that long").
        await db.run("DELETE FROM media_locations WHERE object_id = ? AND provider = 'r2'", [obj.id]);
        await model().upsertLocation(obj.id, { provider: 'r2', bucket: vs.bucketFor('r2'), key, storage_class: 'cache', state: 'present',
            checksum: obj.content_hash, size_bytes: size, verified: true });
        await model().setLocationState(canon.id, { state: 'present', size_bytes: size });
        await events().recordPlacement('media.replica.ready', obj.app_id, subjectOf(obj), {
            object_id: obj.id, app_id: obj.app_id || null, class: storagePolicy.classOf(obj), action: 'promote',
            provider: 'r2', key, bytes: size, replica_since: new Date().toISOString(),
        });
    });
    events().kick();
    console.log(`[ObjectTiers] ${obj.id} (${obj.app_id}) promoted to R2: ${key} (${(size / MB).toFixed(1)} MB)`);
    return await log('done', why, { bytes: size });
}

/**
 * Demote one native object from the R2 popularity cache (its R2 copy is deleted) and log the decision.
 * ctx as for promote(). → { ok, outcome, error? }
 */
async function demote(objectId, ctx = {}) {
    const f = await frame(objectId, 'demote', ctx);
    if (f.missing) return { ok: false, outcome: 'refused', error: 'object not found' };
    const { obj, locs, canon, held, settings, why, log, gate } = f;
    if (ctx.residency) return await log('refused', `${why}; refused: ${ctx.residency}`, { error: ctx.residency });
    if (held) return await log('refused', `${why}; refused: under a retention hold (a hold freezes placement)`, { error: 'held', held: true });
    const r2 = locs.find((l) => l.provider === 'r2');
    if (!r2) return await log('already', `${why}; there is no R2 copy`);
    // Reads of a ready object fall back to its canonical copy: never shift them onto a provider that is failing.
    if (obj.lifecycle_status === 'ready' && gate && !gate.eligible) {
        return await log('refused', `${why}; refused: ${gate.reason} (provider class gate); the R2 copy is kept`, { error: gate.reason, blocked: 'provider' });
    }
    const vs = vodStorage();
    if (!vs.providerConfigured('r2')) return await log('refused', `${why}; refused: R2 is not configured`, { error: 'R2 not configured' });
    if (!canon || canon.provider === 'r2') return await log('refused', `${why}; refused: no canonical copy besides R2 (the R2 copy is kept)`, { error: 'no canonical copy' });

    // The last good copy is never the one removed: the canonical copy must check out now. A dry run checks it too,
    // so it proposes (and projects the freed R2 cost of) only the demotions a live sweep could make.
    const check = await confirmCanonical(obj, canon);
    if (!check.ok) return await log('refused', `${why}; refused: ${check.why}; the R2 copy is kept (it may be the last good copy)`, { error: check.why });
    if (!settings.active) return await log('dry_run', `gate off (active = false): would demote: ${why}`);
    await db.getDb().tx(async () => {
        await events().recordPlacement('media.replica.draining', obj.app_id, subjectOf(obj), {
            object_id: obj.id, app_id: obj.app_id || null, class: storagePolicy.classOf(obj), action: 'demote',
            provider: 'r2', key: r2.key, ...(ctx.demand ? { demand: ctx.demand } : {}),
        });
    });
    events().kick();
    try {
        await vs.deleteObject('r2', r2.key);
        const still = await vs.headObject('r2', r2.key);
        if (still) throw new Error('the R2 copy is still there after the delete');
    } catch (err) {
        return await log('failed', `${why}; the R2 copy could not be removed`, { error: err.message });
    }
    await db.getDb().tx(async () => {
        await db.run('DELETE FROM media_locations WHERE id = ?', [r2.id]);
        await model().setLocationState(canon.id, { state: 'present', size_bytes: Number(obj.size_bytes) });
        await events().recordPlacement('media.replica.evicted', obj.app_id, subjectOf(obj), {
            object_id: obj.id, app_id: obj.app_id || null, class: storagePolicy.classOf(obj), action: 'demote',
            provider: 'r2', key: r2.key,
        });
    });
    events().kick();
    console.log(`[ObjectTiers] ${obj.id} (${obj.app_id}) demoted from R2 (${why})`);
    return await log('done', why);
}

// ── Candidates ───────────────────────────────────────────────

/**
 * Value per dollar of an R2 copy of this row (../placement/value.js): its reads in the last hour (Valkey demand)
 * or else its 7-day unique viewers, scaled to a month of requests, against R2 Standard's storage, read and retrieval prices (media.cost_tiers) and, for a promotion,
 * the class's minimum residency beyond that month (media.storage_policy), which the copy commits to. Free
 * allowances are not counted: a promotion is priced at the margin.
 */
function scoreOf(row, cls, { committing = false } = {}) {
    const p = costTiers.settings().r2.standard;
    const storage = Number(p.storagePerGbMonth) || 0;
    const residencyDays = committing ? Math.max(storagePolicy.settings().classes[cls].minResidencyMs / DAY_MS, Number(p.minResidencyDays) || 0) : 0;
    return value.score({
        // A row that carries a month of counts (the demotion scan) is read as is: an idle copy has no viewer in the
        // 7-day window, so only the longer count tells a copy last viewed 20 days ago from one never viewed.
        requests: row.reads_1h != null ? (Number(row.reads_1h) || 0) * 24 * MONTH_DAYS
            : row.unique_viewers_30d != null ? Number(row.unique_viewers_30d) || 0
            : (Number(row.unique_viewers_7d) || 0) * MONTH_DAYS / popularity.WINDOW_DAYS,
        bytes: Number(row.size_bytes) || 0,
        storageCost: storage,
        requestCost: (Number(p.classBPerMillion) || 0) / 1e6,
        retrievalCost: Number(p.retrievalPerGb) || 0,
        residencyCost: storage * Math.max(0, residencyDays - MONTH_DAYS) / MONTH_DAYS,
        latencyValue: LATENCY_VALUE,
    });
}

const fmtScore = (v) => (Number.isFinite(v) ? Number(v.toPrecision(4)).toString() : String(v));

const SCAN_PAGE = 500;               // rows read per page of the promotion scan
const SWEEP_KEEP = 500;              // top-ranked promotion candidates a sweep keeps

/**
 * Ready native objects that pass the popularity, recency and size thresholds and have no R2 copy yet, each with
 * its class and value_per_dollar, highest value per dollar first (then most viewed). Every eligible row is scored
 * before the limit applies (a most-viewed prefix would drop smaller objects that are worth more per dollar), but
 * the scan reads SCAN_PAGE rows at a time and holds only the best `limit`, so memory stays bounded.
 * excludeSandbox drops developer-sandbox tenants in the query (their objects are never tiered).
 * With `demand` (the sweep's Valkey reader), the hourly reads replace the daily counts: see hotPromotionCandidates.
 */
async function promotionCandidates(settings, { now = Date.now(), appId = null, limit = 200, excludeSandbox = false, demand = null } = {}) {
    if (demand) return await hotPromotionCandidates(settings, demand, { appId, limit, excludeSandbox });
    const today = popularity.dayOf(now);
    const args = [popularity.windowStart(today, popularity.WINDOW_DAYS)];
    const rank = (a, b) => b.value_per_dollar - a.value_per_dollar || Number(b.unique_viewers_7d) - Number(a.unique_viewers_7d) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let best = [];
    for (let after = ''; ;) {
        const rows = await db.all(`SELECT o.*, p.viewers AS unique_viewers_7d, p.last_day AS last_viewed_day
        FROM (SELECT object_id, SUM(unique_viewers)::bigint AS viewers, MAX(day) AS last_day FROM media_object_views_daily
              WHERE day >= ? AND unique_viewers > 0 GROUP BY object_id) p
        JOIN media_objects o ON o.id = p.object_id
        WHERE o.id > ? AND o.legacy_ref IS NULL AND o.lifecycle_status = 'ready'
          AND p.viewers >= ? AND p.last_day >= ? AND o.size_bytes >= ? AND o.size_bytes <= ?
          AND NOT EXISTS (SELECT 1 FROM media_locations l WHERE l.object_id = o.id AND l.provider = 'r2' AND l.state = 'present')${appId ? ' AND o.app_id = ?' : ''}${excludeSandbox
        ? " AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.app_id = o.app_id AND a.env = 'sandbox')" : ''}
        ORDER BY o.id LIMIT ?`,
        [...args, after, settings.promoteMinUniqueViewers7d, popularity.windowStart(today, settings.promoteRecentAccessDays),
            Math.ceil(settings.promoteMinSizeMb * MB), Math.floor(settings.promoteMaxSizeMb * MB), ...(appId ? [appId] : []), SCAN_PAGE]);
        for (const r of rows) {
            r.class = storagePolicy.classOf(r);
            r.value_per_dollar = scoreOf(r, r.class, { committing: true });
            r.demand = { source: 'pg', metric: 'unique_viewers_7d', value: Number(r.unique_viewers_7d) || 0, threshold: settings.promoteMinUniqueViewers7d };
        }
        best = best.concat(rows).sort(rank).slice(0, limit);
        if (rows.length < SCAN_PAGE) return best;
        after = rows[rows.length - 1].id;
    }
}

/** The demand fields a decision records for a Valkey reading: source, the hourly reads and the class's threshold. */
function hotDemand(demand, reads, threshold) {
    return { source: 'valkey', metric: 'reads_1h', value: reads, threshold, region: demand.region, window_s: demand.window_s };
}

/**
 * The Valkey form of promotionCandidates: ready native objects in the size bounds with no R2 copy, paged by id
 * (SCAN_PAGE rows, one hotness MGET per page), kept when their reads in the last hour reach their class's
 * promoteReadsPerHour; ranked by value per dollar at that rate, then reads. A failed read throws (the sweep falls back).
 */
async function hotPromotionCandidates(settings, demand, { appId = null, limit = 200, excludeSandbox = false } = {}) {
    const rank = (a, b) => b.value_per_dollar - a.value_per_dollar || b.reads_1h - a.reads_1h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let best = [];
    for (let after = ''; ;) {
        const rows = await db.all(`SELECT o.* FROM media_objects o
        WHERE o.id > ? AND o.legacy_ref IS NULL AND o.lifecycle_status = 'ready' AND o.size_bytes >= ? AND o.size_bytes <= ?
          AND NOT EXISTS (SELECT 1 FROM media_locations l WHERE l.object_id = o.id AND l.provider = 'r2' AND l.state = 'present')${appId ? ' AND o.app_id = ?' : ''}${excludeSandbox
        ? " AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.app_id = o.app_id AND a.env = 'sandbox')" : ''}
        ORDER BY o.id LIMIT ?`,
        [after, Math.ceil(settings.promoteMinSizeMb * MB), Math.floor(settings.promoteMaxSizeMb * MB), ...(appId ? [appId] : []), SCAN_PAGE]);
        const heat = rows.length ? await demand.read(rows.map((r) => r.id)) : new Map();
        const hot = [];
        for (const r of rows) {
            r.class = storagePolicy.classOf(r);
            r.reads_1h = heat.get(String(r.id)) || 0;
            const { promoteReadsPerHour } = storagePolicy.bandFor(r.class);
            if (r.reads_1h < promoteReadsPerHour) continue;
            r.value_per_dollar = scoreOf(r, r.class, { committing: true });
            r.demand = hotDemand(demand, r.reads_1h, promoteReadsPerHour);
            hot.push(r);
        }
        best = best.concat(hot).sort(rank).slice(0, limit);
        if (rows.length < SCAN_PAGE) return best;
        after = rows[rows.length - 1].id;
    }
}

/**
 * Native objects with an R2 copy that should lose it: not ready any more (first, whatever their score), or idle,
 * lowest value per dollar of keeping the copy first (its viewers over the kept month, since an idle copy has none
 * in the last 7 days), then the largest. With `demand` (the sweep's Valkey reader, one MGET per SCAN_PAGE copies), a
 * ready object is cold when its reads in the last hour fall below its class's demoteReadsPerHour instead of idle by
 * the daily counts (still in R2 at least demoteIdleDays either way). → [{ row, reason, class, value_per_dollar, demand }]
 */
async function demotionCandidates(settings, { now = Date.now(), appId = null, demand = null } = {}) {
    const idleFrom = popularity.windowStart(popularity.dayOf(now), settings.demoteIdleDays);
    const monthFrom = popularity.windowStart(popularity.dayOf(now), popularity.KEEP_DAYS);
    const rows = await db.all(`SELECT o.*, l.created_at AS r2_since, l.state AS r2_state, l.size_bytes AS r2_size_bytes,
                (SELECT MAX(d.day) FROM media_object_views_daily d WHERE d.object_id = o.id AND d.unique_viewers > 0) AS last_viewed_day,
                (SELECT COALESCE(SUM(d.unique_viewers), 0)::bigint FROM media_object_views_daily d WHERE d.object_id = o.id AND d.day >= ?) AS unique_viewers_30d
            FROM media_locations l JOIN media_objects o ON o.id = l.object_id
            WHERE l.provider = 'r2' AND o.legacy_ref IS NULL${appId ? ' AND o.app_id = ?' : ''}
            ORDER BY (o.lifecycle_status = 'ready'), o.id`, appId ? [monthFrom, appId] : [monthFrom]);
    if (demand) {
        for (let i = 0; i < rows.length; i += SCAN_PAGE) {
            const page = rows.slice(i, i + SCAN_PAGE);
            const heat = await demand.read(page.map((r) => r.id));
            for (const r of page) r.reads_1h = heat.get(String(r.id)) || 0;
        }
    }
    const out = [];
    for (const r of rows) {
        const cls = storagePolicy.classOf(r);
        const { demoteReadsPerHour } = storagePolicy.bandFor(cls);
        const scored = { row: r, class: cls, value_per_dollar: scoreOf(r, cls),
            demand: demand ? hotDemand(demand, r.reads_1h, demoteReadsPerHour) : { source: 'pg', metric: 'last_viewed_day', value: r.last_viewed_day || null, threshold: idleFrom } };
        if (r.lifecycle_status !== 'ready') { out.push({ ...scored, reason: `the object is ${r.lifecycle_status}` }); continue; }
        const since = msOf(r.r2_since);
        const settled = !Number.isFinite(since) || now - since >= settings.demoteIdleDays * DAY_MS;
        if (!settled) continue;
        if (demand) {
            if (r.reads_1h < demoteReadsPerHour) {
                out.push({ ...scored, reason: `${r.reads_1h} reads in the last hour (demand valkey, region ${demand.region}) < demoteReadsPerHour ${demoteReadsPerHour} (class ${cls}); `
                    + `in R2 since ${r.r2_since || 'unknown'} (at least demoteIdleDays ${settings.demoteIdleDays})` });
            }
        } else if (!r.last_viewed_day || r.last_viewed_day < idleFrom) {
            out.push({ ...scored, reason: `no viewer since ${r.last_viewed_day || 'the kept counts began'} (idle for demoteIdleDays ${settings.demoteIdleDays}); in R2 since ${r.r2_since || 'unknown'}` });
        }
    }
    const forced = (c) => (c.row.lifecycle_status === 'ready' ? 1 : 0);
    out.sort((a, b) => forced(a) - forced(b) || a.value_per_dollar - b.value_per_dollar
        || Number(b.row.size_bytes) - Number(a.row.size_bytes) || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
    return out;
}

/** Where a move stands in its class's ranking and budget: `class video, value per dollar 1234, 1 of budget 3 (maxPromotionsPerSweep)`. */
function rankNote(cls, score, slot, budgetKey) {
    return `class ${cls}, value per dollar ${fmtScore(score)}, ${slot} of budget ${storagePolicy.budgetFor(cls)[budgetKey]} (${budgetKey}, media.storage_policy)`;
}

function promoteReason(c, s, slot) {
    if (c.demand && c.demand.source === 'valkey') {
        return `${c.reads_1h} reads in the last hour (demand valkey, region ${c.demand.region}) >= promoteReadsPerHour ${c.demand.threshold} (class ${c.class}); `
            + `${(Number(c.size_bytes) / MB).toFixed(1)} MB (promoteMinSizeMb ${s.promoteMinSizeMb} to promoteMaxSizeMb ${s.promoteMaxSizeMb}); `
            + rankNote(c.class, c.value_per_dollar, slot, 'maxPromotionsPerSweep');
    }
    return `${c.unique_viewers_7d} unique viewers in 7 days >= promoteMinUniqueViewers7d ${s.promoteMinUniqueViewers7d}; last viewed ${c.last_viewed_day} `
        + `(within promoteRecentAccessDays ${s.promoteRecentAccessDays}); ${(Number(c.size_bytes) / MB).toFixed(1)} MB (promoteMinSizeMb ${s.promoteMinSizeMb} to promoteMaxSizeMb ${s.promoteMaxSizeMb}); `
        + rankNote(c.class, c.value_per_dollar, slot, 'maxPromotionsPerSweep');
}

/** What the policy would promote now, each with what (on record) would refuse it; database only. */
async function candidates({ appId = null, limit = 20, now = Date.now(), settings = policy.settings() } = {}) {
    return (await Promise.all((await promotionCandidates(settings, { now, appId, limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200) })).map(async (c) => ({
        object_id: c.id, app_id: c.app_id, kind: c.kind, class: c.class, value_per_dollar: c.value_per_dollar,
        size_bytes: c.size_bytes, unique_viewers_7d: c.unique_viewers_7d, last_viewed_day: c.last_viewed_day,
        blocked_by: await promoteRefusal(c, { locs: await model().listLocations(c.id), held: await model().isHeld(c.id) }),
    }))));
}

// ── The sweep ────────────────────────────────────────────────

function tally(out, r) {
    if (r.repeat) out.repeats++;
    else if (r.outcome === 'done') out[r.action === 'demote' ? 'demoted' : 'promoted']++;
    else if (r.outcome === 'dry_run') out[r.action === 'demote' ? 'would_demote' : 'would_promote']++;
    else out[r.outcome] = (out[r.outcome] || 0) + 1;
    if (r.outcome === 'failed') out.errors.push({ object_id: r.object_id, action: r.action, error: r.error });
}

/** When the object last moved: its latest completed promotion or demotion, else null. */
async function lastMovedAt(objectId) {
    const r = await db.get(`SELECT MAX(decided_at) AS at FROM media_object_tier_decisions WHERE object_id = ? AND outcome = 'done'`, [objectId]);
    return r && r.at ? r.at : null;
}

/** Why the class's minimum residency (media.storage_policy) holds this object where it is, or null. */
async function residencyRefusal(obj, cls, action, now) {
    const { minResidencyMs } = storagePolicy.settings().classes[cls];
    if (!minResidencyMs) return null;
    const lastAt = await lastMovedAt(obj.id);
    if (storagePolicy.mayMove({ class: cls, lastMovedAt: lastAt, now })) return null;
    return `minimum residency of ${minResidencyMs} ms for class ${cls} (media.storage_policy) not reached since the last move at ${lastAt}; ${action} suppressed`;
}

/** The sweep's Valkey demand reader, or null when Valkey is not configured. read(ids) throws on any failure. */
function valkeyDemand(now) {
    const demand = require('../placement/demand');
    if (!demand.available()) return null;
    return { region: demand.region(), window_s: (demand.WINDOW_BUCKETS * demand.BUCKET_MS) / 1000,
        read: (ids) => demand.hotness({ objectIds: ids, now, strict: true }) };
}

/**
 * Both candidate lists, from one demand source for the whole sweep: Valkey's hourly reads, or (Valkey absent, or a
 * read failed or timed out anywhere in the scan) the daily PostgreSQL counts. Read before anything moves, so a
 * failure part-way never leaves a sweep acting on two signals. → { source, fallback, demote, promote }
 */
async function sweepCandidates(settings, now) {
    const heat = valkeyDemand(now);
    let fallback = heat ? null : 'Valkey is not configured';
    if (heat) {
        try {
            return { source: 'valkey', fallback, demote: await demotionCandidates(settings, { now, demand: heat }),
                promote: await promotionCandidates(settings, { now, limit: SWEEP_KEEP, excludeSandbox: true, demand: heat }) };
        } catch (err) {
            fallback = `Valkey read failed: ${err.message}`;
        }
    }
    return { source: 'pg', fallback, demote: await demotionCandidates(settings, { now }),
        promote: await promotionCandidates(settings, { now, limit: SWEEP_KEEP, excludeSandbox: true }) };
}

/**
 * One pass over native objects. → { gate, demand_source, demand_fallback?, constraints: { promote_gate, refused: { provider, budget },
 * hot_usd_per_month: { <class>: { spend, projected, ceiling } } }, promoted, demoted, would_promote, would_demote, already, refused, failed,
 * repeats, skipped_backoff, candidates: { promote, demote }, rotated, errors }
 */
async function runSweep({ trigger = 'sweep', now = Date.now() } = {}) {
    if (drill.enabled) return { skipped: true, reason: 'restore drill (MEDIA_DRILL)' };
    if (sweepState.running) return { skipped: true, reason: 'already running' };
    sweepState.running = true;
    try {
        const settings = policy.settings();
        const out = { gate: !!settings.active, promoted: 0, demoted: 0, would_promote: 0, would_demote: 0, already: 0, refused: 0, failed: 0,
            repeats: 0, skipped_backoff: 0, candidates: { promote: 0, demote: 0 }, rotated: await popularity.rotate({ now }), errors: [] };

        const picked = await sweepCandidates(settings, now);
        out.demand_source = picked.source;
        if (picked.fallback) {
            out.demand_fallback = picked.fallback;
            console.warn(`[ObjectTiers] Sweep eligibility reads the daily PostgreSQL counts: ${picked.fallback}`);
        }
        require('../placement/metrics-binding').inc('media_sweep_demand_source_total', { source: picked.source });

        // Demotions first: they free the R2 cache, and a deleted object's copy should not wait behind promotions.
        const demote_ = picked.demote;
        out.candidates.demote = demote_.length;
        // Budgets and residency are per class (media.storage_policy); a class spends only its own budget, in the
        // candidates' value-per-dollar order. A refusal (residency, hold) or a back-off spends nothing, so the next
        // in line takes the slot.
        const spent = { promote: {}, demote: {} };
        // A slot is spent by a move, a failed move, a dry run (a repeat of one logged earlier today included: it is only
        // not logged again, and a live sweep would make that move), or a promotion's provider-gate refusal, repeated or not
        // (every promotion relies on R2, so the next in line would be refused for the same reason and a closed R2 costs
        // the class at most its budget of rows). A demotion's gate is the candidate's own canonical provider, so its
        // refusal spends nothing and an object with a healthy canonical copy takes the slot.
        const spends = (r, action) => (action === 'promote' && r.blocked === 'provider') || ['done', 'failed', 'dry_run'].includes(r.outcome);
        const blocked = (r) => { if (r.blocked) out.constraints.refused[r.blocked]++; };
        // The storage ceiling (F2.6): each class's R2 copies at list price. `spend` follows the moves made; `projected`
        // also counts dry runs (the moves the sweep would make), and the ceiling is held against it.
        const spend = await hotSpend();
        const projected = { ...spend };
        const closed = new Set();
        out.constraints = { promote_gate: providers.placementGate('r2', 'online-hot'), refused: { provider: 0, budget: 0 }, hot_usd_per_month: {} };
        const room = (action, cls) => (spent[action][cls] || 0) < storagePolicy.budgetFor(cls)[action === 'promote' ? 'maxPromotionsPerSweep' : 'maxDemotionsPerSweep'];
        for (const { row, reason, class: cls, value_per_dollar: score, demand } of demote_) {
            if (!room('demote', cls)) continue;
            if (await inBackoff(row.id, 'demote')) { out.skipped_backoff++; continue; }
            // A copy of an object that is no longer ready is removed regardless of residency.
            const residency = row.lifecycle_status === 'ready' ? await residencyRefusal(row, cls, 'demote', now) : null;
            const r = await demote(row.id, { trigger, settings, now, residency, valuePerDollar: score, demand,
                reason: `${reason}; ${rankNote(cls, score, (spent.demote[cls] || 0) + 1, 'maxDemotionsPerSweep')}` });
            tally(out, { ...r, action: 'demote' });
            blocked(r);
            if (spends(r, 'demote')) spent.demote[cls] = (spent.demote[cls] || 0) + 1;
            // hotSpend() counted only present copies: a corrupt or pending one leaves the class's spend as it was.
            if (['done', 'dry_run'].includes(r.outcome) && row.r2_state === 'present') {
                const freed = hotUsdPerMonth(row.r2_size_bytes ?? row.size_bytes);
                projected[cls] = Math.max(0, projected[cls] - freed);
                if (r.outcome === 'done') spend[cls] = Math.max(0, spend[cls] - freed);
            }
        }

        // Every eligible candidate is ranked (not a most-viewed prefix); the best SWEEP_KEEP are kept, so no class is crowded out of its budget.
        const promote_ = picked.promote;
        out.candidates.promote = promote_.length;
        for (const c of promote_) {
            const cls = c.class;
            if (!room('promote', cls) || closed.has(cls)) continue;
            if (await inBackoff(c.id, 'promote')) { out.skipped_backoff++; continue; }
            const residency = await residencyRefusal(c, cls, 'promote', now);
            const cost = hotUsdPerMonth(c.size_bytes);
            const ceiling = storagePolicy.hotCeilingFor(cls);
            const usd = projected[cls];
            const budget = { class: cls, usd_per_month: usd, copy_usd_per_month: cost, ceiling };
            // A zero ceiling closes the class even when R2's configured price is zero (every copy would then cost $0).
            const overBudget = ceiling === 0
                ? `class ${cls} has maxHotUsdPerMonth $0 (media.storage_policy): it never promotes; the class promotes nothing more this sweep`
                : ceiling != null && usd + cost > ceiling
                    ? `class ${cls} R2 storage would reach ${fmtUsd(usd + cost)}/month (${fmtUsd(usd)} now + ${fmtUsd(cost)} for this copy) > maxHotUsdPerMonth ${fmtUsd(ceiling)} (media.storage_policy); the class promotes nothing more this sweep`
                    : null;
            const r = await promote(c.id, { trigger, reason: promoteReason(c, settings, (spent.promote[cls] || 0) + 1), settings, now, residency, valuePerDollar: c.value_per_dollar,
                demand: c.demand, budget, overBudget, pop: picked.source === 'pg' ? { unique_viewers: c.unique_viewers_7d, last_viewed_day: c.last_viewed_day } : undefined });
            tally(out, { ...r, action: 'promote' });
            blocked(r);
            if (r.blocked === 'budget') closed.add(cls);
            if (spends(r, 'promote')) spent.promote[cls] = (spent.promote[cls] || 0) + 1;
            if (['done', 'dry_run'].includes(r.outcome)) projected[cls] += cost;
            if (r.outcome === 'done') spend[cls] += cost;
        }
        for (const cls of storagePolicy.CLASSES) {
            out.constraints.hot_usd_per_month[cls] = { spend: spend[cls], projected: projected[cls], ceiling: storagePolicy.hotCeilingFor(cls) };
        }

        // Demand (F2.4): stage media.object.hot for objects over the hourly read threshold.
        out.demand = await require('../placement/demand').rollup({ now });

        if (out.promoted || out.demoted || out.failed) {
            console.log(`[ObjectTiers] Sweep: ${out.promoted} promoted to R2, ${out.demoted} demoted, ${out.failed} failed, ${out.refused} refused`);
        }
        if (!out.errors.length) delete out.errors;
        out.timestamp = new Date(now).toISOString();
        sweepState.lastRunAt = Date.now();
        sweepState.lastResult = out;
        return out;
    } catch (err) {
        console.error('[ObjectTiers] Sweep error:', err.message);
        return { error: err.message };
    } finally {
        sweepState.running = false;
    }
}

// ── Operator views ───────────────────────────────────────────

function decisionPublic(r) {
    const parse = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
    return {
        id: r.id, decided_at: r.decided_at, object_id: r.object_id, app_id: r.app_id || null, action: r.action,
        from_provider: r.from_provider, to_provider: r.to_provider, outcome: r.outcome, trigger: r.trigger, reason: r.reason,
        inputs: parse(r.inputs), thresholds: parse(r.thresholds), error: r.error || null,
    };
}

/** Decisions of the last 24 hours by action and outcome (appId narrows them). */
async function counts24h(appId = null) {
    const empty = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    const out = { promote: empty(), demote: empty() };
    for (const r of await db.all(`SELECT action, outcome, COUNT(*) AS n FROM media_object_tier_decisions
                            WHERE decided_at >= ov_now_iso('-1 day')${appId ? ' AND app_id = ?' : ''} GROUP BY action, outcome`, appId ? [appId] : [])) {
        if (out[r.action]) out[r.action][r.outcome] = r.n;
    }
    return out;
}

/** A page of decisions, newest first: { decisions, next_before_id }. */
async function listDecisions({ appId = null, objectId = null, action = null, outcome = null, beforeId = null, limit = 50 } = {}) {
    const conds = ['1 = 1'], params = [];
    if (appId) { conds.push('app_id = ?'); params.push(appId); }
    if (objectId) { conds.push('object_id = ?'); params.push(objectId); }
    if (action) { conds.push('action = ?'); params.push(action); }
    if (outcome) { conds.push('outcome = ?'); params.push(outcome); }
    if (beforeId != null) { conds.push('id < ?'); params.push(Number(beforeId) || 0); }
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const rows = await db.all(`SELECT * FROM media_object_tier_decisions WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, n + 1]);
    const page = rows.slice(0, n);
    return { decisions: page.map(decisionPublic), next_before_id: rows.length > n ? page[page.length - 1].id : null, limit: n };
}

/** The operator views' part (server/me/ops.js): database only, no provider or file. */
async function report({ appId = null, limit = 20 } = {}) {
    const settings = policy.settings();
    const s = appId ? { sql: ' AND o.app_id = ?', params: [appId] } : { sql: '', params: [] };
    const r2 = await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(o.size_bytes), 0)::bigint AS b FROM media_locations l JOIN media_objects o ON o.id = l.object_id
                       WHERE l.provider = 'r2' AND o.legacy_ref IS NULL AND l.state = 'present'${s.sql}`, s.params);
    let eligible = 0;
    for (const c of await promotionCandidates(settings, { appId, limit: 100000 })) if (!await db.isSandboxTenant(c.app_id)) eligible++;
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const last = sweepState.lastResult;
    return {
        gate: { active: !!settings.active, source: policy.thresholds(settings).active.source },
        policy: Object.fromEntries(Object.keys(policy.DEFAULTS).filter((k) => k !== 'active').map((k) => [k, settings[k]])),
        r2_copies: { count: r2.n, bytes: r2.b },
        eligible_to_promote: eligible,
        decisions_24h: await counts24h(appId),
        recent: (await listDecisions({ appId, limit: n })).decisions.map((d) => ({ id: d.id, decided_at: d.decided_at, app_id: d.app_id, object_id: d.object_id,
            action: d.action, outcome: d.outcome, trigger: d.trigger, reason: String(d.reason || '').slice(0, 300), error: d.error ? String(d.error).slice(0, 300) : null })),
        sweep: {
            last_run_at: sweepState.lastRunAt ? new Date(sweepState.lastRunAt).toISOString() : null,
            last_result: last ? { gate: last.gate, promoted: last.promoted, demoted: last.demoted, would_promote: last.would_promote, would_demote: last.would_demote,
                refused: last.refused, failed: last.failed, error: last.error || null } : null,
        },
    };
}

module.exports = {
    FAILED_BACKOFF_H, OUTCOMES, hotSpend, hotUsdPerMonth,
    runSweep, promote, demote, candidates, promotionCandidates, demotionCandidates,
    canonicalUnverified, confirmCanonical, r2KeyFor,
    counts24h, listDecisions, decisionPublic, report,
};
