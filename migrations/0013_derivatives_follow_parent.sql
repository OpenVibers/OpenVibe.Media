-- phase: migrate
-- A derived object (media_variants: a recording's or clip's thumbnail) is deleted with the object it was made from. It
-- was not: deleting a VOD marked its own object deleted (the row-delete triggers) and left its thumbnail objects ready,
-- so the reconcile listed 57 thumbnails of deleted recordings as still served (deleted_publicly_reachable, 2026-10-20).
-- The trigger follows every way an object becomes deleted (row deletes, soft deletes, account deletion); restoring a
-- native object brings back the derivatives deleted with it (server/objects/model.js restore). Re-running is a no-op.
CREATE OR REPLACE FUNCTION trg_media_objects_derivatives_follow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.lifecycle_status = 'deleted' AND OLD.lifecycle_status IS DISTINCT FROM 'deleted' THEN
        UPDATE media_objects d SET lifecycle_status = 'deleted', deleted_at = COALESCE(d.deleted_at, NEW.deleted_at, ov_now()), updated_at = ov_now()
          FROM media_variants v
         WHERE v.object_id = NEW.id AND d.id = v.derived_object_id AND d.lifecycle_status != 'deleted';
    END IF;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_media_objects_derivatives_follow ON media_objects;
CREATE TRIGGER trg_media_objects_derivatives_follow AFTER UPDATE OF lifecycle_status ON media_objects
    FOR EACH ROW EXECUTE FUNCTION trg_media_objects_derivatives_follow();

-- The derivatives already left behind by deletes before this release.
UPDATE media_objects d SET lifecycle_status = 'deleted', deleted_at = COALESCE(d.deleted_at, p.deleted_at, ov_now()), updated_at = ov_now()
  FROM media_variants v JOIN media_objects p ON p.id = v.object_id
 WHERE d.id = v.derived_object_id AND p.lifecycle_status = 'deleted' AND d.lifecycle_status != 'deleted';
