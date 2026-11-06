# Changelog

## Unreleased

- Operator retirement for an object with no good copy (`scripts/no-good-copy-report.js --retire <med_id> [--apply]`):
  the dry run changes nothing; only an object in the report, not public and under 1 MiB is retired (public, good-copy,
  1 MiB+ and held objects are refused with the reason). The delete is the ordinary soft delete (bytes kept,
  retention, `media.object.deleted`, restorable), and a projected VOD/clip has its v1 row made private so the inherited
  route stops serving it. Test: `test/retire-no-good-copy.test.js`.

- A legacy Live paste screenshot can be retired for OpenVibe.Community (2026-11-06). The internal
  `POST /internal/community/legacy-paste-screenshots/:id/retire` route is loopback and service-token only
  (`media.object.delete`, principal `svc:community`) and soft-deletes exactly a `legacy:live:paste:<slug>`
  screenshot: 410 at `/o/:id`, the ordinary retention window and `media.object.deleted` event, and a repeat
  is a no-op. VODs, clips, files, thumbnails, avatars and native objects are refused, and so is any other principal.

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
