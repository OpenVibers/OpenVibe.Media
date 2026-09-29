/**
 * OpenVibe.Media — service entrypoint (port 4100)
 *
 * Multi-tenant media service: VOD ingest/recording (RTMP pull, RTP, browser
 * chunks), local/B2/R2 storage tiering with presigned-302 playback, clips,
 * pastes, files, thumbnails, and HMAC-signed webhooks. See CONTRACTS.md
 * (Media API v1) and README.md.
 */
'use strict';

// Restore-drill mode (MEDIA_DRILL=1, `ovhost drill media`): refuse an unsafe environment before the
// database is opened, then cut every way out of the process but its own HTTP port. The instance
// serves reads from a restored copy of the database, never opens a stored file and starts nothing else
// (server/drill.js).
require('dotenv').config();
const drill = require('./drill');
if (drill.enabled) {
    try {
        drill.assertSafe();
    } catch (err) {
        console.error(`[Drill] ${err.message}`);
        process.exit(1);
    }
    drill.installGuards();
    console.log(`[Drill] MEDIA_DRILL: restore-drill instance on ${process.env.HOST}:${process.env.PORT}, database ${(() => { try { const u = new URL(process.env.DATABASE_URL); return `${u.hostname}:${u.port || 5432}${u.pathname}`; } catch { return '(unset)'; } })()}. Reads only; no stored bytes, background work or outbound connections.`);
}

const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db/database');
const auth = require('./auth');

// Tests take the app and the server once the boot has finished: require('./server/index.js').ready.
const ready = (async () => {
    // ── Bootstrap ────────────────────────────────────────────────

    // A drill creates no storage directory (it writes no file) and seeds nothing: the copy is production's.
    if (!drill.enabled) {
        for (const dir of [config.vod.path, config.vod.clipsPath, config.pastes.path, config.thumbnails.path, config.files.path, config.objects.path]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
    }

    // PostgreSQL first (migrations run as the owner), then what reads it before the app serves: Network's token cutoffs
    // (isRevoked() is synchronous) and the two revisioned tier policies (their get() reads memory).
    await db.initDb();
    // Valkey (ADR-035): per-actor limit counters shared across processes (not in a drill: it connects nowhere).
    const valkey = !drill.enabled && config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix }) : null;
    require('./actor-limits').useValkey(valkey);
    if (!drill.enabled) await require('./revocations').load();
    await require('./vod/tier-config').init(require('./vod/vod-storage').DEFAULTS);
    await require('./objects/tier-policy').init();
    await require('./placement/cost-tiers').init();
    // Placement core (F1 part A): the provider registry, signals + router. Boot the cheap live
    // health loop after the DB is open (it reads memory only) and the router is wired in.
    if (!drill.enabled) {
        try { await require('./placement/providers').probeAll(); } catch (err) { console.warn('[Placement] initial probe failed:', err.message); }
        try { require('./placement/providers').startHealthLoop(); } catch (err) { console.warn('[Placement] health loop did not start:', err.message); }
    }
    if (!drill.enabled) {
        await auth.seedApps();     // upsert MEDIA_APPS_SEED / MEDIA_APP_KEYS
        await auth.ensureTokenOnlyApps();  // tenants reached only with Network service tokens (community)
        auth.startJwksRefresh();     // a drill asks Network for nothing (app keys still verify against the copy)
    }

    const app = express();
    // Only the local reverse proxy (nginx on this host) is trusted to say who the client is: req.ip is
    // its X-Forwarded-For for loopback peers and the socket address for anyone else, so a direct caller
    // cannot pick its own IP (views, rate limits). `true` trusted every peer's header.
    app.set('trust proxy', require('./client-ip').TRUST_PROXY);
    // Metrics first, so every route below is measured (GET /metrics: loopback callers only).
    const release = require('openvibe-shared/release').createRelease({ service: 'media', root: require('path').join(__dirname, '..') });
    const observability = require('./observability');
    const instrumented = observability.instrument(app, { release: release.release });
    // Per-actor limit refusals (server/actor-limits.js) are counted there: media_rate_limited_total.
    require('./actor-limits').bindMetrics(instrumented.registry);
    // A restore-drill instance answers reads only: 403 for every other method, on every path (before the
    // raw-body upload routes below).
    if (drill.enabled) app.use(drill.readOnly);
    // Object API v2 content uploads read the raw request body, so they sit ahead of the body parsers.
    app.put('/api/v2/:app/objects/:id/content', ...require('./objects/routes').contentHandlers);
    app.put('/api/v2/:app/objects/:id/multipart/:uploadId/parts/:n', ...require('./objects/routes').partHandlers);
    // Network's sign-out-everywhere cutoffs (server/revocations.js): signed, loopback-only. Before the JSON
    // parser, which would consume the raw body the signature is over.
    app.post('/internal/events', ...require('./revocations').handler());
    app.use(express.json({ limit: '2mb' }));

    // ── Visitor sign-in (OAuth client `media` on the Network; same module as Community/Tools) ──
    // Host-only cookies on openvibe.media. No new dependency: cookies are parsed here.
    app.use((req, _res, next) => {
        req.cookies = {};
        for (const part of String(req.headers.cookie || '').split(';')) {
            const i = part.indexOf('='); if (i < 1) continue;
            try { req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed value */ }
        }
        next();
    });
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'media', service: 'media', host: 'openvibe.media', name: 'OpenVibe.Media', profile: 'hosting' })); app.get('/tos', (_req, res) => res.redirect(301, '/terms')); }
    // Brand assets: icon set + web app manifest generated by openvibe-shared/scripts/build-app-icons.js
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use('/assets', express.static(require('path').join(__dirname, 'brand'), { maxAge: '7d' }));
    app.get('/manifest.webmanifest', (_req, res) => res.type('application/manifest+json').sendFile(require('path').join(__dirname, 'brand', 'manifest.webmanifest')));
    // ── Internal: avatar ingestion (the Network asks; see server/avatars/ingest.js) ──
    {
        const pastes = require('./pastes/routes');
        // Loopback only. A Network service token holding media.avatar.ingest (audience openvibe.media);
        // a Bearer is judged on the token alone (401 bad, 403 no capability) and nothing else opens the
        // route (server/service-guard.js).
        app.post('/internal/avatar-ingest', require('./service-guard').guard('media.avatar.ingest'),
            require('./avatars/ingest').createIngestHandler({ db: require('./db/database'), config, screenshotsDir: pastes.SCREENSHOTS_DIR, generateSlug: pastes.generateSlug }));
    }
    const userAuth = require('./user-auth');
    const userAuthConfig = {
        baseUrl: config.publicUrl, networkUrl: config.network.url, networkInternalUrl: config.network.internalUrl,
        cookies: { secure: /^https:/.test(config.publicUrl) },
        oauth: { clientId: process.env.OV_OAUTH_CLIENT_ID || 'media', clientSecret: process.env.OV_OAUTH_CLIENT_SECRET || '', redirectUri: process.env.OV_OAUTH_REDIRECT_URI || `${config.publicUrl}/auth/callback` },
    };
    // A restore drill signs nobody in: that would redeem codes at Network.
    if (drill.enabled) app.use('/auth', (req, res) => res.status(503).json({ error: 'This is a restore-drill instance (MEDIA_DRILL): no sign-in', code: 'media.drill_no_sign_in' }));
    const userAuthClient = userAuth.createAuthClient(userAuthConfig);
    app.use('/auth', userAuth.createAuthRoutes(userAuthConfig, userAuthClient));
    app.use(express.urlencoded({ extended: true, limit: '2mb' }));

    // CORS preflight for tenant API routes (per-app allow-list; auth-less OPTIONS).
    app.options(['/api/v1/:app/*', '/api/v2/:app/*'], async (req, res) => {
        const origin = req.headers.origin;
        const appRow = await db.getApp(String(req.params.app || ''));
        if (origin && appRow && db.appAllowedOrigins(appRow).includes(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Vary', 'Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Upload-Token, X-Content-SHA256, Idempotency-Key, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        }
        res.sendStatus(204);
    });

    // ── Routes ───────────────────────────────────────────────────

    // What this server runs (ADR-016); the shared navbar's release-watch polls it. POST /release-metrics
    // takes open tabs' update reports into /metrics (release_client_updates_total). A restore drill
    // answers that POST with the readOnly 403 above, like every other write.
    release.mount(app, { registry: instrumented.registry });
    // GET /limits.json: the developer limits enforced here, from config (WS-N task 7; Codes renders them).
    require('./limits').mountLimits(app, config);

    app.get('/healthz', async (req, res) => {
        res.json({
            ok: true,
            service: 'openvibe-media',
            apps: (await db.listApps()).length,
            recordings: require('./vod/recorder').activeCount(),
            uptime_s: Math.round(process.uptime()),
        });
    });

    // Readiness: required = database + writable storage; optional (degraded) = Network key, remote tiers, events outbox.
    {
        const vodStorageForReady = require('./vod/vod-storage');
        observability.mountReady(app, instrumented.registry, {
            release: release.release, db, config, auth,
            recorder: require('./vod/recorder'),
            events: require('./events'),
            remote: { configured: (n) => vodStorageForReady.providerConfigured(n), probe: async (n) => await vodStorageForReady.probeProvider(n) },
            drill: drill.enabled,
        });
    }

    // Per-app media stats (app-key only) — hero/dashboard counters in the owning app.
    app.get('/api/v1/:app/stats', auth.tenantAuth({ verb: 'read' }), async (req, res) => {
        try {
            res.json(await db.getAppStats(req.appId));
        } catch (err) {
            console.error('[Stats] error:', err.message);
            res.status(500).json({ error: 'Failed to compute stats' });
        }
    });

    // Daily series behind a stat (vods, clips, pastes, hours) — "over time" charts in the owning app.
    app.get('/api/v1/:app/stats/series/:metric', auth.tenantAuth({ verb: 'read' }), async (req, res) => {
        try {
            const series = await db.getAppStatSeries(req.appId, String(req.params.metric), req.query.days);
            if (!series) return res.status(404).json({ error: 'Unknown metric' });
            res.json(series);
        } catch (err) {
            console.error('[Stats] series error:', err.message);
            res.status(500).json({ error: 'Failed to compute series' });
        }
    });

    if (!drill.enabled) setInterval(async () => { try { const n = await require('./views/service').prune(30); if (n) console.log(`[Views] pruned ${n} stale visit row(s)`); } catch { /* */ } }, 12 * 3600 * 1000);
    // The object explorer (WS-G task 12): a signed-in person's own objects and usage, and the operator views
    // (server/me/routes.js). /api/v2/me sits ahead of /api/v2/:app/…, so "me" is never a tenant there.
    const me = require('./me/routes').createMeRoutes({ auth: userAuthClient });
    app.use('/api/v2/me', me.api);
    app.use('/me', me.pages);
    app.use('/api/v1/:app/views', require('./views/routes'));
    app.use('/api/v1/:app/vods', require('./vod/routes'));
    app.use('/api/v1/:app/clips', require('./vod/clips-routes'));
    app.use('/api/v1/:app/pastes', require('./pastes/routes'));
    app.use('/api/v1/:app/files', require('./files/routes'));
    app.use('/api/v1/:app/thumbnails', require('./thumbnails/routes'));
    app.use('/api/v1/:app/assets', require('./assets/routes'));
    app.use('/api/v1/:app/admin/storage', require('./admin/routes'));
    app.use('/api/v2/:app/objects', require('./objects/routes'));   // canonical object API (docs/object-model.md)
    app.use('/api/v2/:app/jobs', require('./jobs/routes'));         // media jobs: thumbnails, split/remux, invariant scans
    app.use('/api/v2/:app/namespaces', require('./objects/namespace-routes'));   // a tenant's namespaces: policy, quotas, usage
    app.use('/o', require('./objects/routes').publicRouter);        // object bytes (public, or signed)
    app.use('/', require('./public/routes'));   // /v /c /p /t /f
    app.use(require('./not-found').notFound);   // nothing matched: 404 with Media's CSP (Cloudflare's beacon allowed)

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        console.error('[HTTP] Unhandled error:', err.message);
        if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Internal error' });
    });

    // ── Background jobs ──────────────────────────────────────────

    const recorder = require('./vod/recorder');
    const vodStorage = require('./vod/vod-storage');
    const healthJob = require('./vod/health-job');
    const thumbService = require('./thumbnails/thumbnail-service');

    const timers = [];
    function every(ms, fn) {
        const t = setInterval(fn, ms);
        if (t.unref) t.unref();
        timers.push(t);
    }

    // A restore drill starts none of this: every job below reads or writes stored files, runs ffmpeg,
    // talks to B2/R2 or announces outcomes to Live.
    if (!drill.enabled) {
        vodStorage.checkProviders()
            .then(() => vodStorage.migrateLegacy().catch(() => {}))
            .catch(err => console.warn('[Boot] Provider check failed:', err.message));
        vodStorage.start();                                        // tiering sweep
        healthJob.start().catch((err) => console.warn('[VOD] health job did not start:', err.message));   // health scan + quarantine cleanup
        require('./vod/clip-jobs').start().catch((err) => console.warn('[Clips] re-cut job did not start:', err.message));   // failed clip re-cuts (auto-retry, hot-fetch)
        require('./objects/verify-job').start();                   // scheduled copy verification (bounded batches; never deletes)
        require('./jobs/worker').start().catch((err) => console.warn('[Jobs] worker did not start:', err.message));   // media_jobs worker (light + heavy lanes; proposals wait for their owner)
        require('./objects/owner-subject-job').start();            // owner_subject for objects that name only an app-local owner (asks Network)
        // Descriptor watchdog: a leak here once pinned 80 GB of deleted recordings to the disk.
        every(5 * 60 * 1000, () => {
            try {
                const n = fs.readdirSync('/proc/self/fd').length;
                if (n > 1500) console.warn(`[Boot] ${n} open file descriptors — investigate a stream/handle leak (lsof -p ${process.pid} +L1)`);
            } catch { /* not linux */ }
        });
        every(60 * 1000, () => recorder.checkDisk());              // disk guardian
        every(60 * 60 * 1000, () => thumbService.cleanupOldThumbnails());  // stale live thumbs
        // Object model: purge native objects whose soft-delete retention has passed (held ones are kept).
        every(60 * 60 * 1000, async () => {
            try { const n = await require('./objects/model').purgeExpired(); if (n) console.log(`[Objects] Purged ${n} expired deleted object(s)`); } catch (err) { console.warn('[Objects] purge:', err.message); }
            // Incomplete multipart uploads past MEDIA_MULTIPART_TTL_HOURS: their parts are deleted (the objects stay uploading).
            try { const r = await require('./objects/multipart').purgeExpired(); if (r.expired || r.orphan_dirs) console.log(`[Objects] Multipart: ${r.expired} expired session(s), ${r.orphan_dirs} orphan part dir(s) removed`); } catch (err) { console.warn('[Objects] multipart purge:', err.message); }
            // Native objects' popularity (ADR-021): a finished UTC day's viewer hashes and salt are deleted, only its counts stay (30 days).
            try { const r = await require('./objects/popularity').rotate(); if (r.hashes || r.salts || r.counts) console.log(`[Popularity] ${r.hashes} viewer hash(es) and ${r.salts} salt(s) of finished days deleted, ${r.counts} old daily count(s) pruned`); } catch (err) { console.warn('[Popularity] rotate:', err.message); }
            // Namespaces: uploads whose quota reservation expired are failed and their bytes freed; then every
            // namespace's usage snapshot is refreshed (v1 files, deletes and purges included).
            try {
                const ns = require('./objects/namespaces');
                const r = await ns.expireReservations();
                if (r.expired || r.dropped) console.log(`[Namespaces] ${r.expired} abandoned upload(s) expired, ${r.dropped} stale reservation(s) dropped`);
                await ns.reconcileAll();
            } catch (err) { console.warn('[Namespaces] sweep:', err.message); }
        });
        // Project rows that have no media_object yet (first boot after the upgrade: all of them).
        // C-75 catch-up: every write now makes its object in the same transaction (objects/model.js
        // withObject, WS-G task 1), so this should find nothing. It stays until a release has run with
        // `node scripts/object-drift-report.js` showing zero drift; then it goes, with the finalize
        // follow-up re-projection (vod/finalize.js), in a dated later step.
        setTimeout(async () => {
            try {
                const bf = require('./objects/backfill');
                const r = await bf.backfill({ onlyMissing: true });
                if (r.totals.created || r.totals.updated || r.errors.length) console.log(`[Objects] Backfill: ${bf.summarize(r)}`);
            } catch (err) { console.warn('[Objects] Backfill failed:', err.message); }
            // The namespaces' usage snapshot, first taken here (then hourly, and after each write).
            try { await require('./objects/namespaces').reconcileAll(); } catch (err) { console.warn('[Namespaces] reconcile:', err.message); }
        }, 15 * 1000).unref?.();

        // Recover from an unclean shutdown: rows stuck in is_recording with no live ffmpeg are finalized
        // from whatever hit the disk. With the job worker on, its orphan sweep queues a vod.finalize job
        // for each (retried with backoff; server/jobs/vod-finalize.js); without it, once, here.
        if (!config.jobs.enabled) setTimeout(async () => {
            try {
                const stuck = await db.all('SELECT id FROM vods WHERE is_recording = 1');
                for (const row of stuck) {
                    if (recorder.isRecording(row.id)) continue;
                    console.log(`[Boot] Finalizing orphaned recording vod ${row.id}`);
                    require('./vod/finalize').finalizeVod(row.id).catch(() => {});
                }
            } catch (err) {
                console.warn('[Boot] Orphan finalize sweep failed:', err.message);
            }
        }, 5000).unref?.();
    }

    // ── Listen + graceful shutdown ───────────────────────────────

    const server = app.listen(config.port, config.host, () => {
        // Subscribe to Network's sign-out-everywhere cutoffs (not on a restore drill; retried a few times).
        if (!drill.enabled) {
            const subscribe = (n) => require('./revocations').ensureSubscription().catch((e) => {
                console.warn('[Events] token cutoff subscription not ready:', e.message);
                if (n < 5) setTimeout(() => subscribe(n + 1), 60_000 * n).unref();
            });
            subscribe(1);
        }
        if (drill.enabled) { console.log(`[Drill] Ready: http://${config.host}:${config.port} (reads only)`); return; }
        console.log(`[Media] OpenVibe.Media listening on ${config.host}:${config.port} (${config.nodeEnv})`);
        console.log(`[Media] Data: db=${config.db.url ? 'postgresql' : 'pglite'} vods=${config.vod.path} clips=${config.vod.clipsPath}`);
        console.log(`[Media] RTP ingest pool: udp ${config.rtp.portMin}-${config.rtp.portMax} (127.0.0.1)`);
        // Durable events (roadmap Wave 3): webhook outcomes also go to OpenVibe.Events. Off without EVENTS_URL.
        try { require('./events').init(); } catch (err) { console.warn('[Events] not started:', err.message); }
        // Media's own watch pages in OpenVibe.Search (WS-O task 10): media.index_document.* through the same outbox.
        require('./public/search-documents').start().catch((err) => console.warn('[Search] documents not started:', err.message));
    });

    // A drill whose port is taken stops instead of running unready.
    if (drill.enabled) server.once('error', (err) => { console.error(`[Drill] HTTP server: ${err.message}`); process.exit(1); });

    let shuttingDown = false;
    function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[Media] ${signal} received — shutting down`);
        try { recorder.stopAll(); } catch { /* */ }
        try { vodStorage.stop(); } catch { /* */ }
        try { healthJob.stop(); } catch { /* */ }
        try { require('./objects/verify-job').stop(); } catch { /* */ }
        try { require('./jobs/worker').stop(); } catch { /* */ }
        try { require('./objects/owner-subject-job').stop(); } catch { /* */ }
        try { auth.stopJwksRefresh(); } catch { /* */ }
        try { require('./events')._reset(); } catch { /* */ }
        try { const v = require('./actor-limits').valkey(); if (v) v.close().catch(() => {}); } catch { /* */ }
        for (const t of timers) clearInterval(t);
        server.close(() => {
            db.close().catch(() => {}).finally(() => process.exit(0));
        });
        // Recordings get STOP_GRACE_MS to flush trailers; don't hang forever.
        setTimeout(() => {
            console.warn('[Media] Forced exit after shutdown grace');
            db.close().catch(() => {}).finally(() => process.exit(0));
        }, 70_000).unref();
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return { app, server };
})();
ready.catch((err) => {
    console.error('[Media] failed to start:', err);
    process.exit(1);
});

module.exports = { ready };
