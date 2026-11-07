-- phase: expand
-- A watch id for every VOD and clip (plan track U, 2026-11-07): 11 characters of URL-safe base64 from 8 random bytes
-- (crypto.randomBytes(8).toString('base64url')), YouTube's shape, so a watch page is openvibe.video/watch?v=<watch id>
-- instead of /v/<number>, which anyone could walk. The id is minted here, by the service that owns VODs and clips, and is
-- never derived from the numeric id.
--
-- Nullable on purpose: rows written before this release have none, and they are filled in batches afterwards
-- (server/watch-ids.js backfill, at boot, only where watch_id IS NULL) so the migration itself takes no table rewrite
-- and holds no lock over the whole table. Reads fall back to the number until a row has one. Additive only: an older
-- release never reads or writes the column.
ALTER TABLE vods ADD COLUMN IF NOT EXISTS watch_id text COLLATE "C";
ALTER TABLE clips ADD COLUMN IF NOT EXISTS watch_id text COLLATE "C";

-- The lookup is by id alone and must be one index probe. Partial, so the backfill's many NULLs index nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vods_watch_id ON vods (watch_id) WHERE watch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_clips_watch_id ON clips (watch_id) WHERE watch_id IS NOT NULL;
