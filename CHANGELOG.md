# Changelog

## Unreleased

- Avatar ingestion, image variants, and the upload-time `POST /api/v2/:app/objects/normalize-image` operation share
  `server/images/orientation.js`. The operation applies EXIF orientation to pixels before Sharp drops the source
  metadata, for first-party uploaders such as Community. Test: `test/image-orientation.test.js` covers all eight values.

- A first-party `ai` tenant for OpenVibe.AI's shared image task (`image.picture`): found Commons/Openverse pictures
  and made illustrations are stored by Media reference in the blog or wiki tenant for the person the run acts for.
  Network grants AI `media.object.upload` there (the AI, blog and wiki namespaces). `server/auth.js`.

- **Watch ids (plan track U, 2026-11-07): every VOD and clip answers to an 11-character random id.** YouTube's
  `/watch?v=` shape, so a watch page cannot be found by counting: 8 random bytes as URL-safe base64
  (`crypto.randomBytes(8).toString('base64url')`), never derived from the numeric id. Media owns VODs and clips, so
  Media mints it (`server/watch-ids.js`): at insert for every new row, and in idempotent batches — only where
  `watch_id IS NULL` — for the rows that predate it, at boot. One id space across both tables (`mintUnique()` checks
  both), so a watch id has exactly one meaning. `watch_id` is on every VOD and clip Media serves (`vodPublic`,
  `clipPublic`, so every API read and list), and `GET /api/v1/:app/watch/:watch_id` → `{ kind, id }` resolves one; a
  private item still resolves, and its own read applies the visibility rule it always did. Migration
  `0024_watch_ids.sql` (expand: a nullable column and a partial unique index per table; no table rewrite). Tests:
  `test/watch-ids.test.js` (format, insert, the resolver, the backfill idempotent and leaving none NULL, uniqueness
  across both tables, the route).

- **Audio description on a watch page (X1, consent plan 2026-10-31, "AI and data")**: the player now carries a
  `<track kind="descriptions">` for Live's VODs and clips, served same-origin at `/v/:id/descriptions.vtt` (and
  `/c/:id/descriptions.vtt`) from the WebVTT Live builds out of its scene notes and speech timeline. Public and link
  items are cacheable; a private item's track answers the same 404 as a missing id unless the viewer's Network
  session asks for it (that session is forwarded to Live, which checks the owner). Other apps' media is not described: only Live has the scene-note timeline behind it. The **AD** control and
  its spoken cues are OpenVibe.Shared's player (openvibe-shared 4.126.0, a pin-round follow-up). Tests:
  `test/audio-description.test.js` (public, private-owner, other app; track markup).

- An avatar a person's profile points at cannot be deleted out from under them (incident 2026-11-06: a cleanup of
  public screenshot copies deleted eleven avatars). `media_avatar_refs` (migration `0020_avatar_refs.sql`) records
  each profile slot → object; `model.softDelete` refuses an avatar with an unreleased reference and `DELETE` answers
  409 `media.object.avatar_in_use`. The internal `POST /internal/avatar-adopt` and `/internal/avatar-release` routes
  write it, and `/internal/avatar-ingest` records it when given `product` and `ref`. Replacing a picture releases the
  previous reference in the same transaction; account deletion releases the person's references first. Ingest also
  reads our own `/o/<id>` and `/p/<slug>/screenshot` sources locally instead of fetching them, reuses an avatar the
  subject already owns, and stores a 1600×500 `shape: 'banner'` crop. Test: `test/avatar-guard.test.js`.

- Operator retirement for an object with no good copy (`scripts/no-good-copy-report.js --retire <med_id> [--apply]`):
  the dry run changes nothing; only an object in the report, not public and under 1 MiB is retired (a public v1 row, a
  native public object, good-copy, 1 MiB+ and held objects are refused with the reason). For a legacy VOD/clip the v1
  row decides: a delisted row (`is_public` 0, even with `visibility` still public after the health quarantine), or a
  private/unlisted one, makes the object not public even when its `media_objects` row still says public. The delete is
  the ordinary soft delete (bytes kept, retention, `media.object.deleted`, restorable), and a
  projected VOD/clip has its v1 row made private so the inherited route stops serving it. Test:
  `test/retire-no-good-copy.test.js`.

- A legacy Live paste screenshot can be retired for OpenVibe.Community (2026-11-06). The internal
  `POST /internal/community/legacy-paste-screenshots/:id/retire` route is loopback and service-token only
  (`media.object.delete`, principal `svc:community`) and soft-deletes exactly a `legacy:live:paste:<slug>`
  screenshot: 410 at `/o/:id`, the ordinary retention window and `media.object.deleted` event, and a repeat
  is a no-op. VODs, clips, files, thumbnails, avatars and native objects are refused, and so is any other principal.

- The legacy retire route also accepts a Community-era v1 file object (`app_id community`, kind `file`,
  `legacy_ref legacy:community:file:<key>`), for the same `svc:community` principal and with the same ordinary soft
  delete, retention, hold refusal and idempotence. Community's screenshot move calls it for old pastes whose bytes were
  stored before the Object API v2, after checking no other paste, post or attachment still references the id.
  Test: `test/legacy-paste-retire.test.js`.
- Review follow-up: a category-3 result places an `evidence` hold in the quarantine transaction, so owner delete and
  retention purge answer 409 held; an operator's overruling category releases it with who and when. Adds Vision's
  logged 60-second `operator-view` and service-only `review-decision` routes, a separate operator signature purpose,
  `media_review_views`, migration `0019_review_evidence.sql`, and Contracts v0.294.0.
- Unsafe-image review enforcement (VIS-6): a visible upload is pending until OpenVibe.Vision (`VISION_URL` plus
  Media's service principal) sorts it into `fine`, `sex_acts` or `minor_sexual`. Sex acts become private and leave
  every public surface; sexual content involving a minor is quarantined even from a signed read and keeps Vision's
  operator report id. A reviewer outage leaves the object pending, never public. Migration
  `0018_object_reviews.sql`, `server/objects/review.js`, `POST /api/v2/:app/objects/:id/review`, tests
  `test/object-review.test.js`.

- A tenant for the screenshot pass (plan L9, devblog §3.3): OpenVibe.Host stores the PNGs it captures (ovhost shots) in its own
  tenant, `host`, through the Object API v2. The tenant is created at boot like the other first-party ones, and reached only
  with a Network service token that holds the media.object.* verbs for the host namespace.

- A deleted recording's or clip's thumbnail goes with it (2026-10-20). Migration 0013 adds a trigger that marks an
  object's derivatives (`media_variants`) deleted whenever it is, and backfills the ones left behind; restoring a native
  object brings back the derivatives deleted with it. `/t/vod-<id>-…` and `/t/clip-<id>-…` answer the empty pixel once
  the item's row is gone (the file stays on disk). The reconcile found 57 such thumbnails still served, and the
  thumbnail folder held files for 1,336 recordings and 73 clips that no longer exist.
- Bound local CMAF and packed timeline copies with a configurable byte budget and free-space floor. The hourly sweep
  evicts least recently served copies only after durable size and SHA-256 verification, preserving all timeline rows
  and durable playback.
- Limit lazy HLS backfill to 20 VODs per hour by default while recording finalize remains immediate.
- Add timeline cache readiness and metrics, environment documentation and production enablement guidance.
