-- phase: expand
-- An audio-only recording (a browser broadcast with no camera, Media#240) has no frame to take. The row says so once,
-- from the recorder's mode or from the one ffprobe that already runs at finalize/thumbnail time, so a page never asks
-- again and the thumbnail is the streamer's avatar card (server/thumbnails/audio-card.js) instead of a 404.
ALTER TABLE vods ADD COLUMN IF NOT EXISTS audio_only boolean NOT NULL DEFAULT false;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS audio_only boolean NOT NULL DEFAULT false;
