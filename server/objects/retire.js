'use strict';
/**
 * Operator retirement of a no-good-copy object (scripts/no-good-copy-report.js --retire).
 *
 * A ready object with no good copy cannot be repaired when every copy it has is missing or corrupt. The report can
 * only list it; this is the one operator path that retires it, and only the safe shape (docs/object-model.md,
 * "scheduled verification"):
 *
 *   - it is in the no-good-copy report (listNoGoodCopy: ready, not virtual, no present/pending copy);
 *   - it is not public (a native public object, or a v1 row that is public, is refused); a legacy VOD/clip object
 *     counts as not public when its v1 row is not public (is_public 0, even if visibility still says public — the
 *     health quarantine's shape), even when its media_objects envelope still says public;
 *   - it is under 1 MiB: a stub or a broken small upload, never a real recording;
 *   - no retention hold applies.
 *
 * The delete is the ordinary soft delete (model.softDelete), the same one Media's own delete uses: lifecycle_status
 * becomes deleted, the bytes stay for MEDIA_DELETE_RETENTION_DAYS (metadata.retention_until), the media_objects
 * trigger queues the same media.object.deleted event as any other delete (so Live and Search forget the item), and
 * POST /:id/restore brings it back inside the retention period.
 *
 * A projected VOD or clip is also hidden from its inherited route the way the owning app's delete hides it: its v1
 * row is made private (visibility = private, is_public = 0) through db.setVodVisibility / setClipVisibility, so the
 * row and the object agree. The row is kept, not removed, which is what keeps the retirement reversible; a VOD that
 * is public is refused rather than hidden. A file row keeps being served by /f/:key whatever its object says, so a
 * file object is refused too.
 */
const db = require('../db/database');
const model = require('./model');
const copyReport = require('./copy-report');

const MAX_BYTES = 1024 * 1024;                      // strictly under 1 MiB
const BY = 'operator:no-good-copy-report';
const MED_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

function query() {
    const d = db.getDb();
    return {
        all: async (sql, params = []) => await d.prepare(sql).all(...params),
        get: async (sql, params = []) => await d.prepare(sql).get(...params),
    };
}

/** The v1 route's own visibility rule (vods/clips row → public, unlisted or private). */
function rowVisibility(row) {
    return row.visibility || (row.is_public ? 'public' : 'private');
}

/**
 * Whether a v1 row is public for retirement purposes: the route would show it, and it is not delisted. The health
 * quarantine sets is_public = 0 and leaves visibility = 'public'; such a row is not listed anywhere, so it is not
 * public here and its object can be retired.
 */
function rowPublic(row) {
    return rowVisibility(row) === 'public' && (row.is_public == null || Number(row.is_public) !== 0);
}

function humanBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * Decide whether an object may be retired. Reads only. Returns
 * { ok: true, id, obj, size, rows, locations } or { ok: false, id, obj?, reason }.
 */
async function assess(id, { q = null } = {}) {
    if (!MED_ID.test(String(id || ''))) return { ok: false, id, reason: 'not a med_… object id' };
    const obj = await model.getObject(id);
    if (!obj) return { ok: false, id, reason: 'no such object' };
    if (obj.lifecycle_status === 'deleted') return { ok: false, id, obj, reason: 'it is already deleted' };
    const reads = q || query();
    const inReport = (await copyReport.listNoGoodCopy(reads, { appId: obj.app_id })).some((o) => o.id === obj.id);
    if (!inReport) return { ok: false, id, obj, reason: 'not in the no-good-copy report (it has a good copy, is virtual, or is not ready)' };
    const refs = await copyReport.references(reads, obj);
    const publicVod = refs.vods.find(rowPublic);
    if (publicVod) return { ok: false, id, obj, reason: `its vods#${publicVod.id} row is public` };
    const publicClip = refs.clips.find(rowPublic);
    if (publicClip) return { ok: false, id, obj, reason: `its clips#${publicClip.id} row is public` };
    // The v1 row decides for a projected VOD/clip: an older write or the health quarantine (is_public 0, visibility
    // still public) can leave the envelope at public after the row is delisted. A native object has no row, so its
    // own visibility stands.
    if (obj.visibility === 'public' && !refs.vods.length && !refs.clips.length) {
        return { ok: false, id, obj, reason: 'it is public' };
    }
    const size = Number(obj.size_bytes) || 0;
    if (size >= MAX_BYTES) return { ok: false, id, obj, reason: `${humanBytes(size)} is not under 1 MiB` };
    if (await model.isHeld(obj.id)) return { ok: false, id, obj, reason: 'it is under a retention hold' };
    if (refs.files.length) return { ok: false, id, obj, reason: `its files/${refs.files[0].key} row is served publicly by /f/:key` };

    return {
        ok: true, id, obj, size,
        rows: [
            ...refs.vods.map((r) => ({ table: 'vods', id: r.id })),
            ...refs.clips.map((r) => ({ table: 'clips', id: r.id })),
        ],
        locations: await model.listLocations(obj.id),
    };
}

/** What a dry run (or the apply itself) does, in operator-readable lines. */
function describe(plan) {
    const o = plan.obj;
    const out = [`${o.id}  ${o.kind}  ${humanBytes(plan.size)}  ${o.visibility}  ${o.legacy_ref || '(native object)'}`];
    out.push(`  action: soft delete (bytes kept, ${require('../config').objects.retentionDays}-day retention; restorable; this script deletes no bytes)`);
    out.push('  event: media.object.deleted (Live and Search forget the item)');
    if (plan.rows.length) out.push(`  hide: ${plan.rows.map((r) => `${r.table}#${r.id} (visibility private, is_public 0)`).join(', ')}`);
    if (!plan.locations.length) out.push('  report: no good copy (no locations recorded)');
    else out.push(`  report: no good copy (${plan.locations.map((l) => `${l.provider} ${l.state}`).join(', ')})`);
    return out.join('\n');
}

/**
 * Retire the assessed plans in one transaction: hide their v1 rows, then soft-delete each object through
 * model.softDelete (with the event and retention metadata). Returns the deleted objects' key facts.
 */
async function retire(plans) {
    const d = db.getDb();
    await d.tx(async () => {
        for (const plan of plans) {
            for (const row of plan.rows) {
                if (row.table === 'vods') await db.setVodVisibility(row.id, 'private');
                else if (row.table === 'clips') await db.setClipVisibility(row.id, 'private');
            }
            await model.softDelete(plan.obj, { by: BY });
        }
    });
    return await Promise.all(plans.map(async (plan) => {
        const obj = await model.getObject(plan.obj.id);
        const md = model.parseJson(obj.metadata, {});
        return { id: obj.id, lifecycle_status: obj.lifecycle_status, deleted_at: obj.deleted_at || null, retention_until: md.retention_until || null };
    }));
}

module.exports = { MAX_BYTES, BY, MED_ID, assess, describe, retire, rowVisibility, humanBytes };
