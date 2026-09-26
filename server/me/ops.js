/**
 * OpenVibe.Media — operator views over the object platform (roadmap WS-G task 12;
 * docs/object-model.md#operator-views).
 *
 *   report({ appId, limit })   failed jobs, missing media, backfill status, tiering diagnostics and the
 *                              namespaces' usage snapshot; appId narrows everything that has a tenant
 *                              (the tiering sweep and the provider switches are service-wide)
 *   recompute({ appId })       refresh the namespaces' usage snapshot from the rows (namespaces.reconcile),
 *                              the one write here
 *
 * Read from the database only: no provider is called, no file is opened and no directory is walked, so
 * a page load stays cheap and a restore drill (MEDIA_DRILL) can render it. Nothing runs at load.
 * Callers: GET /api/v2/me/ops and /me/ops (a Network token with staff.site.view; the recompute needs
 * staff.site.configure), GET /api/v1/:app/admin/storage/ops (the app key, scoped to that app).
 */
'use strict';

const db = require('../db/database');
const namespaces = require('../objects/namespaces');
const copyReport = require('../objects/copy-report');

const iso = require('./explorer').iso;
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

/** `AND <col> = ?` when scoped to one tenant. */
function scoped(appId, col = 'app_id') {
    return appId ? { sql: ` AND ${col} = ?`, params: [appId] } : { sql: '', params: [] };
}

function tableExists(name) {
    return !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
}

// ── Jobs ─────────────────────────────────────────────────────

function jobs(appId, limit) {
    const s = scoped(appId);
    const byStatus = {};
    for (const r of db.all(`SELECT status, COUNT(*) AS n FROM media_jobs WHERE 1 = 1${s.sql} GROUP BY status`, s.params)) byStatus[r.status] = r.n;
    const total = byStatus.failed || 0;
    const week = db.all(`SELECT job_type, COALESCE(error_code, '') AS error_code, COUNT(*) AS n FROM media_jobs
                         WHERE status = 'failed' AND COALESCE(finished_at, updated_at) >= datetime('now', '-7 days')${s.sql}
                         GROUP BY job_type, error_code ORDER BY n DESC, job_type`, s.params)
        .map(r => ({ type: r.job_type, error_code: r.error_code || null, count: r.n }));
    const recent = db.all(`SELECT id, app_id, object_id, job_type, error_code, error, attempts, max_attempts, created_by, created_at, finished_at, updated_at
                           FROM media_jobs WHERE status = 'failed'${s.sql} ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC LIMIT ?`, [...s.params, limit])
        .map(j => ({
            id: j.id, app_id: j.app_id, object_id: j.object_id || null, type: j.job_type, error_code: j.error_code || null,
            error: clip(j.error, 500), attempts: j.attempts, max_attempts: j.max_attempts, created_by: j.created_by || null,
            created_at: iso(j.created_at), finished_at: iso(j.finished_at || j.updated_at),
        }));
    return { by_status: byStatus, failed: { total, last_7_days: week, recent } };
}

// ── Missing media ────────────────────────────────────────────

function missing(appId, limit) {
    const s = scoped(appId, 'o.app_id');
    const q = { get: (sql, p) => db.get(sql, p), all: (sql, p) => db.all(sql, p) };
    const noGood = copyReport.countNoGoodCopy(q, { appId });
    const hasVerifications = tableExists('media_verifications');
    const noGoodList = db.all(`SELECT o.id, o.app_id, o.kind, o.legacy_ref, o.size_bytes${hasVerifications ? ', v.status AS verify_status, v.verified_at' : ''}
                               FROM media_objects o${hasVerifications ? ' LEFT JOIN media_verifications v ON v.object_id = o.id' : ''}
                               WHERE ${copyReport.NO_GOOD_COPY_WHERE}${s.sql} ORDER BY o.app_id, o.id LIMIT ?`, [...s.params, limit])
        .map(o => ({ id: o.id, app_id: o.app_id, kind: o.kind, legacy_ref: o.legacy_ref || null, size_bytes: o.size_bytes,
            last_verification: hasVerifications && o.verify_status ? { status: o.verify_status, at: iso(o.verified_at) } : null }));
    const byState = db.all(`SELECT l.provider, l.state, COUNT(*) AS n FROM media_locations l JOIN media_objects o ON o.id = l.object_id
                            WHERE o.lifecycle_status != 'deleted'${s.sql} GROUP BY l.provider, l.state ORDER BY l.provider, l.state`, s.params)
        .map(r => ({ provider: r.provider, state: r.state, count: r.n }));
    const bad = db.all(`SELECT l.object_id, l.provider, l.state, l.verified_at, o.app_id, o.kind, o.legacy_ref, o.lifecycle_status
                        FROM media_locations l JOIN media_objects o ON o.id = l.object_id
                        WHERE l.state IN ('missing', 'corrupt') AND o.lifecycle_status != 'deleted'${s.sql}
                        ORDER BY COALESCE(l.verified_at, '') DESC, l.id DESC LIMIT ?`, [...s.params, limit])
        .map(r => ({ object_id: r.object_id, app_id: r.app_id, kind: r.kind, legacy_ref: r.legacy_ref || null, lifecycle_status: r.lifecycle_status,
            provider: r.provider, state: r.state, verified_at: iso(r.verified_at) }));
    const vs = scoped(appId);
    const quarantined = {};
    for (const r of db.all(`SELECT health_status, COUNT(*) AS n FROM vods WHERE health_status IN ('missing_file', 'zero_byte', 'corrupt', 'needs_review')${vs.sql}
                            GROUP BY health_status`, vs.params)) quarantined[r.health_status] = r.n;
    const verification = { last_run: null, statuses: {} };
    if (tableExists('media_verify_runs')) {
        const r = db.get('SELECT * FROM media_verify_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
        if (r) {
            verification.last_run = { id: r.id, started_at: iso(r.started_at), finished_at: iso(r.finished_at), objects_checked: r.objects_checked,
                good: r.good, no_good_copy: r.no_good_copy, unverifiable: r.unverifiable, reuploaded: r.reuploaded, reupload_failed: r.reupload_failed,
                no_good_copy_total: r.no_good_copy_total, error: clip(r.error, 300) };
        }
    }
    if (hasVerifications) {
        for (const r of db.all(`SELECT v.status, COUNT(*) AS n FROM media_verifications v JOIN media_objects o ON o.id = v.object_id WHERE 1 = 1${s.sql} GROUP BY v.status`, s.params)) {
            verification.statuses[r.status] = r.n;
        }
    }
    return {
        no_good_copy: { total: noGood, objects: noGoodList },
        locations: { by_provider_state: byState, missing_or_corrupt: bad },
        vods_quarantined: quarantined,
        verification,
        note: 'From what the database records (scheduled verification, tier moves, reconciliation). A full walk of storage is the storage.orphans.scan report; drift between rows and objects is scripts/object-drift-report.js.',
    };
}

// ── Backfill ─────────────────────────────────────────────────

function backfill(appId) {
    const s = scoped(appId);
    const last = require('../objects/backfill').lastReport();
    const unprojected = {
        vods: db.get(`SELECT COUNT(*) AS n FROM vods WHERE object_id IS NULL AND COALESCE(clips_only, 0) = 0${s.sql}`, s.params).n,
        clips: db.get(`SELECT COUNT(*) AS n FROM clips WHERE object_id IS NULL${s.sql}`, s.params).n,
        files: db.get(`SELECT COUNT(*) AS n FROM files WHERE object_id IS NULL${s.sql}`, s.params).n,
        screenshots: db.get(`SELECT COUNT(*) AS n FROM pastes WHERE object_id IS NULL AND type = 'screenshot' AND COALESCE(screenshot_path, '') != ''${s.sql}`, s.params).n,
    };
    const owner = db.all(`SELECT app_id, COUNT(*) AS n FROM media_objects WHERE owner_subject IS NULL AND owner_user_id IS NOT NULL
                          AND lifecycle_status != 'deleted'${s.sql} GROUP BY app_id ORDER BY n DESC`, s.params);
    return {
        objects: last ? {
            finished_at: iso(last.finished_at) || null, dry_run: !!last.dry_run, only_missing: !!last.only_missing,
            totals: last.totals || null, locations: last.locations || null,
            errors: Array.isArray(last.errors) ? last.errors.length : 0,
            skipped: Array.isArray(last.skipped) ? last.skipped.length : 0,
        } : null,
        unprojected,
        owner_subject: { missing: owner.reduce((a, r) => a + r.n, 0), by_app: owner.map(r => ({ app_id: r.app_id, count: r.n })) },
        namespace_reservations_seeded: !!db.get("SELECT 1 AS x FROM media_settings WHERE key = 'namespaces.reservations_seeded'"),
        note: 'objects: the last boot or scripted backfill that changed something (media_settings objects.backfill.last_report). unprojected: rows with no object yet. owner_subject: objects the owner-subject job has not resolved.',
    };
}

// ── Tiering ──────────────────────────────────────────────────

function tiering(appId, limit) {
    const vodStorage = require('../vod/vod-storage');
    const s = scoped(appId);
    const providers = (table, bytes) => {
        const out = {};
        for (const r of db.all(`SELECT COALESCE(storage_provider, 'local') AS p, COUNT(*) AS n${bytes ? ', COALESCE(SUM(file_size), 0) AS b' : ''}
                                FROM ${table} WHERE 1 = 1${s.sql} GROUP BY p`, s.params)) out[r.p] = bytes ? { count: r.n, bytes: r.b } : { count: r.n };
        return out;
    };
    const objects = db.all(`SELECT COALESCE(canonical_provider, 'none') AS p, CASE WHEN legacy_ref IS NULL THEN 'native' ELSE 'projected' END AS origin,
                                   COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b
                            FROM media_objects WHERE lifecycle_status != 'deleted'${s.sql} GROUP BY p, origin ORDER BY origin, p`, s.params)
        .map(r => ({ canonical_provider: r.p, origin: r.origin, count: r.n, bytes: r.b }));
    const settings = vodStorage.getSettings();
    const pendingOffload = db.get(`SELECT COUNT(*) AS c FROM vods WHERE ${vodStorage.OFFLOADABLE_WHERE}
            AND created_at <= datetime('now', ?) AND COALESCE(view_count, 0) <= ?
            AND (last_accessed_at IS NULL OR last_accessed_at <= datetime('now', ?))${s.sql}`,
    [`-${Number(settings.minAgeDays) || 0} days`, Number(settings.maxViewsForCold) || 0, `-${Number(settings.minLastAccessDays) || 0} days`, ...s.params]).c;
    const decisions = { promote: { done: 0, already: 0, refused: 0, failed: 0 }, demote: { done: 0, already: 0, refused: 0, failed: 0 } };
    for (const r of db.all(`SELECT action, outcome, COUNT(*) AS n FROM media_tier_decisions
                            WHERE decided_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')${s.sql} GROUP BY action, outcome`, s.params)) {
        if (decisions[r.action]) decisions[r.action][r.outcome] = r.n;
    }
    const problems = db.all(`SELECT id, decided_at, app_id, vod_id, object_id, action, from_provider, to_provider, outcome, trigger, reason, error
                             FROM media_tier_decisions WHERE outcome IN ('refused', 'failed')${s.sql} ORDER BY id DESC LIMIT ?`, [...s.params, Math.min(limit, 20)])
        .map(r => ({ ...r, reason: clip(r.reason, 300), error: clip(r.error, 300) }));
    const sweep = vodStorage.sweepInfo();
    // Native v2 objects (objects/tiering.js): the activation gate, the policy, R2 copies, what would be promoted
    // now, and the decisions (dry runs included), from the database like everything here.
    const nativeObjects = require('../objects/tiering').report({ appId, limit: Math.min(limit, 20) });
    return {
        providers: { b2: vodStorage.providerConfigured('b2'), r2: vodStorage.providerConfigured('r2') },
        policy: { enabled: !!settings.enabled, r2_enabled: !!settings.r2Enabled, min_age_days: settings.minAgeDays, max_views_for_cold: settings.maxViewsForCold, min_last_access_days: settings.minLastAccessDays },
        vods: providers('vods', true),
        clips: providers('clips', false),
        objects,
        pending_offload: pendingOffload,
        decisions_24h: decisions,
        recent_problems: problems,
        sweep: {
            running: sweep.running, started_at: sweep.startedAt, last_run_at: sweep.lastRunAt, next_run_at: sweep.nextRunAt,
            stalled: sweep.stalled, stalled_passes: sweep.stalledPasses,
            last_result: sweep.lastResult ? {
                migrated: sweep.lastResult.migrated ?? null, promoted: sweep.lastResult.promoted ?? null, demoted: sweep.lastResult.demoted ?? null,
                skipped_held: sweep.lastResult.skippedHeld ?? null, quarantined: sweep.lastResult.quarantined ?? null,
                errors: Array.isArray(sweep.lastResult.errors) ? sweep.lastResult.errors.length : 0, error: clip(sweep.lastResult.error, 300),
                timestamp: sweep.lastResult.timestamp || null,
            } : null,
        },
        native_objects: nativeObjects,
        note: 'VODs tier by the media.storage_tier policy; native v2 objects keep their canonical copy and are cached in R2 by the media.object_tier policy, only while its activation gate is on (dry runs otherwise). The sweep, the gate and the provider switches are service-wide; counts follow the scope.',
    };
}

// ── Namespaces ───────────────────────────────────────────────

function namespaceSnapshot(appId) {
    const s = scoped(appId);
    const apps = new Map();
    return db.all(`SELECT * FROM media_namespaces WHERE 1 = 1${s.sql} ORDER BY app_id, namespace`, s.params).map((row) => {
        if (!apps.has(row.app_id)) apps.set(row.app_id, db.getApp(row.app_id) || { app_id: row.app_id });
        return { app_id: row.app_id, ...namespaces.publicShape(apps.get(row.app_id), row) };
    });
}

/** The whole operator report (see the header). `limit` bounds each list (1-200, default 50). */
function report({ appId = null, limit = 50 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    return {
        generated_at: new Date().toISOString(),
        scope: appId || 'all',
        tenants: db.all('SELECT app_id FROM apps ORDER BY app_id').map(r => r.app_id),
        jobs: jobs(appId, n),
        missing: missing(appId, n),
        backfill: backfill(appId),
        tiering: tiering(appId, n),
        namespaces: namespaceSnapshot(appId),
    };
}

/** Refresh the usage snapshot of every namespace (or one tenant's) from the rows: { namespaces, recomputed_at }. */
function recompute({ appId = null } = {}) {
    let count = 0;
    if (appId) {
        const app = db.getApp(appId) || { app_id: appId };
        for (const row of namespaces.listForTenant(appId)) { namespaces.reconcile(app, row.namespace); count++; }
    } else {
        count = namespaces.reconcileAll();
    }
    return { namespaces: count, scope: appId || 'all', recomputed_at: new Date().toISOString() };
}

module.exports = { report, recompute };
