'use strict';
/**
 * OpenVibe.Media — canonical object owners (roadmap D01/D20; docs/object-model.md#owner-subjects).
 *
 * Every media_object should name its owner as a Network subject (owner_subject, usr_<ULID>), so no
 * consumer (Live's lineage resolver, Search, Community) has to translate an app's own user ids.
 * An object created through the v2 API with X-OV-Subject has one from the start. Everything else
 * carries only owner_app + owner_user_id, an id in that app's own user space: the projected vods,
 * clips, files, screenshots, avatars and thumbnails, and v2 uploads that name only user_id.
 *
 * This module fills owner_subject from Network's identity_legacy_map through
 * POST /internal/identity/resolve-batch { system, type: 'user', ids } (at most 500 ids per call).
 * It backs scripts/backfill-owner-subject.js (the one-off backfill, which writes a rollback file)
 * and the reconcile job the service runs every MEDIA_OWNER_SUBJECT_INTERVAL_MIN minutes, which
 * gives objects created since then their subject.
 *
 * Rules:
 *   - a non-null owner_subject is never overwritten. Every UPDATE is guarded by owner_subject IS NULL
 *     and by the owner it was resolved for (owner_app, owner_user_id), so a concurrent change wins;
 *   - an id Network does not know stays NULL and is reported; nothing is guessed;
 *   - only the tenants in SOURCE_SYSTEMS are resolved, because the system names the user-id space.
 *
 * Network is asked with a service token (capability identity.subject.resolve, audience
 * openvibe.network; OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET). When no token can be had
 * (a Network that has not granted it yet), it falls back to INTERNAL_API_KEY.
 */
const { ids, serviceAuth } = require('openvibe-contracts');
const config = require('../config');

// Tenant -> the Network source system its owner_user_id values belong to (identity_legacy_map.source_system).
// Only Live stores app-local user ids here: Tools and developer-project uploads name their owner in
// X-OV-Subject, and Community's files carry no owner. A tenant missing here is reported, never guessed.
const SOURCE_SYSTEMS = Object.freeze({ live: 'live' });
const MAX_IDS_PER_CALL = 500;
const DEFAULT_BATCH = 500;
const TOKEN_RETRY_MS = 10 * 60 * 1000;

const isUserSubject = (s) => typeof s === 'string' && ids.isSubjectId('user', s);
const ownerKey = (app, userId) => `${app}\u0000${userId}`;

/**
 * Network resolver. resolve(system, ids) -> Map<String(id), 'usr_…' | null> (null = Network does not
 * know that id). Throws when Network cannot be asked or answers with an error, so a caller can tell
 * "unresolvable" from "unavailable".
 */
function createResolver({
    networkUrl = config.network.internalUrl,
    internalKey = config.network.internalApiKey,
    clientId = process.env.OV_OAUTH_CLIENT_ID || 'media',
    clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '',
    fetchImpl = globalThis.fetch,
    timeoutMs = 10000,
} = {}) {
    const base = String(networkUrl || '').replace(/\/+$/, '');
    const tokens = clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId, clientSecret, audience: 'openvibe.network',
        scope: 'identity.subject.resolve', fetchImpl, timeoutMs,
    }) : null;
    let tokenRetryAt = 0;
    const state = { via: null, token_error: null, calls: 0 };

    async function credential() {
        if (tokens && Date.now() >= tokenRetryAt) {
            try { return { via: 'service-token', headers: await tokens.authHeaders() }; } catch (err) {
                state.token_error = err.message;
                tokenRetryAt = Date.now() + TOKEN_RETRY_MS;
            }
        }
        if (internalKey) return { via: 'internal-key', headers: { 'X-Internal-Key': internalKey } };
        throw new Error(tokens
            ? `no service token for identity.subject.resolve (${state.token_error}) and no INTERNAL_API_KEY`
            : 'set OV_OAUTH_CLIENT_SECRET (service token) or INTERNAL_API_KEY to ask Network');
    }

    async function send(cred, payload) {
        state.calls++;
        let res;
        try {
            res = await fetchImpl(`${base}/internal/identity/resolve-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...cred.headers },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new Error(`Network unreachable at ${base}: ${err.message}`);
        }
        return res;
    }

    async function post(payload) {
        let cred = await credential();
        let res = await send(cred, payload);
        if ((res.status === 401 || res.status === 403) && cred.via === 'service-token' && internalKey) {
            // A token Network refuses here (grant withdrawn, key rotated): the key, and no token for a while.
            tokens.invalidate();
            tokenRetryAt = Date.now() + TOKEN_RETRY_MS;
            state.token_error = `resolve-batch refused the token (${res.status})`;
            cred = { via: 'internal-key', headers: { 'X-Internal-Key': internalKey } };
            res = await send(cred, payload);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.results !== 'object' || body.results === null) {
            throw new Error(`Network resolve-batch ${res.status}: ${(body && (body.detail || body.error || body.title)) || 'unexpected answer'}`);
        }
        state.via = cred.via;
        return body.results;
    }

    async function resolve(system, idList) {
        const out = new Map();
        const list = [...new Set(idList.map(String))];
        for (let i = 0; i < list.length; i += MAX_IDS_PER_CALL) {
            const chunk = list.slice(i, i + MAX_IDS_PER_CALL);
            const results = await post({ system, type: 'user', ids: chunk });
            for (const id of chunk) {
                const p = results[id];
                const sid = p && p.subject && p.subject.type === 'user' ? p.subject.id : null;
                out.set(id, isUserSubject(sid) ? sid : null);
            }
        }
        return out;
    }

    return { resolve, state };
}

// ── Reads ────────────────────────────────────────────────────

/** Per-tenant ownership counts (read-only). */
function summary(sqlite) {
    const rows = sqlite.prepare(`
        SELECT app_id, count(*) AS objects,
               sum(owner_subject IS NOT NULL) AS already_set,
               sum(owner_subject IS NULL AND owner_user_id IS NOT NULL) AS missing,
               sum(owner_subject IS NULL AND owner_user_id IS NULL) AS no_owner
        FROM media_objects GROUP BY app_id ORDER BY app_id`).all();
    const out = {};
    for (const r of rows) out[r.app_id] = { objects: r.objects, already_set: r.already_set || 0, missing: r.missing || 0, no_owner: r.no_owner || 0 };
    return out;
}

/** Distinct (owner_app, owner_user_id) pairs that still lack a subject, with their object counts. */
function pendingOwners(sqlite) {
    return sqlite.prepare(`
        SELECT COALESCE(owner_app, app_id) AS owner_app, owner_user_id, count(*) AS objects
        FROM media_objects WHERE owner_subject IS NULL AND owner_user_id IS NOT NULL
        GROUP BY COALESCE(owner_app, app_id), owner_user_id ORDER BY 1, 2`).all();
}

/**
 * Resolve owners through Network, grouped by source system.
 * -> { subjects: Map<ownerKey, 'usr_…'>, unresolvable: [owner], unsupported: [owner] }
 */
async function resolveOwners(owners, { resolver }) {
    const subjects = new Map();
    const unresolvable = [], unsupported = [];
    const bySystem = new Map();
    for (const o of owners) {
        const system = Object.prototype.hasOwnProperty.call(SOURCE_SYSTEMS, o.owner_app) ? SOURCE_SYSTEMS[o.owner_app] : null;
        if (!system) { unsupported.push(o); continue; }
        if (!bySystem.has(system)) bySystem.set(system, []);
        bySystem.get(system).push(o);
    }
    for (const [system, list] of bySystem) {
        const got = await resolver.resolve(system, list.map(o => String(o.owner_user_id)));
        for (const o of list) {
            const sid = got.get(String(o.owner_user_id));
            if (sid) subjects.set(ownerKey(o.owner_app, o.owner_user_id), sid);
            else unresolvable.push(o);
        }
    }
    return { subjects, unresolvable, unsupported };
}

/**
 * The rows the resolved subjects fill, read in id order `batch` at a time.
 * -> [{ id, app_id, owner_app, owner_user_id, owner_subject }]
 */
function planChanges(sqlite, subjects, { batch = DEFAULT_BATCH } = {}) {
    const page = sqlite.prepare(`
        SELECT id, app_id, COALESCE(owner_app, app_id) AS owner_app, owner_user_id FROM media_objects
        WHERE owner_subject IS NULL AND owner_user_id IS NOT NULL AND id > ? ORDER BY id LIMIT ?`);
    const changes = [];
    let after = '';
    for (;;) {
        const rows = page.all(after, batch);
        if (!rows.length) break;
        for (const r of rows) {
            const sid = subjects.get(ownerKey(r.owner_app, r.owner_user_id));
            if (sid) changes.push({ id: r.id, app_id: r.app_id, owner_app: r.owner_app, owner_user_id: r.owner_user_id, owner_subject: sid });
        }
        after = rows[rows.length - 1].id;
    }
    return changes;
}

// ── Writes ───────────────────────────────────────────────────

/**
 * Fill owner_subject on the planned rows, one transaction per `batch` rows. A row is written only if
 * it still has no subject and the same owner. -> { applied: [change], skipped: [change], batches }
 */
function applyChanges(sqlite, changes, { batch = DEFAULT_BATCH, onBatch = null } = {}) {
    const set = sqlite.prepare(`
        UPDATE media_objects SET owner_subject = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_subject IS NULL AND COALESCE(owner_app, app_id) = ? AND owner_user_id = ?`);
    const applied = [], skipped = [];
    let batches = 0;
    for (let i = 0; i < changes.length; i += batch) {
        const slice = changes.slice(i, i + batch);
        sqlite.transaction(() => {
            for (const c of slice) (set.run(c.owner_subject, c.id, c.owner_app, c.owner_user_id).changes ? applied : skipped).push(c);
        })();
        batches++;
        if (onBatch) onBatch({ batch: batches, rows: slice.length, applied: applied.length, skipped: skipped.length });
    }
    return { applied, skipped, batches };
}

/**
 * Undo a backfill: clear owner_subject on each listed row that still carries exactly the subject the
 * backfill wrote for the same owner. A row changed since (another subject, another owner) is left
 * alone and counted. With apply=false nothing is written.
 * -> { restored, changed_since, missing, rows: { restored: [id], changed_since: [id], missing: [id] } }
 */
function rollbackChanges(sqlite, entries, { apply = false, batch = DEFAULT_BATCH } = {}) {
    const get = sqlite.prepare('SELECT id, owner_subject, COALESCE(owner_app, app_id) AS owner_app, owner_user_id FROM media_objects WHERE id = ?');
    const clear = sqlite.prepare(`
        UPDATE media_objects SET owner_subject = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_subject = ? AND COALESCE(owner_app, app_id) = ? AND owner_user_id = ?`);
    const rows = { restored: [], changed_since: [], missing: [] };
    const unchanged = (row, e) => row.owner_subject === e.owner_subject && row.owner_app === e.owner_app && Number(row.owner_user_id) === Number(e.owner_user_id);
    for (let i = 0; i < entries.length; i += batch) {
        const slice = entries.slice(i, i + batch);
        sqlite.transaction(() => {
            for (const e of slice) {
                const row = get.get(e.id);
                if (!row) { rows.missing.push(e.id); continue; }
                if (!unchanged(row, e)) { rows.changed_since.push(e.id); continue; }
                if (apply && !clear.run(e.id, e.owner_subject, e.owner_app, e.owner_user_id).changes) { rows.changed_since.push(e.id); continue; }
                rows.restored.push(e.id);
            }
        })();
    }
    return { restored: rows.restored.length, changed_since: rows.changed_since.length, missing: rows.missing.length, rows };
}

/**
 * One reconcile pass (the service's job): resolve every owner still lacking a subject and fill their
 * objects. -> { owners, filled, skipped, unresolvable, unsupported, via }
 */
async function reconcileOnce(sqlite, { resolver, batch = DEFAULT_BATCH } = {}) {
    const owners = pendingOwners(sqlite);
    const out = { owners: owners.length, filled: 0, skipped: 0, unresolvable: 0, unsupported: 0, via: null };
    if (!owners.length) return out;
    const callsBefore = resolver.state ? resolver.state.calls : 0;
    const r = await resolveOwners(owners, { resolver });
    out.unresolvable = r.unresolvable.reduce((n, o) => n + o.objects, 0);
    out.unsupported = r.unsupported.reduce((n, o) => n + o.objects, 0);
    out.via = resolver.state && resolver.state.calls > callsBefore ? resolver.state.via : null;
    if (!r.subjects.size) return out;
    const applied = applyChanges(sqlite, planChanges(sqlite, r.subjects, { batch }), { batch });
    out.filled = applied.applied.length;
    out.skipped = applied.skipped.length;
    return out;
}

module.exports = {
    SOURCE_SYSTEMS, MAX_IDS_PER_CALL, DEFAULT_BATCH,
    createResolver, summary, pendingOwners, resolveOwners, planChanges, applyChanges, rollbackChanges, reconcileOnce,
    isUserSubject, ownerKey,
};
