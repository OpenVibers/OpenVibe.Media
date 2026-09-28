-- phase: expand
-- OpenVibe.Media on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.
-- SQLite's text timestamps and date functions (openvibe-sdk tools/asyncify SQLITE_DATE_FUNCTIONS).
CREATE FUNCTION ov_ts(t text) RETURNS timestamp LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF t IS NULL THEN RETURN NULL; END IF;
    IF t = 'now' THEN RETURN statement_timestamp() AT TIME ZONE 'UTC'; END IF;
    IF t ~ '\d\d:\d\d(:\d\d(\.\d+)?)?\s*(Z|[+-]\d\d(:?\d\d)?)$' THEN RETURN t::timestamptz AT TIME ZONE 'UTC'; END IF;
    RETURN t::timestamp;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;
CREATE FUNCTION ov_now() RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE FUNCTION ov_now_iso() RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION ov_now_iso(modifier text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char((statement_timestamp() AT TIME ZONE 'UTC') + modifier::interval, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION datetime(t text, modifier text DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE ts timestamp := ov_ts(t);
BEGIN
    IF ts IS NULL THEN RETURN NULL; END IF;
    IF modifier IS NOT NULL THEN ts := ts + modifier::interval; END IF;
    RETURN to_char(ts, 'YYYY-MM-DD HH24:MI:SS');
EXCEPTION WHEN others THEN RETURN NULL;
END $$;
CREATE FUNCTION julianday(t text) RETURNS double precision LANGUAGE sql STABLE AS $$ SELECT extract(epoch FROM ov_ts(t))::double precision / 86400.0 + 2440587.5 $$;
-- SQLite's JSON1 as the code uses it: json_valid(t), and json_extract(t, '$.a.b') as text (CAST it for a number).
CREATE FUNCTION json_valid(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT t IS JSON $$;
CREATE FUNCTION json_extract(t text, path text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_extract_path_text(t::jsonb, VARIADIC string_to_array(substr(path, 3), '.')) $$;
CREATE FUNCTION json_type(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof(t::jsonb) $$;   -- 'object' and 'array' as SQLite; scalars are PostgreSQL's names
CREATE FUNCTION instr(t text, sub text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT strpos(t, sub) $$;   -- SQLite's instr

CREATE TABLE apps (
    app_id text COLLATE "C" PRIMARY KEY,
    name text COLLATE "C" NOT NULL DEFAULT '',
    api_key_hash text COLLATE "C" NOT NULL,
    webhook_url text COLLATE "C",
    webhook_secret text COLLATE "C",
    allowed_origins text COLLATE "C" DEFAULT '[]',
    quota_bytes bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    project_id text COLLATE "C",
    env text COLLATE "C"
);

CREATE TABLE vods (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL DEFAULT 'live',
    stream_id bigint,
    stream_key text COLLATE "C",
    managed_stream_id bigint,
    user_id bigint,
    title text COLLATE "C",
    description text COLLATE "C" DEFAULT '',
    file_path text COLLATE "C",
    thumbnail_url text COLLATE "C",
    master_file_path text COLLATE "C",
    file_size bigint DEFAULT 0,
    duration_seconds bigint DEFAULT 0,
    probe_duration_seconds double precision DEFAULT 0,
    duration_source text COLLATE "C",
    probe_format_json text COLLATE "C" DEFAULT '',
    health_status text COLLATE "C" DEFAULT 'unknown',
    health_score bigint DEFAULT 0,
    health_issues_json text COLLATE "C" DEFAULT '[]',
    last_health_scan_at text COLLATE "C",
    quarantined_at text COLLATE "C",
    is_public bigint DEFAULT 1,
    visibility text COLLATE "C" DEFAULT 'public',
    is_recording bigint DEFAULT 0,
    clips_only bigint DEFAULT 0,
    view_count bigint DEFAULT 0,
    storage_tier text COLLATE "C" DEFAULT 'hot',
    storage_provider text COLLATE "C" DEFAULT 'local',
    storage_key text COLLATE "C",
    last_accessed_at text COLLATE "C",
    ai_overview text COLLATE "C",
    ai_transcript text COLLATE "C",
    ai_analyzed_at text COLLATE "C",
    meta_json text COLLATE "C" DEFAULT '{}',
    object_id text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    unique_views bigint DEFAULT 0
);

CREATE TABLE clips (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL DEFAULT 'live',
    vod_id bigint,
    stream_id bigint,
    user_id bigint,
    channel_user_id bigint,
    title text COLLATE "C" DEFAULT 'Untitled Clip',
    description text COLLATE "C" DEFAULT '',
    file_path text COLLATE "C",
    thumbnail_url text COLLATE "C",
    start_time double precision NOT NULL DEFAULT 0,
    end_time double precision NOT NULL DEFAULT 0,
    duration_seconds double precision DEFAULT 0,
    is_public bigint DEFAULT 1,
    visibility text COLLATE "C" DEFAULT 'public',
    status text COLLATE "C" DEFAULT 'ready',
    view_count bigint DEFAULT 0,
    auto_generated bigint DEFAULT 0,
    storage_provider text COLLATE "C" DEFAULT 'local',
    storage_key text COLLATE "C",
    ai_overview text COLLATE "C",
    ai_transcript text COLLATE "C",
    ai_analyzed_at text COLLATE "C",
    object_id text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    cut_error text COLLATE "C",
    cut_attempts bigint DEFAULT 0,
    cut_next_at text COLLATE "C",
    unique_views bigint DEFAULT 0
);

CREATE TABLE content_views (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content_type text COLLATE "C" NOT NULL CHECK(content_type IN ('vod', 'clip')),
    content_id bigint NOT NULL,
    ip text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(content_type, content_id, ip)
);

CREATE TABLE pastes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL DEFAULT 'live',
    slug text COLLATE "C" UNIQUE NOT NULL,
    user_id bigint,
    type text COLLATE "C" DEFAULT 'paste' CHECK(type IN ('paste', 'screenshot')),
    title text COLLATE "C" NOT NULL DEFAULT 'Untitled',
    content text COLLATE "C",
    language text COLLATE "C" DEFAULT 'text',
    visibility text COLLATE "C" DEFAULT 'public' CHECK(visibility IN ('public', 'unlisted', 'private')),
    stream_id bigint,
    screenshot_path text COLLATE "C",
    metadata text COLLATE "C",
    burn_after_read bigint DEFAULT 0,
    forked_from bigint,
    pinned bigint DEFAULT 0,
    views bigint DEFAULT 0,
    copies bigint DEFAULT 0,
    likes bigint DEFAULT 0,
    is_nsfw bigint DEFAULT 0,
    ip_address text COLLATE "C",
    ai_summary text COLLATE "C",
    ai_tags text COLLATE "C",
    ai_analyzed_at text COLLATE "C",
    object_id text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    unique_views bigint DEFAULT 0,
    FOREIGN KEY (forked_from) REFERENCES pastes(id) ON DELETE SET NULL
);

CREATE TABLE paste_likes (
    paste_id bigint NOT NULL,
    user_id bigint NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (paste_id, user_id),
    FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE
);

CREATE TABLE paste_comments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    paste_id bigint NOT NULL,
    user_id bigint,
    parent_id bigint,
    anon_name text COLLATE "C",
    message text COLLATE "C" NOT NULL,
    ip_address text COLLATE "C",
    is_deleted bigint DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES paste_comments(id) ON DELETE CASCADE
);

CREATE TABLE files (
    key text COLLATE "C" PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL DEFAULT 'live',
    user_id bigint,
    original_name text COLLATE "C",
    size bigint NOT NULL DEFAULT 0,
    mime text COLLATE "C" DEFAULT 'application/octet-stream',
    sha256 text COLLATE "C",
    object_id text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    unique_views bigint DEFAULT 0,
    view_count bigint DEFAULT 0
);

CREATE TABLE media_settings (
    key text COLLATE "C" PRIMARY KEY,
    value text COLLATE "C",
    description text COLLATE "C" DEFAULT '',
    type text COLLATE "C" DEFAULT 'string',
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE assets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL DEFAULT 'live',
    kind text COLLATE "C" NOT NULL,
    name text COLLATE "C" NOT NULL,
    file_path text COLLATE "C" NOT NULL,
    mime text COLLATE "C" DEFAULT 'application/octet-stream',
    user_id bigint,
    username text COLLATE "C" DEFAULT '',
    channel_username text COLLATE "C" DEFAULT '',
    duration_seconds double precision DEFAULT 0,
    meta_json text COLLATE "C" DEFAULT '{}',
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE media_objects (
    id text COLLATE "C" PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL,
    namespace text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK(kind IN ('vod', 'clip', 'file', 'thumbnail', 'screenshot', 'avatar', 'asset')),
    owner_subject text COLLATE "C",
    owner_app text COLLATE "C",
    owner_user_id bigint,
    visibility text COLLATE "C" NOT NULL DEFAULT 'private' CHECK(visibility IN ('public', 'unlisted', 'private')),
    lifecycle_status text COLLATE "C" NOT NULL DEFAULT 'uploading' CHECK(lifecycle_status IN ('uploading', 'ready', 'failed', 'archived', 'deleted')),
    mime_type text COLLATE "C",
    size_bytes bigint NOT NULL DEFAULT 0,
    content_hash text COLLATE "C",
    canonical_provider text COLLATE "C",
    canonical_key text COLLATE "C",
    legacy_ref text COLLATE "C" UNIQUE,
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    deleted_at text COLLATE "C"
);

CREATE TABLE media_namespaces (
    namespace text COLLATE "C" PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL,
    parent text COLLATE "C",
    owner text COLLATE "C" NOT NULL,
    policy text COLLATE "C" NOT NULL DEFAULT '{}',
    quota_bytes bigint,
    quota_objects bigint,
    used_bytes bigint NOT NULL DEFAULT 0,
    used_objects bigint NOT NULL DEFAULT 0,
    reserved_bytes bigint NOT NULL DEFAULT 0,
    reserved_objects bigint NOT NULL DEFAULT 0,
    reconciled_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE media_quota_reservations (
    object_id text COLLATE "C" PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL,
    namespace text COLLATE "C" NOT NULL,
    bytes bigint NOT NULL DEFAULT 0,
    expires_at text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE media_locations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_id text COLLATE "C" NOT NULL,
    provider text COLLATE "C" NOT NULL CHECK(provider IN ('local', 'b2', 'r2')),
    bucket text COLLATE "C",
    key text COLLATE "C" NOT NULL,
    storage_class text COLLATE "C",
    state text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK(state IN ('present', 'missing', 'pending', 'corrupt')),
    checksum text COLLATE "C",
    size_bytes bigint,
    verified_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(object_id, provider)
);

CREATE TABLE media_relationships (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_object_id text COLLATE "C" NOT NULL,
    relation text COLLATE "C" NOT NULL,
    to_object_id text COLLATE "C" NOT NULL,
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(from_object_id, relation, to_object_id)
);

CREATE TABLE media_variants (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_id text COLLATE "C" NOT NULL,
    variant_name text COLLATE "C" NOT NULL,
    derived_object_id text COLLATE "C" NOT NULL,
    recipe text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE(object_id, variant_name)
);

CREATE TABLE media_jobs (
    id text COLLATE "C" PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL,
    object_id text COLLATE "C",
    job_type text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'queued' CHECK(status IN ('proposed', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
    idempotency_key text COLLATE "C",
    request_hash text COLLATE "C",
    params text COLLATE "C" NOT NULL DEFAULT '{}',
    result text COLLATE "C",
    attempts bigint NOT NULL DEFAULT 0,
    max_attempts bigint NOT NULL DEFAULT 3,
    run_after text COLLATE "C",
    lease_until text COLLATE "C",
    lease_token text COLLATE "C",
    checkpoint text COLLATE "C",
    error text COLLATE "C",
    error_code text COLLATE "C",
    cancel_requested bigint NOT NULL DEFAULT 0,
    created_by text COLLATE "C",
    owner_user_id bigint,
    decided_by text COLLATE "C",
    decided_at text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    started_at text COLLATE "C",
    finished_at text COLLATE "C"
);

CREATE TABLE media_uploads (
    id text COLLATE "C" PRIMARY KEY,
    object_id text COLLATE "C" NOT NULL,
    app_id text COLLATE "C" NOT NULL,
    part_size bigint NOT NULL,
    total_size bigint NOT NULL,
    parts_expected bigint NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completing', 'completed', 'aborted', 'expired')),
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    expires_at text COLLATE "C" NOT NULL,
    completed_at text COLLATE "C"
);

CREATE TABLE media_upload_parts (
    upload_id text COLLATE "C" NOT NULL,
    part_number bigint NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text COLLATE "C" NOT NULL,
    received_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE media_holds (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_id text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK(kind IN ('moderation', 'dmca', 'creator_pin', 'admin', 'evidence')),
    reason text COLLATE "C" NOT NULL DEFAULT '',
    created_by text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    released_at text COLLATE "C",
    released_by text COLLATE "C",
    note text COLLATE "C"
);

CREATE TABLE media_invariant_violations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_id text COLLATE "C" NOT NULL UNIQUE,
    level text COLLATE "C" NOT NULL CHECK(level IN ('warn', 'violation')),
    size_bytes bigint NOT NULL,
    threshold_bytes bigint NOT NULL,
    detected_at text COLLATE "C" DEFAULT ov_now(),
    last_seen_at text COLLATE "C" DEFAULT ov_now(),
    resolved_at text COLLATE "C"
);

CREATE TABLE media_tier_decisions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decided_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    vod_id bigint NOT NULL,
    app_id text COLLATE "C",
    object_id text COLLATE "C",
    action text COLLATE "C" NOT NULL CHECK(action IN ('promote', 'demote')),
    from_provider text COLLATE "C",
    to_provider text COLLATE "C",
    outcome text COLLATE "C" NOT NULL CHECK(outcome IN ('done', 'already', 'refused', 'failed')),
    trigger text COLLATE "C" NOT NULL,
    reason text COLLATE "C" NOT NULL,
    inputs text COLLATE "C" NOT NULL DEFAULT '{}',
    thresholds text COLLATE "C" NOT NULL DEFAULT '{}',
    error text COLLATE "C"
);

CREATE TABLE media_object_view_salts (
    day text COLLATE "C" PRIMARY KEY,
    salt text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE TABLE media_object_viewer_days (
    day text COLLATE "C" NOT NULL,
    object_id text COLLATE "C" NOT NULL,
    viewer text COLLATE "C" NOT NULL,
    PRIMARY KEY (day, object_id, viewer)
);

CREATE TABLE media_object_views_daily (
    object_id text COLLATE "C" NOT NULL,
    day text COLLATE "C" NOT NULL,
    unique_viewers bigint NOT NULL DEFAULT 0,
    last_viewed_at text COLLATE "C",
    PRIMARY KEY (object_id, day)
);

CREATE TABLE media_object_tier_decisions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decided_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    object_id text COLLATE "C" NOT NULL,
    app_id text COLLATE "C",
    action text COLLATE "C" NOT NULL CHECK(action IN ('promote', 'demote')),
    from_provider text COLLATE "C",
    to_provider text COLLATE "C",
    outcome text COLLATE "C" NOT NULL CHECK(outcome IN ('done', 'already', 'refused', 'failed', 'dry_run')),
    trigger text COLLATE "C" NOT NULL,
    reason text COLLATE "C" NOT NULL,
    inputs text COLLATE "C" NOT NULL DEFAULT '{}',
    thresholds text COLLATE "C" NOT NULL DEFAULT '{}',
    error text COLLATE "C"
);

CREATE TABLE media_object_changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_id text COLLATE "C" NOT NULL,
    change text COLLATE "C" NOT NULL CHECK(change IN ('deleted', 'visibility_changed')),
    previous_visibility text COLLATE "C",
    visibility text COLLATE "C",
    changed_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);

CREATE TABLE media_verifications (
    object_id text COLLATE "C" PRIMARY KEY,
    verified_at text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL CHECK(status IN ('good', 'no_good_copy', 'unverifiable')),
    good_providers text COLLATE "C",
    detail text COLLATE "C" NOT NULL DEFAULT '{}',
    run_id bigint
);

CREATE TABLE media_verify_runs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at text COLLATE "C" NOT NULL,
    finished_at text COLLATE "C",
    objects_checked bigint NOT NULL DEFAULT 0,
    locations_checked bigint NOT NULL DEFAULT 0,
    good bigint NOT NULL DEFAULT 0,
    no_good_copy bigint NOT NULL DEFAULT 0,
    unverifiable bigint NOT NULL DEFAULT 0,
    reuploaded bigint NOT NULL DEFAULT 0,
    reupload_failed bigint NOT NULL DEFAULT 0,
    no_good_copy_total bigint,
    error text COLLATE "C"
);

CREATE TABLE account_data_events (
    id text COLLATE "C" PRIMARY KEY,
    kind text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    outcome text COLLATE "C",
    sent_at text COLLATE "C",
    applied_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);

CREATE TABLE subject_merges (
    merge_id text COLLATE "C" PRIMARY KEY,
    from_subject text COLLATE "C" NOT NULL,
    into_subject text COLLATE "C" NOT NULL,
    objects bigint NOT NULL DEFAULT 0,
    applied_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);

CREATE TABLE content_visits (
    content_type text COLLATE "C" NOT NULL,
    content_id bigint NOT NULL,
    visitor text COLLATE "C" NOT NULL,
    first_at text COLLATE "C" DEFAULT ov_now(),
    last_at text COLLATE "C" DEFAULT ov_now(),
    visits bigint DEFAULT 1,
    PRIMARY KEY (content_type, content_id, visitor)
);

CREATE TABLE search_doc_pushes (
    kind text COLLATE "C" NOT NULL,
    media_id bigint NOT NULL,
    hash text COLLATE "C" NOT NULL,
    revision bigint NOT NULL,
    deleted bigint NOT NULL DEFAULT 0,
    pushed_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (kind, media_id)
);

CREATE INDEX idx_vods_app ON vods(app_id, created_at DESC);
CREATE INDEX idx_vods_recording ON vods(is_recording);
CREATE INDEX idx_vods_provider ON vods(storage_provider);
CREATE INDEX idx_clips_app ON clips(app_id, created_at DESC);
CREATE INDEX idx_clips_vod ON clips(vod_id);
CREATE INDEX idx_clips_stream ON clips(stream_id);
CREATE INDEX idx_content_views_lookup ON content_views(content_type, content_id);
CREATE INDEX idx_pastes_slug ON pastes(slug);
CREATE INDEX idx_pastes_app ON pastes(app_id, created_at DESC);
CREATE INDEX idx_pastes_user ON pastes(user_id);
CREATE INDEX idx_pastes_visibility ON pastes(visibility);
CREATE INDEX idx_paste_comments_paste ON paste_comments(paste_id);
CREATE INDEX idx_paste_comments_ip ON paste_comments(ip_address);
CREATE INDEX idx_files_app ON files(app_id, created_at DESC);
CREATE INDEX idx_assets_app_kind ON assets(app_id, kind, created_at DESC);
CREATE UNIQUE INDEX idx_assets_identity ON assets(app_id, kind, name, channel_username);
CREATE INDEX idx_media_objects_app ON media_objects(app_id, id);
CREATE INDEX idx_media_objects_kind ON media_objects(app_id, kind);
CREATE INDEX idx_media_objects_owner ON media_objects(owner_subject);
CREATE INDEX idx_media_objects_lifecycle ON media_objects(lifecycle_status);
CREATE INDEX idx_media_objects_namespace ON media_objects(app_id, namespace, lifecycle_status);
CREATE INDEX idx_media_namespaces_app ON media_namespaces(app_id, namespace);
CREATE INDEX idx_media_quota_reservations_ns ON media_quota_reservations(app_id, namespace);
CREATE INDEX idx_media_quota_reservations_expiry ON media_quota_reservations(expires_at);
CREATE INDEX idx_media_relationships_to ON media_relationships(to_object_id, relation);
CREATE INDEX idx_media_jobs_status ON media_jobs(status, job_type);
CREATE INDEX idx_media_uploads_object ON media_uploads(object_id, status);
CREATE INDEX idx_media_uploads_expiry ON media_uploads(status, expires_at);
CREATE INDEX idx_media_holds_object ON media_holds(object_id, released_at);
CREATE INDEX idx_media_tier_decisions_vod ON media_tier_decisions(vod_id, id);
CREATE INDEX idx_media_tier_decisions_app ON media_tier_decisions(app_id, id);
CREATE INDEX idx_media_object_views_daily_day ON media_object_views_daily(day, object_id);
CREATE INDEX idx_media_object_tier_decisions_object ON media_object_tier_decisions(object_id, id);
CREATE INDEX idx_media_object_tier_decisions_app ON media_object_tier_decisions(app_id, id);
CREATE INDEX idx_media_verifications_at ON media_verifications(verified_at);
CREATE INDEX idx_media_verifications_status ON media_verifications(status);
CREATE INDEX idx_media_jobs_app ON media_jobs(app_id, id);
CREATE INDEX idx_media_jobs_object ON media_jobs(object_id, job_type, status);
CREATE UNIQUE INDEX idx_media_jobs_idem ON media_jobs(app_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_clips_object ON clips(object_id);
CREATE INDEX idx_content_visits_item ON content_visits(content_type, content_id);
CREATE INDEX idx_content_visits_last ON content_visits(last_at);

CREATE FUNCTION trg_vods_hold_guard_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (OLD.object_id IS NOT NULL AND EXISTS (SELECT 1 FROM media_holds h WHERE h.released_at IS NULL AND (h.object_id = OLD.object_id OR h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = OLD.object_id AND r.relation = 'clip_of') OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = OLD.object_id)))) THEN RAISE EXCEPTION 'media object is under a retention hold'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_vods_hold_guard_v2 BEFORE DELETE ON vods FOR EACH ROW EXECUTE FUNCTION trg_vods_hold_guard_v2();

CREATE FUNCTION trg_vods_object_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.object_id IS NOT NULL THEN UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = COALESCE(deleted_at, ov_now()), updated_at = ov_now() WHERE id = OLD.object_id AND lifecycle_status != 'deleted'; END IF; RETURN NULL; END $$;
CREATE TRIGGER trg_vods_object_deleted AFTER DELETE ON vods FOR EACH ROW EXECUTE FUNCTION trg_vods_object_deleted();

CREATE FUNCTION trg_clips_hold_guard_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (OLD.object_id IS NOT NULL AND EXISTS (SELECT 1 FROM media_holds h WHERE h.released_at IS NULL AND (h.object_id = OLD.object_id OR h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = OLD.object_id AND r.relation = 'clip_of') OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = OLD.object_id)))) OR (OLD.vod_id IS NOT NULL AND EXISTS (SELECT 1 FROM media_holds h JOIN vods v ON v.object_id = h.object_id WHERE v.id = OLD.vod_id AND h.released_at IS NULL)) THEN RAISE EXCEPTION 'media object is under a retention hold'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_clips_hold_guard_v2 BEFORE DELETE ON clips FOR EACH ROW EXECUTE FUNCTION trg_clips_hold_guard_v2();

CREATE FUNCTION trg_clips_object_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.object_id IS NOT NULL THEN UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = COALESCE(deleted_at, ov_now()), updated_at = ov_now() WHERE id = OLD.object_id AND lifecycle_status != 'deleted'; END IF; RETURN NULL; END $$;
CREATE TRIGGER trg_clips_object_deleted AFTER DELETE ON clips FOR EACH ROW EXECUTE FUNCTION trg_clips_object_deleted();

CREATE FUNCTION trg_files_hold_guard_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (OLD.object_id IS NOT NULL AND EXISTS (SELECT 1 FROM media_holds h WHERE h.released_at IS NULL AND (h.object_id = OLD.object_id OR h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = OLD.object_id AND r.relation = 'clip_of') OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = OLD.object_id)))) THEN RAISE EXCEPTION 'media object is under a retention hold'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_files_hold_guard_v2 BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION trg_files_hold_guard_v2();

CREATE FUNCTION trg_files_object_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.object_id IS NOT NULL THEN UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = COALESCE(deleted_at, ov_now()), updated_at = ov_now() WHERE id = OLD.object_id AND lifecycle_status != 'deleted'; END IF; RETURN NULL; END $$;
CREATE TRIGGER trg_files_object_deleted AFTER DELETE ON files FOR EACH ROW EXECUTE FUNCTION trg_files_object_deleted();

CREATE FUNCTION trg_pastes_hold_guard_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (OLD.object_id IS NOT NULL AND EXISTS (SELECT 1 FROM media_holds h WHERE h.released_at IS NULL AND (h.object_id = OLD.object_id OR h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = OLD.object_id AND r.relation = 'clip_of') OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = OLD.object_id)))) THEN RAISE EXCEPTION 'media object is under a retention hold'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_pastes_hold_guard_v2 BEFORE DELETE ON pastes FOR EACH ROW EXECUTE FUNCTION trg_pastes_hold_guard_v2();

CREATE FUNCTION trg_pastes_object_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.object_id IS NOT NULL THEN UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = COALESCE(deleted_at, ov_now()), updated_at = ov_now() WHERE id = OLD.object_id AND lifecycle_status != 'deleted'; END IF; RETURN NULL; END $$;
CREATE TRIGGER trg_pastes_object_deleted AFTER DELETE ON pastes FOR EACH ROW EXECUTE FUNCTION trg_pastes_object_deleted();

CREATE FUNCTION trg_media_objects_hold_guard_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lifecycle_status = 'deleted' AND OLD.lifecycle_status != 'deleted' AND EXISTS (SELECT 1 FROM media_holds h WHERE h.released_at IS NULL AND (h.object_id = OLD.id OR h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = OLD.id AND r.relation = 'clip_of') OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = OLD.id))) THEN RAISE EXCEPTION 'media object is under a retention hold'; END IF; RETURN NEW; END $$;
CREATE TRIGGER trg_media_objects_hold_guard_v2 BEFORE UPDATE OF lifecycle_status ON media_objects FOR EACH ROW EXECUTE FUNCTION trg_media_objects_hold_guard_v2();

CREATE FUNCTION trg_media_objects_hold_delete_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM media_holds h WHERE h.released_at IS NULL AND (h.object_id = OLD.id OR h.object_id IN (SELECT r.to_object_id FROM media_relationships r WHERE r.from_object_id = OLD.id AND r.relation = 'clip_of') OR h.object_id IN (SELECT v.object_id FROM clips c JOIN vods v ON v.id = c.vod_id WHERE c.object_id = OLD.id))) THEN RAISE EXCEPTION 'media object is under a retention hold'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_media_objects_hold_delete_v2 BEFORE DELETE ON media_objects FOR EACH ROW EXECUTE FUNCTION trg_media_objects_hold_delete_v2();

CREATE FUNCTION trg_media_objects_visibility_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.visibility IS DISTINCT FROM NEW.visibility AND NEW.lifecycle_status != 'deleted' THEN INSERT INTO media_object_changes (object_id, change, previous_visibility, visibility) VALUES (NEW.id, 'visibility_changed', OLD.visibility, NEW.visibility); END IF; RETURN NULL; END $$;
CREATE TRIGGER trg_media_objects_visibility_event AFTER UPDATE OF visibility ON media_objects FOR EACH ROW EXECUTE FUNCTION trg_media_objects_visibility_event();

CREATE FUNCTION trg_media_objects_deleted_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.lifecycle_status = 'deleted' AND OLD.lifecycle_status != 'deleted' THEN INSERT INTO media_object_changes (object_id, change, previous_visibility) VALUES (NEW.id, 'deleted', OLD.visibility); END IF; RETURN NULL; END $$;
CREATE TRIGGER trg_media_objects_deleted_event AFTER UPDATE OF lifecycle_status ON media_objects FOR EACH ROW EXECUTE FUNCTION trg_media_objects_deleted_event();

-- openvibe-shared/config on PostgreSQL (configSchema()): the revisioned policies media.storage_tier and media.object_tier
CREATE TABLE IF NOT EXISTS config_snapshots (
    namespace            text COLLATE "C" NOT NULL,
    revision             bigint NOT NULL,
    service              text COLLATE "C" NOT NULL,
    previous_revision    bigint,
    state                text COLLATE "C" NOT NULL CHECK (state IN ('proposed', 'active', 'superseded', 'rejected', 'rolled_back')),
    values_json          text COLLATE "C" NOT NULL,              -- the full values, secrets included (never served)
    classification_json  text COLLATE "C" NOT NULL,
    values_checksum      text COLLATE "C" NOT NULL,              -- sha256 of the full values: internal, never served
    created_at           text COLLATE "C" NOT NULL,
    created_by           text COLLATE "C" NOT NULL,
    activated_at         text COLLATE "C",
    activated_by         text COLLATE "C",
    reason               text COLLATE "C",
    error                text COLLATE "C",
    copied_from          bigint,
    good                 bigint NOT NULL DEFAULT 0,             -- 1 once it activated successfully (last-known-good)
    PRIMARY KEY (namespace, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS config_snapshots_one_active ON config_snapshots (namespace) WHERE state = 'active';
-- The fingerprint key of each namespace. Never served, never logged.
CREATE TABLE IF NOT EXISTS config_keys (
    namespace   text COLLATE "C" PRIMARY KEY,
    hmac_key    bytea NOT NULL,
    created_at  text COLLATE "C" NOT NULL
);

-- openvibe-sdk/auth createPgRevocationStore: Network's per-person token cutoffs (revocationSchema('token_revocations'))
CREATE TABLE IF NOT EXISTS token_revocations (
    subject_id     text COLLATE "C" PRIMARY KEY,
    valid_after_ms bigint NOT NULL,
    reason         text,
    updated_at     bigint NOT NULL
);

-- Rows the SQLite boot seeded
INSERT INTO media_settings (key, value, description, type) VALUES
    ('namespaces.reservations_seeded', '2026-09-28T19:44:20.852Z', '', 'string'),
    ('max_clip_duration', '60', 'Maximum clip length in seconds', 'number'),
    ('paste_max_size_kb', '512', 'Maximum paste content size in KB', 'number'),
    ('paste_screenshot_max_size_mb', '8', 'Maximum screenshot upload size in MB', 'number'),
    ('paste_cooldown_seconds', '30', 'Cooldown between paste submissions in seconds (user-JWT callers)', 'number'),
    ('paste_max_per_user_per_day', '200', 'Maximum pastes per user per day (0 = unlimited)', 'number'),
    ('paste_comment_cooldown_seconds', '10', 'Cooldown between paste comments in seconds', 'number'),
    ('paste_comment_max_length', '2000', 'Maximum paste comment length in characters', 'number'),
    ('paste_comment_anon_allowed', 'true', 'Allow anonymous comments on pastes', 'boolean'),
    ('views_migrated_v2', '1', 'Internal: legacy content_views imported', 'boolean'),
    ('view_cooldown_sec', '21600', 'A visitor counts as a new view of the same item only after this many seconds (anti refresh-spam). 0 = every visit', 'number'),
    ('view_ip_events_per_min', '60', 'Drop view events from an IP that fires more than this many per minute (across all content)', 'number');

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
