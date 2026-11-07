-- phase: expand
-- A person's profile picture is a native avatar object (kind 'avatar'), but nothing in Media knew which object a
-- profile still pointed at: a cleanup could soft-delete the object behind a live avatar and no service was told
-- (incident 2026-11-06, 11 avatars went this way). This table records the reference a product's profile holds, so
-- model.softDelete can refuse to delete an avatar while it is in use. A row is released, never deleted: the history
-- says which objects a person's picture moved through.
CREATE TABLE IF NOT EXISTS media_avatar_refs (
    id          bigserial PRIMARY KEY,
    object_id   text COLLATE "C" NOT NULL,          -- med_… the profile points at
    subject     text COLLATE "C",                   -- usr_… of the person when the product knows it
    product     text COLLATE "C" NOT NULL,          -- 'network' (users.avatar_url), 'live' (users.avatar_url, channel banner)
    ref         text COLLATE "C" NOT NULL,          -- the person's id in that product's own space
    created_at  text COLLATE "C" NOT NULL DEFAULT ov_now(),
    released_at text COLLATE "C"
);

-- One live picture per person per product; a product may hold several kinds of slot, so the ref names the slot.
CREATE UNIQUE INDEX IF NOT EXISTS media_avatar_refs_active
    ON media_avatar_refs (product, ref) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS media_avatar_refs_object
    ON media_avatar_refs (object_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS media_avatar_refs_subject
    ON media_avatar_refs (subject) WHERE released_at IS NULL;
