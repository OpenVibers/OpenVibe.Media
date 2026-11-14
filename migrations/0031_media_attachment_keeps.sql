-- phase: expand
-- Which messages an attachment is kept with (composer.attachment@1): one picture may be shown by more than one
-- message (the same address in two rooms, or the same card twice), and every one of those keeps it alive. The
-- attachment row keeps the last of them (message_id) and the window it lives in (expires_at); this table keeps
-- them all. A row goes when the attachment does (the expiry sweep deletes both).
CREATE TABLE IF NOT EXISTS media_attachment_keeps (
    attachment_id text COLLATE "C" NOT NULL,
    message_id text COLLATE "C" NOT NULL,
    kept_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    PRIMARY KEY (attachment_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_media_attachment_keeps_message ON media_attachment_keeps(message_id);
