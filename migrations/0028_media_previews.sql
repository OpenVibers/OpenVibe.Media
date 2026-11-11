-- phase: expand
-- Hover previews (6 s, muted, 320 px wide, MP4 H.264 and WebM) for a finished recording or clip, stored as files
-- beside the thumbnails and named for their item (vod-<id>-<time>.mp4/.webm, served at /p/<name>). preview_url is
-- the MP4 (every browser plays it); preview_webm_url the WebM of the same moment. Both null until made, and the
-- preview.make job fills them. A live stream's preview_url is Live's own field (its DVR playlist), not a column here.
ALTER TABLE vods ADD COLUMN IF NOT EXISTS preview_url text COLLATE "C";
ALTER TABLE vods ADD COLUMN IF NOT EXISTS preview_webm_url text COLLATE "C";
ALTER TABLE clips ADD COLUMN IF NOT EXISTS preview_url text COLLATE "C";
ALTER TABLE clips ADD COLUMN IF NOT EXISTS preview_webm_url text COLLATE "C";
