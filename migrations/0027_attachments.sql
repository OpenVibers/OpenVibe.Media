-- phase: expand
-- The composer's attachments (composer.attachment@1): one row per file a person attached to a message before it is
-- sent. Bytes live under ATTACHMENTS_PATH/<id>/; the row is the authority on who may keep or delete it. An unkept
-- attachment expires 24 hours after upload (expires_at); a site that keeps it names the message it belongs to
-- (message_id, kept_at) and the window moves to the kept one. Deleting the row removes the directory.
CREATE TABLE IF NOT EXISTS media_attachments (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    principal text COLLATE "C" NOT NULL,
    name text COLLATE "C" NOT NULL,
    stored_name text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file', 'code')),
    mime text COLLATE "C" NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    sha256 text COLLATE "C",
    width bigint,
    height bigint,
    thumb_name text COLLATE "C",
    message_id text COLLATE "C",
    kept_at text COLLATE "C",
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    expires_at text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_attachments_subject ON media_attachments(subject, created_at);
CREATE INDEX IF NOT EXISTS idx_media_attachments_expires ON media_attachments(expires_at);
