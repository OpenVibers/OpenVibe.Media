/**
 * OpenVibe.Media — tiering of native v2 objects (roadmap WS-G task 11; docs/object-model.md#tiering-of-native-objects).
 *
 * A native object (uploaded through /api/v2: legacy_ref NULL) keeps its canonical copy where the upload put it
 * (local disk, OBJECTS_PATH; a B2 canonical copy is handled the same way). A popular one also gets a copy in
 * the Cloudflare R2 popularity cache, which becomes its playback source (GET /o/:id redirects there while R2
 * is available; the canonical copy is the fallback), and loses it when it goes idle or stops being ready.
 * Popularity is ./popularity.js (unique viewers per UTC day, no identifiers); the thresholds and the
 * site-level activation gate are the revisioned policy media.object_tier (./tier-policy.js).
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
const popularity = require('./popularity');

const MB = 1024 * 1024;
const FAILED_BACKOFF_H = 6;
const OUTCOMES = ['done', 'already', 'refused', 'failed', 'dry_run'];

const vodStorage = () => require('../vod/vod-storage');
const model = () => require('./model');

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

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO → epoch ms (NaN when unreadable). */
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

// ── Decisions ────────────────────────────────────────────────

function thresholdSnapshot(settings) {
    const out = {};
    for (const [k, t] of Object.entries(policy.thresholds(settings))) out[k] = { value: t.value, source: t.source };
    return out;
}

/** What a decision saw: the object's popularity, size, lifecycle, copies, hold and the gate. */
function inputsOf(obj, { locs, pop, held, settings }) {
    const canon = canonicalLocation(obj, locs);
    const r2 = locs.find((l) => l.provider === 'r2');
    return {
        unique_viewers_7d: pop ? pop.unique_viewers : 0,
        last_viewed_day: pop ? pop.last_viewed_day : popularity.lastViewedDay(obj.id),
        size_bytes: Number(obj.size_bytes) || 0,
        kind: obj.kind, visibility: obj.visibility, lifecycle_status: obj.lifecycle_status,
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
function recordDecision({ obj, action, from, to, outcome, trigger, reason, inputs, settings, error = null }) {
    try {
        return db.run(`INSERT INTO media_object_tier_decisions (object_id, app_id, action, from_provider, to_provider, outcome, trigger, reason, inputs, thresholds, error)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [obj.id, obj.app_id || null, action, from || null, to || null, outcome, String(trigger || 'manual').slice(0, 40), String(reason || '').slice(0, 1000),
            JSON.stringify(inputs || {}), JSON.stringify(thresholdSnapshot(settings)), error == null ? null : String(error).slice(0, 500)]).lastInsertRowid;
    } catch (err) {
        console.warn(`[ObjectTiers] decision for ${obj && obj.id} not logged: ${err.message}`);
        return null;
    }
}

/** The sweep logged the same outcome for this object and action within the last day. */
function loggedToday(objectId, action, outcome) {
    return !!db.get(`SELECT 1 AS x FROM media_object_tier_decisions WHERE object_id = ? AND action = ? AND outcome = ? AND trigger = 'sweep'
                     AND decided_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') LIMIT 1`, [objectId, action, outcome]);
}

/** A move of this object failed within the back-off window. */
function inBackoff(objectId, action) {
    return !!db.get(`SELECT 1 AS x FROM media_object_tier_decisions WHERE object_id = ? AND action = ? AND outcome = 'failed'
                     AND decided_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) LIMIT 1`, [objectId, action, `-${FAILED_BACKOFF_H} hours`]);
}

/**
 * Shared frame of promote()/demote(): loads the object and its facts, and returns log(outcome, reason, extra)
 * which records the decision (the sweep's repeated refusals and dry runs once a day) and shapes the answer.
 */
function frame(objectId, action, ctx) {
    const settings = ctx.settings || policy.settings();
    const obj = model().getObject(String(objectId || ''));
    if (!obj) return { missing: true };
    const locs = model().listLocations(obj.id);
    const pop = ctx.pop !== undefined ? ctx.pop : (popularity.stats({ ids: [obj.id], now: ctx.now }).get(obj.id) || null);
    const held = model().isHeld(obj.id);
    const inputs = inputsOf(obj, { locs, pop, held, settings });
    const canon = canonicalLocation(obj, locs);
    const trigger = ctx.trigger || 'manual';
    const why = ctx.reason || 'requested';
    const from = action === 'promote' ? (canon ? canon.provider : null) : 'r2';
    const to = action === 'promote' ? 'r2' : (canon ? canon.provider : null);
    const log = (outcome, reason, extra = {}) => {
        const repeat = trigger === 'sweep' && (outcome === 'refused' || outcome === 'dry_run') && loggedToday(obj.id, action, outcome);
        if (!repeat) recordDecision({ obj, action, from, to, outcome, trigger, reason, inputs, settings, error: extra.error });
        return { ok: outcome === 'done' || outcome === 'already', outcome, object_id: obj.id, repeat, ...extra };
    };
    return { obj, locs, canon, held, settings, why, log };
}

/** Why an object may not be promoted at all, from the record (no I/O), or null. */
function promoteRefusal(obj, { locs, held }) {
    if (held) return 'under a retention hold (a hold freezes placement)';
    if (obj.legacy_ref) return 'not a native object (projected objects tier with their VOD)';
    if (obj.lifecycle_status !== 'ready') return `the object is ${obj.lifecycle_status}`;
    if (db.isSandboxTenant(obj.app_id)) return 'developer sandbox objects are never tiered';
    return canonicalUnverified(obj, locs);
}

// ── Moves ────────────────────────────────────────────────────

/**
 * Promote one native object to the R2 popularity cache and log the decision. ctx { trigger, reason, settings, pop }.
 * → { ok, outcome: done | already | refused | failed | dry_run, error?, bytes? }
 */
async function promote(objectId, ctx = {}) {
    const f = frame(objectId, 'promote', ctx);
    if (f.missing) return { ok: false, outcome: 'refused', error: 'object not found' };
    const { obj, locs, canon, held, settings, why, log } = f;
    if (held) return log('refused', `${why}; refused: under a retention hold (a hold freezes placement)`, { error: 'held', held: true });
    const r2Now = locs.find((l) => l.provider === 'r2');
    if (r2Now && r2Now.state === 'present' && r2Now.verified_at) return log('already', `${why}; the R2 copy is already present`);
    const refusal = promoteRefusal(obj, { locs, held });
    if (refusal) return log('refused', `${why}; refused: ${refusal}`, { error: refusal });
    const vs = vodStorage();
    if (!settings.active) return log('dry_run', `gate off (active = false): would promote: ${why}${vs.providerAvailable('r2') ? '' : ' (R2 is not available now)'}`);
    if (!vs.providerAvailable('r2')) return log('refused', `${why}; refused: R2 is not available`, { error: 'R2 not available' });

    const check = await confirmCanonical(obj, canon);
    if (!check.ok) return log('refused', `${why}; refused: ${check.why}`, { error: check.why });
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
        return log('failed', `${why}; the copy to R2 did not verify`, { error: err.message });
    }

    // A hold placed (or a delete made) while the bytes were copied wins: the new copy was never recorded, so
    // removing it moves nothing anyone could see.
    const now = model().getObject(obj.id);
    if (!now || model().isHeld(obj.id) || now.lifecycle_status !== 'ready') {
        await vs.deleteObject('r2', key).catch(() => {});
        return log('refused', `${why}; refused: the object was ${!now ? 'removed' : now.lifecycle_status !== 'ready' ? now.lifecycle_status : 'put under a hold'} during the copy (the copy was removed)`,
            { error: 'changed during the copy' });
    }
    db.getDb().transaction(() => {
        // A fresh row: its created_at is when the object entered R2 (the demotion's "in R2 at least that long").
        db.run("DELETE FROM media_locations WHERE object_id = ? AND provider = 'r2'", [obj.id]);
        model().upsertLocation(obj.id, { provider: 'r2', bucket: vs.bucketFor('r2'), key, storage_class: 'cache', state: 'present',
            checksum: obj.content_hash, size_bytes: size, verified: true });
        model().setLocationState(canon.id, { state: 'present', size_bytes: size });
    })();
    console.log(`[ObjectTiers] ${obj.id} (${obj.app_id}) promoted to R2: ${key} (${(size / MB).toFixed(1)} MB)`);
    return log('done', why, { bytes: size });
}

/**
 * Demote one native object from the R2 popularity cache (its R2 copy is deleted) and log the decision.
 * ctx as for promote(). → { ok, outcome, error? }
 */
async function demote(objectId, ctx = {}) {
    const f = frame(objectId, 'demote', ctx);
    if (f.missing) return { ok: false, outcome: 'refused', error: 'object not found' };
    const { obj, locs, canon, held, settings, why, log } = f;
    if (held) return log('refused', `${why}; refused: under a retention hold (a hold freezes placement)`, { error: 'held', held: true });
    const r2 = locs.find((l) => l.provider === 'r2');
    if (!r2) return log('already', `${why}; there is no R2 copy`);
    const vs = vodStorage();
    if (!settings.active) return log('dry_run', `gate off (active = false): would demote: ${why}`);
    if (!vs.providerConfigured('r2')) return log('refused', `${why}; refused: R2 is not configured`, { error: 'R2 not configured' });
    if (!canon || canon.provider === 'r2') return log('refused', `${why}; refused: no canonical copy besides R2 (the R2 copy is kept)`, { error: 'no canonical copy' });

    // The last good copy is never the one removed: the canonical copy must check out now.
    const check = await confirmCanonical(obj, canon);
    if (!check.ok) return log('refused', `${why}; refused: ${check.why}; the R2 copy is kept (it may be the last good copy)`, { error: check.why });
    try {
        await vs.deleteObject('r2', r2.key);
        const still = await vs.headObject('r2', r2.key);
        if (still) throw new Error('the R2 copy is still there after the delete');
    } catch (err) {
        return log('failed', `${why}; the R2 copy could not be removed`, { error: err.message });
    }
    db.getDb().transaction(() => {
        db.run('DELETE FROM media_locations WHERE id = ?', [r2.id]);
        model().setLocationState(canon.id, { state: 'present', size_bytes: Number(obj.size_bytes) });
    })();
    console.log(`[ObjectTiers] ${obj.id} (${obj.app_id}) demoted from R2 (${why})`);
    return log('done', why);
}

// ── Candidates ───────────────────────────────────────────────

/** Ready native objects that pass the popularity, recency and size thresholds and have no R2 copy yet, most viewed first. */
function promotionCandidates(settings, { now = Date.now(), appId = null, limit = 200 } = {}) {
    const today = popularity.dayOf(now);
    return db.all(`SELECT o.*, p.viewers AS unique_viewers_7d, p.last_day AS last_viewed_day
        FROM (SELECT object_id, SUM(unique_viewers) AS viewers, MAX(day) AS last_day FROM media_object_views_daily
              WHERE day >= ? AND unique_viewers > 0 GROUP BY object_id) p
        JOIN media_objects o ON o.id = p.object_id
        WHERE o.legacy_ref IS NULL AND o.lifecycle_status = 'ready'
          AND p.viewers >= ? AND p.last_day >= ? AND o.size_bytes >= ? AND o.size_bytes <= ?
          AND NOT EXISTS (SELECT 1 FROM media_locations l WHERE l.object_id = o.id AND l.provider = 'r2' AND l.state = 'present')${appId ? ' AND o.app_id = ?' : ''}
        ORDER BY p.viewers DESC, o.id LIMIT ?`,
    [popularity.windowStart(today, popularity.WINDOW_DAYS), settings.promoteMinUniqueViewers7d, popularity.windowStart(today, settings.promoteRecentAccessDays),
        Math.ceil(settings.promoteMinSizeMb * MB), Math.floor(settings.promoteMaxSizeMb * MB), ...(appId ? [appId] : []), limit]);
}

/** Native objects with an R2 copy that should lose it: not ready any more, or idle. → [{ obj row, reason }] */
function demotionCandidates(settings, { now = Date.now(), appId = null } = {}) {
    const idleFrom = popularity.windowStart(popularity.dayOf(now), settings.demoteIdleDays);
    const rows = db.all(`SELECT o.*, l.created_at AS r2_since,
                (SELECT MAX(d.day) FROM media_object_views_daily d WHERE d.object_id = o.id AND d.unique_viewers > 0) AS last_viewed_day
            FROM media_locations l JOIN media_objects o ON o.id = l.object_id
            WHERE l.provider = 'r2' AND o.legacy_ref IS NULL${appId ? ' AND o.app_id = ?' : ''}
            ORDER BY (o.lifecycle_status = 'ready'), o.id`, appId ? [appId] : []);
    const out = [];
    for (const r of rows) {
        if (r.lifecycle_status !== 'ready') { out.push({ row: r, reason: `the object is ${r.lifecycle_status}` }); continue; }
        const idle = !r.last_viewed_day || r.last_viewed_day < idleFrom;
        const since = msOf(r.r2_since);
        const settled = !Number.isFinite(since) || now - since >= settings.demoteIdleDays * 864e5;
        if (idle && settled) {
            out.push({ row: r, reason: `no viewer since ${r.last_viewed_day || 'the kept counts began'} (idle for demoteIdleDays ${settings.demoteIdleDays}); in R2 since ${r.r2_since || 'unknown'}` });
        }
    }
    return out;
}

function promoteReason(c, s) {
    return `${c.unique_viewers_7d} unique viewers in 7 days >= promoteMinUniqueViewers7d ${s.promoteMinUniqueViewers7d}; last viewed ${c.last_viewed_day} `
        + `(within promoteRecentAccessDays ${s.promoteRecentAccessDays}); ${(Number(c.size_bytes) / MB).toFixed(1)} MB (promoteMinSizeMb ${s.promoteMinSizeMb} to promoteMaxSizeMb ${s.promoteMaxSizeMb})`;
}

/** What the policy would promote now, each with what (on record) would refuse it; database only. */
function candidates({ appId = null, limit = 20, now = Date.now(), settings = policy.settings() } = {}) {
    return promotionCandidates(settings, { now, appId, limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200) }).map((c) => ({
        object_id: c.id, app_id: c.app_id, kind: c.kind, size_bytes: c.size_bytes, unique_viewers_7d: c.unique_viewers_7d, last_viewed_day: c.last_viewed_day,
        blocked_by: promoteRefusal(c, { locs: model().listLocations(c.id), held: model().isHeld(c.id) }),
    }));
}

// ── The sweep ────────────────────────────────────────────────

function tally(out, r) {
    if (r.repeat) out.repeats++;
    else if (r.outcome === 'done') out[r.action === 'demote' ? 'demoted' : 'promoted']++;
    else if (r.outcome === 'dry_run') out[r.action === 'demote' ? 'would_demote' : 'would_promote']++;
    else out[r.outcome] = (out[r.outcome] || 0) + 1;
    if (r.outcome === 'failed') out.errors.push({ object_id: r.object_id, action: r.action, error: r.error });
}

/**
 * One pass over native objects. → { gate, promoted, demoted, would_promote, would_demote, already, refused, failed,
 * repeats, skipped_backoff, candidates: { promote, demote }, rotated, errors }
 */
async function runSweep({ trigger = 'sweep', now = Date.now() } = {}) {
    if (drill.enabled) return { skipped: true, reason: 'restore drill (MEDIA_DRILL)' };
    if (sweepState.running) return { skipped: true, reason: 'already running' };
    sweepState.running = true;
    try {
        const settings = policy.settings();
        const out = { gate: !!settings.active, promoted: 0, demoted: 0, would_promote: 0, would_demote: 0, already: 0, refused: 0, failed: 0,
            repeats: 0, skipped_backoff: 0, candidates: { promote: 0, demote: 0 }, rotated: popularity.rotate({ now }), errors: [] };

        // Demotions first: they free the R2 cache, and a deleted object's copy should not wait behind promotions.
        const demote_ = demotionCandidates(settings, { now });
        out.candidates.demote = demote_.length;
        let budget = settings.maxDemotionsPerSweep;
        for (const { row, reason } of demote_) {
            if (budget <= 0) break;
            if (inBackoff(row.id, 'demote')) { out.skipped_backoff++; continue; }
            const r = await demote(row.id, { trigger, reason, settings, now });
            tally(out, { ...r, action: 'demote' });
            if (!r.repeat && ['done', 'failed', 'dry_run'].includes(r.outcome)) budget--;
        }

        const promote_ = promotionCandidates(settings, { now, limit: Math.max(50, settings.maxPromotionsPerSweep * 10) })
            .filter((c) => !db.isSandboxTenant(c.app_id));
        out.candidates.promote = promote_.length;
        budget = settings.maxPromotionsPerSweep;
        for (const c of promote_) {
            if (budget <= 0) break;
            if (inBackoff(c.id, 'promote')) { out.skipped_backoff++; continue; }
            const r = await promote(c.id, { trigger, reason: promoteReason(c, settings), settings, now,
                pop: { unique_viewers: c.unique_viewers_7d, last_viewed_day: c.last_viewed_day } });
            tally(out, { ...r, action: 'promote' });
            if (!r.repeat && ['done', 'failed', 'dry_run'].includes(r.outcome)) budget--;
        }

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
function counts24h(appId = null) {
    const empty = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    const out = { promote: empty(), demote: empty() };
    for (const r of db.all(`SELECT action, outcome, COUNT(*) AS n FROM media_object_tier_decisions
                            WHERE decided_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')${appId ? ' AND app_id = ?' : ''} GROUP BY action, outcome`, appId ? [appId] : [])) {
        if (out[r.action]) out[r.action][r.outcome] = r.n;
    }
    return out;
}

/** A page of decisions, newest first: { decisions, next_before_id }. */
function listDecisions({ appId = null, objectId = null, action = null, outcome = null, beforeId = null, limit = 50 } = {}) {
    const conds = ['1 = 1'], params = [];
    if (appId) { conds.push('app_id = ?'); params.push(appId); }
    if (objectId) { conds.push('object_id = ?'); params.push(objectId); }
    if (action) { conds.push('action = ?'); params.push(action); }
    if (outcome) { conds.push('outcome = ?'); params.push(outcome); }
    if (beforeId != null) { conds.push('id < ?'); params.push(Number(beforeId) || 0); }
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const rows = db.all(`SELECT * FROM media_object_tier_decisions WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, n + 1]);
    const page = rows.slice(0, n);
    return { decisions: page.map(decisionPublic), next_before_id: rows.length > n ? page[page.length - 1].id : null, limit: n };
}

/** The operator views' part (server/me/ops.js): database only, no provider or file. */
function report({ appId = null, limit = 20 } = {}) {
    const settings = policy.settings();
    const s = appId ? { sql: ' AND o.app_id = ?', params: [appId] } : { sql: '', params: [] };
    const r2 = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(o.size_bytes), 0) AS b FROM media_locations l JOIN media_objects o ON o.id = l.object_id
                       WHERE l.provider = 'r2' AND o.legacy_ref IS NULL AND l.state = 'present'${s.sql}`, s.params);
    const eligible = promotionCandidates(settings, { appId, limit: 100000 }).filter((c) => !db.isSandboxTenant(c.app_id)).length;
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const last = sweepState.lastResult;
    return {
        gate: { active: !!settings.active, source: policy.thresholds(settings).active.source },
        policy: Object.fromEntries(Object.keys(policy.DEFAULTS).filter((k) => k !== 'active').map((k) => [k, settings[k]])),
        r2_copies: { count: r2.n, bytes: r2.b },
        eligible_to_promote: eligible,
        decisions_24h: counts24h(appId),
        recent: listDecisions({ appId, limit: n }).decisions.map((d) => ({ id: d.id, decided_at: d.decided_at, app_id: d.app_id, object_id: d.object_id,
            action: d.action, outcome: d.outcome, trigger: d.trigger, reason: String(d.reason || '').slice(0, 300), error: d.error ? String(d.error).slice(0, 300) : null })),
        sweep: {
            last_run_at: sweepState.lastRunAt ? new Date(sweepState.lastRunAt).toISOString() : null,
            last_result: last ? { gate: last.gate, promoted: last.promoted, demoted: last.demoted, would_promote: last.would_promote, would_demote: last.would_demote,
                refused: last.refused, failed: last.failed, error: last.error || null } : null,
        },
    };
}

module.exports = {
    FAILED_BACKOFF_H, OUTCOMES,
    runSweep, promote, demote, candidates, promotionCandidates, demotionCandidates,
    canonicalUnverified, confirmCanonical, r2KeyFor,
    counts24h, listDecisions, decisionPublic, report,
};
