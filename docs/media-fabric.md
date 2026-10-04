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
  `durable_provider`, `packed_object_id` + `byte_offset`/`byte_length` (packing is F3.3; NULL until then),
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
  **Still open in F3:** the growing live/DVR playlist written as OpenRe segments (F3.2), write-behind durability for
  live segments and its upload-lag metric, packing into ~60 s chunks (F3.3), virtual and materialized clips over the
  timeline, sprites and captions on it, the faststart MP4 fallback as a derivative, segment-bucket demand, a finalize
  hook that queues `object.cmaf` by itself, signed playlists that outlive one signed-URL lifetime, and Live's player
  moving to HLS. Renditions are F4.

## 4. Clips reuse the source

- **Virtual clip** (default): `{source, start, end}` → a clipped manifest over the source's segments. No bytes copied.
- **Materialized clip** (shared externally, downloaded, edited, popular): middle GOPs are **referenced**, not copied
  (the new manifest points at the source's packed chunks); only the two boundary segments are re-encoded for
  frame-accurate cuts. Segments and chunks are content-addressed (sha256) with reference counts, so deleting a VOD
  that a clip still references keeps the referenced chunks (and holds still freeze everything).

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

## 6. Placement: one engine, every class, down to the segment bucket

- **Hotness is per object × region × segment bucket** (5-minute buckets for video: beginnings are hotter than middles).
  A two-hour VOD can have its first 10 minutes on R2 + CDN + edge, minutes 10–40 on R2, the rest only on B2, and
  promote minute 60 when viewers start landing there.
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
  `<bucket>` is the 5-minute bucket number (`floor(epoch_ms / 300000)`). The region is one per deployment
  (`MEDIA_DEMAND_REGION`, default `local`); per-viewer regions wait for an edge-provided header. `hotness()` sums the last
  12 buckets (one hour) per object. The writes are fire-and-forget: a slow, failing or absent Valkey never delays or fails
  a read (without Valkey the counts stay in-process). Object × region only for now; the segment bucket comes later in F3 (F3.1 shipped the timeline it will bucket).
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
  one before it frees any projected cost). Native objects classify only as `video`, `image` or `download` today, so a ceiling (or budget)
  set on `game-asset`, `attachment` or `backup` decides nothing yet.

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

- **F1 foundation (now):** provider registry + capability probes; `media.cost_tiers` + per-class budgets in a revisioned
  `media.storage_policy` (retiring `media.storage_tier`/`media.object_tier`); the read router (EWMA latency, error
  circuit breaker, continuous health probe, fastest healthy copy) in `server/placement/`; presigned-URL LRU; two-phase
  moves with a cleanup job; per-class hysteresis bands; `media_storage_alerts_total`, provider latency histograms; the
  corrected price table; the nginx shield (slice + cache lock) on the Media host.
- **F2 one placement engine:** every class through one sweep, value-per-dollar under budgets, dry-run + simulator,
  decision log with class and reason, the events above, Valkey rollups of demand (F2.4, shipped) and the sweep's
  eligibility on them with per-class hysteresis and a PostgreSQL fallback (F2.5, shipped), the provider-class gate
  and per-class monthly R2 storage ceilings on its moves (F2.6, shipped), the move cleanup job and its alert after
  three failures (§6, shipped). Still open in F2: every class (not only native objects ↔ R2) through the one sweep.
- **F3 segment-native video:** the timeline index and the CMAF/HLS source representation of finished video (F3.1,
  shipped; §3); still open: CMAF/HLS recording with the growing DVR playlist from OpenRe, packing after finalize,
  virtual clips, sprites and captions on the timeline, MP4 fallback; Live's player moves to HLS.
- **F4 reactive derivatives:** on-demand renditions and image variants, keep-vs-regenerate economics, AV1 for viral
  VODs, compute placement.
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
