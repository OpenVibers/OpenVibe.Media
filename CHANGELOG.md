# Changelog

## Unreleased

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
