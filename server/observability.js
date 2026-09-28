'use strict';
/**
 * Metrics and readiness for OpenVibe.Media (roadmap Track O, openvibe-shared/metrics + /ready).
 *
 *   GET /metrics     Prometheus text; direct loopback callers only (404 through nginx)
 *   GET /api/ready   named checks; 503 only when a required one fails, optional failures → degraded
 *
 * Required (Media cannot serve without them): the SQLite database answers a real query, and every
 * local storage directory accepts a write. Optional (one capability degrades, the rest keeps
 * working): the Network public key (user-JWT and service-token routes; app-key tenants are
 * unaffected), each CONFIGURED remote tier (B2 cold storage, R2 cache; a HeadBucket at most once a
 * minute), the Events outbox (webhooks still deliver when it backs up), and object_copies: every
 * ready object has a good copy somewhere (server/objects/verify-job.js records it; objects with no
 * good copy are listed by scripts/no-good-copy-report.js). object_copies never fails readiness —
 * Media keeps serving everything else.
 *
 * `instrument()` must run before any route is mounted; `mountReady()` any time after.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const metrics = require('openvibe-shared/metrics');
const { createReadiness, skip } = require('openvibe-shared/ready');

const copyReport = require('./objects/copy-report');

const OUTBOX_BACKLOG_LIMIT = 1000;

function instrument(app, { release }) {
    return metrics.instrument(app, {
        service: 'media',
        release,
        // Static brand files: one label for the directory, never the file name.
        normalize: (req) => (!req.route && req.path.startsWith('/assets/') ? '/assets/*' : null),
    });
}

/** Write and remove a probe file: the directory exists and accepts writes. */
function writable(dir) {
    const probe = path.join(dir, `.ready-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
}

function storageDirs(config) {
    return {
        vods: config.vod.path,
        clips: config.vod.clipsPath,
        pastes: config.pastes.path,
        thumbnails: config.thumbnails.path,
        files: config.files.path,
        objects: config.objects.path,
    };
}

function domainMetrics(registry, { db, recorder, events }) {
    registry.gauge({ name: 'media_recordings_in_progress', help: 'Recordings ffmpeg is writing right now', collect: () => recorder.activeCount() });
    // target vod: media_tier_decisions (VODs); object: media_object_tier_decisions (native v2 objects), whose
    // outcome dry_run is what the object sweep would have done while its activation gate is off.
    registry.gauge({
        name: 'media_tier_decisions_24h', help: 'R2 promotions and demotions decided in the last 24 hours, by target (vod, object), action and outcome', labelNames: ['target', 'action', 'outcome'],
        collect: async () => {
            const out = [];
            for (const [target, table] of [['vod', 'media_tier_decisions'], ['object', 'media_object_tier_decisions']]) {
                for (const r of await db.all(`SELECT action, outcome, COUNT(*) AS n FROM ${table} WHERE decided_at >= ov_now_iso('-1 day') GROUP BY action, outcome`)) {
                    out.push({ labels: { target, action: r.action, outcome: r.outcome }, value: r.n });
                }
            }
            return out;
        },
    });
    registry.gauge({
        name: 'media_object_locations', help: 'Stored copies of media objects by provider and verification state', labelNames: ['provider', 'state'],
        collect: async () => (await db.all('SELECT provider, state, COUNT(*) AS n FROM media_locations GROUP BY provider, state')).map((r) => ({ labels: { provider: r.provider, state: r.state }, value: r.n })),
    });
    registry.gauge({
        name: 'media_objects', help: 'Media objects by lifecycle status', labelNames: ['lifecycle_status'],
        collect: async () => (await db.all('SELECT lifecycle_status, COUNT(*) AS n FROM media_objects GROUP BY lifecycle_status')).map((r) => ({ labels: { lifecycle_status: r.lifecycle_status }, value: r.n })),
    });
    registry.gauge({
        name: 'media_objects_no_good_copy', help: 'Ready media objects with no present or unverified copy anywhere (see scripts/no-good-copy-report.js)',
        collect: async () => await copyReport.countNoGoodCopy(db),
    });
    registry.gauge({
        name: 'media_verify_last_run_timestamp_seconds', help: 'When the scheduled copy verification last finished a run',
        collect: async () => {
            const r = await db.get('SELECT finished_at FROM media_verify_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
            const t = r ? Date.parse(r.finished_at) : NaN;
            return Number.isFinite(t) ? Math.floor(t / 1000) : null;   // no run yet: no series
        },
    });
    registry.gauge({
        name: 'media_jobs', help: 'Media jobs by type and status (proposed = waiting for the owner; see scripts/media-jobs.js)', labelNames: ['type', 'status'],
        collect: async () => (await db.all('SELECT job_type, status, COUNT(*) AS n FROM media_jobs GROUP BY job_type, status')).map((r) => ({ labels: { type: r.job_type, status: r.status }, value: r.n })),
    });
    // Job writes the lease-token fence refused (server/jobs/queue.js): a holder that lost its job tried to
    // renew, checkpoint or finish it. Anything above zero means two claimants overlapped.
    const stale = registry.counter({ name: 'media_job_stale_completions_total', help: 'Media job writes refused because the writer no longer held the job (lease-token fencing), by action', labelNames: ['action'] });
    for (const action of ['succeed', 'fail', 'cancel', 'renew', 'checkpoint']) stale.inc({ action }, 0);
    require('./jobs/queue').bus.on('stale', (e) => stale.inc({ action: e.action }));
    registry.gauge({
        name: 'media_uploads_open', help: 'Multipart upload sessions still open (active or completing)',
        collect: async () => (await db.get("SELECT COUNT(*) AS n FROM media_uploads WHERE status IN ('active', 'completing')")).n,
    });
    registry.gauge({
        name: 'media_events_outbox', help: 'Events outbox rows waiting to reach OpenVibe.Events, and rows Events rejected', labelNames: ['status'],
        collect: async () => {
            const s = await events.status();
            if (!s.enabled) return null;   // no outbox running: no series, never a made-up zero
            return [{ labels: { status: 'pending' }, value: s.pending }, { labels: { status: 'rejected' }, value: s.rejected }];
        },
    });
}

function createMediaReadiness({ release, db, config, auth, recorder, events, remote, drill = false }) {
    const checks = [
        // A real round trip that names the store (postgresql / pglite), and the tenants it holds.
        { name: 'db', required: true, check: async () => {
            const r = await db.getDb().ready();
            if (!r.ok) return r.error;
            const n = Number((await db.get('SELECT COUNT(*) AS n FROM apps')).n);
            return { ok: Number.isInteger(n), detail: { ...r.detail, apps: n } };
        } },
        { name: 'valkey', required: false, check: async () => { const v = require('./actor-limits').valkey(); return v ? v.ready() : { skipped: 'VALKEY_URL not set (or a drill): per-actor limits count in this process only' }; } },
    ];
    // A restore drill (MEDIA_DRILL) writes no file and asks no remote tier anything: neither is checked.
    if (!drill) {
        for (const [name, dir] of Object.entries(storageDirs(config))) {
            checks.push({ name: `storage_${name}`, required: true, check: () => writable(dir) });
        }
    }
    checks.push({ name: 'network_jwks', required: false, description: 'user sign-in and service tokens (app keys work without it)', check: () => auth.jwksLoaded() || 'Network public key not loaded yet' });
    for (const name of ['b2', 'r2']) {
        if (drill) continue;
        // Not configured: listed as skipped (never a pretend pass), so the status shows the tier is not in use.
        if (!remote.configured(name)) { checks.push({ name: `remote_${name}`, required: false, check: () => skip('not configured') }); continue; }
        checks.push({ name: `remote_${name}`, required: false, cacheMs: 60 * 1000, timeoutMs: 5000, check: () => remote.probe(name) });
    }
    checks.push({
        name: 'events_outbox', required: false, description: 'durable events to OpenVibe.Events (webhooks are separate)',
        check: async () => {
            const s = await events.status();
            if (!s.enabled) return skip('relay off (EVENTS_URL or the service credentials unset)', { enabled: false });   // verified nothing: never ok (WS-Q task 7)
            if (s.pending > OUTBOX_BACKLOG_LIMIT) return { ok: false, error: `${s.pending} events waiting (limit ${OUTBOX_BACKLOG_LIMIT})`, detail: { pending: s.pending } };
            return { ok: true, detail: { pending: s.pending, rejected: s.rejected } };
        },
    });
    checks.push({
        name: 'object_copies', required: false, cacheMs: 60 * 1000, description: 'every ready object has a good copy (scheduled verification)',
        check: async () => {
            const n = await copyReport.countNoGoodCopy(db);
            const last = await db.get('SELECT id, finished_at, objects_checked, reuploaded FROM media_verify_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
            const detail = { no_good_copy: n, last_verify_run: last ? last.finished_at : null };
            if (n) return { ok: false, error: `${n} ready object(s) with no good copy (scripts/no-good-copy-report.js)`, detail };
            return { ok: true, detail };
        },
    });
    return createReadiness({
        service: 'media',
        release,
        checks,
        details: () => ({ ...(drill ? { mode: 'drill' } : {}), recordings_in_progress: recorder.activeCount() }),
    });
}

/** Everything after instrument(): domain gauges and GET /api/ready. */
function mountReady(app, registry, deps) {
    domainMetrics(registry, deps);
    const readiness = createMediaReadiness(deps);
    app.get('/api/ready', readiness.handler);
    return readiness;
}

module.exports = { instrument, mountReady, createMediaReadiness, domainMetrics, storageDirs };
