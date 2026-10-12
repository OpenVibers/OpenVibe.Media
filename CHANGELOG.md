# Changelog

## Unreleased

- Bound local CMAF and packed timeline copies with a configurable byte budget and free-space floor. The hourly sweep
  evicts least recently served copies only after durable size and SHA-256 verification, preserving all timeline rows
  and durable playback.
- Limit lazy HLS backfill to 20 VODs per hour by default while recording finalize remains immediate.
- Add timeline cache readiness and metrics, environment documentation and production enablement guidance.
