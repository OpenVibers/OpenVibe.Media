# Changelog

## Unreleased

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
