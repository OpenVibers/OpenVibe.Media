-- phase: expand
-- When a finished MP4's layout was checked (server/vod/mp4-layout.js; the health job's layout sweep, 2026-11-20). A
-- recording left fragmented (a small moov, then thousands of moof+mdat with no index) plays from a URL only after the
-- browser walked the whole file; the sweep remuxes it to a faststart MP4. NULL: not checked yet.
ALTER TABLE vods ADD COLUMN IF NOT EXISTS layout_checked_at text;
