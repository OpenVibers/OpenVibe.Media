-- phase: expand
-- Named object zones and the S3 surface (ADR-031 and its 2026-10-02 amendment, OpenVibe.Zone).
--
-- media_zones is Media's projection of the zone records OpenVibe.Zone owns: Zone pushes each change with a higher
-- revision (PUT /internal/zones/:id) and Media resolves S3 bucket names, quotas and states from it. A name stays with
-- its zone for ever within one project environment, deleted or not, so a signed request names exactly one zone id.
CREATE TABLE media_zones (
    id              text COLLATE "C" PRIMARY KEY,                -- zon_<ULID>
    project_id      text COLLATE "C" NOT NULL,
    env             text COLLATE "C" NOT NULL CHECK (env IN ('sandbox', 'production')),
    name            text COLLATE "C" NOT NULL,
    is_default      boolean NOT NULL DEFAULT false,
    namespace       text COLLATE "C" NOT NULL UNIQUE,            -- the environment root, or <root>.<id>
    quota_bytes     bigint,
    state           text COLLATE "C" NOT NULL CHECK (state IN ('provisioning', 'active', 'deleting', 'deleted')),
    revision        bigint NOT NULL,
    record          jsonb NOT NULL,                              -- the zone.object-zone@1 Zone sent
    deletion_requested_at bigint,
    deletion_completed_at bigint,
    updated_at      bigint NOT NULL,
    UNIQUE (project_id, env, name)
);

-- S3 access keys (ADR-031: bound to one project environment, read and/or write, optionally to some zones). Media
-- verifies the SigV4 signature, so Media keeps the secret: encrypted with MEDIA_S3_KEY_SECRET, shown once at issue.
CREATE TABLE media_access_keys (
    id              text COLLATE "C" PRIMARY KEY,                -- ovk_<ULID>, the S3 access key id
    project_id      text COLLATE "C" NOT NULL,
    env             text COLLATE "C" NOT NULL CHECK (env IN ('sandbox', 'production')),
    name            text NOT NULL,
    permissions     text COLLATE "C" NOT NULL CHECK (permissions IN ('read', 'write', 'read-write')),
    zones           jsonb NOT NULL DEFAULT '[]',                 -- [] = every zone of the environment
    secret_enc      text COLLATE "C" NOT NULL,                   -- iv.tag.ciphertext (AES-256-GCM), base64url
    created_by      text COLLATE "C" NOT NULL,                   -- usr_… who issued it
    created_at      bigint NOT NULL,
    last_used_at    bigint,
    revoked_at      bigint,
    revoked_by      text COLLATE "C"
);
CREATE INDEX media_access_keys_project ON media_access_keys (project_id, env) WHERE revoked_at IS NULL;

-- An object's zone and its S3 key. Objects written over S3 carry both; a native object's key is derived (its med_ id,
-- below the child namespace path in the default zone) until the contract migration backfills every row.
ALTER TABLE media_objects ADD COLUMN zone_id text COLLATE "C";
ALTER TABLE media_objects ADD COLUMN object_key text COLLATE "C";
-- One live object per key in a zone. An S3 write stores its bytes first and then, in one transaction under the
-- tenant's quota lock, tombstones the previous object of the key and inserts the new one already ready.
CREATE UNIQUE INDEX media_objects_zone_key_live ON media_objects (zone_id, object_key)
    WHERE zone_id IS NOT NULL AND object_key IS NOT NULL AND lifecycle_status = 'ready';
CREATE INDEX media_objects_namespace_key ON media_objects (namespace, object_key) WHERE lifecycle_status = 'ready';
