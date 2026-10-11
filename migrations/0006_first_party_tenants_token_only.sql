-- phase: migrate
-- Compatibility register C-71: every first-party tenant is reached only with its service's Network service token
-- (Live since C-70, OpenRestream since C-42, Inventory and MediaHub since their 2026-10-11 releases). App keys were
-- only ever seeded from MEDIA_APPS_SEED / MEDIA_APP_KEYS, which this release stops reading, so the key hashes still
-- stored for those tenants are emptied: an empty hash never matches a presented key (server/auth.js checkAppKey),
-- exactly like the tenants that never had one. Developer-project tenants never carry a hash (ADR-014). Re-running it
-- is a no-op.
UPDATE apps SET api_key_hash = '' WHERE project_id IS NULL AND api_key_hash <> '';
