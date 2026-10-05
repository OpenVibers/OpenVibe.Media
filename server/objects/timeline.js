/**
 * OpenVibe.Media — the timeline index (media_timeline; docs/media-fabric.md §3, F3.1).
 *
 * A video object is a timeline of CMAF segments per rendition. This module is the store: it answers
 * "the bytes for 01:47:12.350" (segmentAt) and "the segments of a rendition in order" (segments) without
 * opening a file, and writes the playlists from the rows. Segment 0 of a rendition is its init segment.
 *
 * Bytes: <object>/<rendition>/<version>/<name> is the segment's key, `version` the sha prefix of the bytes, so a re-cut
 * writes beside the old one instead of over it; a copy on this node's disk sits at
 * OBJECTS_PATH/.timeline/<app>/<object>/<rendition>/<version>/<name> (local_path), and a durable one under the same key
 * on durable_provider. The name alone is the playlist URI, so a row carries the versioned location it serves from. The
 * object.cmaf job (server/jobs/cmaf.js) writes the source rendition; the public routes
 * /o/:id/master.m3u8 and /o/:id/source/… (objects/routes.js) serve it behind MEDIA_HLS_ENABLED.
 *
 * Packed (F3.3): object.pack (server/jobs/pack.js) concatenates ~60 s of durable segments into one chunk object. A packed
 * row's key/local_path/durable_provider then name the chunk, packed_object_id its sha256 (content address) and
 * byte_offset/byte_length the segment's bytes inside it; its name, times and sha256 stay the segment's. Several rows
 * share one chunk, so the bytes are deleted once per location and kept (for a retry) while any delete of them fails.
 *
 * Locations are shared (§3/§4): any number of rows — of any number of objects (a source and the clips over it, F3.5/F4) —
 * may name one location, because a location is content-addressed and names bytes, not an owner. A location's bytes are
 * deleted only when no row names it. "How many objects name this location?" is a query over these rows (namedElsewhere),
 * never a counter table, so a count cannot drift from them; migration 0003 indexes (durable_provider, key) and
 * (local_path) for it. removeObject and deleteBytes therefore keep a location another object's rows still name, and
 * object.pack re-keys every row that names a packed segment's old location (same sha256) to the chunk in the same
 * transaction, so a clip follows its source into the chunk and the per-segment location is freed only once nothing names
 * it. A source's own purge deletes its rows; the shared bytes go when the last naming object does.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');

const SOURCE = 'source';
const INIT_NAME = 'init.mp4';
const FIELDS = ['name', 'start_ms', 'end_ms', 'keyframe_ms', 'key', 'local_path', 'durable_provider', 'packed_object_id', 'byte_offset', 'byte_length', 'sha256', 'durability'];

function localRoot() { return path.join(path.resolve(config.objects.path), '.timeline'); }
/** `version` names the immutable set of bytes (the sha's prefix): a re-cut lands beside the old one instead of on it. */
function localPathFor(obj, rendition, name, version = null) {
    return path.join(localRoot(), obj.app_id, obj.id, rendition, ...(version ? [version] : []), name);
}
function keyFor(objectId, rendition, name, version = null) { return `${objectId}/${rendition}/${version ? `${version}/` : ''}${name}`; }
function segmentName(seq) { return seq === 0 ? INIT_NAME : `${String(seq).padStart(6, '0')}.m4s`; }

/** Every row of a rendition in order, the init segment (seq 0) first. */
async function list(objectId, rendition = SOURCE) {
    return await db.all('SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? ORDER BY seq', [objectId, rendition]);
}

/** The media segments of a rendition in order (no init segment). */
async function segments(objectId, rendition = SOURCE) {
    return await db.all('SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > 0 ORDER BY seq', [objectId, rendition]);
}

async function byName(objectId, rendition, name) {
    return await db.get('SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? AND name = ?', [objectId, rendition, name]) || null;
}

async function has(objectId, rendition = SOURCE) {
    return !!(await db.get('SELECT 1 AS x FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > 0 LIMIT 1', [objectId, rendition]));
}

/** The segment holding the instant tMs (milliseconds from the start): start_ms <= t < end_ms, or null past either end. */
async function segmentAt(objectId, rendition, tMs) {
    const t = Math.floor(Number(tMs));
    if (!Number.isFinite(t) || t < 0) return null;
    const row = await db.get(`SELECT * FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > 0 AND start_ms <= ?
                              ORDER BY start_ms DESC, seq DESC LIMIT 1`, [objectId, rendition, t]);
    return row && t < Number(row.end_ms) ? row : null;
}

function same(a, b) {
    return FIELDS.every((f) => (a[f] == null ? null : String(a[f])) === (b[f] == null ? null : String(b[f])));
}

/** Inside a transaction: replace() and markPacked() of one object take turns, so each sees the other's commit. */
async function lockObject(objectId) {
    await db.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`media.timeline:${objectId}`]);
}

/** Thrown by replace() when the rows changed since the caller read them (`expect`). */
class TimelineChanged extends Error {}

/**
 * Make the rows of one rendition exactly `rows` (each { seq, name, start_ms, … }), in one transaction: a row that already
 * says the same is not written, a changed one is updated, rows past the new end are dropped. → { inserted, updated, unchanged, removed }.
 * `expect` (the rows the caller read, by seq) makes it compare-and-set: if any row's location or packing changed meanwhile
 * (an object.pack committed), nothing is written and TimelineChanged is thrown.
 */
async function replace(objectId, rendition, rows, { jobId = null, expect = null } = {}) {
    const out = { inserted: 0, updated: 0, unchanged: 0, removed: 0 };
    await db.getDb().tx(async () => {
        await lockObject(objectId);
        const before = new Map((await list(objectId, rendition)).map((r) => [Number(r.seq), r]));
        if (expect) {
            const at = (r) => (r ? ['key', 'local_path', 'durable_provider', 'packed_object_id', 'sha256'].map((f) => (r[f] == null ? '' : String(r[f]))).join('\n') : null);
            const seqs = new Set([...before.keys(), ...expect.keys()]);
            for (const q of seqs) if (at(before.get(q)) !== at(expect.get(q))) throw new TimelineChanged(`timeline of ${objectId}/${rendition} changed (seq ${q})`);
        }
        for (const r of rows) {
            const prev = before.get(r.seq);
            if (prev && same(prev, r)) { out.unchanged++; continue; }
            await db.run(`INSERT INTO media_timeline (object_id, rendition, seq, ${FIELDS.join(', ')}, job_id)
                          VALUES (?, ?, ?, ${FIELDS.map(() => '?').join(', ')}, ?)
                          ON CONFLICT (object_id, rendition, seq) DO UPDATE SET ${FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
                              job_id = excluded.job_id, updated_at = ov_now()`,
            [objectId, rendition, r.seq, ...FIELDS.map((f) => r[f] ?? null), jobId]);
            out[prev ? 'updated' : 'inserted']++;
        }
        const last = rows.reduce((m, r) => Math.max(m, r.seq), -1);
        out.removed = (await db.run('DELETE FROM media_timeline WHERE object_id = ? AND rendition = ? AND seq > ?', [objectId, rendition, last])).changes || 0;
    });
    return out;
}

/**
 * Delete the bytes a set of rows names: this node's copy (only inside the timeline root) and the durable copy. A remote
 * delete that fails is returned, never swallowed: the caller keeps (or restores) those rows, and their keys, so a later
 * pass retries. A location any row still names (`isNamed`, across EVERY object, the caller's own included) is kept,
 * never deleted: it is shared (a source and the clips over it). Callers therefore delete the rows that named a location
 * first, in one transaction, so the check sees the other objects' rows: concurrent removals of objects sharing a
 * location converge on the last committer deleting it, and a double delete is idempotent. → { failed: [{ row, provider,
 * key, error }], kept: [{ row, provider, key }] } (kept = intentionally not deleted; for a local location provider is 'local').
 */
async function deleteBytes(rows) {
    const root = localRoot() + path.sep;
    const vodStorage = require('../vod/vod-storage');
    const dirs = new Set();
    const failed = [];
    const kept = [];
    const done = new Set();   // a packed chunk is named by every row it holds: each location is handled once
    for (const r of rows) {
        if (r.local_path && path.resolve(r.local_path).startsWith(root) && !done.has(`local\n${r.local_path}`)) {
            done.add(`local\n${r.local_path}`);
            if (await isNamed({ localPath: r.local_path })) kept.push({ row: r, provider: 'local', key: r.local_path });
            else { try { fs.unlinkSync(r.local_path); } catch { /* already gone */ } dirs.add(path.dirname(r.local_path)); }
        }
        if (r.durable_provider && vodStorage.providerConfigured(r.durable_provider) && !done.has(`${r.durable_provider}\n${r.key}`)) {
            done.add(`${r.durable_provider}\n${r.key}`);
            if (await isNamed({ provider: r.durable_provider, key: r.key })) kept.push({ row: r, provider: r.durable_provider, key: r.key });
            else {
                const ok = await vodStorage.deleteObject(r.durable_provider, r.key);
                if (!ok) failed.push({ row: r, provider: r.durable_provider, key: r.key, error: 'delete failed' });
            }
        }
    }
    for (const d of dirs) {
        for (const p of [d, path.dirname(d)]) { try { fs.rmdirSync(p); } catch { /* not empty or gone */ } }
    }
    return { failed, kept };
}

/**
 * Whether any row of ANOTHER object names this location (a durable `provider` + `key`, or a local `localPath`), i.e.
 * whether its bytes are shared with an object other than `exceptObjectId`. That is the reference count's only question:
 * a location's bytes may be deleted exactly when this is false. Keys and paths are content-addressed, so two objects'
 * rows can name one location (a source and the clips over it). `exceptObjectId`, when given, is an object whose own rows
 * to ignore (a caller that has not deleted them yet); null counts every object (isNamed).
 */
async function namedElsewhere({ provider = null, key = null, localPath = null }, exceptObjectId = null) {
    const skip = exceptObjectId ? ' AND object_id <> ?' : '';
    const rest = exceptObjectId ? [exceptObjectId] : [];
    if (provider && key && await db.get(`SELECT 1 AS x FROM media_timeline WHERE durable_provider = ? AND key = ?${skip} LIMIT 1`, [provider, key, ...rest])) return true;
    if (localPath && await db.get(`SELECT 1 AS x FROM media_timeline WHERE local_path = ?${skip} LIMIT 1`, [localPath, ...rest])) return true;
    return false;
}

/**
 * Whether any timeline row still names this location. Keys and paths are content-addressed, so a run that lost a race
 * may have built exactly the bytes a winner committed: it deletes what it staged only when no row names it.
 */
async function isNamed(loc) { return await namedElsewhere(loc, null); }

/** Put a row back exactly as it was read, so a later pass retries a delete that failed (a packed chunk: every row). */
async function reinsertRow(r) {
    await db.run(`INSERT INTO media_timeline (object_id, rendition, seq, ${FIELDS.join(', ')}, job_id)
                  VALUES (?, ?, ?, ${FIELDS.map(() => '?').join(', ')}, ?)
                  ON CONFLICT (object_id, rendition, seq) DO UPDATE SET ${FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
                      job_id = excluded.job_id, updated_at = ov_now()`,
    [r.object_id, r.rendition, r.seq, ...FIELDS.map((f) => r[f] ?? null), r.job_id ?? null]);
}

/**
 * The object's whole timeline is gone with its bytes (a purge, or a vod/clip deleted for good): row, then local files,
 * then the durable copies. The rows go first, in one transaction, and the bytes are deleted only once `isNamed` — a
 * check across ALL objects — sees no row naming a location; a location another object's rows still name is kept (its
 * rows are already gone, the shared bytes stay, and they are deleted when the last naming object is removed). That is
 * what makes concurrent removals converge: each remover deletes its rows before checking, so the last one to commit
 * sees no naming row and deletes, and the loser's double delete is idempotent. A durable delete that failed gets its
 * rows back — with their keys — so a later pass retries; dropping them would lose the only record of the bytes still in
 * B2/R2. Callers have already refused a held object. → { removed, pending } (pending = rows restored for a retry).
 */
async function removeObject(objectId) {
    if (!objectId) return { removed: 0, pending: 0 };
    const rows = await db.all('SELECT * FROM media_timeline WHERE object_id = ?', [objectId]);
    if (!rows.length) return { removed: 0, pending: 0 };
    // (a) The rows go first, in one transaction, before their bytes; the delete is not conditioned on what another
    // object still names, so two concurrent removals of a shared location cannot each keep it and both drop their rows.
    let removed = 0;
    await db.getDb().tx(async () => {
        removed = (await db.run('DELETE FROM media_timeline WHERE object_id = ?', [objectId])).changes || 0;
    });
    // (b) After the commit, each location the rows named, deleted only when no row of ANY object names it.
    const { failed } = await deleteBytes(rows);
    // (c) Every row naming a location whose delete failed is restored: for a packed chunk that is all the rows it holds.
    const stuck = new Set(failed.map((f) => `${f.provider}\n${f.key}`));
    let pending = 0;
    for (const r of rows) {
        if (r.durable_provider && stuck.has(`${r.durable_provider}\n${r.key}`)) { await reinsertRow(r); pending++; }
    }
    if (pending) console.warn(`[Timeline] ${objectId}: ${pending} segment row(s) kept — their durable copy could not be deleted`);
    return { removed, pending };
}

/**
 * Point rows at the chunk they were packed into, in one transaction. `updates` = [{ row, key, local_path,
 * durable_provider, packed_object_id, byte_offset }]; the location is the segment's old key (content-addressed, versioned
 * by its sha), and EVERY row of any object that names it with the same sha256 — the source's, and a clip's over it —
 * moves to the chunk in this same transaction, so a clip follows its source into the chunk. Each group changes only if
 * it still names the unpacked segment the packer read (same key and sha256, not packed) AND at least one changed row is
 * `objectId`'s own: a re-cut in between makes the whole commit roll back and false is returned, so the caller drops its
 * chunk. Without that second condition a re-cut source row (new key/sha) would leave only a clip's same-sha row matching
 * and the pack would commit while the source is not in the chunk. A row naming the old location with a different sha256
 * (which should not happen) does not match, is left alone, and so keeps the old location named (its bytes are not
 * deleted). Never deletes a row.
 */
async function markPacked(objectId, updates, { jobId = null } = {}) {
    const CONFLICT = new Error('timeline changed');
    try {
        await db.getDb().tx(async () => {
            await lockObject(objectId);
            for (const u of updates) {
                // The old location: the durable pair when the row was durable (packed rows always are), the local copy
                // too. The (durable_provider, key) index serves the first, (local_path) the second.
                const loc = u.row.durable_provider ? '(durable_provider = ? AND key = ?)' : 'key = ?';
                const at = u.row.durable_provider ? [u.row.durable_provider, u.row.key] : [u.row.key];
                const names = u.row.local_path ? `(${loc} OR local_path = ?)` : loc;
                const r = await db.run(`UPDATE media_timeline SET key = ?, local_path = ?, durable_provider = ?, durability = 'durable',
                                           packed_object_id = ?, byte_offset = ?, byte_length = ?, job_id = ?, updated_at = ov_now()
                                        WHERE sha256 = ? AND packed_object_id IS NULL AND ${names}
                                        RETURNING object_id`,
                [u.key, u.local_path, u.durable_provider, u.packed_object_id, u.byte_offset, u.row.byte_length, jobId,
                    u.row.sha256, ...at, ...(u.row.local_path ? [u.row.local_path] : [])]);
                // The pack changes `objectId`'s OWN timeline: at least one re-keyed row must be its. A re-cut between
                // the read and this commit leaves the source's row with a new key/sha; the same-sha match is then only
                // some other object's row (a clip's), and committing would leave the source out of the chunk it names.
                // Treat that as a conflict — nothing is written and the caller drops its chunk and retries.
                if (!r.rows.some((row) => String(row.object_id) === String(objectId))) throw CONFLICT;
            }
        });
        return true;
    } catch (err) {
        if (err === CONFLICT) return false;
        throw err;
    }
}

/**
 * The durable provider for bytes derived from `obj` (segments, packed chunks), chosen by the placement router like
 * every other provider choice (derive.js): the provider of the object's own best-ranked remote copy, else the best
 * configured, healthy one. Purpose `durable` ranks the canonical tier (B2) before the hot cache (R2). null = none.
 */
async function durableProvider(obj) {
    const router = require('../placement/router');
    const remote = (d) => (d.candidates || []).find((c) => c.provider !== 'local');
    const own = remote(await router.route({ object: obj, purpose: 'durable', presign: false }));
    if (own) return own.provider;
    const vodStorage = require('../vod/vod-storage');
    const configured = vodStorage.REMOTE_PROVIDERS.filter((p) => vodStorage.providerConfigured(p)).map((p) => ({ provider: p, key: p, state: 'present' }));
    const any = remote(await router.route({ locations: configured, purpose: 'durable', presign: false }));
    return any ? any.provider : null;
}

/** The copies of a row's bytes as router locations: this node's file, then the durable copy. */
function locationsOf(row) {
    const out = [];
    if (row.local_path && fs.existsSync(row.local_path)) out.push({ provider: 'local', key: row.local_path, state: 'present' });
    if (row.durable_provider && row.durability === 'durable') out.push({ provider: row.durable_provider, key: row.key, state: 'present' });
    return out;
}

// ── Playlists (from the rows, never from files) ──────────────

const secs = (ms) => (Number(ms) / 1000).toFixed(3);

/** `?exp=…&sig=…` carried onto every URI of a signed playlist, so a private object's segments pass the same check. */
function withQuery(uri, query) { return query ? `${uri}?${query}` : uri; }

/** The media playlist of a finished rendition: VOD, ENDLIST, one EXTINF per segment with its timeline duration. */
function mediaPlaylist(rows, { query = '' } = {}) {
    const segs = rows.filter((r) => Number(r.seq) > 0);
    const init = rows.find((r) => Number(r.seq) === 0);
    const target = Math.max(1, ...segs.map((r) => Math.ceil((Number(r.end_ms) - Number(r.start_ms)) / 1000)));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${segs.length ? Number(segs[0].seq) : 1}`,
        '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (init) lines.push(`#EXT-X-MAP:URI="${withQuery(init.name, query)}"`);
    for (const r of segs) lines.push(`#EXTINF:${secs(Number(r.end_ms) - Number(r.start_ms))},`, withQuery(r.name, query));
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
}

/** The master playlist: one variant per rendition (only `source` in F3.1), BANDWIDTH = its peak segment bitrate. */
function masterPlaylist(renditions, { query = '' } = {}) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const { name, rows } of renditions) {
        const segs = rows.filter((r) => Number(r.seq) > 0);
        const rate = (r) => Math.ceil(Number(r.byte_length) * 8 * 1000 / Math.max(1, Number(r.end_ms) - Number(r.start_ms)));
        const peak = Math.max(1, ...segs.map(rate));
        const total = segs.reduce((a, r) => a + Number(r.end_ms) - Number(r.start_ms), 0);
        const avg = Math.max(1, Math.ceil(segs.reduce((a, r) => a + Number(r.byte_length), 0) * 8 * 1000 / Math.max(1, total)));
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${peak},AVERAGE-BANDWIDTH=${avg}`, withQuery(`${name}/index.m3u8`, query));
    }
    lines.push('');
    return lines.join('\n');
}

// ── Clips (docs/media-fabric.md §4, F3.5) ───────────────────
/**
 * A virtual clip is a manifest over its source's rows: the media segments intersecting [startMs, endMs), the source's
 * init segment, seq renumbered 1..n, each row's times clipped to the window (and made relative to its start). key,
 * local_path, durable_provider, packed_object_id and byte_* stay the source's, so a segment serves from the source's
 * bytes (or its packed chunk), and its name, the playlist URI, never changes. A segment straddling an edge is served
 * whole: a virtual clip's edges are the source's segment boundaries (a materialized clip cuts exactly).
 */
function clipRows(rows, startMs, endMs) {
    const init = rows.find((r) => Number(r.seq) === 0);
    const segs = rows
        .filter((r) => Number(r.seq) > 0 && Number(r.end_ms) > startMs && Number(r.start_ms) < endMs)
        .map((r) => ({ ...r, start_ms: Math.max(Number(r.start_ms), startMs) - startMs, end_ms: Math.min(Number(r.end_ms), endMs) - startMs }))
        .filter((r) => r.end_ms > r.start_ms)
        .map((r, i) => ({ ...r, seq: i + 1 }));
    return segs.length && init ? [{ ...init, seq: 0, start_ms: 0, end_ms: 0 }, ...segs] : segs;
}

module.exports = {
    SOURCE, INIT_NAME, FIELDS, localRoot, localPathFor, keyFor, segmentName,
    list, segments, byName, has, segmentAt, replace, TimelineChanged, isNamed, namedElsewhere, deleteBytes, removeObject, markPacked, durableProvider, locationsOf,
    mediaPlaylist, masterPlaylist, clipRows,
};
