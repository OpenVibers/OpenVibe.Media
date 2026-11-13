-- phase: expand
-- A video attachment that no browser can play as it is gets a web copy (server/jobs/attachment-playback.js):
-- H.264 (yuv420p) + AAC in a faststart MP4, at most 1080 lines tall, the source frame rate up to 60, the rotation
-- applied. The original is never touched. The row says where the attachment stands: playback_status is 'ready'
-- (the copy, or the original when it already played), 'processing' (the copy is being made) or 'failed' (it could
-- not be made; playback_reason says why). playback_name is the copy's file name in the attachment's directory, so
-- the bytes are served at /a/<id>/<playback_name>. duration_s is the length of the video; width and height are
-- the size it is shown at (the rotation applied).
ALTER TABLE media_attachments ADD COLUMN IF NOT EXISTS playback_status text COLLATE "C";
ALTER TABLE media_attachments ADD COLUMN IF NOT EXISTS playback_reason text COLLATE "C";
ALTER TABLE media_attachments ADD COLUMN IF NOT EXISTS playback_name text COLLATE "C";
ALTER TABLE media_attachments ADD COLUMN IF NOT EXISTS playback_mime text COLLATE "C";
ALTER TABLE media_attachments ADD COLUMN IF NOT EXISTS duration_s double precision;
