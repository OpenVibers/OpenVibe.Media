# The Media Fabric

**Status:** accepted design, 2026-09-29 (owner direction: "R2 is for faster storage than B2 and it should auto detect
and load balance automatically while maximizing cost effectiveness and not wasting", plus the Media Fabric write-up of
the same day). Supersedes the VOD-only R2 popularity sweep and the separate native-object tiering. Build order at the
end; each phase ships alone.

Media is the authority for every stored byte on the network: objects, timelines, variants, manifests, clips,
thumbnails, captions, placement, storage and delivery. Products (Live, Video, Pics, Download, Community, Games) are
presentation; they ask Media for an object and a delivery URL and never know where the bytes live.

## 1. Two fabrics, never mixed

**Online (the Media Fabric).** Every object a viewer can ask for has an immediately retrievable copy:

```
viewer → openvibe.media → delivery router
            ├─ OpenVibe edge (the Media host's NVMe cache; later edge nodes)   capacity-bounded, prepaid bandwidth
            ├─ global CDN (Bunny in front of B2; Cloudflare only in front of R2)
            └─ hot object tier: R2 Standard
                          └─ origin shield (nginx slice + cache lock) → B2: the canonical online copy
```

**Archive/backup (separate).** PostgreSQL (pgBackRest), host snapshots, configs and optional long-term archives go to
B2 (warm) and, optionally, a deep-archive provider (Glacier Deep Archive, GCS Archive). Nothing online ever fails over
to deep archive; a restore from it is an operator action, drilled like every other restore.

## 2. Provider classes, not provider names

Business logic asks for a class; providers declare capabilities; the fabric picks.

| Class | Today | Capabilities that make a provider eligible |
|---|---|---|
| `online-canonical` | B2 | durable (≥ 11 nines), no minimum duration, free ops, range + 206 + ETag |
| `online-hot` | R2 Standard | low TTFB, zero egress, range + 206; **not** R2 Infrequent Access for anything seekable (retrieval fee, 30-day minimum) |
| `global-cdn` | Bunny (origin B2, free Alliance egress); Cloudflare with R2 as origin | range from cache or cache slicing, request coalescing, origin shield, token auth, purge API |
| `regional-cache` | Media host NVMe (nginx) | prepaid bandwidth up to the port; single-flight per object+range |
| `bulk-download` | B2/R2 + CDN mirrors | range/resume, checksums |
| `warm-backup`, `deep-archive` | B2; Glacier/GCS Archive | backup fabric only |

Each adapter passes a capability probe before it becomes eligible for a class: `supports_range`, `supports_206`,
`supports_if_range`, `supports_etag`, `supports_cache_range`, `token_auth`, `purge`. The probe runs at boot and every
hour; a failed capability removes the provider from that class until it passes again.

**Economic facts the engine is built on (official price pages, fetched 2026-09-29; kept in the revisioned
`media.cost_tiers` config, never in code):** R2 Standard $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, zero egress;
R2 IA $0.01/GB-month + $0.01/GB retrieval + 30-day minimum; B2 ≈ $6–6.95/TB-month, API calls free, egress free up to 3×
stored data then $0.01/GB, and **unlimited free egress to Alliance CDNs (Bunny, Cloudflare, Fastly, …)**. Consequences:

- Behind a CDN, B2 egress costs nothing. R2 earns its place through **latency** (cold B2 TTFB is hundreds of ms) and by
  **shielding B2's request ceiling** (≈ 500 requests/s per account by default), not through egress savings.
- For small objects (segments, thumbnails) **R2 request charges dominate**, not storage: promote by requests saved per
  dollar, cache presigned URLs, and let the CDN absorb repeat reads.
- Writes go to B2 first (free PUTs); R2 PUTs (Class A) are spent only on promotion.
- **Cloudflare's terms restrict video through its CDN to its paid media products (R2, Stream, Images):** video cached by
  Cloudflare must come from an R2 origin (custom domain); B2-origin video goes through Bunny. Re-verify the terms before
  enabling a Cloudflare video path.
- The Media host's bandwidth is prepaid: the router fills the OpenVibe edge first, up to a capacity ceiling (70 % of the
  port by default), then spills to CDN/R2.

## 3. Video is segment-native (CMAF under HLS)

A video object is a timeline of fragmented-MP4 (CMAF) segments, not a file:

```
med_xyz/master.m3u8
med_xyz/source/{init.mp4, 000001.m4s, …}      canonical, durable
med_xyz/{720p,480p,360p,av1-…}/…               derivatives, rebuildable
med_xyz/{captions/*.vtt, storyboard.webp+.vtt, waveform, metadata}
```

- **Live → DVR → VOD without a conversion step.** OpenRe segments continuously; the playlist grows while live (seek
  anywhere from the start to the live edge) and gets `#EXT-X-ENDLIST` at the end. Live latency modes: WebRTC (sub-second,
  SFU), LL-HLS (partial segments, ~2–4 s), HLS DVR. When the SFU nears capacity, new viewers move to LL-HLS.
- **Write-behind durability for live.** A segment lands on the ingest node's NVMe first (served from RAM/NVMe for the
  first minutes: `segment_age` is a routing input), then uploads to B2 asynchronously. A segment is *durable* once B2
  confirms it; the timeline records that. A crash loses only the not-yet-uploaded tail, bounded by the upload lag,
  which is a metric with an alert.
- **Packing after finalize.** Two-second segments are perfect while live but produce thousands of objects per hour.
  After finalize, segments are packed into ~60-second chunk objects (byte-range playlists, `EXT-X-BYTERANGE`): ~30×
  fewer objects, PUTs, HEADs and metadata rows, while placement stays at minute granularity.
- **Keyframes.** Browser (WHIP) sources have irregular keyframes, so the source representation segments on the source's
  own keyframes (variable segment duration is legal HLS). Every derived rendition forces keyframes at exactly the
  source's segment boundaries (`-force_key_frames` from the timeline), so ABR switches and clips line up everywhere.
- **The timeline index** (`media_timeline`: object, rendition, segment number, start/end time, keyframe time, packed
  object + byte offset/length, sha256, durability) answers "the bytes for 01:47:12.350" without opening a file, and is
  the shared axis for DVR, seek, clips, sprites, captions, transcripts, chapters, AI moments and moderation markers.
- **MP4 stays for downloads and old clients:** a remuxed faststart MP4 (lazy, cached like any derivative) with plain
  HTTP ranges.
- **F3.1, shipped: the timeline index and the source representation of finished video.** Migration
  `0002_media_timeline.sql` adds `media_timeline` (object, rendition, segment number `seq` — 0 is the init segment —,
  `start_ms`/`end_ms` (contiguous, half-open), `keyframe_ms`, the segment's `key` `<object>/<rendition>/<version>/<name>`
  (`version` = the sha prefix of the bytes, so a re-cut writes beside the old segment, never over it), `local_path`,
  `durable_provider`, `packed_object_id` + `byte_offset`/`byte_length` (set by F3.3 packing; NULL until a segment is packed),
  `sha256`, `durability` `local|durable`), keyed by (object, rendition, seq) for "segments in order" with an index on
  (object, rendition, start_ms) for "the segment at t". `server/objects/timeline.js` is the store (`segmentAt(objectId,
  rendition, tMs)`, `segments`, `replace`, `removeObject`, the playlist writers). The heavy-lane job **`object.cmaf`**
  (`server/jobs/cmaf.js`) stream-copies a ready vod/clip/video object (`ffmpeg -c copy -f hls -hls_segment_type fmp4`,
  `params.segment_seconds` 1–10, 4 by default, cut at the first source keyframe after it) into `init.mp4` +
  `000001.m4s`…, stores each under `OBJECTS_PATH/.timeline/<app>/<object>/source/<version>/` and, with B2 configured,
  under the key `<object>/source/<version>/<name>` on B2 (`durable` once B2 confirms the size), then writes all rows of
  the rendition in one transaction and only then deletes the previous cut's bytes. It never touches the source object; a
  rerun reuses rows whose sha256 matches and their location as they are and uploads only what is not durable yet; it
  honours the abort signal (which stops an upload in flight) and, before the rows commit, removes the files and keys it
  staged; the stream-copy budget is honoured and its work directory removed.
  Behind **`MEDIA_HLS_ENABLED`** (off by default: the job is refused with `409 media.hls.disabled` and the routes 404),
  `GET /o/:id/master.m3u8`, `/o/:id/source/index.m3u8` and `/o/:id/source/{init.mp4,NNNNNN.m4s}` serve the timeline
  under the same check as `GET /o/:id` (private and sandbox objects only with the object's `?exp&sig`, carried onto
  every URI of a signed playlist; deleted 410). The playlists are written from the rows (`#EXT-X-PLAYLIST-TYPE:VOD`,
  `#EXT-X-ENDLIST`, EXTINF = the row's duration, BANDWIDTH = peak segment bitrate); `GET …/download?format=json` adds
  `hls_url` when a timeline exists. A purge, or a vod/clip deleted for good, removes the segments and rows; a durable
  copy that will not delete keeps its row so the next pass retries the key; a held object keeps them all. Storage orphan
  reports count timeline files and keys as wanted.
  The durable provider of the segments is the placement router's choice (`timeline.durableProvider`: the source's own
  best-ranked remote copy, else the best configured healthy provider; purpose `durable` ranks B2 before R2), and the
  segment route serves the router's ranked copy; a private or sandbox HLS answer carries no
  `Access-Control-Allow-Origin` (as `GET /o/:id`), a public one `*`.
- **F3.3, shipped: packing after finalize.** The heavy-lane job **`object.pack`** (`server/jobs/pack.js`, `params`
  `rendition` (`source`), `target_seconds` 10–300, 60 by default) concatenates each run of contiguous, durable, unpacked
  media segments of one rendition into chunk objects of about the target (a tail under half of it joins the chunk
  before; runs of one segment and the init segment stay as they are; a segment not durable yet ends a run). Each
  segment's bytes are checked against its row's sha256 (this node's copy, else the durable one through the router); the
  chunk goes to the router's durable provider under `<object>/<rendition>/<chunk sha prefix>/p<first seq>.m4s` and is
  verified there (sha256 read back), this node keeps a copy where it kept the segments, and the rows move to it in one
  transaction: `key`/`local_path`/`durable_provider` name the chunk, `packed_object_id` is its sha256 (content address),
  `byte_offset`/`byte_length` the segment inside it; name, times and sha256 stay the segment's. Only after the commit are
  the per-segment files and keys **deleted**: the chunk holds the same verified bytes, keeping both would double the
  stored bytes and every per-segment object packing exists to remove, and a delete that fails leaves an orphan the
  storage report names. A re-cut in between rolls the commit back and drops the chunk. The job never deletes a row, is
  idempotent (a rerun packs nothing), refuses a held object, honours the abort signal and `derive.budgetMs` and removes
  its work directory; `object.cmaf` keeps a packed row whose bytes it reproduces. The playlists do not change: the
  segment route answers a packed segment as a byte range of its chunk (from this node's file, or a ranged GET of the
  durable chunk, since a redirect cannot carry the range) under the same check and signature; the `EXT-X-BYTERANGE`
  form over chunk URIs is not used, so URIs, signed playlists and caches stay as they were. Purge, VOD delete, holds
  and the orphan report see a chunk through the rows that name it (each location deleted once, every row kept while its
  chunk's delete fails). All of it behind `MEDIA_HLS_ENABLED`; no schema change (F3.1's columns carry it). A finished
  `object.cmaf` queues it by itself (`objects/timeline-queue.js`; `dedupeActive`, so a rerun while a pack is active joins
  it and a later cut queues a new one), so packing follows the cut without an operator.
- **F3.4, shipped: shared locations and reference counts (the foundation of materialized clips, §4).** A location names
  bytes, not an owner: any number of `media_timeline` rows — of any number of objects (a source and the clips over it) —
  may name one location, because a location is content-addressed and names the same bytes. **A location's bytes are
  deleted exactly when no row names it.** The reference count is a query over the rows (`timeline.namedElsewhere`: the
  rows of another object naming a durable `(durable_provider, key)` or a `local_path`), never a counter table, so a count
  cannot drift from the rows; migration `0003_media_timeline_locations.sql` indexes both so the query is an index
  lookup. `timeline.removeObject(objectId)`/`deleteBytes` keep a location another object's rows still name: deleting a
  clip never deletes its source's bytes, deleting a source a clip still names keeps them (its rows go; the bytes are
  deleted when the last naming object is removed), and only a delete that fails keeps rows for a retry, as before.
  `object.pack` re-keys **every** row that names a packed segment's old location with the same sha256 — not only the
  source's — to the chunk in the same transaction, so a clip follows its source into the chunk and the per-segment
  location is then freed only once nothing names it; a row naming the old location with a different sha256 (which should
  not happen) is left alone and keeps the location named. `object.cmaf` deletes an older cut's locations under the same
  rule. No schema besides the two indexes; additive, an older release never reads it.
- **F3.c, shipped: the timeline queued by itself, signed playlists, the MP4 fallback.** A recording's finalize queues
  `object.cmaf` for its object once it is ready (`server/objects/timeline-queue.js`; `dedupeActive` and the idempotency
  key `object.cmaf:<id>`, so a second finalize joins the same job; a queue error is logged, never fails the finalize),
  and `GET …/download?format=json` queues it lazily for a media object without a timeline (a VOD older than F3.1):
  `hls_url` appears once the job ran. Nothing is queued with `MEDIA_HLS_ENABLED` off, for a non-media object or once
  the source timeline exists. For a private or sandbox object `hls_url` is a **playlist token**: its own MAC purpose
  (`hls`), valid for `MEDIA_HLS_PLAYLIST_TTL_S` (6 h by default, 60 s to 12 h) so a viewer plays a long VOD on one page
  load, carried onto every playlist and segment URI, and accepted only by the HLS routes (never by `GET /o/:id` or any
  other route); the HLS routes still accept the object's download signature, so earlier URLs keep working. A public
  object's `hls_url` stays unsigned. The v1 VOD and clip shapes carry the same field (`GET /api/v1/:app/vods/:id` and
  `/clips/:id`, their lists, creates and updates through `vodPublic`/`clipPublic`), from the shared discovery
  (`server/objects/hls.js`; the same presence and access rules as `…/download?format=json`), so an app renders a player
  from the record it already has: a VOD with a timeline, a materialized clip with one, or a virtual clip playing its
  source's window; one without gets `object.cmaf` queued and the field appears once it ran. `GET …/download?format=mp4`
  answers the object's `remux` variant (`object.remux`,
  `-movflags +faststart` for an MP4 source; the container stays the source's) as a signed URL, or queues the remux
  (`dedupeActive`) and answers `202 { job_id }` while it is missing.
- **F3.5, shipped: virtual clips over the timeline (§4).**
- **F3.6, shipped (behind `MEDIA_HLS_ENABLED` + `MEDIA_MATERIALIZED_CLIPS`, off by default): materialized clips over
  the source's bytes (§4, docs/materialized-clips.md).** A clip whose source has a timeline gets its own persisted
  `media_timeline` rows: the interior segments are the source's rows (same location, packed chunk range and sha256,
  renumbered and relative to the clip), only the two window edges are re-encoded (H.264/AAC fMP4) with their own init
  rows (`init-head.mp4`/`init-tail.mp4`, negative seq), and the playlist switches init with `#EXT-X-DISCONTINUITY` +
  `#EXT-X-MAP`. The rows are inserted in one transaction that locks the named source rows `FOR SHARE` and aborts with a
  retryable JobError when one is gone or any location column moved (a pack), so a racing source delete either waits and
  keeps the bytes or aborts the insert; the clip's projection keeps `virtual: true` and gains `materialized: true`, so
  readiness, `playableSql` and the verify job treat it as a virtual clip; deleting the clip removes its rows and edge
  bytes while every location the source still names stays; sprites decode each edge with its own init; a source without
  a timeline (or the flag off) keeps the full re-encode, and `…/download?format=mp4` answers the playlist for a
  timeline-only clip until `object.remux` gains a timeline input branch.
- **F3.1 sprites, shipped: a sprite sheet from the timeline.** `object.sprite` (with `MEDIA_HLS_ENABLED`) cuts its
  frames from the object's `media_timeline` rows instead of seeking the source: each sample time picks the row covering
  it (`timeline.segmentAt`) and one frame is decoded from that row's bytes — this node's segment file, or a packed row's
  byte range in its chunk, with the init segment prepended — checked against the row's sha256. A packed long VOD is
  never decoded end to end. The layout (`sprite: { count, interval_seconds, columns, rows, tile_width, tile_height }`)
  and metadata are the seek path's, so the player contract is unchanged. A source without a timeline, or with
  `MEDIA_HLS_ENABLED` off, keeps the one-fast-seek-per-frame path; captions stay with AI's `media.analyze`.
  **Still open in F3:** the growing live/DVR playlist written as OpenRe segments (F3.2), write-behind durability for
  live segments and its upload-lag metric, captions on the timeline, and Live's player moving to HLS. Segment-bucket
  demand (F2.4) now records reads per timeline segment; deciding placement per segment stays F5's. Renditions are F4.

## 4. Clips reuse the source

- **Virtual clip** (default): `{source, start, end}` → a clipped manifest over the source's segments. No bytes copied.
- **F3.5, shipped.** `POST /api/v1/:app/clips` over a VOD whose object has a source timeline (with `MEDIA_HLS_ENABLED`)
  makes a **virtual** clip: no ffmpeg, ready at once (**201**, `clip.ready` as before), the row `status='ready'`,
  `file_path` NULL, `storage_provider='timeline'` (the marker; no schema change), its object ready with no location
  and its `clip_of` edge carrying the window (`start_time`/`end_time`, seconds; the end clamped to the timeline's).
  `timeline.clipRows(rows, startMs, endMs)` writes it: the media segments intersecting the window plus the init
  segment, `seq` renumbered 1..n, times clipped to the window; `key`/`local_path`/`durable_provider`/`packed_object_id`/
  `byte_*` and the name stay the source's, so a segment serves from the source's bytes or a slice of its packed chunk.
  A segment straddling an edge is served whole (the clip's edges are the source's segment boundaries). The clip's
  `/o/<clip>/master.m3u8`, `source/index.m3u8` and `source/<name>` go through `hlsObject()` with the **clip's** own
  visibility and signature (a playlist token over the clip's id, purpose `hls`, or its download signature); the
  segment route resolves a name on the clip's own timeline, else only among `clipRows` of its source: **a clip's token
  reaches the segments inside its window and nothing else** (the rest of the source is a 404, the source's routes
  refuse it, a source token is never needed and opens nothing of the clip, `GET /o/:id` refuses it). A clip with a
  timeline of its own uses it. A virtual clip's source must be the same tenant's ready object; a deleted source stops
  it. `…/download?format=json` names its `hls_url` and never queues `object.cmaf` for it; `/c/:id` (public, the owner,
  or a `getc` URL from `GET /clips/:id/signed-url`) answers a virtual clip with a 302 to its master playlist (signed
  with the clip's playlist token when closed), a browser navigation too (no watch page for it yet); the clip answers
  (`GET /api/v1/:app/clips/:id` and the list/create/update shapes) carry its `hls_url` (the clip's own token when
  closed), and `playback_url` is unchanged. Its object's metadata carries `virtual: true`: readiness counts it
  `bytes_verified`/`playable` without a location of its own, and the verify job skips it. **Materialized** = a clip
  that asked for it (`materialize: true` on `POST /clips` or `POST /clips/:id/recut`), or whose source has no timeline:
  with `MEDIA_HLS_ENABLED` + `MEDIA_MATERIALIZED_CLIPS` on and a source timeline it gets its own persisted rows over
  the source's segments — only the edges re-encoded (F3.6, docs/materialized-clips.md) — and otherwise it is
  `clip.cut`'s full re-encode into the clip's own file. A virtual clip keeps playing while it is materialized and
  stays virtual if the cut fails; a clip with a file is never turned virtual (its recut stays a cut). The retry sweeper
  recovers a failed, file-less clip the way a recut does: virtual when its source now has a timeline. Holds still inherit
  through `clip_of`.
- **Materialized clip, shipped (F3.6; docs/materialized-clips.md)** (shared externally, downloaded, edited, popular):
  middle GOPs are **referenced**, not copied (the clip's own persisted rows point at the source's locations, packed
  chunk ranges included); only the two boundary segments are re-encoded for frame-accurate cuts. Segments and chunks
  are content-addressed (sha256), so the reference count of a location is just the rows that name it (F3.4, shipped:
  `timeline.namedElsewhere`, no counter table; migration 0003 indexes it) and deleting a VOD that a clip still
  references keeps the referenced chunks — they go when the last naming object is removed, and holds still freeze
  everything. The clip's rows are inserted in one transaction that locks the named source rows `FOR SHARE` and aborts
  when one is gone or any location column moved (a pack), so a concurrent delete cannot drop bytes the new clip names.
  The path is behind `MEDIA_MATERIALIZED_CLIPS` (off by default); a download still answers the playlist until
  `object.remux` gains a timeline input branch.

## 5. Derivatives are cost-managed computed caches

Canonical source media is durable. Renditions, codecs (AV1/HEVC), storyboards and sprites, waveforms, image sizes and
formats (AVIF/WebP), preview clips and AI thumbnails are `rebuildable = true`:

- generated **on demand** (the first request enqueues the job and is served from the source meanwhile) or **ahead of
  demand** when the class predicts it (a live stream with a big audience gets 480p/720p while live; a trending VOD gets
  its ladder prewarmed);
- **kept only while cheaper than regenerating**: keep if `storage_cost(horizon) + delivery_cost < p(regenerate) ×
  regeneration_cost`, else drop and rebuild on the next request;
- **codec economics:** for a viral VOD, an AV1 rendition is produced when the egress/CDN bytes it saves exceed its encode
  cost; for a cold VOD, never;
- compute is placed by the Compute fabric (cheapest available CPU/GPU, `openvibe-sdk/placement`).
- **F4 slice 1, shipped: an on-demand rendition.** When a client asks a ready media object's master playlist or its
  JSON download and a ladder rung is missing, `rendition.create` (heavy) is queued lazily — one job per object and
  rendition, an idempotency key answering a later request with the same job. This slice ships one extra rung, `720p`
  (H.264/AAC, libx264), transcoded from the source (or its timeline) with the source timeline's segment boundaries
  forced as keyframes so a switch lands on one; a source already 720p or smaller is skipped, and a source with no video
  stream is refused. The rows are published exactly as the source cut's (content-addressed placement, the placement
  router's durable provider, one transaction, then the previous cut's unnamed bytes deleted; object.pack is queued for
  the rendition) and the source object is untouched. Behind `MEDIA_RENDITIONS`, which also needs `MEDIA_HLS_ENABLED`:
  off by default, no new rendition is cut or queued (one already produced keeps serving). The master playlist lists a
  rendition only once its rows exist, and the variant plays at `/o/:id/<rendition>/index.m3u8`. Keep-vs-regenerate
  economics, AV1 and compute placement stay open.

## 6. Placement: one engine, every class, down to the segment bucket

- **Hotness is per object × region × segment bucket** (5-minute buckets for video: beginnings are hotter than middles).
  A two-hour VOD can have its first 10 minutes on R2 + CDN + edge, minutes 10–40 on R2, the rest only on B2, and
  promote minute 60 when viewers start landing there. The reads record both axes (F2.4, below): the object total the
  tiering sweep's eligibility reads, and each timeline segment's own count; the per-segment placement decision
  itself stays open.
- **Decision rule:** value-per-dollar greedy under per-class budgets (the knapsack is near-optimal when costs are
  monotone): expected requests and bytes saved × latency value, against storage + requests + retrieval + minimum
  residency, with hysteresis (promote above P, demote below D < P), minimum residency, and rate limits on moves.
- **Intents** set class defaults: `video` (segments, seek-sensitive), `image` (tiny, cache hard), `download`
  (throughput + cost, mirrors, resume), `game-asset` (small hot assets global; large packs mirrored), `attachment`,
  `backup` (archive fabric only).
- **Every move is two-phase:** verify the new copy (size + sha256), commit the location in one transaction, then
  delete old bytes after commit, with a retrying cleanup job and an alert after three failures. The row never points
  at bytes that do not exist. The sweep retries a failed move after 6 h and logs every failure as a `failed` row in
  `media_object_tier_decisions`; the job `storage.move.cleanup` (`server/jobs/move-cleanup.js`, light lane, system app
  only, report only) reads those rows every `MEDIA_MOVE_CLEANUP_MINUTES` (60; `0` = never; not in a restore drill): an
  object whose move failed three times in the last 7 days (a later `done` of that move resets the count) raises one
  `storage.alert` of kind `move_cleanup_failed`, listing the objects (`media_storage_alerts_total{kind}`, the Events
  outbox and the per-app webhook, once per 6 h cooldown like every storage alert).
- **Dry-run and simulator:** every policy can run in dry-run mode (logs what it would do and what it would cost), and a
  simulator replays recorded telemetry against a candidate policy before it is enabled.
- **Demand rollups (F2.4, shipped):** every served viewer read (`router.route()` for playback or download, not a derive
  job) adds one best-effort hit in Valkey (`server/placement/demand.js`): a counter `demand:<region>:<bucket>:<object_id>`
  and the region's hot sorted set `hot:<region>:<bucket>` (object id → reads), both under `VALKEY_PREFIX` with a 2 h TTL;
  `<bucket>` is the 5-minute bucket number (`floor(epoch_ms / 300000)`). A read of a timeline segment (`GET
  /o/:id/source/:name`) carries the segment name, moving that segment's member in the per-object segment set
  `hot:<region>:<bucket>:<object_id>` (segment → reads; capped at `TOP_N` members, 2 h TTL), so a hot beginning reads
  apart from a cold middle without a key per segment; the object counter moves on every read either
  way, so the object is the sum over its segments (plus whole-object reads) and `hotness()` — the sweep's eligibility —
  is unchanged. `hotness({ segment })` reads one segment (per object, or across the region's hottest `TOP_N` objects).
  The region is one per deployment (`MEDIA_DEMAND_REGION`, default `local`); per-viewer regions wait for an
  edge-provided header.
  `hotness()` sums the last 12 buckets (one hour). The writes are fire-and-forget: a slow, failing or absent Valkey never
  delays or fails a read (without Valkey the counts stay in-process, both axes). The per-segment placement decision
  (which minutes of a VOD sit on R2/edge) stays open; F2 records the demand it will read.
- **The sweep reads demand (F2.5, shipped):** the object tiering sweep's promote/demote eligibility is `hotness()` for the
  deployment's region, against each class's hysteresis band in `media.storage_policy` (`promoteReadsPerHour` /
  `demoteReadsPerHour`, demote < promote, validated per revision): video 60 / 6, image 300 / 30, download 30 / 3, the
  other classes 60 / 6. At or above P an object may promote, below D its R2 copy may go (still in R2 at least
  `demoteIdleDays`), in between nothing moves. Size bounds, per-class budgets, minimum residency, holds and back-off are
  unchanged; value per dollar ranks at the hour's rate (reads × 24 × 30 a month). The reads are batched: one `MGET` per
  page of 500 objects (the promotion scan pages by id; the R2 copies are read in pages of 500), never a round trip per
  object. Valkey absent, erroring or timing out (2 s) anywhere in the scan sends the **whole** sweep back to the daily
  PostgreSQL view counts (`media.object_tier` thresholds, today's rules), with one warning per sweep and
  `media_sweep_demand_source_total{source="valkey"|"pg"}`; both candidate lists are read before anything moves. Every
  decision's `inputs.demand` (`{ source, metric, value, threshold[, region, window_s] }`) and its reason say which source
  and value drove it, dry runs included; a sweep's `media.replica.requested` and `media.replica.draining` carry the same
  `demand`, and the sweep result carries `demand_source` (and `demand_fallback`).
- **Constraints (F2.6, shipped):** a sweep move needs the provider class it relies on: a promotion needs R2 eligible
  for `online-hot`, the demotion of a ready object needs its canonical copy's provider eligible for its class
  (`online-canonical`; the Media host's disk is always the `regional-cache`). Eligible means the circuit breaker is
  not open and no completed capability probe found a capability the class needs missing
  (`providers.placementGate()`, whatever `MEDIA_CAPABILITY_GATE` says; a probe not run or not completed decides
  nothing). Otherwise the move is refused and every copy stays; a promotion's refusal spends the class's slot (every
  promotion relies on R2, so a failing R2 logs at most a class budget of refusals per sweep), a demotion's does not
  (its gate is that object's own canonical provider). Each class may carry a monthly ceiling on its R2
  storage, `maxHotUsdPerMonth` in `media.storage_policy` (absent = none; `0` = the class never promotes, whatever
  R2's configured price), priced at R2 Standard's list price in
  `media.cost_tiers` over every present R2 copy of the class, gross of R2's free tier (`freeGb` is account-wide, not
  per class, so the ceiling binds up to its value early), and kept current as the sweep moves: the first
  promotion that would pass it is refused and closes the class's promotions for that sweep (a cheaper, lower-ranked
  object never jumps the value-per-dollar queue). Every decision records `inputs.provider_gate` (`{ provider, class,
  eligible, breaker, probe[, missing, reason] }`) and a sweep promotion `inputs.budget` (`{ class, usd_per_month,
  copy_usd_per_month, ceiling }`); the sweep result carries `constraints` (`promote_gate`, `refused.{provider,budget}`,
  `hot_usd_per_month.<class>.{spend,projected,ceiling}` for every class, `ceiling` null when unset). `spend` follows
  only the moves made; `projected` also counts the dry runs, and the ceiling (and `inputs.budget.usd_per_month`) is held
  against it, so dry runs (gate off) are refused as a live sweep would be, without changing `spend` (a dry run
  repeated the same day is logged once but still counts, and a dry-run demotion checks its canonical copy like a live
  one before it frees any projected cost). Every native object classifies into one of the six classes, so a budget,
  hysteresis band or ceiling set on any of them acts on that class's objects: `kind` and `mime_type` decide `video`
  and `image` (everything else is `download`), and an app may declare **`game-asset`, `attachment` or `backup`** for
  one of its objects in the object's metadata — `metadata.class`, or the explicit `media_class` / `placement_class`.
  A declaration is honoured only when kind and mime type would otherwise say `download`, so content alone decides
  `video` and `image`: a name outside those three (a `video` or `image` declaration included, or one on a video or
  image object) is ignored and kind and mime type decide. The declaration is limited this way because budgets,
  hysteresis bands and R2 ceilings are global per class — without the limit any app could declare a class on a large
  video and spend another class's budget, starving or filling it, and be billed for it in the sweep's spend
  (`hotSpend()`). An `attachment` or `backup` object therefore promotes and demotes under its own budget, and a
  `game-asset` ceiling refuses that class alone.

## 7. Delivery: sticky, measured, canaried

- **Route epochs:** a playback session gets a route (primary + fallbacks, TTL ~30 s) and keeps it until a health
  failure, a significant latency change, a capacity or cost guard, or TTL; changes happen at segment boundaries.
- **Canary shifts:** moving traffic between routes goes 1 % → 5 % → 25 % → 50 % → 100 %, watching errors, TTFB,
  throughput, seek failures, player stalls and cost, and reverts automatically.
- **Origin protection:** the OpenVibe edge collapses concurrent misses (nginx `proxy_cache_lock` + `slice` = one upstream
  fetch per object+range per shield); Bunny's origin shield and request coalescing in front of B2; presigned-URL LRU in
  Media for provider request costs.
- **Access control never leaks to caches:** private and unlisted media use tokenized URLs (Bunny token auth, signed R2
  URLs); the cache key excludes the token; private bytes are never pushed to a public cache.
- **Deletion reaches everything:** a delete, DMCA takedown or account erasure (ADR-033) removes every replica and
  derivative and purges every CDN path, and is verified.

## 8. The closed loop

```
request/playback → telemetry → Events → {Hotness, Health, Cost} engines → Placement engine → route/replica change → Delivery
```

- **One telemetry sample schema** (`openvibe.telemetry.sample@1`: service, project, resource, provider, node, region,
  operation, bytes, duration, ttfb, throughput, status, cache status, cost estimate, route epoch, trace id), shared by
  Media, OpenRe, Host, AI, Events and Compute.
- **Aggregation, not rows per request:** nginx JSON access logs and player beacons are folded into rolling Valkey
  counters (EWMA + p50/p95/p99 over 10 s, 1 min, 5 min, 1 h, 24 h), HyperLogLog for unique viewers, sorted sets for the
  top-N hot objects and buckets; PostgreSQL gets 5-minute rollups per object × region × bucket; raw samples go to
  object storage in batches.
- **Player QoE counts, not only HTTP:** startup time, rebuffers, fatal errors, seek latency, quality switches, bitrate,
  live-edge delay (privacy-bounded, a random session id, no user id). **SLOs:** cold seek p95 < 500 ms to the first
  playable segment, hot seek < 200 ms, live rewind < 150 ms, startup p95 < 1.5 s.
- **Loops cooperate by time constant and precedence:** player ABR (seconds) ⊂ delivery routing (30 s–5 min) ⊂ placement
  (minutes–hours) ⊂ cost (hours–days). Each outer loop only constrains the inner (budgets bound placement; placement
  bounds routes); every loop uses hysteresis and rate limits.
- **Shipped (F2.4):** the Valkey counters and per-region hot sorted sets of §6. Each tiering sweep calls
  `demand.rollup()`, which stages `media.object.hot` (`{ object_id, app_id, region, reads, window_s, threshold, bucket,
  since }`) through the placement outbox for objects with at least 100 reads in the last hour, at most once per object per
  hour (`hot-announced:<region>:<object_id>`, `SET NX EX 3600`). Not yet: nginx logs, player beacons, EWMA/percentiles,
  HyperLogLog, the PostgreSQL 5-minute rollup and `media.region.hot`.
- **Shipped (F2.5):** the placement loop reads those counters: the tiering sweep promotes and demotes on the hour's reads
  per object with per-class hysteresis (§6), and falls back to the daily PostgreSQL counts for a whole sweep when Valkey
  does not answer.
- **Events emitted:** `media.object.hot`, `media.replica.requested|ready|draining|evicted`, `media.variant.requested|ready`,
  `media.region.hot`, `media.delivery.surge|degraded`, `media.provider.health_degraded`, `media.provider.capacity_warning`,
  `media.provider.cost_threshold`.

## 9. Cost truth

`media.cost_tiers` holds list prices; estimates drive decisions; **provider bills calibrate them**: R2 analytics
(GraphQL), B2 usage reports, Bunny statistics API are imported daily, compared with the estimate, and the gap is a
metric. Budgets per class and provider with a forecast; `media.provider.cost_threshold` at 90 % shifts non-critical traffic.

## 10. Build order

- **F1 foundation (shipped):** provider registry + capability probes; `media.cost_tiers` + per-class budgets in a revisioned
  `media.storage_policy` (retiring `media.storage_tier`/`media.object_tier`); the read router (EWMA latency, error
  circuit breaker, continuous health probe, fastest healthy copy) in `server/placement/`; presigned-URL LRU; two-phase
  moves with a cleanup job; per-class hysteresis bands; `media_storage_alerts_total`, provider latency histograms; the
  corrected price table; the nginx shield (slice + cache lock) on the Media host.
- **F2 one placement engine (shipped; close-out: Media PR #24):** every class through one sweep, value-per-dollar under budgets, dry-run + simulator,
  decision log with class and reason, the events above, Valkey rollups of demand (F2.4, shipped) and the sweep's
  eligibility on them with per-class hysteresis and a PostgreSQL fallback (F2.5, shipped), the provider-class gate
  and per-class monthly R2 storage ceilings on its moves (F2.6, shipped), the move cleanup job and its alert after
  three failures (§6, shipped). Every storage class (all six) now acts in the one sweep: native objects classify by
  kind and mime type, or by a class the app declares in the object's metadata (§6, shipped). Still open in F2: the
  projected objects (VODs and clips) keep their own tiering path (`media_tier_decisions`) instead of the sweep.
- **F3 segment-native video:** the timeline index and the CMAF/HLS source representation of finished video (F3.1,
  shipped; §3), packing into ~60 s chunks (F3.3, shipped; §3), the timeline queued at finalize (and lazily on
  download), signed playlists outliving a download URL and the faststart MP4 fallback (F3.c, shipped; §3), virtual and
  materialized clips (F3.5/F3.6, shipped; §4) and sprite sheets cut from the timeline's rows (F3.1, shipped; §3); still
  open: live DVR from OpenRe (CMAF/HLS recording with the growing
  playlist), captions on the timeline (the demand rollups already record reads per timeline segment, F2.4); Live's
  player moves to HLS.
- **F4 reactive derivatives:** on-demand renditions and image variants, keep-vs-regenerate economics, AV1 for viral
  VODs, compute placement. (Slice 1 shipped: one on-demand 720p rung, queued by the master playlist / JSON download
  and cut into the timeline; the economics, AV1 and compute placement are still open.)
- **F5 multi-CDN delivery:** Bunny path (B2 origin), R2 custom-domain path, OpenVibe edge first up to capacity, route
  epochs, canary shifts with auto-revert, player QoE beacons, seek SLOs.
- **F6 cost truth:** bill imports, forecasts, budget guards, the owner dashboard.
- **Archive fabric:** backups and snapshots to B2; optional deep archive with restore drills; never online.

## F1b decisions (2026-09-29)

**On in production since 2026-09-29 11:5x UTC:** `edge.openvibe.media` (DNS-only A record, Let's Encrypt via DNS-01), the
shield config in nginx, `MEDIA_SHIELD=b2` and `MEDIA_SHIELD_HOST=edge.openvibe.media` in `media.env`. Probe: a public B2 VOD on
openvibe.media answers 302 → the edge answers 206 with the exact range, MISS then HIT, one Content-Type, Node's
Cache-Control, nosniff and noindex, and no B2 header. VOD bytes carry no CORS header, as when Node serves them itself.

- **Shield B2 only.** B2 is the canonical copy whose ~500 req/s ceiling is worth shielding; R2 reads keep their 302
  until F2's engine can enforce the 70 %-of-port rule (an R2 read through the shield spends the same host bandwidth).
- **A DNS-only edge host.** openvibe.media is behind Cloudflare's proxy and its terms for video are not verified, so
  the shield answers only on `edge.openvibe.media` (grey cloud; `MEDIA_SHIELD_HOST`). Bytes that went viewer → B2 never
  start flowing through Cloudflare. Node knows the edge from `X-Media-Shield-Host`, which only the edge server block sets
  (from its own server name) and `openvibe.media` clears; never from Host or `X-Forwarded-Host`, which a client chooses.
- **One B2 host.** nginx proxies to one B2 endpoint and SigV4 signs the Host, so a URL signed for any other host (a
  changed `MEDIA_B2_ENDPOINT`) is never shielded and keeps its 302 (`shield.js` `B2_UPSTREAM_HOST` = the nginx snippet;
  a test pins both).
- **Cache key:** `b2|<bucket>/<key>|<slice range>`: the object path and the 10 MB slice, never the signature. The
  shield's presign lives six hours (it stays inside nginx and a long response fetches later slices with it; a single
  response longer than that gets an uncached 403 on its next slice); the viewer-facing 302 keeps its short TTL.
- **Headers:** Node's answer owns Content-Type, Content-Disposition and Cache-Control (they survive the X-Accel
  redirect; B2's copies are hidden); the shield location adds `nosniff` and `noindex` itself. Unlisted objects are served
  through the shared cache (anyone with the link may read them; `/o` answers `public, max-age=3600` for them), unlisted
  VODs answer `private, max-age=0`.
- **Private and sandbox bytes never enter the shield.**
- **Sizing:** one disk with recordings: `max_size=5g`, `min_free=20g` (the recording guardian warns at 15 GB), `inactive=24h`.
- **Purge:** deleting a shielded object refreshes each of its slices (four at a time) through a loopback-only listener
  (`127.0.0.1:8479`, `allow 127.0.0.1; deny all`, `proxy_cache_bypass`), so the provider's 404 replaces the cached bytes
  at once. Overwriting a shielded key (a repair re-upload, or a re-upload within ten minutes of a delete) refreshes it
  after the upload, so the shield never serves the old bytes.
- **Logs:** shield logs carry the path only: the signed query is a bearer token.
- Config: `deploy/nginx/media-shield.http.conf` (conf.d), `media-shield-b2-upstream.conf` (snippets),
  `edge.openvibe.media.conf` (sites-enabled), and `openvibe.media.conf` clearing `X-Media-Shield-Host`. Switch on with
  `MEDIA_SHIELD=b2` and `MEDIA_SHIELD_HOST` after nginx has them, and check a real slice with `curl -I` on the edge
  (one Content-Type, Node's Content-Disposition, `X-Cache-Status`, no `x-amz-*`).
