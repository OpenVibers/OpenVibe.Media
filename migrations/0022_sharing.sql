-- phase: expand
-- Sharing (design 2026-11-06, VISIBILITY-EVERYWHERE step 5): the tables openvibe-sdk/share v0.91.0's
-- sharesSchema() creates, kept verbatim so Media's database has the same shape as every other
-- service that adopts it. Expand only: nothing is dropped or rewritten.

CREATE TABLE IF NOT EXISTS shares (
    service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    owner_subject jsonb NOT NULL, audience text NOT NULL CHECK (audience IN ('public','link','people','private')),
    revision integer NOT NULL DEFAULT 1,
    lock text NOT NULL DEFAULT 'none',
    reseal_nonce_base text,
    PRIMARY KEY (service, kind, resource_id)
);
CREATE TABLE IF NOT EXISTS share_members (
    service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    subject jsonb NOT NULL, role text NOT NULL CHECK (role IN ('viewer','editor')),
    expires_at timestamptz, added_by jsonb NOT NULL, added_at timestamptz NOT NULL,
    key_slot jsonb,
    PRIMARY KEY (service, kind, resource_id, subject),
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE TABLE IF NOT EXISTS share_transfers (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    from_subject jsonb NOT NULL, to_subject jsonb NOT NULL, keep_access boolean NOT NULL DEFAULT false,
    requested_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','accepted','declined','cancelled','expired')),
    key_slot jsonb,
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_transfer_pending ON share_transfers(service,kind,resource_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS share_access_requests (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    subject jsonb NOT NULL, requested_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','granted','dismissed')),
    FOREIGN KEY (service,kind,resource_id) REFERENCES shares(service,kind,resource_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_request_pending ON share_access_requests(service,kind,resource_id,subject) WHERE state='pending';
CREATE TABLE IF NOT EXISTS share_log (
    id uuid PRIMARY KEY, service text NOT NULL, kind text NOT NULL, resource_id text NOT NULL,
    actor jsonb NOT NULL, action text NOT NULL, details jsonb NOT NULL, occurred_at timestamptz NOT NULL,
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE OR REPLACE FUNCTION share_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'share_log is append-only'; END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='share_log_no_changes' AND tgrelid='share_log'::regclass) THEN
        CREATE TRIGGER share_log_no_changes BEFORE UPDATE OR DELETE OR TRUNCATE ON share_log
        FOR EACH STATEMENT EXECUTE FUNCTION share_log_append_only();
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS share_deliveries (
    id uuid PRIMARY KEY, channel text NOT NULL CHECK (channel IN ('event','notify')),
    body jsonb NOT NULL, created_at timestamptz NOT NULL, delivered_at timestamptz,
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE TABLE IF NOT EXISTS share_name_limits (
    caller jsonb PRIMARY KEY, window_start bigint NOT NULL, attempts integer NOT NULL
);
CREATE INDEX IF NOT EXISTS share_members_subject ON share_members(subject);
CREATE INDEX IF NOT EXISTS share_transfers_recipient ON share_transfers(to_subject) WHERE state='pending';
CREATE INDEX IF NOT EXISTS share_deliveries_pending ON share_deliveries(created_at) WHERE delivered_at IS NULL;
-- Expand-only for an existing deployment: the lock kind on the share, the member's key slot and the
-- slot a transfer was offered with. Repeating this migration is a no-op.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS lock text NOT NULL DEFAULT 'none';
DO $$ BEGIN
    ALTER TABLE shares ADD CONSTRAINT shares_lock_allowed CHECK (lock IN ('none','people','password','link'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE share_members ADD COLUMN IF NOT EXISTS key_slot jsonb;
ALTER TABLE share_transfers ADD COLUMN IF NOT EXISTS key_slot jsonb;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS reseal_nonce_base text;
