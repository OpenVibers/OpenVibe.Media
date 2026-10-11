-- phase: contract
-- after: 0001
-- OpenVibe.Media: the frozen paste tables go. Pastes moved to OpenVibe.Community on 2026-09-22; Media#75
-- (2026-10-10 13:38 UTC) stopped every read and write of `pastes`, `paste_likes` and `paste_comments`
-- (test/paste-tables-unread.test.js), and production showed no scan or write of them after it. They were created by
-- 0001, so the N-1 window has long passed. The legacy screenshot and avatar objects stay: they are media_objects
-- found by legacy_ref (/p/:slug/screenshot 301s to /o/<id>), and DROP TABLE fires no row trigger, so dropping
-- pastes marks no object deleted. A pg_dump of the three tables was kept before this ran
-- (/root/ov_media-pastes-pre-drop-2026-10-11.dump on the host).
DROP TABLE IF EXISTS paste_comments;
DROP TABLE IF EXISTS paste_likes;
DROP TABLE IF EXISTS pastes;
DROP FUNCTION IF EXISTS trg_pastes_hold_guard_v2();
DROP FUNCTION IF EXISTS trg_pastes_object_deleted();
DELETE FROM media_settings WHERE key IN ('paste_max_size_kb', 'paste_screenshot_max_size_mb', 'paste_cooldown_seconds',
    'paste_max_per_user_per_day', 'paste_comment_cooldown_seconds', 'paste_comment_max_length', 'paste_comment_anon_allowed');
