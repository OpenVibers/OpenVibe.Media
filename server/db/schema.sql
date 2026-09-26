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
    duration_source TEXT,                 -- probe | remux | unknown: where duration_seconds came from (NULL: before it was recorded)
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
    object_id TEXT,                       -- media_objects.id (Wave 4 object model)
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
    object_id TEXT,                       -- media_objects.id
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
    object_id TEXT,                       -- media_objects.id of the screenshot/avatar bytes (text pastes have none)
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
    object_id TEXT,                       -- media_objects.id
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

-- ── Canonical object model (roadmap Wave 4; docs/object-model.md) ──
-- Every stored byte-blob is a media_object. The vods/clips/files/pastes rows
-- above are typed projections over it (their object_id column), so the old
-- APIs and URLs keep working while new code speaks in med_<ULID> ids.
CREATE TABLE IF NOT EXISTS media_objects (
    id TEXT PRIMARY KEY,                  -- med_<ULID> (time-sortable)
    app_id TEXT NOT NULL,                 -- tenant
    namespace TEXT NOT NULL,              -- capability namespace (= app_id today; projects later)
    kind TEXT NOT NULL CHECK(kind IN ('vod', 'clip', 'file', 'thumbnail', 'screenshot', 'avatar', 'asset')),
    owner_subject TEXT,                   -- canonical subject (usr_<ULID>) when known
    owner_app TEXT,                       -- legacy owner: the app whose user-id space owner_user_id is in
    owner_user_id INTEGER,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('public', 'unlisted', 'private')),
    lifecycle_status TEXT NOT NULL DEFAULT 'uploading' CHECK(lifecycle_status IN ('uploading', 'ready', 'failed', 'archived', 'deleted')),
    mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,                    -- sha256 hex
    canonical_provider TEXT,              -- local | b2 | r2
    canonical_key TEXT,
    legacy_ref TEXT UNIQUE,               -- legacy:<app>:<kind>:<id> for projected rows; NULL = native v2 object
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_media_objects_app ON media_objects(app_id, id);
CREATE INDEX IF NOT EXISTS idx_media_objects_kind ON media_objects(app_id, kind);
CREATE INDEX IF NOT EXISTS idx_media_objects_owner ON media_objects(owner_subject);
CREATE INDEX IF NOT EXISTS idx_media_objects_lifecycle ON media_objects(lifecycle_status);

-- Where the bytes are. One row per provider copy; the canonical one is named on the object.
CREATE TABLE IF NOT EXISTS media_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local', 'b2', 'r2')),
    bucket TEXT,
    key TEXT NOT NULL,                    -- absolute path for local, object key for b2/r2
    storage_class TEXT,                   -- hot (local) | cold (b2 canonical) | cache (r2)
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('present', 'missing', 'pending', 'corrupt')),
    checksum TEXT,
    size_bytes INTEGER,
    verified_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(object_id, provider)
);

CREATE TABLE IF NOT EXISTS media_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_object_id TEXT NOT NULL,
    relation TEXT NOT NULL,               -- clip_of | thumbnail_of | derived_from | screenshot_of
    to_object_id TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_object_id, relation, to_object_id)
);
CREATE INDEX IF NOT EXISTS idx_media_relationships_to ON media_relationships(to_object_id, relation);

CREATE TABLE IF NOT EXISTS media_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id TEXT NOT NULL,              -- the source object
    variant_name TEXT NOT NULL,           -- thumbnail | 720p | waveform | …
    derived_object_id TEXT NOT NULL,
    recipe TEXT,                          -- how it was made (name@version)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(object_id, variant_name)
);

-- Generic derivative/maintenance jobs (server/jobs/; docs/object-model.md#jobs). A database made before
-- the worker existed has the schema-only shape (integer id, no app_id); database.js migrateJobsTable()
-- rebuilds it into this one. The other indexes are created there too, after the rebuild.
CREATE TABLE IF NOT EXISTS media_jobs (
    id TEXT PRIMARY KEY,                  -- mjob_<ULID>
    app_id TEXT NOT NULL,                 -- the tenant that owns the job
    object_id TEXT,                       -- the object it works on (NULL for tenant-wide jobs: invariant.scan)
    job_type TEXT NOT NULL,               -- thumbnail.regenerate | invariant.scan | object.split | object.remux
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('proposed', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
    idempotency_key TEXT,                 -- unique per tenant: a repeat answers with the same job
    request_hash TEXT,                    -- sha256 of { type, object_id, params }: a different request under a used key is refused
    params TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    run_after DATETIME,                   -- queued: not before (retry backoff)
    lease_until DATETIME,                 -- running: renewed while the worker holds the job
    lease_token TEXT,                     -- running: the claim's random fencing token; renew/checkpoint/succeed/fail must match it
    checkpoint TEXT,                      -- handler progress (JSON); a retry resumes from it
    error TEXT,
    error_code TEXT,                      -- stable code of the last failure (media_unavailable, quota_exceeded, …)
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,                      -- svc:<id> | app:<app> | app:<app>:user:<id> | system:<what>
    owner_user_id INTEGER,                -- the app's user it was created for (X-OV-User-Id), if any
    decided_by TEXT,                      -- who approved or rejected a proposal
    decided_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, job_type);

-- Multipart uploads of native v2 objects (server/objects/multipart.js). Parts are stored under
-- OBJECTS_PATH/.parts/<upload id>/ and assembled at complete; one active session per object.
CREATE TABLE IF NOT EXISTS media_uploads (
    id TEXT PRIMARY KEY,                  -- mup_<ULID>
    object_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    part_size INTEGER NOT NULL,
    total_size INTEGER NOT NULL,
    parts_expected INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completing', 'completed', 'aborted', 'expired')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    completed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_media_uploads_object ON media_uploads(object_id, status);
CREATE INDEX IF NOT EXISTS idx_media_uploads_expiry ON media_uploads(status, expires_at);

CREATE TABLE IF NOT EXISTS media_upload_parts (
    upload_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,         -- 1-based
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (upload_id, part_number)
);

-- Retention holds: an object with an unreleased hold cannot be deleted or moved between tiers, and a
-- clip follows its source VOD's hold (database.js heldSql). created_by / created_at are who placed it and
-- when (placed_by / placed_at in the API); note is free text for staff. Placed and released through
-- /api/v2/:app/objects/:id/holds and the staff routes /api/v1/:app/admin/storage/holds.
CREATE TABLE IF NOT EXISTS media_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('moderation', 'dmca', 'creator_pin', 'admin', 'evidence')),
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    released_at DATETIME,
    released_by TEXT,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_holds_object ON media_holds(object_id, released_at);

-- Public playback objects above the size policy (MEDIA_PUBLIC_OBJECT_*_MB). One row per object.
CREATE TABLE IF NOT EXISTS media_invariant_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id TEXT NOT NULL UNIQUE,
    level TEXT NOT NULL CHECK(level IN ('warn', 'violation')),
    size_bytes INTEGER NOT NULL,
    threshold_bytes INTEGER NOT NULL,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);

-- R2 tier decisions (server/vod/vod-storage.js recordTierDecision): one row for every promotion to and
-- demotion from the R2 popularity cache, whoever asked (the sweep, an admin move, the eviction drill),
-- with the inputs it saw, the policy thresholds in force and the reason. Read by the staff policy
-- endpoint (GET /api/v1/:app/admin/storage/tiers/policy and /tiers/decisions).
CREATE TABLE IF NOT EXISTS media_tier_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    vod_id INTEGER NOT NULL,
    app_id TEXT,
    object_id TEXT,
    action TEXT NOT NULL CHECK(action IN ('promote', 'demote')),
    from_provider TEXT,
    to_provider TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('done', 'already', 'refused', 'failed')),
    trigger TEXT NOT NULL,                -- sweep | admin | drill | clip | manual
    reason TEXT NOT NULL,
    inputs TEXT NOT NULL DEFAULT '{}',    -- JSON: view_count, last_accessed_at, storage_provider, is_recording, held, file_size, created_at
    thresholds TEXT NOT NULL DEFAULT '{}',-- JSON: the R2 policy in force, each value with its source (default | setting)
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_tier_decisions_vod ON media_tier_decisions(vod_id, id);
CREATE INDEX IF NOT EXISTS idx_media_tier_decisions_app ON media_tier_decisions(app_id, id);

-- Object changes waiting to become events (server/events.js recordObjectChanges): media_objects
-- triggers (database.js ensureObjectTriggers) write one row per visibility change and per deletion,
-- in the transaction that makes the change, whatever path made it; the rows become
-- media.object.visibility_changed / media.object.deleted outbox envelopes and are removed.
CREATE TABLE IF NOT EXISTS media_object_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id TEXT NOT NULL,
    change TEXT NOT NULL CHECK(change IN ('deleted', 'visibility_changed')),
    previous_visibility TEXT,
    visibility TEXT,
    changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Scheduled copy verification (server/objects/verify-job.js). One row per ready object: when it was
-- last checked and what that check found; the least recently verified objects go first in each run.
-- Verification only records and restores copies — it never deletes bytes or rows.
CREATE TABLE IF NOT EXISTS media_verifications (
    object_id TEXT PRIMARY KEY,
    verified_at TEXT NOT NULL,            -- ISO-8601 with ms (orders the rotation)
    status TEXT NOT NULL CHECK(status IN ('good', 'no_good_copy', 'unverifiable')),
    good_providers TEXT,                  -- comma list of providers holding a good copy
    detail TEXT NOT NULL DEFAULT '{}',    -- per-location verdicts and any re-upload
    run_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_media_verifications_at ON media_verifications(verified_at);
CREATE INDEX IF NOT EXISTS idx_media_verifications_status ON media_verifications(status);

-- One row per verification run (summary).
CREATE TABLE IF NOT EXISTS media_verify_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    objects_checked INTEGER NOT NULL DEFAULT 0,
    locations_checked INTEGER NOT NULL DEFAULT 0,
    good INTEGER NOT NULL DEFAULT 0,
    no_good_copy INTEGER NOT NULL DEFAULT 0,
    unverifiable INTEGER NOT NULL DEFAULT 0,
    reuploaded INTEGER NOT NULL DEFAULT 0,
    reupload_failed INTEGER NOT NULL DEFAULT 0,
    no_good_copy_total INTEGER,           -- ready objects with no good copy anywhere, after this run
    error TEXT
);
