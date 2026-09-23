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
