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
viewer → media.openvibe.network → delivery router
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
  at bytes that do not exist.
- **Dry-run and simulator:** every policy can run in dry-run mode (logs what it would do and what it would cost), and a
  simulator replays recorded telemetry against a candidate policy before it is enabled.

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
- **Events emitted:** `media.object.hot`, `media.replica.requested|ready|draining|evicted`, `media.variant.requested|ready`,
  `media.region.hot`, `media.delivery.surge|degraded`, `provider.health.degraded`, `provider.capacity.warning`,
  `provider.cost.threshold`.

## 9. Cost truth

`media.cost_tiers` holds list prices; estimates drive decisions; **provider bills calibrate them**: R2 analytics
(GraphQL), B2 usage reports, Bunny statistics API are imported daily, compared with the estimate, and the gap is a
metric. Budgets per class and provider with a forecast; `provider.cost.threshold` at 90 % shifts non-critical traffic.

## 10. Build order

- **F1 foundation (now):** provider registry + capability probes; `media.cost_tiers` + per-class budgets in a revisioned
  `media.storage_policy` (retiring `media.storage_tier`/`media.object_tier`); the read router (EWMA latency, error
  circuit breaker, continuous health probe, fastest healthy copy) in `server/placement/`; presigned-URL LRU; two-phase
  moves with a cleanup job; per-class hysteresis bands; `media_storage_alerts_total`, provider latency histograms; the
  corrected price table; the nginx shield (slice + cache lock) on the Media host.
- **F2 one placement engine:** every class through one sweep, value-per-dollar under budgets, dry-run + simulator,
  decision log with class and reason, the events above, Valkey rollups of demand.
- **F3 segment-native video:** CMAF/HLS recording with the growing DVR playlist, the timeline index, packing after
  finalize, virtual clips, sprites and captions on the timeline, MP4 fallback; Live's player moves to HLS.
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
