/**
 * OpenVibe.Media — object reconciliation (docs/object-model.md#reconciliation)
 *
 * Compares the object model with the bytes. Read-only by default: it checks
 * local files and the database and reports. With verify=true it also HEADs
 * every B2/R2 location (through the storage engine's S3 client, or an injected
 * `head` for tests) and writes what it learned back to media_locations
 * (state present/missing/corrupt, size, verified_at). Never deletes anything.
 *
 * Detects:
 *   no_canonical_location           ready object with no row for its canonical copy
 *   canonical_missing_replica_present canonical copy gone/corrupt while another copy is present
 *   no_present_copy                 ready object with no present copy anywhere
 *   missing_local_file              ready object's local location whose file is not on disk
 *   remote_missing                  ready object's B2/R2 location whose HEAD says 404 (verify)
 *   size_mismatch / hash_mismatch   bytes differ from the object's size / sha256
 *   orphan_location                 location rows whose object does not exist
 *   deleted_publicly_reachable      deleted object still served (legacy row, or a thumbnail of it)
 *   missing_projection              inherited rows with no object yet (run the backfill)
 *   incomplete_multipart            multipart sessions still open past their expiry (the hourly purge
 *                                   removes their parts; one listed here means the purge is not running)
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');
const model = require('./model');

const MB = 1024 * 1024;
const ISSUES = ['no_canonical_location', 'canonical_missing_replica_present', 'no_present_copy', 'missing_local_file', 'remote_missing',
    'size_mismatch', 'hash_mismatch', 'orphan_location', 'deleted_publicly_reachable', 'missing_projection', 'incomplete_multipart'];

/** Real provider: undefined when the provider is not configured here (cannot verify), null on 404. */
async function defaultHead(provider, key) {
    const vs = require('../vod/vod-storage');
    if (!vs.providerConfigured(provider)) return undefined;
    return vs.headObject(provider, key);
}

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', d => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

// Which inherited row serves a projected object, and is it reachable without credentials?
const PROJECTIONS = [
    { table: 'vods', open: (r) => (r.visibility || (r.is_public ? 'public' : 'private')) !== 'private' && !r.clips_only },
    { table: 'clips', open: (r) => (r.visibility || (r.is_public ? 'public' : 'private')) !== 'private' },
    { table: 'files', open: () => true },
    { table: 'pastes', open: (r) => r.visibility !== 'private' && !!r.screenshot_path },
];

async function reconcile({ verify = false, hash = false, head = defaultHead, hashMaxBytes = 512 * MB, appId = null, listLimit = 200 } = {}) {
    const report = {
        generated_at: new Date().toISOString(),
        mode: { verify: !!verify, hash: !!hash, app_id: appId },
        counts: { objects: 0, locations: 0, local_checked: 0, remote_checked: 0, remote_unverified: 0, remote_unverifiable: 0, locations_updated: 0 },
        issues: Object.fromEntries(ISSUES.map(k => [k, { count: 0, items: [] }])),
    };
    const issue = (k, item) => { const i = report.issues[k]; i.count++; if (i.items.length < listLimit) i.items.push(item); };

    const objects = db.all(`SELECT * FROM media_objects${appId ? ' WHERE app_id = ?' : ''}`, appId ? [appId] : []);
    const byId = new Map(objects.map(o => [o.id, o]));
    const locations = appId
        ? db.all('SELECT l.* FROM media_locations l LEFT JOIN media_objects o ON o.id = l.object_id WHERE o.app_id = ? OR o.id IS NULL', [appId])
        : db.all('SELECT * FROM media_locations');
    report.counts.objects = objects.length;
    report.counts.locations = locations.length;

    const effective = new Map();   // location id → state after this run's checks
    const byObject = new Map();
    const write = (loc, state, size) => {
        if (!verify) return;
        model.setLocationState(loc.id, { state, size_bytes: size });
        report.counts.locations_updated++;
    };

    for (const loc of locations) {
        const obj = byId.get(loc.object_id);
        if (!obj) { issue('orphan_location', { location_id: loc.id, object_id: loc.object_id, provider: loc.provider }); continue; }
        if (!byObject.has(obj.id)) byObject.set(obj.id, []);
        byObject.get(obj.id).push(loc);
        // Missing bytes are an issue for ready objects; a recording or upload may not have written yet.
        const live = obj.lifecycle_status === 'ready';
        const expected = Number(obj.size_bytes) || 0;
        const sizeMatters = obj.lifecycle_status === 'ready' && expected > 0;

        if (loc.provider === 'local') {
            report.counts.local_checked++;
            let st = null;
            try { const s = fs.statSync(loc.key); if (s.isFile()) st = s; } catch { /* missing */ }
            if (!st) {
                effective.set(loc.id, 'missing');
                if (live) issue('missing_local_file', { object_id: obj.id, kind: obj.kind, legacy_ref: obj.legacy_ref, path: loc.key });
                write(loc, 'missing', null);
                continue;
            }
            let state = 'present';
            if (sizeMatters && st.size !== expected) {
                issue('size_mismatch', { object_id: obj.id, provider: 'local', expected, actual: st.size, legacy_ref: obj.legacy_ref });
            }
            if (hash && obj.content_hash && st.size <= hashMaxBytes) {
                const actual = await sha256File(loc.key).catch(() => null);
                if (actual && actual !== obj.content_hash) {
                    state = 'corrupt';
                    issue('hash_mismatch', { object_id: obj.id, provider: 'local', expected: obj.content_hash, actual });
                }
            }
            effective.set(loc.id, state);
            write(loc, state, st.size);
            continue;
        }

        // b2 / r2
        if (!verify) {
            effective.set(loc.id, loc.state);
            if (loc.state === 'pending') report.counts.remote_unverified++;
            continue;
        }
        let h;
        try { h = await head(loc.provider, loc.key, loc.bucket); } catch { h = undefined; report.counts.remote_unverifiable++; effective.set(loc.id, loc.state); continue; }
        if (h === undefined) { report.counts.remote_unverifiable++; effective.set(loc.id, loc.state); continue; }
        report.counts.remote_checked++;
        if (!h) {
            effective.set(loc.id, 'missing');
            if (live) issue('remote_missing', { object_id: obj.id, provider: loc.provider, key: loc.key, legacy_ref: obj.legacy_ref });
            write(loc, 'missing', null);
            continue;
        }
        let state = 'present';
        if (sizeMatters && Number(h.size) !== expected) {
            state = 'corrupt';
            issue('size_mismatch', { object_id: obj.id, provider: loc.provider, expected, actual: Number(h.size), legacy_ref: obj.legacy_ref });
        }
        effective.set(loc.id, state);
        write(loc, state, Number(h.size));
    }

    // Per object: is the canonical copy there, and is any copy there at all?
    for (const obj of objects) {
        if (obj.lifecycle_status !== 'ready') continue;
        const locs = byObject.get(obj.id) || [];
        const canon = obj.canonical_provider ? locs.find(l => l.provider === obj.canonical_provider) : null;
        const present = locs.filter(l => effective.get(l.id) === 'present');
        if (!canon) {
            issue('no_canonical_location', { object_id: obj.id, kind: obj.kind, canonical_provider: obj.canonical_provider, legacy_ref: obj.legacy_ref });
        } else if (['missing', 'corrupt'].includes(effective.get(canon.id))) {
            if (present.length) issue('canonical_missing_replica_present', { object_id: obj.id, canonical: canon.provider, present: present.map(l => l.provider), legacy_ref: obj.legacy_ref });
        }
        const knownGone = locs.length && locs.every(l => ['missing', 'corrupt'].includes(effective.get(l.id)));
        if (knownGone) issue('no_present_copy', { object_id: obj.id, kind: obj.kind, legacy_ref: obj.legacy_ref });
    }

    // Deleted objects that the inherited routes still serve.
    for (const p of PROJECTIONS) {
        const rows = db.all(`SELECT t.* FROM ${p.table} t JOIN media_objects o ON o.id = t.object_id WHERE o.lifecycle_status = 'deleted'${appId ? ' AND o.app_id = ?' : ''}`, appId ? [appId] : []);
        for (const r of rows) if (p.open(r)) issue('deleted_publicly_reachable', { object_id: r.object_id, table: p.table, id: r.id ?? r.key, reason: 'the inherited row still serves it' });
    }
    // …and derivatives (thumbnails) of deleted objects that are still served by name.
    const orphanThumbs = db.all(`SELECT d.* FROM media_variants v JOIN media_objects p ON p.id = v.object_id JOIN media_objects d ON d.id = v.derived_object_id
                                 WHERE p.lifecycle_status = 'deleted' AND d.lifecycle_status != 'deleted' AND d.visibility != 'private'${appId ? ' AND p.app_id = ?' : ''}`, appId ? [appId] : []);
    for (const d of orphanThumbs) {
        const loc = (byObject.get(d.id) || []).find(l => effective.get(l.id) === 'present');
        if (loc) issue('deleted_publicly_reachable', { object_id: d.id, kind: d.kind, legacy_ref: d.legacy_ref, reason: 'derivative of a deleted object is still served' });
    }

    // Inherited rows the model does not cover yet.
    const gaps = [
        ['vods', 'id', 'object_id IS NULL AND COALESCE(clips_only, 0) = 0'],
        ['clips', 'id', 'object_id IS NULL'],
        ['files', 'key', 'object_id IS NULL'],
        ['pastes', 'id', "object_id IS NULL AND type = 'screenshot' AND screenshot_path IS NOT NULL"],
    ];
    for (const [table, keyCol, cond] of gaps) {
        for (const r of db.all(`SELECT ${keyCol} AS k FROM ${table} WHERE ${cond}${appId ? ' AND app_id = ?' : ''}`, appId ? [appId] : [])) {
            issue('missing_projection', { table, id: r.k });
        }
    }

    for (const u of db.all(`SELECT u.*, (SELECT COUNT(*) FROM media_upload_parts p WHERE p.upload_id = u.id) AS parts_received FROM media_uploads u
                            WHERE u.status IN ('active', 'completing') AND u.expires_at < datetime('now')${appId ? ' AND u.app_id = ?' : ''}`, appId ? [appId] : [])) {
        issue('incomplete_multipart', { upload_id: u.id, object_id: u.object_id, parts_received: u.parts_received, parts_expected: u.parts_expected, expires_at: u.expires_at });
    }

    report.total_issues = ISSUES.reduce((n, k) => n + report.issues[k].count, 0);
    return report;
}

function summarize(report) {
    const c = report.counts;
    const lines = [`objects ${c.objects}, locations ${c.locations} (local checked ${c.local_checked}, remote checked ${c.remote_checked}, `
        + `remote unverified ${c.remote_unverified}, unverifiable ${c.remote_unverifiable}${report.mode.verify ? `, updated ${c.locations_updated}` : ''})`];
    for (const k of ISSUES) if (report.issues[k].count) lines.push(`  ${k}: ${report.issues[k].count}`);
    if (!report.total_issues) lines.push('  no issues');
    return lines.join('\n');
}

module.exports = { reconcile, summarize, ISSUES, defaultHead };
