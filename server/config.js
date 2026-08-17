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
    thumbnails: {
        path: process.env.THUMBNAILS_PATH || './data/thumbnails',
    },
    files: {
        path: process.env.FILES_PATH || './data/files',
        maxSizeMb: intEnv('MAX_FILE_SIZE_MB', 256),
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
    },
};

// Resolve all storage paths to absolute
for (const p of ['path']) {
    config.vod[p] = path.resolve(config.vod[p]);
}
config.vod.clipsPath = path.resolve(config.vod.clipsPath);
config.pastes.path = path.resolve(config.pastes.path);
config.thumbnails.path = path.resolve(config.thumbnails.path);
config.files.path = path.resolve(config.files.path);
config.db.path = path.resolve(config.db.path);

module.exports = config;
