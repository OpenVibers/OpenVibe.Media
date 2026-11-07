-- phase: migrate
-- Every VOD and clip that existed before sharing is registered once, so canView has a row for all of
-- them and the share sheet opens on an old item too.
--
--   visibility public     → public  (Everyone)
--   visibility unlisted   → link
--   visibility private    → private (Only me)
--
-- A legacy row with no visibility falls back to is_public. The owner is the Network subject Media's
-- object projection carries (media_objects.owner_subject); an imported or app-owned row with none
-- belongs to the service, which nobody can sign in as. `people` is never in the column: it is a
-- share.v1 audience only. Deleted objects are not registered.
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT 'media', 'vod', v.id::text,
       CASE WHEN o.owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'
            THEN jsonb_build_object('type', 'user', 'id', o.owner_subject)
            ELSE jsonb_build_object('type', 'service', 'id', 'media') END,
       CASE COALESCE(v.visibility, CASE WHEN v.is_public = 1 THEN 'public' ELSE 'private' END)
            WHEN 'public' THEN 'public'
            WHEN 'unlisted' THEN 'link'
            ELSE 'private' END
FROM vods v
LEFT JOIN media_objects o ON o.legacy_ref = 'legacy:' || v.app_id || ':vod:' || v.id::text
WHERE COALESCE(v.visibility, CASE WHEN v.is_public = 1 THEN 'public' ELSE 'private' END) IN ('public', 'unlisted', 'private')
ON CONFLICT (service, kind, resource_id) DO NOTHING;

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT 'media', 'clip', c.id::text,
       CASE WHEN o.owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'
            THEN jsonb_build_object('type', 'user', 'id', o.owner_subject)
            ELSE jsonb_build_object('type', 'service', 'id', 'media') END,
       CASE COALESCE(c.visibility, CASE WHEN c.is_public = 1 THEN 'public' ELSE 'private' END)
            WHEN 'public' THEN 'public'
            WHEN 'unlisted' THEN 'link'
            ELSE 'private' END
FROM clips c
LEFT JOIN media_objects o ON o.legacy_ref = 'legacy:' || c.app_id || ':clip:' || c.id::text
WHERE COALESCE(c.visibility, CASE WHEN c.is_public = 1 THEN 'public' ELSE 'private' END) IN ('public', 'unlisted', 'private')
ON CONFLICT (service, kind, resource_id) DO NOTHING;
