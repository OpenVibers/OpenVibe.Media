/**
 * OpenVibe.Media — Config
 *
 * Lean env-driven configuration per CONTRACTS.md (Media API v1).
 * Shapes (config.vod.path, config.vod.clipsPath, config.thumbnails.path)
 * are kept compatible with the inherited vod/thumbnail modules.
 */
require('dotenv').config();

const path = require('path');

function intEnv(name, fallback) {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) ? v : fallback;
}

const config = {
    port: intEnv('PORT', 4100),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    publicUrl: (process.env.MEDIA_PUBLIC_URL || 'https://openvibe.media').replace(/\/$/, ''),

    db: {
        path: process.env.DB_PATH || './data/media.db',
    },

    vod: {
        path: process.env.VOD_PATH || './data/vods',
        clipsPath: process.env.CLIPS_PATH || './data/clips',
        maxSizeMb: intEnv('MAX_VOD_SIZE_MB', 2048),
    },
    pastes: {
        path: process.env.PASTES_PATH || './data/pastes',
    },
    assets: {
        path: process.env.ASSETS_PATH || './data/assets',
    },
    thumbnails: {
        path: process.env.THUMBNAILS_PATH || './data/thumbnails',
    },
    files: {
        path: process.env.FILES_PATH || './data/files',
        maxSizeMb: intEnv('MAX_FILE_SIZE_MB', 256),
    },

    // Canonical object model (Wave 4): native v2 uploads, signed delivery, retention,
    // and the public playback object-size invariant (policy, not a copied constant).
    objects: {
        path: process.env.OBJECTS_PATH || './data/objects',
        maxUploadMb: intEnv('MEDIA_OBJECT_MAX_MB', 256),          // single-part upload limit
        retentionDays: intEnv('MEDIA_DELETE_RETENTION_DAYS', 30),  // soft-deleted bytes kept this long
        signingSecret: process.env.MEDIA_SIGNING_SECRET || '',
        signedUrlTtlS: intEnv('MEDIA_SIGNED_URL_TTL_S', 300),
        uploadTokenTtlS: intEnv('MEDIA_UPLOAD_TOKEN_TTL_S', 3600),
        publicMaxMb: intEnv('MEDIA_PUBLIC_OBJECT_MAX_MB', 500),
        publicTargetMb: intEnv('MEDIA_PUBLIC_OBJECT_TARGET_MB', 256),
        publicWarnMb: intEnv('MEDIA_PUBLIC_OBJECT_WARN_MB', 384),
        // Multipart uploads (server/objects/multipart.js): parts are stored locally and assembled at complete.
        multipartMaxMb: intEnv('MEDIA_MULTIPART_MAX_MB', 20480),         // largest object a multipart upload may declare
        multipartMinPartMb: intEnv('MEDIA_MULTIPART_MIN_PART_MB', 5),    // every part but the last is at least this
        multipartMaxPartMb: intEnv('MEDIA_MULTIPART_MAX_PART_MB', 256),
        multipartDefaultPartMb: intEnv('MEDIA_MULTIPART_PART_MB', 64),
        multipartTtlHours: intEnv('MEDIA_MULTIPART_TTL_HOURS', 24),      // an unfinished session's parts are purged after this
        uploadMinFreeMb: intEnv('MEDIA_UPLOAD_MIN_FREE_MB', 10240),      // multipart needs 2x its size free plus this
        // Namespaces and quotas (server/objects/namespaces.js): an upload holds its quota reservation this long
        // after its last step (init, a fresh URL, the bytes); then the hourly sweep fails it and frees its bytes.
        reservationHours: Math.max(1, intEnv('MEDIA_UPLOAD_RESERVATION_HOURS', 72)),
        maxChildNamespaces: Math.max(0, intEnv('MEDIA_NAMESPACE_MAX_CHILDREN', 100)),   // children per tenant
    },

    // Job system (server/jobs/; docs/object-model.md#jobs).
    jobs: {
        enabled: !['0', 'false', 'off'].includes(String(process.env.MEDIA_JOBS_ENABLED || '').toLowerCase()),
        pollMs: intEnv('MEDIA_JOBS_POLL_MS', 5000),
        lightConcurrency: Math.max(1, intEnv('MEDIA_JOBS_LIGHT_CONCURRENCY', 2)),   // thumbnails, scans
        heavyConcurrency: Math.max(1, intEnv('MEDIA_JOBS_HEAVY_CONCURRENCY', 1)),   // split, remux
        finalizeConcurrency: Math.max(1, intEnv('MEDIA_JOBS_FINALIZE_CONCURRENCY', 1)),   // vod.finalize retries
        clipsConcurrency: Math.max(1, intEnv('MEDIA_JOBS_CLIPS_CONCURRENCY', 2)),   // clip.cut (runs while recording)
        // Heavy jobs wait while a recording is running (as the health job does), unless this is on.
        heavyWhileRecording: ['1', 'true', 'on'].includes(String(process.env.MEDIA_JOBS_HEAVY_WHILE_RECORDING || '').toLowerCase()),
        leaseS: Math.max(30, intEnv('MEDIA_JOBS_LEASE_S', 120)),
        // The size-invariant validator runs this often (hours; 0 = only on demand). It proposes jobs, never runs them.
        invariantScanHours: intEnv('MEDIA_INVARIANT_SCAN_HOURS', 24),
        retentionDays: intEnv('MEDIA_JOBS_RETENTION_DAYS', 30),     // finished thumbnail jobs are pruned after this
    },

    // Scheduled copy verification (server/objects/verify-job.js; docs/object-model.md#scheduled-verification).
    verify: {
        enabled: !['0', 'false', 'off'].includes(String(process.env.MEDIA_VERIFY_ENABLED || '').toLowerCase()),
        intervalMin: intEnv('MEDIA_VERIFY_INTERVAL_MIN', 10),     // one batch this often
        batch: intEnv('MEDIA_VERIFY_BATCH', 50),                  // objects per run (least recently verified first)
        hashMaxMb: intEnv('MEDIA_VERIFY_HASH_MAX_MB', 64),        // sha256 local copies up to this size (objects with a content_hash)
        maxReuploads: intEnv('MEDIA_VERIFY_MAX_REUPLOADS', 2),    // missing remote copies restored from a good local copy, per run
        repairCorrupt: ['1', 'true', 'on'].includes(String(process.env.MEDIA_VERIFY_REPAIR_CORRUPT || '').toLowerCase()),
    },

    // Owner subjects (server/objects/owner-subject-job.js): objects that name only an app-local owner get
    // the owner's Network subject (usr_…) on the next run.
    ownerSubject: {
        enabled: !['0', 'false', 'off'].includes(String(process.env.MEDIA_OWNER_SUBJECT_SYNC || '').toLowerCase()),
        intervalMin: intEnv('MEDIA_OWNER_SUBJECT_INTERVAL_MIN', 10),
    },

    // Where POST /vods/:id/ingest/rtmp may make ffmpeg connect (an SSRF guard): host:port entries,
    // by default Live's RTMP server on this host. A URL without a port means 1935 (rtmp) / 443 (rtmps).
    rtmpPull: {
        allow: String(process.env.MEDIA_RTMP_PULL_ALLOW || '127.0.0.1:1935,localhost:1935,[::1]:1935')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    },

    rtp: {
        portMin: intEnv('RTP_PORT_MIN', 12000),
        portMax: intEnv('RTP_PORT_MAX', 12199),
    },

    network: {
        url: (process.env.OV_NETWORK_URL || 'https://openvibe.network').replace(/\/$/, ''),
        internalUrl: (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/$/, ''),
        internalApiKey: process.env.INTERNAL_API_KEY || '',
    },

    apps: {
        // JSON array: [{app_id, name, api_key, webhook_url, webhook_secret, allowed_origins, quota_bytes}]
        seedJson: process.env.MEDIA_APPS_SEED || '',
        // Fallback short form: "live:key1,games:key2"
        seedKeys: process.env.MEDIA_APP_KEYS || '',
        // Developer-project tenants (ADR-014), created on first use by an app token: default quotas.
        // Applied when the tenant is created; an operator can change apps.quota_bytes afterwards.
        projectQuotaMb: Math.max(1, intEnv('MEDIA_APP_TENANT_QUOTA_MB', 1024)),
        sandboxQuotaMb: Math.max(1, intEnv('MEDIA_APP_SANDBOX_QUOTA_MB', 100)),
    },
};

// Resolve all storage paths to absolute
for (const p of ['path']) {
    config.vod[p] = path.resolve(config.vod[p]);
}
config.vod.clipsPath = path.resolve(config.vod.clipsPath);
config.pastes.path = path.resolve(config.pastes.path);
config.assets.path = path.resolve(config.assets.path);
config.thumbnails.path = path.resolve(config.thumbnails.path);
config.files.path = path.resolve(config.files.path);
config.objects.path = path.resolve(config.objects.path);
config.db.path = path.resolve(config.db.path);

module.exports = config;
