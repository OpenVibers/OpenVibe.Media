-- OpenVibe.Media — Schema
-- Multi-tenant media service. Every domain table carries app_id (tenant key,
-- default 'live' so rows bulk-imported from the predecessor DB need no rewrite).

PRAGMA journal_mode = WAL;

-- ── Tenants ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS apps (
    app_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    api_key_hash TEXT NOT NULL,
    webhook_url TEXT,
    webhook_secret TEXT,
    allowed_origins TEXT DEFAULT '[]',   -- JSON array of origins for browser (user-JWT) calls
    quota_bytes INTEGER DEFAULT 0,        -- files quota; 0 = unlimited
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── VODs ─────────────────────────────────────────────────────
-- Full column set inherited from the predecessor (health, probe, tiering,
-- clips_only, is_recording, last_accessed_at) + tenant/ingest metadata.
CREATE TABLE IF NOT EXISTS vods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL DEFAULT 'live',
    stream_id INTEGER,
    stream_key TEXT,
    managed_stream_id INTEGER,            -- owning app's stream "slot" (list filter)
    user_id INTEGER,
    title TEXT,
    description TEXT DEFAULT '',
    file_path TEXT,
    thumbnail_url TEXT,
    master_file_path TEXT,
    file_size INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    probe_duration_seconds REAL DEFAULT 0,
    probe_format_json TEXT DEFAULT '',
    health_status TEXT DEFAULT 'unknown',
    health_score INTEGER DEFAULT 0,
    health_issues_json TEXT DEFAULT '[]',
    last_health_scan_at DATETIME,
    quarantined_at DATETIME,
    is_public INTEGER DEFAULT 1,
    visibility TEXT DEFAULT 'public',
    is_recording INTEGER DEFAULT 0,
    clips_only INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    storage_tier TEXT DEFAULT 'hot',      -- legacy column (pre object-store); kept for import
    storage_provider TEXT DEFAULT 'local',
    storage_key TEXT,
    last_accessed_at DATETIME,
    ai_overview TEXT,                     -- kept for import; Live owns AI generation
    ai_transcript TEXT,
    ai_analyzed_at DATETIME,
    meta_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vods_app ON vods(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vods_recording ON vods(is_recording);
CREATE INDEX IF NOT EXISTS idx_vods_provider ON vods(storage_provider);

-- ── Clips ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL DEFAULT 'live',
    vod_id INTEGER,
    stream_id INTEGER,
    user_id INTEGER,
    channel_user_id INTEGER,              -- owner of the clipped channel/stream (list filter)
    title TEXT DEFAULT 'Untitled Clip',
    description TEXT DEFAULT '',
    file_path TEXT,
    thumbnail_url TEXT,
    start_time REAL NOT NULL DEFAULT 0,
    end_time REAL NOT NULL DEFAULT 0,
    duration_seconds REAL DEFAULT 0,
    is_public INTEGER DEFAULT 1,
    visibility TEXT DEFAULT 'public',
    status TEXT DEFAULT 'ready',          -- processing | ready | failed (imports default ready)
    view_count INTEGER DEFAULT 0,
    auto_generated INTEGER DEFAULT 0,
    storage_provider TEXT DEFAULT 'local',
    storage_key TEXT,
    ai_overview TEXT,
    ai_transcript TEXT,
    ai_analyzed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_clips_app ON clips(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_vod ON clips(vod_id);
CREATE INDEX IF NOT EXISTS idx_clips_stream ON clips(stream_id);

-- ── Unique view tracking (IP dedup for VODs and clips) ───────
CREATE TABLE IF NOT EXISTS content_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL CHECK(content_type IN ('vod', 'clip')),
    content_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(content_type, content_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_content_views_lookup ON content_views(content_type, content_id);

-- ── Pastes ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pastes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL DEFAULT 'live',
    slug TEXT UNIQUE NOT NULL,
    user_id INTEGER,
    type TEXT DEFAULT 'paste' CHECK(type IN ('paste', 'screenshot')),
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT,
    language TEXT DEFAULT 'text',
    visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public', 'unlisted', 'private')),
    stream_id INTEGER,
    screenshot_path TEXT,
    metadata TEXT,
    burn_after_read INTEGER DEFAULT 0,
    forked_from INTEGER,
    pinned INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    copies INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    is_nsfw INTEGER DEFAULT 0,
    ip_address TEXT,
    ai_summary TEXT,                      -- kept for import; Live owns AI generation
    ai_tags TEXT,
    ai_analyzed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (forked_from) REFERENCES pastes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pastes_slug ON pastes(slug);
CREATE INDEX IF NOT EXISTS idx_pastes_app ON pastes(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pastes_user ON pastes(user_id);
CREATE INDEX IF NOT EXISTS idx_pastes_visibility ON pastes(visibility);

CREATE TABLE IF NOT EXISTS paste_likes (
    paste_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (paste_id, user_id),
    FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paste_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paste_id INTEGER NOT NULL,
    user_id INTEGER,
    parent_id INTEGER,
    anon_name TEXT,
    message TEXT NOT NULL,
    ip_address TEXT,
    is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES paste_comments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paste_comments_paste ON paste_comments(paste_id);
CREATE INDEX IF NOT EXISTS idx_paste_comments_ip ON paste_comments(ip_address);

-- ── Files (new: generic per-app file storage) ────────────────
CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY,
    app_id TEXT NOT NULL DEFAULT 'live',
    user_id INTEGER,
    original_name TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT DEFAULT 'application/octet-stream',
    sha256 TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_files_app ON files(app_id, created_at DESC);

-- ── Service settings (storage-tier knobs, paste limits, …) ───
-- Same key names the inherited modules used in site_settings.
CREATE TABLE IF NOT EXISTS media_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    description TEXT DEFAULT '',
    type TEXT DEFAULT 'string',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── App assets (emotes / channel sounds) ─────────────────────
-- Canonical public home for per-channel chat assets the apps upload; browse
-- index shows uploader + channel. Unique per (app, kind, name, channel).
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL DEFAULT 'live',
    kind TEXT NOT NULL,                     -- 'emote' | 'sound'
    name TEXT NOT NULL,                     -- emote code or !command
    file_path TEXT NOT NULL,
    mime TEXT DEFAULT 'application/octet-stream',
    user_id INTEGER,                        -- uploader (app-local id)
    username TEXT DEFAULT '',               -- uploader name snapshot
    channel_username TEXT DEFAULT '',       -- channel it belongs to
    duration_seconds REAL DEFAULT 0,
    meta_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_assets_app_kind ON assets(app_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_identity ON assets(app_id, kind, name, channel_username);
