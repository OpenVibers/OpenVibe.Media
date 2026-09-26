/**
 * OpenVibe.Media — canonical object model (roadmap Wave 4; docs/object-model.md)
 *
 * Every stored blob is a media_object (id med_<ULID>) with one media_locations
 * row per provider copy. The inherited vods/clips/files/pastes rows are typed
 * projections over objects: each carries object_id, and the sync*() functions
 * below derive the object + locations from the row as it is right now. The same
 * functions back the one-off backfill and every write on the old APIs, which
 * writes the row and its object in one transaction (withObject, WS-G task 1), so
 * the model cannot drift between "imported" and "written since". The drift
 * report (./drift.js) checks that it has not.
 *
 * Location states: present (verified: the local file exists / a HEAD answered),
 * missing (verified absent), pending (believed there, not yet verified — every
 * remote copy until reconciliation --verify), corrupt (size/hash mismatch).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ids } = require('openvibe-contracts');
const db = require('../db/database');
const config = require('../config');

const KINDS = ['vod', 'clip', 'file', 'thumbnail', 'screenshot', 'avatar', 'asset'];
const VISIBILITIES = ['public', 'unlisted', 'private'];
const LIFECYCLES = ['uploading', 'ready', 'failed', 'archived', 'deleted'];
const HOLD_KINDS = ['moderation', 'dmca', 'creator_pin', 'admin', 'evidence'];
const STORAGE_CLASS = { local: 'hot', b2: 'cold', r2: 'cache' };

const MIME_BY_EXT = {
    '.webm': 'video/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.ogg': 'video/ogg',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf',
};

class HeldError extends Error {
    constructor(objectId) { super('media object is under a retention hold'); this.code = 'media.object.held'; this.objectId = objectId; }
}

// ── Small helpers ────────────────────────────────────────────

function mimeFor(p, fallback = 'application/octet-stream') {
    return MIME_BY_EXT[path.extname(String(p || '')).toLowerCase()] || fallback;
}

function parseJson(s, fallback) {
    if (s == null || s === '') return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) → epoch ms, so backfilled ids sort by original creation time. */
function toMs(createdAt) {
    const ms = Date.parse(String(createdAt || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(createdAt || '')) ? '' : 'Z'));
    return Number.isFinite(ms) ? ms : Date.now();
}

function statFile(p) {
    if (!p) return null;
    try { const st = fs.statSync(p); return st.isFile() ? { size: st.size } : null; } catch { return null; }
}

function rowVisibility(row) {
    const v = row.visibility || (row.is_public ? 'public' : 'private');
    return VISIBILITIES.includes(v) ? v : 'private';
}

function legacyRef(app, kind, id) {
    return ids.legacyMediaId(app, kind, id);
}

function parseLegacyRef(ref) {
    const m = /^legacy:([^:]+):([^:]+):(.+)$/.exec(String(ref || ''));
    return m ? { app: m[1], kind: m[2], id: m[3] } : null;
}

const vodStorage = () => require('../vod/vod-storage');

// ── Reads ────────────────────────────────────────────────────

function getObject(id) {
    return id ? db.get('SELECT * FROM media_objects WHERE id = ?', [id]) : null;
}

function getObjectByLegacyRef(ref) {
    return ref ? db.get('SELECT * FROM media_objects WHERE legacy_ref = ?', [ref]) : null;
}

/** An object by med_ id or legacy ref, scoped to one tenant (null when it belongs to another). */
function resolveObject(idOrRef, appId) {
    const key = String(idOrRef || '');
    const obj = key.startsWith('legacy:') ? getObjectByLegacyRef(key) : getObject(key);
    return obj && obj.app_id === appId ? obj : null;
}

function listLocations(objectId) {
    return db.all('SELECT * FROM media_locations WHERE object_id = ? ORDER BY id', [objectId]);
}

function listHolds(objectId, { includeReleased = false } = {}) {
    return db.all(`SELECT * FROM media_holds WHERE object_id = ?${includeReleased ? '' : ' AND released_at IS NULL'} ORDER BY id`, [objectId]);
}

/** Unreleased holds a clip inherits from its source VOD (clip_of, or the clip row's vod_id), each with inherited_from. */
function inheritedHolds(objectId) {
    if (!objectId) return [];
    return db.all(`SELECT h.*, h.object_id AS inherited_from FROM media_holds h WHERE h.released_at IS NULL AND h.object_id != @id AND (
        h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = @id AND r.relation = 'clip_of')
        OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = @id)) ORDER BY h.id`, { id: objectId });
}

/** Under an unreleased hold: its own, or (a clip) its source VOD's. The delete triggers apply the same rule (db.heldSql). */
function isHeld(objectId) {
    if (!objectId) return false;
    return !!db.get(`SELECT ${db.heldSql('@id')} AS held`, { id: objectId }).held;
}

/**
 * Hold check for an inherited row (vods/clips/files/pastes). A clip row also follows its source VOD's
 * hold before it has an object of its own; any other row with no object yet is not held.
 */
function isHeldRow(row) {
    try {
        if (!row) return false;
        if (row.object_id && isHeld(row.object_id)) return true;
        if (row.vod_id != null) {
            const vod = db.get('SELECT object_id FROM vods WHERE id = ?', [row.vod_id]);
            return !!(vod && vod.object_id && isHeld(vod.object_id));
        }
        return false;
    } catch { return false; }
}

// ── Writes ───────────────────────────────────────────────────

const OBJECT_COLUMNS = ['app_id', 'namespace', 'kind', 'owner_subject', 'owner_app', 'owner_user_id', 'visibility',
    'lifecycle_status', 'mime_type', 'size_bytes', 'content_hash', 'canonical_provider', 'canonical_key', 'legacy_ref', 'metadata', 'deleted_at'];

function createObject(o) {
    if (!KINDS.includes(o.kind)) throw new Error(`unknown kind ${o.kind}`);
    const id = ids.newId('media', o.createdMs);
    db.run(`INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, owner_app, owner_user_id, visibility,
                lifecycle_status, mime_type, size_bytes, content_hash, canonical_provider, canonical_key, legacy_ref, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    [id, o.app_id, o.namespace || o.app_id, o.kind, o.owner_subject || null, o.owner_app || null, o.owner_user_id ?? null,
        VISIBILITIES.includes(o.visibility) ? o.visibility : 'private', LIFECYCLES.includes(o.lifecycle_status) ? o.lifecycle_status : 'uploading',
        o.mime_type || null, Number(o.size_bytes) || 0, o.content_hash || null, o.canonical_provider || null, o.canonical_key || null,
        o.legacy_ref || null, JSON.stringify(o.metadata || {}), o.created_at || null]);
    return id;
}

function updateObject(id, fields) {
    const sets = [], params = [];
    for (const [k, v] of Object.entries(fields)) {
        if (!OBJECT_COLUMNS.includes(k)) continue;
        sets.push(`${k} = ?`);
        params.push(k === 'metadata' && typeof v !== 'string' ? JSON.stringify(v || {}) : v);
    }
    if (!sets.length) return;
    params.push(id);
    db.run(`UPDATE media_objects SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);
}

/**
 * Upsert one provider copy. A remote copy re-derived as 'pending' keeps what
 * reconciliation already verified about the same key (never downgrade knowledge).
 */
function upsertLocation(objectId, loc) {
    const existing = db.get('SELECT * FROM media_locations WHERE object_id = ? AND provider = ?', [objectId, loc.provider]);
    const verifiedAt = loc.verified ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null;
    if (!existing) {
        db.run(`INSERT INTO media_locations (object_id, provider, bucket, key, storage_class, state, checksum, size_bytes, verified_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [objectId, loc.provider, loc.bucket || null, loc.key, loc.storage_class || STORAGE_CLASS[loc.provider] || null,
            loc.state || 'pending', loc.checksum || null, loc.size_bytes ?? null, verifiedAt]);
        return;
    }
    const keep = existing.key === loc.key && (loc.state || 'pending') === 'pending' && existing.state !== 'pending';
    db.run(`UPDATE media_locations SET bucket = ?, key = ?, storage_class = ?, state = ?, checksum = ?, size_bytes = ?, verified_at = ?,
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [loc.bucket ?? existing.bucket, loc.key, loc.storage_class || existing.storage_class,
        keep ? existing.state : (loc.state || 'pending'),
        loc.clearChecksum ? null : (loc.checksum ?? (existing.key === loc.key ? existing.checksum : null)),
        keep ? existing.size_bytes : (loc.size_bytes ?? null),
        keep ? existing.verified_at : (verifiedAt || (existing.key === loc.key && loc.state === existing.state ? existing.verified_at : null)),
        existing.id]);
}

function setLocationState(locationId, { state, size_bytes, verified = true }) {
    db.run(`UPDATE media_locations SET state = ?, size_bytes = COALESCE(?, size_bytes), verified_at = ${verified ? 'CURRENT_TIMESTAMP' : 'verified_at'},
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [state, size_bytes ?? null, locationId]);
}

function setRelationship(fromId, relation, toId, metadata = {}) {
    db.run(`INSERT INTO media_relationships (from_object_id, relation, to_object_id, metadata) VALUES (?, ?, ?, ?)
            ON CONFLICT(from_object_id, relation, to_object_id) DO UPDATE SET metadata = excluded.metadata`,
    [fromId, relation, toId, JSON.stringify(metadata)]);
}

function setVariant(objectId, variantName, derivedId, recipe = null) {
    db.run(`INSERT INTO media_variants (object_id, variant_name, derived_object_id, recipe) VALUES (?, ?, ?, ?)
            ON CONFLICT(object_id, variant_name) DO UPDATE SET derived_object_id = excluded.derived_object_id, recipe = excluded.recipe`,
    [objectId, variantName, derivedId, recipe]);
}

function getVariant(objectId, variantName) {
    return db.get('SELECT * FROM media_variants WHERE object_id = ? AND variant_name = ?', [objectId, variantName]);
}

// ── Projection core ──────────────────────────────────────────

/**
 * Create or update the object behind one inherited row and make its locations
 * exactly the derived set. Returns { id, created }.
 *   p.locations  [{ provider, bucket, key, state, size_bytes, checksum }]
 *   p.canonical  preferred canonical provider (falls back to the first location)
 */
function project(p) {
    const found = getObjectByLegacyRef(p.legacy_ref) || (p.existingId ? getObject(p.existingId) : null);
    const canon = p.locations.find(l => l.provider === p.canonical) || p.locations[0] || null;
    const fields = {
        app_id: p.app_id, namespace: p.app_id, kind: p.kind,
        owner_app: p.owner_app || p.app_id, owner_user_id: p.owner_user_id ?? null,
        visibility: p.visibility, lifecycle_status: p.lifecycle_status,
        mime_type: p.mime_type || null, size_bytes: Number(p.size_bytes) || 0, content_hash: p.content_hash || null,
        canonical_provider: canon ? canon.provider : null, canonical_key: canon ? canon.key : null,
        legacy_ref: p.legacy_ref, metadata: p.metadata || {},
    };
    let id, created = false;
    let staleHash = false;
    if (found) {
        id = found.id;
        // Knowledge the row doesn't carry survives a re-projection.
        if (!fields.content_hash) fields.content_hash = found.content_hash;
        fields.metadata = { ...parseJson(found.metadata, {}), ...fields.metadata };
        // A hash the content-hash job computed (hash_basis: the local file it read) holds only while
        // that file is unchanged: a present local copy at another path or of another size (a remux,
        // a re-cut, a regenerated thumbnail) makes it stale. A copy that moved to B2/R2 keeps it.
        const basis = fields.metadata.hash_basis;
        if (basis && fields.content_hash === found.content_hash && !p.content_hash) {
            const local = p.locations.find(l => l.provider === 'local' && l.state === 'present');
            if (local && (local.key !== basis.key || Number(local.size_bytes) !== Number(basis.size))) {
                fields.content_hash = null;
                delete fields.metadata.hash_basis;
                staleHash = true;
            }
        }
        if (found.lifecycle_status === 'deleted') fields.deleted_at = null;   // the row exists, so the object does
        // owner_subject (filled by the owner-subject job) is the subject of owner_user_id; a different owner
        // drops it until the job resolves the new one.
        if (String(found.owner_app || found.app_id) !== String(fields.owner_app) || String(found.owner_user_id ?? '') !== String(fields.owner_user_id ?? '')) {
            fields.owner_subject = null;
        }
        updateObject(id, fields);
    } else {
        id = createObject({ ...fields, createdMs: toMs(p.created_at), created_at: p.created_at || null });
        created = true;
    }
    const keep = new Set(p.locations.map(l => l.provider));
    for (const loc of p.locations) upsertLocation(id, staleHash && loc.provider === 'local' ? { ...loc, clearChecksum: true } : loc);
    for (const l of listLocations(id)) if (!keep.has(l.provider)) db.run('DELETE FROM media_locations WHERE id = ?', [l.id]);
    return { id, created };
}

function localLocation(candidates, { mustExist = false } = {}) {
    for (const p of candidates.filter(Boolean)) {
        const st = statFile(p);
        if (st) return { provider: 'local', key: path.resolve(p), state: 'present', size_bytes: st.size, verified: true };
    }
    if (mustExist || !candidates[0]) return null;
    return { provider: 'local', key: path.resolve(candidates[0]), state: 'missing', size_bytes: null, verified: true };
}

/** local + B2 canonical + R2 cache copies for a vods/clips row (same columns, same key scheme). */
function tieredLocations(row, localCandidates) {
    const vs = vodStorage();
    const provider = vs.providerOf(row);
    const remoteKnown = provider !== 'local' || !!row.storage_key;
    const locs = [];
    const local = row.file_path ? localLocation(localCandidates, { mustExist: provider !== 'local' }) : null;
    if (local) locs.push(local);
    if (remoteKnown && row.file_path) {
        const key = vs.keyForVod(row);
        locs.push({ provider: 'b2', bucket: vs.bucketFor('b2'), key, state: 'pending' });
        if (provider === 'r2') locs.push({ provider: 'r2', bucket: vs.bucketFor('r2'), key, state: 'pending' });
    }
    return { locs, canonical: remoteKnown ? 'b2' : 'local' };
}

function linkRow(table, keyCol, keyVal, objectId) {
    db.run(`UPDATE ${table} SET object_id = ? WHERE ${keyCol} = ? AND (object_id IS NULL OR object_id != ?)`, [objectId, keyVal, objectId]);
}

function recordInvariant(objectId) {
    try { require('./invariant').record(getObject(objectId)); } catch (err) { console.warn('[Objects] invariant record:', err.message); }
}

// ── Per-kind projections ─────────────────────────────────────
// <kind>Projection(row) derives what the object behind one inherited row must say (project()'s input).
// Read-only (it stats local files, never writes), and shared by the sync*() writers below and the
// drift report (./drift.js), so the report checks exactly what a write would have written. A row
// that has no object of its own answers { skipped: reason }.

function vodLifecycle(row) {
    const s = db.vodStatus(row);
    if (s === 'ready' || s === 'failed') return s;
    return 'uploading';
}

function vodProjection(row) {
    if (row.clips_only) return { skipped: 'clips-only recording (ephemeral, never published)' };
    const vs = vodStorage();
    const { locs, canonical } = tieredLocations(row, [row.file_path ? vs.localPathForVod(row) : null, row.file_path]);
    const local = locs.find(l => l.provider === 'local' && l.state === 'present');
    return {
        legacy_ref: legacyRef(row.app_id, 'vod', row.id), existingId: row.object_id,
        app_id: row.app_id, kind: 'vod', owner_user_id: row.user_id,
        visibility: rowVisibility(row), lifecycle_status: vodLifecycle(row),
        mime_type: row.file_path ? mimeFor(row.file_path, 'video/webm') : null,
        size_bytes: Number(row.file_size) || (local ? local.size_bytes : 0),
        metadata: { title: row.title || null, duration_seconds: Number(row.duration_seconds) || 0, health_status: row.health_status || null,
            managed_stream_id: row.managed_stream_id || null, recording: !!row.is_recording },
        created_at: row.created_at, locations: locs, canonical,
    };
}

function clipProjection(row) {
    const clipsDir = path.resolve(config.vod.clipsPath);
    const { locs, canonical } = tieredLocations(row, [row.file_path || null, row.file_path ? path.join(clipsDir, path.basename(row.file_path)) : null]);
    const status = row.status || 'ready';
    const lifecycle = status === 'processing' ? 'uploading' : status === 'failed' ? 'failed' : (row.file_path ? 'ready' : 'failed');
    const local = locs.find(l => l.provider === 'local' && l.state === 'present');
    return {
        legacy_ref: legacyRef(row.app_id, 'clip', row.id), existingId: row.object_id,
        app_id: row.app_id, kind: 'clip', owner_user_id: row.user_id,
        visibility: rowVisibility(row), lifecycle_status: lifecycle,
        mime_type: row.file_path ? mimeFor(row.file_path, 'video/webm') : null,
        size_bytes: local ? local.size_bytes : 0,
        metadata: { title: row.title || null, duration_seconds: Number(row.duration_seconds) || 0, start_time: row.start_time, end_time: row.end_time,
            channel_user_id: row.channel_user_id || null, auto_generated: !!row.auto_generated },
        created_at: row.created_at, locations: locs, canonical,
    };
}

function fileProjection(row) {
    const local = localLocation([path.join(config.files.path, row.app_id, row.key)]);
    if (local.state === 'present' && row.sha256) local.checksum = row.sha256;
    return {
        legacy_ref: legacyRef(row.app_id, 'file', row.key), existingId: row.object_id,
        app_id: row.app_id, kind: 'file', owner_user_id: row.user_id,
        visibility: 'public',                                       // /f/:key serves every file without auth
        lifecycle_status: 'ready', mime_type: row.mime || 'application/octet-stream',
        size_bytes: Number(row.size) || 0, content_hash: row.sha256 || null,
        metadata: { filename: row.original_name || null },
        created_at: row.created_at, locations: [local], canonical: 'local',
    };
}

/** Screenshot pastes (and avatars, which are stored as screenshot pastes) — the bytes only; text is Community's. */
function pasteProjection(row) {
    if (row.type !== 'screenshot') return { skipped: 'text paste (no bytes)' };
    if (!row.screenshot_path) return { skipped: 'screenshot paste without a file path' };
    const meta = parseJson(row.metadata, {}) || {};
    const kind = meta.kind === 'avatar' ? 'avatar' : 'screenshot';
    const local = localLocation([row.screenshot_path]);
    return {
        legacy_ref: legacyRef(row.app_id, kind === 'avatar' ? 'avatar' : 'paste', row.slug), existingId: row.object_id,
        app_id: row.app_id, kind, owner_user_id: row.user_id,
        visibility: VISIBILITIES.includes(row.visibility) ? row.visibility : 'public', lifecycle_status: 'ready',
        mime_type: meta.mime_type || mimeFor(row.screenshot_path, 'image/png'),
        size_bytes: local.state === 'present' ? local.size_bytes : (Number(meta.size_bytes) || 0),
        metadata: { title: row.title || null, slug: row.slug },
        created_at: row.created_at, locations: [local], canonical: 'local',
    };
}

function syncVod(idOrRow) {
    const row = typeof idOrRow === 'object' ? idOrRow : db.get('SELECT * FROM vods WHERE id = ?', [idOrRow]);
    if (!row) return null;
    const p = vodProjection(row);
    if (p.skipped) return p;
    const r = project(p);
    linkRow('vods', 'id', row.id, r.id);
    recordInvariant(r.id);
    const thumbnail = syncThumbnail(row, r.id, 'vod');
    return { ...r, locations: p.locations.map(l => l.state), thumbnail };
}

function syncClip(idOrRow) {
    const row = typeof idOrRow === 'object' ? idOrRow : db.get('SELECT * FROM clips WHERE id = ?', [idOrRow]);
    if (!row) return null;
    const p = clipProjection(row);
    const r = project(p);
    linkRow('clips', 'id', row.id, r.id);
    if (row.vod_id) {
        const vod = db.get('SELECT object_id FROM vods WHERE id = ?', [row.vod_id]);
        if (vod && vod.object_id) setRelationship(r.id, 'clip_of', vod.object_id, { start_time: row.start_time, end_time: row.end_time });
    }
    recordInvariant(r.id);
    const thumbnail = syncThumbnail(row, r.id, 'clip');
    return { ...r, locations: p.locations.map(l => l.state), thumbnail };
}

function syncFile(keyOrRow) {
    const row = typeof keyOrRow === 'object' ? keyOrRow : db.get('SELECT * FROM files WHERE key = ?', [keyOrRow]);
    if (!row) return null;
    const p = fileProjection(row);
    const r = project(p);
    linkRow('files', 'key', row.key, r.id);
    return { ...r, locations: [p.locations[0].state] };
}

function syncPaste(idOrRow) {
    const row = typeof idOrRow === 'object' ? idOrRow : db.get('SELECT * FROM pastes WHERE id = ?', [idOrRow]);
    if (!row) return null;
    const p = pasteProjection(row);
    if (p.skipped) return p;
    const r = project(p);
    linkRow('pastes', 'id', row.id, r.id);
    return { ...r, kind: p.kind, locations: [p.locations[0].state] };
}

/** Thumbnail file name behind a stored thumbnail_url, or null when it is not one of ours. */
function thumbFileFromUrl(u) {
    if (!u) return null;
    let p = String(u);
    if (/^https?:\/\//i.test(p)) {
        if (!p.startsWith(config.publicUrl + '/')) return null;
        p = p.slice(config.publicUrl.length);
    }
    const m = /^\/(?:t|api\/thumbnails)\/([A-Za-z0-9._-]+)$/.exec(p);
    return m ? m[1] : null;
}

/**
 * A vod/clip's thumbnail is one object per parent, updated in place when the
 * picture is regenerated (live recordings refresh theirs every couple of minutes).
 * null when the parent has no thumbnail.
 */
function thumbnailProjection(parentRow, parentKind) {
    if (!parentRow.thumbnail_url) return null;
    const name = thumbFileFromUrl(parentRow.thumbnail_url);
    if (!name) return { skipped: 'external thumbnail url' };
    const local = localLocation([path.join(path.resolve(config.thumbnails.path), name)]);
    const parentVis = rowVisibility(parentRow);
    return {
        legacy_ref: legacyRef(parentRow.app_id, 'thumbnail', name),
        app_id: parentRow.app_id, kind: 'thumbnail', owner_user_id: parentRow.user_id,
        // /t/<name> is served to anyone holding the name.
        visibility: parentVis === 'public' ? 'public' : 'unlisted', lifecycle_status: 'ready',
        mime_type: mimeFor(name, 'image/jpeg'), size_bytes: local.state === 'present' ? local.size_bytes : 0,
        metadata: { of: parentKind },
        created_at: parentRow.created_at, locations: [local], canonical: 'local',
    };
}

function syncThumbnail(parentRow, parentObjectId, parentKind) {
    const p = thumbnailProjection(parentRow, parentKind);
    if (!p || p.skipped) return p;
    const variant = getVariant(parentObjectId, 'thumbnail');
    const r = project({ ...p, existingId: variant ? variant.derived_object_id : null });
    setVariant(parentObjectId, 'thumbnail', r.id);
    setRelationship(r.id, 'thumbnail_of', parentObjectId);
    return { ...r, locations: [p.locations[0].state] };
}

/**
 * Projection work in one transaction, with the object-change events it caused (server/events.js).
 * Nested in an outer transaction (webhooks.announce, another withObject) it is a savepoint, and the
 * outer one records the changes at its end, in the same transaction and after its own outcome event,
 * the order they had when the object was synced after the commit.
 */
function _syncTx(fn) {
    const events = require('../events');
    const raw = db.getDb();
    const outer = raw.inTransaction;
    const out = raw.transaction(() => {
        const r = fn();
        if (!outer) events.recordObjectChanges();
        return r;
    })();
    if (!outer) events.kick();
    return out;
}

const SYNC_BY_KIND = { vod: syncVod, clip: syncClip, file: syncFile, paste: syncPaste };

/** Row ids named by withObject()'s `ids` (a value, a list, or a function of write()'s result). */
function _rowIds(ids, out) {
    return [].concat((typeof ids === 'function' ? ids(out) : ids) ?? []).filter(id => id != null);
}

/** Re-project one inherited row: kind vod|clip|file|paste, id = row id (file key for files). */
function sync(kind, id) {
    const fn = SYNC_BY_KIND[kind];
    if (!fn || id == null) return null;
    return _syncTx(() => fn(id));
}

/**
 * Never-throwing re-projection, for follow-ups that re-read what is on disk after a write already
 * committed with its object (see withObject), and for scripts. Not a write path any more.
 */
function safeSync(kind, id) {
    try { return sync(kind, id); } catch (err) { console.warn(`[Objects] sync ${kind} ${id}:`, err.message); return null; }
}

/**
 * Object-first write (WS-G task 1; retires compatibility shim C-75, "write the row, then sync its
 * object"): write() changes inherited rows and the objects behind them are re-projected in the SAME
 * SQLite transaction, so both commit or neither does: no crash or error between the two can leave
 * an object behind its row. kind vod|clip|file|paste; ids the row id (a file's key), a list of them,
 * or a function of write()'s result that gives them (an INSERT's lastInsertRowid). write() must be
 * synchronous database work. Returns write()'s result; throws, with nothing written, when either
 * part fails. Inside an outer transaction (webhooks.announce) it is a savepoint of that one.
 *
 * The projection stats local files (sizes, present/missing copies) but never reads them: content
 * hashes stay with the content-hash job and remote copies stay 'pending' until reconciliation or a
 * tier move verifies them (afterTierMove), as before. A row write() deleted needs nothing: the
 * row-delete trigger marks its object deleted in the same statement (server/db/database.js).
 */
function withObject(kind, ids, write) {
    const fn = SYNC_BY_KIND[kind];
    if (!fn) throw new Error(`withObject: unknown projection ${kind}`);
    return _syncTx(() => {
        const out = write();
        for (const id of _rowIds(ids, out)) fn(id);
        return out;
    });
}

/**
 * withObject() for a row write that records something already done outside the database (a
 * recorder's ffmpeg is running): the row must say so whatever happens to its object. When the
 * combined transaction fails, the row is written alone and the object re-projected after it (the
 * pre-WS-G two steps; logged, and the drift report lists the row until a later write catches up).
 */
function withObjectOrRow(kind, ids, write) {
    try { return withObject(kind, ids, write); } catch (err) {
        console.warn(`[Objects] ${kind}: object not written with its row (${err.message}); writing the row alone`);
        const out = write();
        for (const id of _rowIds(ids, out)) safeSync(kind, id);
        return out;
    }
}

/**
 * A tier move that verified a copy (upload + HEAD, copy + HEAD). write() flips the row's
 * storage_provider / storage_key; the object is re-projected and the verified providers marked
 * present in the same transaction. The bytes have already moved, so the flip is never lost to its
 * object: when the combined transaction fails the row is flipped alone and re-projected after it
 * (as withObjectOrRow). Without write(), the re-projection alone. The object part never throws.
 */
function afterTierMove(vodId, verifiedProviders = [], write = null) {
    const reproject = () => {
        const r = syncVod(vodId);
        if (!r || !r.id) return;
        for (const l of listLocations(r.id)) {
            if (verifiedProviders.includes(l.provider)) setLocationState(l.id, { state: 'present' });
        }
    };
    let out;
    if (write) {
        try { return _syncTx(() => { const w = write(); reproject(); return w; }); } catch (err) {
            console.warn(`[Objects] tier move vod ${vodId}: object not written with its row (${err.message}); flipping the row alone`);
            out = write();
        }
    }
    try { _syncTx(reproject); } catch (err) { console.warn(`[Objects] tier sync vod ${vodId}:`, err.message); }
    return out;
}

// ── Holds ────────────────────────────────────────────────────

/**
 * A staff hold placed or released is a moderation action (media.moderation.action, ADR-022): announced in
 * the transaction that records it, for Network's moderation audit. A creator's own pin is not moderation.
 */
function announceHold(action, hold, by) {
    if (!hold || hold.kind === 'creator_pin') return;
    const obj = getObject(hold.object_id);
    if (!obj) return;
    const who = String(by || '');
    require('../events').recordModeration(obj.app_id, {
        action,
        target: { type: obj.kind, id: obj.id, ...(obj.owner_subject ? { owner_subject: obj.owner_subject } : {}) },
        actor_subject: /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(who) ? who : null,
        ...(hold.reason ? { reason: String(hold.reason).slice(0, 500) } : {}),
        details: { hold_id: hold.id, kind: hold.kind, app: obj.app_id, ...(who && !who.startsWith('usr_') ? { by: who.slice(0, 200) } : {}) },
    });
}

/** Place a hold. created_by (or placed_by) is who placed it; note is free text for staff (≤ 2000). */
function placeHold({ object_id, kind, reason = '', created_by = null, placed_by = null, note = null }) {
    if (!HOLD_KINDS.includes(kind)) throw new Error(`hold kind must be one of ${HOLD_KINDS.join(', ')}`);
    return db.getDb().transaction(() => {
        const r = db.run('INSERT INTO media_holds (object_id, kind, reason, created_by, note) VALUES (?, ?, ?, ?, ?)',
            [object_id, kind, String(reason || '').slice(0, 1000), placed_by ?? created_by, note == null || note === '' ? null : String(note).slice(0, 2000)]);
        const hold = db.get('SELECT * FROM media_holds WHERE id = ?', [r.lastInsertRowid]);
        announceHold('hold.placed', hold, placed_by ?? created_by);
        return hold;
    })();
}

/** A hold as the APIs answer it: the row, plus placed_by / placed_at (the names staff tools use for created_by / created_at). */
function holdPublic(h) {
    if (!h) return null;
    return { ...h, note: h.note ?? null, placed_by: h.created_by ?? null, placed_at: h.created_at ?? null };
}

function releaseHold(holdId, releasedBy = null) {
    return db.getDb().transaction(() => {
        const r = db.run('UPDATE media_holds SET released_at = CURRENT_TIMESTAMP, released_by = ? WHERE id = ? AND released_at IS NULL', [releasedBy, holdId]);
        const hold = db.get('SELECT * FROM media_holds WHERE id = ?', [holdId]);
        if (r.changes) announceHold('hold.released', hold, releasedBy);
        return hold;
    })();
}

// ── Native objects: soft delete, restore, purge, quota ───────

function objectFilePath(obj) {
    return path.join(config.objects.path, obj.app_id, obj.id);
}

function softDelete(obj, { by = null } = {}) {
    if (isHeld(obj.id)) throw new HeldError(obj.id);
    const md = parseJson(obj.metadata, {});
    md.pre_delete_status = obj.lifecycle_status;
    md.retention_until = new Date(Date.now() + config.objects.retentionDays * 864e5).toISOString();
    if (by) md.deleted_by = by;
    const events = require('../events');
    db.getDb().transaction(() => {
        db.run(`UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = CURRENT_TIMESTAMP, metadata = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`, [JSON.stringify(md), obj.id]);
        events.recordObjectChanges();       // media.object.deleted commits with the delete
    })();
    events.kick();
    return getObject(obj.id);
}

function restore(obj) {
    const md = parseJson(obj.metadata, {});
    if (md.purged_at) return null;
    const back = md.pre_delete_status && md.pre_delete_status !== 'deleted' ? md.pre_delete_status : 'ready';
    delete md.pre_delete_status; delete md.retention_until; delete md.deleted_by;
    db.run(`UPDATE media_objects SET lifecycle_status = ?, deleted_at = NULL, metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [back, JSON.stringify(md), obj.id]);
    return getObject(obj.id);
}

/**
 * Remove the bytes of native (v2) objects deleted longer ago than the retention
 * period. Projected objects are never purged here — their bytes belong to the
 * inherited pipelines. Held objects are skipped.
 */
function purgeExpired({ retentionDays = config.objects.retentionDays } = {}) {
    const rows = db.all(`SELECT * FROM media_objects WHERE lifecycle_status = 'deleted' AND legacy_ref IS NULL
                         AND deleted_at <= datetime('now', ?)`, [`-${Math.max(0, retentionDays)} days`]);
    const root = path.resolve(config.objects.path) + path.sep;
    let purged = 0;
    for (const obj of rows) {
        const md = parseJson(obj.metadata, {});
        if (md.purged_at || isHeld(obj.id)) continue;
        for (const l of listLocations(obj.id)) {
            if (l.provider === 'local' && path.resolve(l.key).startsWith(root)) { try { fs.unlinkSync(l.key); } catch { /* already gone */ } }
            if (l.provider === 'local') db.run('DELETE FROM media_locations WHERE id = ?', [l.id]);
        }
        md.purged_at = new Date().toISOString();
        db.run('UPDATE media_objects SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(md), obj.id]);
        purged++;
    }
    return purged;
}

/** Bytes counted against apps.quota_bytes: v1 files + live native objects (reservations included). */
function usedBytes(appId, excludeId = null) {
    // Developer-project tenants (third-party uploaders) also pay for soft-deleted bytes until they are
    // purged: those stay on disk for the retention period, and upload -> delete -> upload would
    // otherwise grow the disk without bound.
    const app = db.getApp(appId);
    const retained = app && app.project_id ? " OR (lifecycle_status = 'deleted' AND json_extract(metadata, '$.purged_at') IS NULL)" : '';
    const native = db.get(`SELECT COALESCE(SUM(size_bytes), 0) AS b FROM media_objects
                           WHERE app_id = ? AND legacy_ref IS NULL AND (lifecycle_status IN ('uploading', 'ready')${retained}) AND id != ?`,
    [appId, excludeId || '']).b;
    return db.appFilesBytes(appId) + native;
}

// ── Public shape ─────────────────────────────────────────────

/** Where a projected object is served today (the inherited public URL), or null. */
function legacyPublicUrl(obj) {
    const ref = parseLegacyRef(obj.legacy_ref);
    if (!ref) return null;
    const id = encodeURIComponent(ref.id);
    const p = { vod: `/v/${id}`, clip: `/c/${id}`, file: `/f/${id}`, thumbnail: `/t/${id}`, paste: `/p/${id}/screenshot`, avatar: `/p/${id}/screenshot` }[ref.kind];
    return p ? config.publicUrl + p : null;
}

function objectPublic(obj, { locations = true } = {}) {
    if (!obj) return null;
    const locs = listLocations(obj.id);
    const out = {
        id: obj.id,
        media_ref: { media_id: obj.id },
        legacy_ref: obj.legacy_ref || null,
        app_id: obj.app_id,
        namespace: obj.namespace,
        kind: obj.kind,
        owner: { subject: obj.owner_subject || null, app: obj.owner_app || null, user_id: obj.owner_user_id ?? null },
        visibility: obj.visibility,
        lifecycle_status: obj.lifecycle_status,
        mime_type: obj.mime_type,
        size_bytes: obj.size_bytes,
        content_hash: obj.content_hash || null,
        metadata: parseJson(obj.metadata, {}),
        held: isHeld(obj.id),
        // metadata / bytes_verified / playable, from this row and its copies' recorded checks (objects/readiness.js).
        readiness: require('./readiness').compute(obj, locs),
        // Developer-project sandbox objects have no public URL: /download hands out signed ones.
        public_url: obj.visibility !== 'private' && obj.lifecycle_status === 'ready' && !db.isSandboxTenant(obj.app_id)
            ? (legacyPublicUrl(obj) || `${config.publicUrl}/o/${obj.id}`) : null,
        created_at: obj.created_at,
        updated_at: obj.updated_at,
        deleted_at: obj.deleted_at || null,
    };
    if (db.isSandboxTenant(obj.app_id)) out.sandbox = true;
    // Where the bytes are, never the keys or paths themselves.
    if (locations) {
        out.locations = locs.map(l => ({
            provider: l.provider, storage_class: l.storage_class, state: l.state, size_bytes: l.size_bytes,
            verified_at: l.verified_at, canonical: l.provider === obj.canonical_provider,
        }));
    }
    return out;
}

module.exports = {
    KINDS, VISIBILITIES, LIFECYCLES, HOLD_KINDS, HeldError,
    mimeFor, parseJson, parseLegacyRef, thumbFileFromUrl,
    getObject, getObjectByLegacyRef, resolveObject, listLocations, listHolds, inheritedHolds, isHeld, isHeldRow,
    createObject, updateObject, upsertLocation, setLocationState, setRelationship, setVariant, getVariant,
    vodProjection, clipProjection, fileProjection, pasteProjection, thumbnailProjection,
    syncVod, syncClip, syncFile, syncPaste, sync, safeSync, withObject, withObjectOrRow, afterTierMove,
    placeHold, releaseHold, holdPublic,
    objectFilePath, softDelete, restore, purgeExpired, usedBytes,
    legacyPublicUrl, objectPublic,
};
