-- phase: expand
-- Materialized clips over the source's bytes (docs/materialized-clips.md, F3.6). A media segment row may name the init
-- segment it decodes with (init_name; NULL = the rendition's seq 0 init, every existing row's meaning), and a clip's
-- rendition carries the two re-encoded edge inits as rows with negative seq (-1 head, -2 tail). The primary key
-- (object_id, rendition, seq) already distinguishes the two values; this migration replaces 0002's seq >= 0 CHECK with
-- one that admits exactly the two edge init names. Additive only: an older release never reads init_name and never
-- writes a negative seq.
ALTER TABLE media_timeline ADD COLUMN IF NOT EXISTS init_name text COLLATE "C";
-- 0002's inline column check is named media_timeline_seq_check (PostgreSQL's default for a column CHECK). DROP IF
-- EXISTS + ADD together, so re-applying this migration to an already-migrated database is a no-op, never an error.
ALTER TABLE media_timeline DROP CONSTRAINT IF EXISTS media_timeline_seq_check;
ALTER TABLE media_timeline ADD CONSTRAINT media_timeline_seq_check
    CHECK (seq >= 0 OR name IN ('init-head.mp4', 'init-tail.mp4'));
