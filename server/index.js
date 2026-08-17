/**
 * OpenVibe.Media — service entrypoint (port 4100)
 *
 * Multi-tenant media service: VOD ingest/recording (RTMP pull, RTP, browser
 * chunks), local/B2/R2 storage tiering with presigned-302 playback, clips,
 * pastes, files, thumbnails, and HMAC-signed webhooks. See CONTRACTS.md
 * (Media API v1) and README.md.
 */
'use strict';

const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db/database');
const auth = require('./auth');

// ── Bootstrap ────────────────────────────────────────────────

for (const dir of [config.vod.path, config.vod.clipsPath, config.pastes.path, config.thumbnails.path, config.files.path]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

db.getDb();          // init schema (WAL)
auth.seedApps();     // upsert MEDIA_APPS_SEED / MEDIA_APP_KEYS
auth.startJwksRefresh();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// CORS preflight for tenant API routes (per-app allow-list; auth-less OPTIONS).
app.options('/api/v1/:app/*', (req, res) => {
    const origin = req.headers.origin;
    const appRow = db.getApp(String(req.params.app || ''));
    if (origin && appRow && db.appAllowedOrigins(appRow).includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    res.sendStatus(204);
});

// ── Routes ───────────────────────────────────────────────────

app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        service: 'openvibe-media',
        apps: db.listApps().length,
        recordings: require('./vod/recorder').activeCount(),
        uptime_s: Math.round(process.uptime()),
    });
});

app.use('/api/v1/:app/vods', require('./vod/routes'));
app.use('/api/v1/:app/clips', require('./vod/clips-routes'));
app.use('/api/v1/:app/pastes', require('./pastes/routes'));
app.use('/api/v1/:app/files', require('./files/routes'));
app.use('/api/v1/:app/thumbnails', require('./thumbnails/routes'));
app.use('/', require('./public/routes'));   // /v /c /p /t /f

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

vodStorage.checkProviders()
    .then(() => vodStorage.migrateLegacy().catch(() => {}))
    .catch(err => console.warn('[Boot] Provider check failed:', err.message));
vodStorage.start();                                        // tiering sweep
healthJob.start();                                         // health scan + quarantine cleanup
every(60 * 1000, () => recorder.checkDisk());              // disk guardian
every(60 * 60 * 1000, () => thumbService.cleanupOldThumbnails());  // stale live thumbs

// Recover from an unclean shutdown: rows stuck in is_recording with no live
// ffmpeg are finalized from whatever hit the disk.
setTimeout(() => {
    try {
        const stuck = db.all('SELECT id FROM vods WHERE is_recording = 1');
        for (const row of stuck) {
            if (recorder.isRecording(row.id)) continue;
            console.log(`[Boot] Finalizing orphaned recording vod ${row.id}`);
            require('./vod/finalize').finalizeVod(row.id).catch(() => {});
        }
    } catch (err) {
        console.warn('[Boot] Orphan finalize sweep failed:', err.message);
    }
}, 5000).unref?.();

// ── Listen + graceful shutdown ───────────────────────────────

const server = app.listen(config.port, config.host, () => {
    console.log(`[Media] OpenVibe.Media listening on ${config.host}:${config.port} (${config.nodeEnv})`);
    console.log(`[Media] Data: db=${config.db.path} vods=${config.vod.path} clips=${config.vod.clipsPath}`);
    console.log(`[Media] RTP ingest pool: udp ${config.rtp.portMin}-${config.rtp.portMax} (127.0.0.1)`);
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Media] ${signal} received — shutting down`);
    try { recorder.stopAll(); } catch { /* */ }
    try { vodStorage.stop(); } catch { /* */ }
    try { healthJob.stop(); } catch { /* */ }
    try { auth.stopJwksRefresh(); } catch { /* */ }
    for (const t of timers) clearInterval(t);
    server.close(() => {
        try { db.close(); } catch { /* */ }
        process.exit(0);
    });
    // Recordings get STOP_GRACE_MS to flush trailers; don't hang forever.
    setTimeout(() => {
        console.warn('[Media] Forced exit after shutdown grace');
        try { db.close(); } catch { /* */ }
        process.exit(0);
    }, 70_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
