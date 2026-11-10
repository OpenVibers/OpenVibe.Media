-- phase: expand
-- Owner-scoped lookup index for duplicate preflight. Existing objects without hashes are filled by object.hash.
CREATE INDEX idx_media_objects_owner_content_hash
    ON media_objects (app_id, owner_subject, content_hash, created_at DESC)
    WHERE lifecycle_status = 'ready' AND owner_subject IS NOT NULL AND content_hash IS NOT NULL;

CREATE INDEX idx_media_objects_user_content_hash
    ON media_objects (app_id, owner_user_id, content_hash, created_at DESC)
    WHERE lifecycle_status = 'ready' AND owner_user_id IS NOT NULL AND content_hash IS NOT NULL;
