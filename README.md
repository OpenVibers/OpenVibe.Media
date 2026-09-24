# OpenVibe.Media

Standalone multi-tenant media service (port **4100**) extracted from the
OpenVibe.Live predecessor. Owns VOD ingest/recording, storage tiering
(local → Backblaze B2 → Cloudflare R2), clips, pastes, generic files, and
thumbnails, for all OpenVibe apps (`live`, `games`, `tools`, `network`).

Implements **Media API v1** from `../CONTRACTS.md`.

```
npm install
cp .env.example .env     # set MEDIA_APPS_SEED at minimum
npm start                # node server/index.js
```

Requires Node ≥ 20, `ffmpeg`/`ffprobe` on PATH. SQLite (better-sqlite3, WAL).

## Layout

```
server/
  index.js               boot, route mounts, background jobs, graceful shutdown
  config.js              env config (PORT, DB_PATH, *_PATH, MEDIA_B2_*/R2_*, RTP pool, OV_NETWORK_URL)
  auth.js                tenancy + auth middleware, JWKS fetch, app seeding
  webhooks.js            HMAC-signed outbound webhooks
  drill.js               MEDIA_DRILL: restore-drill mode (reads only, no bytes, no jobs, nothing leaves)
  db/schema.sql          apps, vods, clips, pastes(+likes/comments), files, content_views, media_settings,
                         media_objects/locations/relationships/variants/jobs/holds/invariant_violations
  db/database.js         better-sqlite3 helpers, all app_id-scoped; legacy row importer
  vod/recorder.js        ffmpeg recording: RTMP pull + RTP (SDP) ingest, codec passthrough
  vod/media-tools.js     probes, seekable remux, DVR sidecar, chunk-segment concat
  vod/finalize.js        finalize pipeline (remux → probe → master recovery → thumbnail → webhook)
  vod/routes.js          /api/v1/:app/vods (+ ingest + chunks)
  vod/clip-cutter.js     re-encoding clip cutter (local file or presigned URL source)
  vod/clips-routes.js    /api/v1/:app/clips
  vod/vod-storage.js     local/B2/R2 tiering, presigned playback, sweep, CLI
  vod/health-scanner.js  probe/decode/master-recovery primitives
  vod/health-job.js      background health scan + quarantine cleanup + master sweep
  pastes/routes.js       /api/v1/:app/pastes (+ admin: stats/forks/bulk/censor)
  files/routes.js        /api/v1/:app/files
  admin/routes.js        /api/v1/:app/admin/storage (disk, tiers, buckets, bulk ops)
  thumbnails/            thumbnail service + /api/v1/:app/thumbnails
  public/routes.js       public /v /c /p /t /f
  objects/               canonical object model: model (projections, holds), routes (/api/v2 + /o),
                         backfill, reconcile, invariant, signing (presigned URLs), multipart,
                         content-type, verify-job (scheduled copy verification), copy-report —
                         see docs/object-model.md
  jobs/                  media_jobs: queue (states, idempotency, media.job.* events in the state
                         change's transaction; payload queue.jobEvent: ids, state, ISO times,
                         has_result, never params/result/error text/creator), worker (light/heavy lanes, leases, retries,
                         cancellation), routes (/api/v2/:app/jobs), types: thumbnail.regenerate,
                         invariant.scan (proposes split/remux), object.split, object.remux
(openvibe-shared v1.5.1, openvibe-contracts v0.33.0, openvibe-sdk v0.5.0: pinned release tarballs, installed by npm)
scripts/smoke-test.sh    end-to-end smoke test (boots a temp instance)
scripts/backfill-objects.js / reconcile-objects.js / object-invariant.js / no-good-copy-report.js   object-model operator tools
scripts/media-jobs.js     list jobs, run the size-invariant scan (dry run by default), approve/cancel proposals
scripts/r2-eviction-drill.js   evict one VOD's R2 copy, prove B2 serves it, re-warm R2; JSON artifact (dry run by default)
```

## Visitor sign-in

The public pages use the shared navbar and footer. Visitors sign in through the Network as OAuth
client `media` (`server/user-auth.js`, routes under `/auth`, host-only cookies); set
`OV_OAUTH_CLIENT_SECRET` in the unit's environment. `/terms`, `/privacy` and `/dmca` come from
`openvibe-shared/legal` (profile `hosting`). This is separate from tenant auth below, which is how
other OpenVibe services call the API.

## Tenancy & auth

Tenant = the `:app` path segment. Rows in the `apps` table define tenants:

| column | meaning |
|---|---|
| `app_id` | tenant id (`live`, `games`, …) |
| `api_key_hash` | sha256 of the app API key (never stored in plaintext) |
| `webhook_url` / `webhook_secret` | outbound event delivery (HMAC) |
| `allowed_origins` | JSON array; guards browser (user-JWT) calls |
| `quota_bytes` | storage quota: v1 files + native v2 objects (0 = unlimited) |
| `project_id` / `env` | set only on developer-project tenants (below) |

Credential types on `/api/v1/:app/...`:

1. **App API key** — `Authorization: Bearer <app_api_key>`. Compared in
   constant time against the app's stored hash. A key is only valid for its
   own `:app` segment; presenting another app's key returns **403**.
2. **Network user JWT** (browser endpoints only — chunks/complete, clips,
   pastes, files, thumbnails) — RS256, verified **offline** against the JWKS
   public key fetched from `OV_NETWORK_URL/api/.well-known/jwks` at boot
   (cached, refreshed every 6 h). `aud` must include `openvibe.media` when
   present. If the request carries an `Origin` header it must be in the app's
   `allowed_origins` (CORS is reflected for allow-listed origins only).

3. **Network principal token** (`sub svc:…`, `app:…`, `mod:…`; RS256, audience `openvibe.media`) —
   accepted only on routes that name a capability: files upload/delete and every objects v2 write
   (`media.object.upload`), files list/meta and objects v2 reads (`media.object.read`), and only for
   the `:app` namespaces in the token's `ns`.

### Developer-project tenants (ADR-014)

A developer app from OpenVibe.Network (token `sub app:app_<ULID>`, `project_id prj_<ULID>`,
`env sandbox|production`, `ns [project_id]`) holding `media.object.upload` / `media.object.read`
gets a tenant keyed by its project id, **created on first use**. The URL always names the project
(`/api/v1/prj_<ULID>/files`, `/api/v2/prj_<ULID>/objects`, so openvibe-sdk's
`createMediaClient({ app: projectId })` works); the token's `env` picks one of two separate tenants:

| env | tenant (`apps.app_id`) | default quota |
|---|---|---|
| production | `prj_<ULID>` | `MEDIA_APP_TENANT_QUOTA_MB` (1024) |
| sandbox | `prj_<ULID>-sandbox` | `MEDIA_APP_SANDBOX_QUOTA_MB` (100) |

- Both rows carry `project_id` and `env`, and have no API key (`api_key_hash` empty; the seeding
  env refuses `prj_…` ids). Only the project's own app tokens reach them: other projects' tokens,
  first-party service tokens, app keys and user JWTs get 403/404, and the `-sandbox` id cannot be
  named in a URL. Nothing is created unless the token's `project_id` is the path's project and the
  token holds the route's capability.
- App tokens reach only these tenants and only the capability routes (files, objects v2 without
  retention holds). VODs, clips, pastes, thumbnails, assets, stats and admin refuse them.
- **Sandbox tokens** (`env: sandbox`) are accepted on these routes only; everywhere else they get
  `401 token.sandbox_refused`.
- **Sandbox content is never public.** `/f/:key` and `/o/:id` answer 404 for it unless the URL
  carries a valid signature; the Files API returns a signed, short-lived `url` (+ `url_expires_at`,
  `sandbox: true`), objects have `public_url: null` and `/download` always signs, whatever the
  visibility. Sandbox tenants emit no platform events.
- The quota counts v1 files and native v2 objects together (files uploads now use the same count
  as objects for every tenant). v1 file keys in project tenants carry a tenant tag, so two tenants
  never collide on identical uploads. Project tenants' files are not listed in the public gallery.
  Soft-deleted objects keep counting against a project tenant's quota until their bytes are purged.
- `/f/:key` (like `/o/:id`) sends `nosniff` and serves only images (not SVG), video, audio, PDF and
  plain text inline; anything else an uploader labels (HTML, SVG, XML…) is an `attachment`.
- Not yet: reading quotas set in Network (`network.project.read`), and removing a project's
  tenants when the project is archived.

### App seeding

On every boot the service upserts apps from env (keys are hashed):

```bash
MEDIA_APPS_SEED='[{"app_id":"live","name":"OpenVibe.Live","api_key":"…","webhook_url":"http://127.0.0.1:3000/internal/media-webhook","webhook_secret":"…","allowed_origins":["https://openvibe.live"],"quota_bytes":0}]'
# fallback short form (no webhooks/origins):
MEDIA_APP_KEYS="live:key1,games:key2"
```

## API (all under `/api/v1/:app`)

### VODs

| method | path | notes |
|---|---|---|
| POST | `/vods` | `{ title?, stream_id?, stream_key?, managed_stream_id?, user_id?, meta?, visibility?, clips_only? }` → `{ id }` |
| POST | `/vods/:id/ingest/rtmp` | `{ rtmp_url }` → **202**; ffmpeg pulls the URL, lossless stream-copy → fragmented `.mp4` |
| POST | `/vods/:id/ingest/rtp/start` | `{ video: {payloadType, codec, clockRate, ssrc?, parameters?}, audio?: {…} }` → `{ videoPort, audioPort }` from UDP 12000-12199; point PlainRtpTransports at `127.0.0.1` (RTCP = port+1) |
| POST | `/vods/:id/ingest/rtp/stop` | finalizes the recording |
| POST | `/vods/:id/chunks` | multipart `chunk` (+`segmentId`), user JWT ok — browser MediaRecorder append flow |
| POST | `/vods/:id/complete` | finalize chunked upload (user JWT ok) |
| POST | `/vods/:id/finalize` | close recording; remux, probe, thumbnail, webhook |
| GET | `/vods/:id` | `{ id, title, status, duration, playback_url, thumbnail_url, storage_provider, … }` |
| GET | `/vods?limit&offset&user_id&stream_id&managed_stream_id&include_private&order&since` | list; `include_private` app-key only; `order` = newest\|oldest\|views; `since` = created at or after (ISO 8601 or `YYYY-MM-DD HH:MM:SS`, UTC) |
| PUT | `/vods/:id` | `{ title?, description?, visibility? }` |
| DELETE | `/vods/:id` | deletes local + B2 + R2 objects + row |

`status`: `pending → recording → ready | failed` (derived; failures come from
health quarantine: corrupt / zero-byte / missing file).

**Durations are measured, never estimated.** Finalize stores what the file says and
records where it came from in `duration_source`: `probe` (ffprobe's container
duration), `remux` (the last packet time of a stream-copy pass, used when the header
has none or is far longer than the packets) or `unknown` (nothing measurable: the
duration is stored as **0**, `health_status` is `needs_review` with `probe_failed` or
`inflated_duration`, and the VOD is hidden until a later finalize measures it). The
wall clock only bounds a recording the recorder saw start (a value longer than 1.5x
its run + 30 s is refused); an orphan finalized after a restart has no bound and is
never measured as now - created_at. While recording, `duration` is the live elapsed
time; finalize replaces it.

**Recording formats** (inherited codec-passthrough behavior — VODs are *not*
always `.webm`): RTMP and RTP-H.264 record by lossless stream copy into a
fragmented **`.mp4`** (audio → AAC on the RTP path); RTP-VP8/VP9 copies into
**`.webm`** (Opus copied); exotic codecs fall back to a libvpx re-encode with a
lossless `.master.mkv` recovery archive. A `.seekable` sidecar is remuxed every
60 s during recording so `/v/:id` is DVR-seekable while live.

### Clips

| method | path | notes |
|---|---|---|
| POST | `/clips` | `{ vod_id, start_s, end_s, title?, description?, user_id?, visibility?, auto_generated? }` → **202** `{ id, status: 'processing' }`; cut runs in background (from the local file or a presigned B2/R2 URL); duplicate windows are deduplicated; live recordings are clamped to flushed footage. Multipart `video` = direct upload of an already-cut blob → **201** ready |
| GET | `/clips/:id` | status: `processing | ready | failed` |
| GET | `/clips?limit&offset&vod_id&stream_id&user_id&channel_user_id&hide_self&include_private&order&auto_generated&status&since` | list; `channel_user_id` = clipped-channel owner; `include_private` app-key only; `auto_generated=1\|0` = cut by the app's automation (AI auto-clips) or made by a person; `status=ready` = playable clips only; `since` as for VODs |
| PUT | `/clips/:id` | `{ title?, visibility?, auto_generated? }` (`auto_generated` app key only, 403 when acting for a user) |
| DELETE | `/clips/:id` | local + offloaded objects + row |

### Pastes

**Production (since 2026-09-22):** OpenVibe.Community is the paste authority.
With `PASTES_FROZEN_APPS=live`, paste writes for app `live` answer 410, and
`PASTES_MOVED_TO=https://openvibe.community` turns `/p/:slug` and its text
`/raw` into 301s to Community. Screenshot bytes are still served from here, and
new screenshots are uploaded to the token-only `community` tenant. The routes
below stay as the rollback path.

| method | path | notes |
|---|---|---|
| POST | `/pastes` | `{ title?, content?, language?, user_id?, visibility?, burn_after_read?, is_nsfw? }` or multipart with `screenshot` image (EXIF-stripped via sharp) → `{ id, slug, url }` |
| GET | `/pastes?limit&offset&type&search&user_id` | public list |
| GET | `/pastes/config` | paste limits (`maxSizeKb`, `cooldownSeconds`, `maxPerUserPerDay`, `todayCount`, …) |
| GET | `/pastes/:slug` | full paste (private: owner/app only) |
| PUT | `/pastes/:slug` | update (owner/app) |
| DELETE | `/pastes/:slug` | delete + screenshot (local & legacy B2 object) |
| POST | `/pastes/:slug/fork` | fork a text paste |
| POST | `/pastes/:slug/like` | toggle like (needs a user identity) |
| POST | `/pastes/:slug/copy` | track a copy event |
| GET/POST | `/pastes/:slug/comments` | threaded comments (anon supported) |
| DELETE | `/pastes/:slug/comments/:id` | author/paste-owner/app |

**Paste admin** (app-key auth only — the app's server fronts its admins):

| method | path | notes |
|---|---|---|
| GET | `/pastes/admin/stats` | app-scoped `{ total, textPastes, screenshots, forks, totalViews, totalCopies, totalLikes }` |
| GET | `/pastes/admin/forks?limit&offset` | list forked pastes |
| DELETE | `/pastes/admin/forks` | delete ALL forks (screenshots unlinked too) → `{ deleted }` |
| POST | `/pastes/bulk` | `{ slugs: [...], action: delete\|public\|unlisted\|private }` (max 500) → `{ done, skipped }` |
| POST | `/pastes/:slug/censor` | multipart `screenshot` (PNG/JPEG/WebP ≤ 16 MB) replaces a screenshot paste's image (old file deleted); `:slug` also accepts a numeric paste id |

Cooldowns and daily limits (`media_settings`: `paste_cooldown_seconds`,
`paste_max_per_user_per_day`, sizes) apply to user-JWT callers; app-key callers
are trusted server-to-server. AI summary/tags generation was **dropped** (Live
owns AI) but the columns remain for imported rows.

### Files

| method | path | notes |
|---|---|---|
| POST | `/files` | multipart `file` → `{ key, url, size, mime }`; key = `<sha256[0:12]>-<name>`; per-app `quota_bytes` enforced (413 on exceed) |
| GET | `/files` | list + `used_bytes`/`quota_bytes` |
| GET | `/files/:key` | meta |
| DELETE | `/files/:key` | delete |

### Thumbnails

| method | path | notes |
|---|---|---|
| POST | `/thumbnails/:kind/:id` | kind `vod`/`clip`: multipart `thumbnail` (or `{image: base64}`) uploads a custom image, or with no body (re)generates from the media (VOD @10%, clip near first frame); kind `live`: upload a broadcaster frame, stored under the stable name `stream-<app>-<id>.jpg` → `{ url }` |

### Admin storage (`/admin/storage`, app-key auth only)

Storage-management endpoints ported from the predecessor's admin panel. Auth
is the app API key only (no user JWTs) — admins reach these through their
app's own server, which holds the key. DB-derived stats are scoped to the
calling app; **disk totals and directory sizes are host-wide** (the data
directories are shared across apps) and responses carry a `note` saying so.

| method | path | notes |
|---|---|---|
| GET | `/admin/storage` | `{ disk (df of VOD volume), database.bytes, breakdown [vods/clips/pastes/thumbnails/files dirs], vodStats/clipStats/pasteStats/fileStats (app-scoped), byProvider.{vods,clips} (count+bytes per local/b2/r2) }` |
| GET | `/admin/storage/vods?limit&offset&sort&order&provider&tier` | detailed app VOD listing: id, title, size, provider, health, views, `last_accessed_at`, created + `fileExists`/`diskSize`/`actualTier` (disk-reconciled: local/b2/r2/missing), per-user summary. `sort` = size\|date\|duration\|tier\|views\|accessed, `order` = asc\|desc, `provider` = local\|b2\|r2 (`tier` accepts legacy hot/cold aliases) |
| DELETE | `/admin/storage/vods/bulk` | `{ ids: [...] }` (max 200) — deletes each VOD everywhere (local + B2 + R2 + sidecars/master + thumbnail + row), app-scoped → `{ deleted, freed, results: [{id, ok, error?}] }` |
| GET | `/admin/storage/tiers` | tiering status: settings, provider health, local disk, service-wide tier counts (`tiers`/`clipTiers`), `sweepRunning`, plus `app.{tiers, pendingOffload}` scoped to the caller |
| PUT | `/admin/storage/tiers/settings` | update any `storage_tier.*` knob (see `vod-storage.js` `DEFAULTS`: `enabled`, `minAgeDays`, `maxViewsForCold`, `minLastAccessDays`, `sweepIntervalMs`, `hotDiskPressurePct`, `localLowWaterPct`, `maxPerSweep`, `r2Enabled`, `r2MinViews`, …); persisted in `media_settings`, sweep timer restarted → `{ ok, settings }` |
| POST | `/admin/storage/tiers/sweep` | run the tiering sweep now → sweep summary |
| POST | `/admin/storage/tiers/move` | `{ vod_id, target: local\|hot\|b2\|cold\|r2 }` — reuses the storage engine's verified move logic; VOD must belong to the app |
| POST | `/admin/storage/tiers/bulk-move` | `{ ids: [...], target }` (max 50) → `{ moved, bytes, errors? }` |
| GET | `/admin/storage/buckets` | sanitized bucket status per provider: `{ configured, endpoint, bucket, region, healthy, reachable }` via a live HeadBucket probe — **credentials are never returned** |

### Webhooks (outbound)

`POST` to the app's `webhook_url` with body
`{ "event": "vod.ready"|"vod.failed"|"clip.ready"|"clip.failed"|"media.object.uploaded"|"storage.alert"|"storage.recovered", "app_id", "data", "event_id"? }`
and header `X-OVMedia-Signature: sha256=<hex hmac-sha256 of the raw body with
the app's webhook_secret>`. 3 attempts with backoff, 10 s timeout.

Each outcome is also a durable OpenVibe.Events event (`media.vod.ready|failed`,
`media.clip.ready|failed`, `media.object.uploaded`, `media.storage.alert|recovered`;
`server/events.js`). The outbox row is written in the **same SQLite transaction** as the state
change it describes (`webhooks.announce()`), so an outcome is never lost or announced for a
rolled-back change; the webhook follows the commit and carries `event_id` = that event's id
(absent when the outbox is off), so an app that reads both paths (Live during its webhook →
Events transition) handles each outcome once. Webhooks stay until every consumer reads Events.

## Restore drills (`MEDIA_DRILL=1`)

`ovhost drill media` (OpenVibe.Host `docs/restore-drills.md`) restores `media.db` from the latest
backup and starts a second Media from this checkout on 127.0.0.1:14100 with `MEDIA_DRILL=1` and
`DB_PATH` on the copy. In that mode (`server/drill.js`) Media:

- refuses to start unless `DB_PATH` is set and outside the checkout and `/opt/openvibe.media`, `HOST`
  is loopback and `PORT` is not 4100 (before the database is opened);
- starts only its HTTP server: no app seeding, JWKS refresh, tiering sweep, health job, junk sweep,
  clip re-cuts, copy verification, jobs worker, disk guardian, thumbnail cleanup, object purge,
  backfill, orphan-recording finalize or Events relay; webhooks are never sent;
- writes no file and creates no directory (the storage checks leave `/api/ready`, as do the remote
  tiers; it reports `"mode": "drill"`);
- never opens a file path from the database: every byte route (`/v` and `/c` bytes, `/t`, `/a`, `/f`,
  `/o`, `/p/:slug/screenshot`, `/live/:sel/frame.jpg`, `/api/thumbnails/:name`) answers 503;
  watch pages and the `/browse` index still render from the copy;
- connects to nothing and runs no program but `git` (no ffmpeg or ffprobe), opens no UDP socket and
  listens on nothing but its port;
- answers 403 to every method but GET, HEAD and OPTIONS, and 503 to `/auth/*`.

`test/drill-mode.test.js` boots the real server that way against a copy whose app has a webhook URL
and checks each point.

## Health, readiness and metrics

| path | behavior |
|---|---|
| `GET /healthz` | liveness: the process answers (unchanged; it checks nothing else) |
| `GET /api/ready` | readiness from real checks, each with `status`, `required`, `latency_ms`, `checked_at`. **Required** (503 when one fails): `db` (a query against the SQLite database), `storage_vods`, `storage_clips`, `storage_pastes`, `storage_thumbnails`, `storage_files`, `storage_objects` (a probe file is written and removed). **Optional** (listed in `degraded`, still 200): `network_jwks` (user JWTs and service tokens; app keys work without it), `remote_b2` / `remote_r2` (HeadBucket, at most once a minute; present only when the provider is configured), `events_outbox` (backlog over 1000 events). Also `recordings_in_progress`. |
| `GET /metrics` | Prometheus text (openvibe-shared/metrics) for **direct loopback callers only**; 404 through nginx. HTTP golden signals by route template, process metrics, `release_info`, `release_client_updates_total{outcome,reason}`, plus `media_recordings_in_progress`, `media_object_locations{provider,state}`, `media_objects{lifecycle_status}`, `media_events_outbox{status}` (only while the outbox runs). |
| `GET /release.json` | release manifest (`registry.release-manifest@1` 1.1.0, openvibe-shared/release, ADR-016): deployed commit, package versions, components, contract ranges, `metrics_url`. The shared navbar's release-watch polls it. No components are declared, so every release still prompts open tabs to reload. |
| `POST /release-metrics` | open tabs' update reports (release-watch beacons, at most 4 KB; 30 a minute per connecting address, which behind nginx is the proxy, so one budget for all tabs; Sec-GPC/DNT dropped) into `release_client_updates_total` on `/metrics`. 403 in a restore drill, like every write. |

## Public serving (no auth unless the item is private)

| path | behavior |
|---|---|
| `GET /v/:id` | VOD playback — local stream with Range support, live-DVR `.seekable` sidecar while recording, or **302** to a presigned B2/R2 URL. `X-Robots-Tag: noindex`. Also accepts a legacy **file basename** (old `/api/vods/file/<name>` URLs; clip basenames resolve too) |
| `GET /c/:id` | clip playback, same logic, `noindex` |
| `GET /p/:slug` | server-rendered paste HTML page (**indexable** — Media is the canonical home for pastes) |
| `GET /p/:slug/raw` | `text/plain` |
| `GET /p/:slug/screenshot` | paste screenshot image |
| `GET /t/:id` | thumbnail (id = filename), `noindex` |
| `GET /f/:key` | file with stored Content-Type + Range, `noindex` |
| `GET /f/screenshots/:name` | paste screenshot by filename — serves straight from `PASTES_PATH/screenshots` (migrated legacy files have no files-table rows), `noindex` |
| `GET /live/:sel/transcript.json` | **transcript + AI timeline API** — full audio-transcription log and AI overview timeline. `:sel` = slot id / slot slug → slot-scoped sessions; **`@username`** → user-scoped (all their slots, works while offline). Returns `{ live, current, sessions[] (each: ai_overview, transcript, duration…), streamer (overview + stream memories), user }`. `?limit=1..50` sessions (default 10), `?app=`. Cached **30s** (that's the rate limit), CORS-open. |
| `GET /live/:sel/chat-insight.json` | **chat insight API** — a user's chat-related AI insight/timeline (`:sel` = `@username` or numeric user id): today-vs-alltime chat overviews, condensed memory, event timeline, plus their streamer overview + stream memories when they stream. Proxied from the app's public chat-AI API over loopback; cached **30s**, CORS-open. |
| `GET /v/:id/transcript.json` | **VOD transcript API** — transcript + AI overview for one existing VOD id (`{ vod_id, title, duration_seconds, ai_overview, transcript, ai_analyzed_at }`). Private VODs → 404. Cached 30s, CORS-open. |
| `GET /live/:sel/frame.jpg` | **live frame API** — near-realtime JPEG frame of an actively-live stream slot, extracted from its in-progress recording. `:sel` = slot id (`1`), slot **slug** (`whip`), or **`@username`** (that streamer's top-viewed live slot; slug/username resolve via the app's `/api/streams` listing, cached 5s). Optional `?w=64..1920` scales the width, `?app=` selects the tenant (default `live`; internal base URLs from `APP_INTERNAL_URLS` JSON env or `LIVE_APP_INTERNAL_URL`). Cached **5s per slot** (that cache is the rate limit), CORS-open for external APIs/bots/dashboards. Not live → **404 with a styled OFFLINE card** (real JPEG bytes — dev pipelines decode the body as image/jpeg) so `<img>` embeds degrade nicely (`?format=json` for JSON errors); `503` + card when live but a frame can't be cut. |

Private items (and legacy rows with no visibility and `is_public = 0`) answer
exactly like a missing id — the same 404 and body — unless the request bears the
owning app's API key, optionally acting for the owner via `X-OV-User-Id`. That holds
for the watch page, the bytes, `transcript.json`, the legacy `/api/thumbnails` redirect
and `/p/:slug/raw`; the v1 detail routes (`GET /vods/:id`, `/clips/:id`, `/pastes/:slug`)
apply it to an app acting for someone other than the owner.

`GET /o/:id` serves object bytes by canonical id (`med_…`): public/unlisted
objects openly, private ones only with a valid signature from
`/api/v2/:app/objects/:id/download`, deleted ones 410 (a deleted private object
without a signature is a 404 like any other private one).

## Object model and API v2

Every stored blob is a **media object** (`med_<ULID>`, `media_objects`) with one
`media_locations` row per copy (local / B2 canonical / R2 cache, each `present`,
`missing`, `pending` or `corrupt`). The `vods`, `clips`, `files` and screenshot
`pastes` rows are typed projections over objects (`object_id` column); every
existing route and response is unchanged, and the old write paths keep the
model current. Full reference: **[docs/object-model.md](docs/object-model.md)**.

- **Backfill** — `node scripts/backfill-objects.js [--dry-run]`: one object per
  vod, clip, file, screenshot, avatar and thumbnail; idempotent; never moves
  bytes or calls B2/R2 (remote copies stay `pending`). The service runs the
  `--only-missing` form 15 s after boot.
- **API** — `/api/v2/:app/objects`: init → `PUT /:id/content` (sha256, size,
  quota) → `/:id/complete`; `GET /:id`, cursor `GET /`, soft `DELETE /:id`
  (bytes kept `MEDIA_DELETE_RETENTION_DAYS`), `/:id/restore`, `/:id/download`
  (302 for public, HMAC-signed short-lived URL for private —
  `MEDIA_SIGNING_SECRET`). App key, or a Network service token with
  `media.object.upload` / `media.object.read` for namespace `:app`;
  `X-OV-Subject` sets the owner.
- **Retention holds** — `media_holds` (`moderation`, `dmca`, `creator_pin`,
  `admin`, `evidence`; `/:id/holds`, app key only): a held object cannot be
  deleted by any path (409 / DB trigger) or moved between tiers.
- **Reconciliation** — `node scripts/reconcile-objects.js [--verify] [--hash]`:
  read-only by default; `--verify` HEADs B2/R2 and records location states.
  Reports missing canonical copies, lost local files, size/hash mismatches,
  orphan locations, deleted-but-still-served objects and unprojected rows.
- **Public object-size invariant** — `MEDIA_PUBLIC_OBJECT_MAX_MB` (500) /
  `_TARGET_MB` (256) / `_WARN_MB` (384): v2 refuses oversized public playback
  uploads; `node scripts/object-invariant.js` lists offenders and records them in
  `media_invariant_violations`. No automatic re-encoding.

## Storage tiering

`vod/vod-storage.js` (ported nearly as-is): local → B2 canonical cold tier →
R2 popularity cache; verified uploads before any deletion; periodic sweep
(offload by age/views/last-access, aggressive drain under disk pressure, R2
promote/demote); presigned-302 playback. Knobs live in `media_settings` under
`storage_tier.*` (JSON values). CLI:

```
node server/vod/vod-storage.js check|migrate-legacy|drain [targetPct]
```

Background jobs wired in `index.js`: tiering sweep, VOD health job (probe scan,
master-recovery repair, quarantine + cleanup, orphaned-master sweep), disk
guardian (refuses new recordings when free space is critical), stale live-thumb
cleanup, and an on-boot sweep that finalizes recordings orphaned by an unclean
shutdown.

## Migration from the predecessor DB

Every domain table carries `app_id TEXT NOT NULL DEFAULT 'live'`, and the new
schema keeps all predecessor columns (including legacy `storage_tier`), so the
cutover script can bulk-copy rows unchanged:

```js
const media = require('./server/db/database');
const old = require('better-sqlite3')('/path/to/old-live.db', { readonly: true });
for (const table of ['vods', 'clips', 'pastes', 'paste_likes', 'paste_comments', 'content_views']) {
    const rows = old.prepare(`SELECT * FROM ${table}`).all();
    console.log(table, media.importLegacyRows(table, rows, 'live'));
}
```

`importLegacyRows` inserts by column-name intersection (unknown legacy columns
ignored, new columns take defaults), preserves ids, backfills `app_id`, and is
idempotent (`INSERT OR IGNORE`). After the copy, run
`node server/vod/vod-storage.js migrate-legacy` to map legacy `storage_tier =
'cold'` rows to provider `b2`.

## Not ported

- **Song-request media queue** (`media/` yt-dlp downloader/queue): deeply
  coupled to Live's channels/chat/coins subsystems; Live keeps it local.
- Server-side live thumbnail grabbers (RTMP-FLV / JSMPEG-WS / SFU PlainRTP)
  and JSMPEG stdin recording: sources live inside the apps now; apps POST
  frames / use RTMP-RTP-chunk ingest instead.
- VOD part rotation + live-recording reconciler: tied to the predecessor's
  stream registry; apps re-trigger ingest on their side.
- Comments on VODs/clips, notifications, permissions/moderation ranks: owned
  by the apps.

## VOD storage tiering & disk safety

`server/vod/vod-storage.js` keeps the local VOD volume healthy without anyone watching it:

- **Drain policy** — a drain starts when the disk is above `hotDiskPressurePct` (70%) **or** has less than `minFreeGb` (25 GB) free, and stops only when it is under `localLowWaterPct` (60%) **and** has `targetFreeGb` (40 GB) free. Above `criticalDiskPct` (90%) recordings finished more than `criticalMinAgeHours` (2 h) ago are eligible; otherwise 1 day. Least-recently-watched VODs go first. All values live in `media_settings` as `storage_tier.*` (`PUT /api/v1/:app/admin/storage/tiers/settings`).
- **Only real files are candidates.** Rows without a file (a recording that was refused or never produced output, legacy paths) are quarantined as `health_status='missing_file'` and excluded — they used to fill the candidate list and starve the drain.
- **Cadence** — while a drain is still needed the sweep re-runs every `pressureRetryMs` (2 min), otherwise every `sweepIntervalMs` (15 min). A VOD whose upload failed is skipped for 30 min so one bad file cannot pin the drain.
- **Bounded uploads** — each upload is aborted past `uploadTimeoutFloorMs + size / uploadMinThroughputMBps`; a watchdog logs a sweep that has run for hours.
- **Stall alerts** — after `alertAfterStalledPasses` (2) consecutive pressure passes that freed nothing, and whenever the disk is critical, Media sends `storage.alert` to every app webhook (Live logs it and forwards to `OPS_ALERT_WEBHOOK_URL` / the `ops_alert_webhook_url` setting); `storage.recovered` follows once the drain works again. Each pass under pressure logs candidates / uploaded / failed / backed-off / quarantined.
- **Status** — `GET /api/v1/:app/admin/storage` includes `sweep` (last result, next run, stalled flag, needsDrain/critical).

Run `npm test` for the policy regression tests.
