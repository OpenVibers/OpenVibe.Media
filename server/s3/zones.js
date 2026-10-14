'use strict';
/**
 * Media's projection of OpenVibe.Zone's zones (ADR-031 amendment 2026-10-02). Zone owns the record; it pushes every
 * change here with a higher revision (PUT /internal/zones/:id, server/s3/admin-routes.js), and Media uses the
 * projection to resolve S3 bucket names, enforce a zone's byte ceiling (its namespace row's quota_bytes, checked with
 * the environment's by objects/namespaces.checkQuota) and refuse requests to a zone that is going away.
 *
 *   provision(record)       → { applied, zone }   (checkObjectZone first; a lower or equal revision changes nothing)
 *   byName(projectId, env, name) / byId(id) / listActive(projectId, env)
 *   status(zone)            → { stored_bytes, objects, objects_remaining, held_objects, as_of }
 *   sweepDeleting()         → tombstones and purges what deleting zones still hold (the job runs it every minute)
 *   objectScope(zone, app)  → { where, args }: the SQL condition for the objects of a zone
 *
 * A zone's namespace is `<environment root>.<zone id>`; the default zone is the environment root itself and holds
 * every object of the environment that is not in a named zone (children included, legacy layouts unchanged).
 */
const { zones: zoneContracts } = require('openvibe-contracts');
const db = require('../db/database');
const config = require('../config');
const model = require('../objects/model');

const BATCH = 200;

class ZoneError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const rootOf = (projectId, env) => `app.${projectId}${env === 'sandbox' ? '.sandbox' : ''}`;
const tenantQuota = (env) => (env === 'sandbox' ? config.apps.sandboxQuotaMb : config.apps.projectQuotaMb) * 1024 * 1024;

async function byId(id) {
    return await db.get('SELECT * FROM media_zones WHERE id = ?', [id]) || null;
}

async function byName(projectId, env, name) {
    return await db.get('SELECT * FROM media_zones WHERE project_id = ? AND env = ? AND name = ?', [projectId, env, name]) || null;
}

async function listActive(projectId, env) {
    return await db.all("SELECT * FROM media_zones WHERE project_id = ? AND env = ? AND state = 'active' ORDER BY name", [projectId, env]);
}

/** The zone a namespace belongs to: the named zone it is, or the environment's default zone. */
async function forNamespace(app, namespace) {
    if (!app || !app.project_id) return null;
    const root = rootOf(app.project_id, app.env);
    const m = /^(.+)\.(zon_[0-9A-HJKMNP-TV-Z]{26})$/.exec(namespace);
    if (m && m[1] === root) return await byId(m[2]);
    if (namespace === root || namespace.startsWith(`${root}.`)) return await byName(app.project_id, app.env, 'default');
    return null;
}

/** Apply one zone record from Zone. Idempotent by revision; throws ZoneError for a record Media must refuse. */
async function provision(record, { now = Date.now() } = {}) {
    const check = zoneContracts.checkObjectZone(record);
    if (!check.valid) throw new ZoneError(400, 'media.zone.invalid', JSON.stringify(check.errors).slice(0, 400));
    return await db.getDb().tx(async () => {
        const cur = await byId(record.id);
        if (cur && Number(cur.revision) >= record.revision) return { applied: false, zone: cur };
        if (cur && (cur.project_id !== record.project_id || cur.env !== record.env || cur.name !== record.name || cur.namespace !== record.media_namespace)) {
            throw new ZoneError(409, 'media.zone.immutable', 'a zone keeps its project, environment, name and namespace');
        }
        if (cur && cur.state === 'deleted' && record.state !== 'deleted') throw new ZoneError(409, 'media.zone.deleted', 'a deleted zone stays deleted');
        const named = await byName(record.project_id, record.env, record.name);
        if (named && named.id !== record.id) throw new ZoneError(409, 'media.zone.name_retired', `${record.name} belongs to ${named.id} in this environment`);
        const tenant = await db.ensureProjectTenant(record.project_id, record.env, tenantQuota(record.env));
        const root = db.rootNamespace(tenant);
        if (!record.default) {
            // The zone's own namespace row: its quota (a ceiling below the environment's) is enforced on every write.
            await db.run(`INSERT INTO media_namespaces (namespace, app_id, parent, owner, quota_bytes) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (namespace) DO UPDATE SET quota_bytes = excluded.quota_bytes, updated_at = ov_now()`,
            [record.media_namespace, tenant.app_id, root, db.namespaceOwner(tenant), record.quota_bytes ?? null]);
        }
        const deleting = ['deleting', 'deleted'].includes(record.state);
        await db.run(`INSERT INTO media_zones (id, project_id, env, name, is_default, namespace, quota_bytes, state, revision, record,
                deletion_requested_at, deletion_completed_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
            ON CONFLICT (id) DO UPDATE SET quota_bytes = excluded.quota_bytes, state = excluded.state, revision = excluded.revision,
                record = excluded.record, updated_at = excluded.updated_at,
                deletion_requested_at = COALESCE(media_zones.deletion_requested_at, excluded.deletion_requested_at)`,
        [record.id, record.project_id, record.env, record.name, !!record.default, record.media_namespace, record.quota_bytes ?? null,
            record.state, record.revision, JSON.stringify(record), deleting ? now : null, now]);
        if (record.state === 'deleted') await require('./keys').dropZone(record.id, { now });
        return { applied: true, zone: await byId(record.id) };
    });
}

/** SQL for the objects of a zone: its namespace, or (default zone) the environment's objects outside named zones. */
function objectScope(zone, tenantId) {
    if (!zone.is_default) return { where: 'o.namespace = ?', args: [zone.namespace] };
    return {
        where: "o.app_id = ? AND (o.namespace = ? OR (o.namespace LIKE ? AND o.namespace NOT LIKE ?))",
        args: [tenantId, zone.namespace, `${zone.namespace}.%`, `${zone.namespace}.zon\\_%`],
    };
}

const tenantIdOf = (zone) => db.projectTenantId(zone.project_id, zone.env);

async function status(zone, { now = Date.now() } = {}) {
    const s = objectScope(zone, tenantIdOf(zone));
    const live = await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(o.size_bytes), 0) AS b FROM media_objects o
        WHERE ${s.where} AND o.lifecycle_status = 'ready'`, s.args);
    const remaining = await db.get(`SELECT COUNT(*) AS n FROM media_objects o WHERE ${s.where}
        AND (o.lifecycle_status <> 'deleted' OR o.metadata NOT LIKE '%"purged_at"%')`, s.args);
    const held = await db.get(`SELECT COUNT(DISTINCT o.id) AS n FROM media_objects o JOIN media_holds h ON h.object_id = o.id
        WHERE ${s.where} AND h.released_at IS NULL AND (o.lifecycle_status <> 'deleted' OR o.metadata NOT LIKE '%"purged_at"%')`, s.args);
    return {
        stored_bytes: Number(live.b), objects: Number(live.n),
        objects_remaining: Number(remaining.n), held_objects: Number(held.n), as_of: new Date(now).toISOString(),
    };
}

/** Is any object of the zone under a retention hold? (Zone asks before it starts a deletion: 409 zone.held.) */
async function hasHeld(zone) {
    return (await status(zone)).held_objects > 0;
}

/**
 * One pass over the zones being deleted: every live object is tombstoned with no restore window (a held one too: its
 * hold delays only its purge), then every tombstoned object without a hold is purged, its copies erased. When nothing
 * is left the projection records the completion; Zone reads it from the status and marks the zone deleted.
 */
async function sweepDeleting({ now = Date.now() } = {}) {
    const zones = await db.all("SELECT * FROM media_zones WHERE state = 'deleting' AND deletion_completed_at IS NULL");
    let tombstoned = 0, purged = 0;
    for (const zone of zones) {
        const s = objectScope(zone, tenantIdOf(zone));
        const live = await db.all(`SELECT o.* FROM media_objects o WHERE ${s.where} AND o.lifecycle_status <> 'deleted' LIMIT ${BATCH}`, s.args);
        for (const obj of live) {
            const md = model.parseJson(obj.metadata, {});
            md.pre_delete_status = obj.lifecycle_status;
            md.retention_until = new Date(now).toISOString();
            md.deleted_by = `zone:${zone.id}`;
            md.no_restore = true;
            const events = require('../events');
            await db.getDb().tx(async () => {
                await db.run(`UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = ov_now(), metadata = ?, updated_at = ov_now()
                    WHERE id = ? AND lifecycle_status <> 'deleted'`, [JSON.stringify(md), obj.id]);
                await require('../objects/namespaces').settle(obj.id);
                await events.recordObjectChanges();
            });
            events.kick();
            tombstoned++;
        }
        const dead = await db.all(`SELECT o.* FROM media_objects o WHERE ${s.where} AND o.lifecycle_status = 'deleted'
            AND o.metadata NOT LIKE '%"purged_at"%' LIMIT ${BATCH}`, s.args);
        for (const obj of dead) if (await model.purgeOne(obj)) purged++;
        const st = await status(zone, { now });
        if (st.objects_remaining === 0) {
            await db.run('UPDATE media_zones SET deletion_completed_at = ?, updated_at = ? WHERE id = ?', [now, now, zone.id]);
        }
    }
    return { zones: zones.length, tombstoned, purged };
}

/** The zone.object-zone-usage@1-like snapshot Zone shows: the live objects and, while deleting, the progress. */
async function report(zone, opts) {
    const st = await status(zone, opts);
    return {
        zone_id: zone.id, revision: Number(zone.revision), state: zone.state,
        usage: { stored_bytes: st.stored_bytes, objects: st.objects, as_of: st.as_of },
        held_objects: st.held_objects,                       // Zone refuses to start a deletion while any object is held
        deletion: zone.deletion_requested_at == null ? null : {
            requested_at: new Date(Number(zone.deletion_requested_at)).toISOString(),
            objects_remaining: st.objects_remaining, held_objects: st.held_objects,
            completed_at: zone.deletion_completed_at == null ? null : new Date(Number(zone.deletion_completed_at)).toISOString(),
        },
    };
}

module.exports = {
    provision, byId, byName, listActive, forNamespace, status, report, hasHeld, sweepDeleting, objectScope, rootOf, ZoneError,
};
