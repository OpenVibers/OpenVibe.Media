/**
 * OpenVibe.Media — "no good copy" query and report (docs/object-model.md#scheduled-verification).
 *
 * A ready object has NO GOOD COPY when none of its locations is `present` (verified there) or
 * `pending` (not verified yet, so possibly fine). That covers objects whose every copy was found
 * missing/corrupt, and ready objects with no location row at all.
 *
 * Pure SQL over a small `q` interface — { all(sql, params), get(sql, params) } — so the service
 * (server/db/database.js), the metrics/readiness checks and the read-only report script
 * (scripts/no-good-copy-report.js, which opens the database file read-only) share one definition.
 * Nothing here writes.
 */
'use strict';

const NO_GOOD_COPY_WHERE = `o.lifecycle_status = 'ready'
    AND NOT EXISTS (SELECT 1 FROM media_locations l WHERE l.object_id = o.id AND l.state IN ('present', 'pending'))`;

function countNoGoodCopy(q, { appId = null } = {}) {
    const r = q.get(`SELECT COUNT(*) AS n FROM media_objects o WHERE ${NO_GOOD_COPY_WHERE}${appId ? ' AND o.app_id = ?' : ''}`, appId ? [appId] : []);
    return Number(r && r.n) || 0;
}

function listNoGoodCopy(q, { appId = null } = {}) {
    return q.all(`SELECT o.* FROM media_objects o WHERE ${NO_GOOD_COPY_WHERE}${appId ? ' AND o.app_id = ?' : ''} ORDER BY o.app_id, o.id`, appId ? [appId] : []);
}

function tableExists(q, name) {
    return !!q.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
}

function parseJson(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } }

/** Rows elsewhere that point at the object: the inherited projections, relationships, variants, holds. */
function references(q, obj) {
    const refs = {
        vods: q.all(`SELECT id, app_id, user_id, stream_id, managed_stream_id, title, visibility, is_public, file_path, file_size,
                            storage_provider, storage_key, created_at FROM vods WHERE object_id = ?`, [obj.id]),
        clips: q.all(`SELECT id, app_id, vod_id, stream_id, user_id, channel_user_id, title, visibility, is_public, file_path, status, created_at
                      FROM clips WHERE object_id = ?`, [obj.id]),
        files: q.all('SELECT key, app_id, user_id, original_name, size, mime, created_at FROM files WHERE object_id = ?', [obj.id]),
        pastes: q.all('SELECT id, slug, app_id, user_id, title, type, visibility, screenshot_path, created_at FROM pastes WHERE object_id = ?', [obj.id]),
        relationships: q.all(`SELECT from_object_id, relation, to_object_id FROM media_relationships
                              WHERE from_object_id = ? OR to_object_id = ? ORDER BY id`, [obj.id, obj.id]),
        variants: q.all(`SELECT object_id, variant_name, derived_object_id FROM media_variants
                         WHERE object_id = ? OR derived_object_id = ? ORDER BY id`, [obj.id, obj.id]),
        holds: q.all('SELECT id, kind, reason, created_by, created_at FROM media_holds WHERE object_id = ? AND released_at IS NULL ORDER BY id', [obj.id]),
    };
    return refs;
}

/** Everything an operator needs to decide what to do with each object that has no good copy. */
function buildReport(q, { appId = null } = {}) {
    const hasVerifications = tableExists(q, 'media_verifications');
    const items = listNoGoodCopy(q, { appId }).map((o) => {
        const last = hasVerifications ? q.get('SELECT verified_at, status, detail FROM media_verifications WHERE object_id = ?', [o.id]) : null;
        const md = parseJson(o.metadata, {});
        return {
            object_id: o.id,
            app_id: o.app_id,
            kind: o.kind,
            visibility: o.visibility,
            title: md.title || md.filename || null,
            size_bytes: Number(o.size_bytes) || 0,
            content_hash: o.content_hash || null,
            created_at: o.created_at,
            owner: { app: o.owner_app || o.app_id, user_id: o.owner_user_id ?? null, subject: o.owner_subject || null },
            legacy_ref: o.legacy_ref || null,
            canonical: { provider: o.canonical_provider || null, key: o.canonical_key || null },
            locations: q.all('SELECT provider, bucket, key, state, size_bytes, verified_at FROM media_locations WHERE object_id = ? ORDER BY id', [o.id]),
            references: references(q, o),
            last_verification: last ? { verified_at: last.verified_at, status: last.status, detail: parseJson(last.detail, {}) } : null,
        };
    });
    return { generated_at: new Date().toISOString(), app_id: appId, count: items.length, objects: items };
}

function mb(n) { return `${((Number(n) || 0) / 1048576).toFixed(1)} MB`; }

function formatReport(report) {
    const out = [`${report.count} ready object(s) with no good copy${report.app_id ? ` in ${report.app_id}` : ''} (generated ${report.generated_at})`];
    if (!report.count) return out.join('\n');
    out.push('Nothing was changed. Decide per object: restore the bytes from elsewhere, or retire it through its owning app.');
    for (const it of report.objects) {
        out.push('');
        out.push(`${it.object_id}  ${it.kind}  ${it.app_id}  ${mb(it.size_bytes)}  created ${it.created_at}  ${it.visibility}`);
        if (it.title) out.push(`  title: ${it.title}`);
        out.push(`  owner: app=${it.owner.app} user_id=${it.owner.user_id ?? '-'} subject=${it.owner.subject || '-'}`);
        out.push(`  legacy_ref: ${it.legacy_ref || '(native object)'}`);
        if (!it.locations.length) out.push('  locations: (none recorded)');
        for (const l of it.locations) out.push(`  location: ${l.provider}${l.bucket ? `/${l.bucket}` : ''} ${l.key}  ${l.state}${l.size_bytes != null ? `  ${l.size_bytes} bytes` : ''}${l.verified_at ? `  verified ${l.verified_at}` : ''}`);
        const r = it.references;
        for (const v of r.vods) out.push(`  vods#${v.id}: user ${v.user_id ?? '-'} "${v.title || ''}" ${v.visibility || ''} provider=${v.storage_provider || 'local'} file=${v.file_path || '-'}`);
        for (const c of r.clips) out.push(`  clips#${c.id}: vod ${c.vod_id ?? '-'} user ${c.user_id ?? '-'} "${c.title || ''}" ${c.visibility || ''} file=${c.file_path || '-'}`);
        for (const f of r.files) out.push(`  files/${f.key}: user ${f.user_id ?? '-'} ${f.original_name || ''}`);
        for (const p of r.pastes) out.push(`  pastes/${p.slug}: user ${p.user_id ?? '-'} ${p.type || ''} ${p.visibility || ''}`);
        for (const x of r.relationships) out.push(`  relationship: ${x.from_object_id} ${x.relation} ${x.to_object_id}`);
        for (const x of r.variants) out.push(`  variant: ${x.object_id} ${x.variant_name} → ${x.derived_object_id}`);
        for (const h of r.holds) out.push(`  HOLD ${h.kind}: ${h.reason || ''} (by ${h.created_by || '-'})`);
        if (it.last_verification) out.push(`  last verified ${it.last_verification.verified_at}: ${it.last_verification.status}`);
    }
    return out.join('\n');
}

module.exports = { NO_GOOD_COPY_WHERE, countNoGoodCopy, listNoGoodCopy, buildReport, formatReport };
