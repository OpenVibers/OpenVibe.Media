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
 * minute), and the Events outbox (webhooks still deliver when it backs up).
 *
 * `instrument()` must run before any route is mounted; `mountReady()` any time after.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const metrics = require('openvibe-shared/metrics');
const { createReadiness } = require('openvibe-shared/ready');

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
    registry.gauge({
        name: 'media_object_locations', help: 'Stored copies of media objects by provider and verification state', labelNames: ['provider', 'state'],
        collect: () => db.all('SELECT provider, state, COUNT(*) AS n FROM media_locations GROUP BY provider, state').map((r) => ({ labels: { provider: r.provider, state: r.state }, value: r.n })),
    });
    registry.gauge({
        name: 'media_objects', help: 'Media objects by lifecycle status', labelNames: ['lifecycle_status'],
        collect: () => db.all('SELECT lifecycle_status, COUNT(*) AS n FROM media_objects GROUP BY lifecycle_status').map((r) => ({ labels: { lifecycle_status: r.lifecycle_status }, value: r.n })),
    });
    registry.gauge({
        name: 'media_events_outbox', help: 'Events outbox rows waiting to reach OpenVibe.Events, and rows Events rejected', labelNames: ['status'],
        collect: () => {
            const s = events.status();
            if (!s.enabled) return null;   // no outbox running: no series, never a made-up zero
            return [{ labels: { status: 'pending' }, value: s.pending }, { labels: { status: 'rejected' }, value: s.rejected }];
        },
    });
}

function createMediaReadiness({ release, db, config, auth, recorder, events, remote }) {
    const checks = [
        { name: 'db', required: true, check: () => { const r = db.get('SELECT COUNT(*) AS n FROM apps'); return { ok: Number.isInteger(r.n), detail: { apps: r.n } }; } },
    ];
    for (const [name, dir] of Object.entries(storageDirs(config))) {
        checks.push({ name: `storage_${name}`, required: true, check: () => writable(dir) });
    }
    checks.push({ name: 'network_jwks', required: false, description: 'user sign-in and service tokens (app keys work without it)', check: () => auth.jwksLoaded() || 'Network public key not loaded yet' });
    for (const name of ['b2', 'r2']) {
        if (!remote.configured(name)) continue;   // not configured: no check, rather than a pretend pass
        checks.push({ name: `remote_${name}`, required: false, cacheMs: 60 * 1000, timeoutMs: 5000, check: () => remote.probe(name) });
    }
    checks.push({
        name: 'events_outbox', required: false, description: 'durable events to OpenVibe.Events (webhooks are separate)',
        check: () => {
            const s = events.status();
            if (!s.enabled) return { ok: true, detail: { enabled: false } };
            if (s.pending > OUTBOX_BACKLOG_LIMIT) return { ok: false, error: `${s.pending} events waiting (limit ${OUTBOX_BACKLOG_LIMIT})`, detail: { pending: s.pending } };
            return { ok: true, detail: { pending: s.pending, rejected: s.rejected } };
        },
    });
    return createReadiness({
        service: 'media',
        release,
        checks,
        details: () => ({ recordings_in_progress: recorder.activeCount() }),
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
