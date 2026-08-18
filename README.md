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
  db/schema.sql          apps, vods, clips, pastes(+likes/comments), files, content_views, media_settings
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
vendor/openvibe-shared/  vendored shared helpers (do not edit; re-sync from canonical)
scripts/smoke-test.sh    end-to-end smoke test (boots a temp instance)
```

## Tenancy & auth

Tenant = the `:app` path segment. Rows in the `apps` table define tenants:

| column | meaning |
|---|---|
| `app_id` | tenant id (`live`, `games`, …) |
| `api_key_hash` | sha256 of the app API key (never stored in plaintext) |
| `webhook_url` / `webhook_secret` | outbound event delivery (HMAC) |
| `allowed_origins` | JSON array; guards browser (user-JWT) calls |
| `quota_bytes` | files-subsystem quota (0 = unlimited) |

Two credential types on `/api/v1/:app/...`:

1. **App API key** — `Authorization: Bearer <app_api_key>`. Compared in
   constant time against the app's stored hash. A key is only valid for its
   own `:app` segment; presenting another app's key returns **403**.
2. **Network user JWT** (browser endpoints only — chunks/complete, clips,
   pastes, files, thumbnails) — RS256, verified **offline** against the JWKS
   public key fetched from `OV_NETWORK_URL/api/.well-known/jwks` at boot
   (cached, refreshed every 6 h). `aud` must include `openvibe.media` when
   present. If the request carries an `Origin` header it must be in the app's
   `allowed_origins` (CORS is reflected for allow-listed origins only).

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
| GET | `/vods?limit&offset&user_id&stream_id&managed_stream_id&include_private&order` | list; `include_private` app-key only; `order` = newest\|oldest\|views |
| PUT | `/vods/:id` | `{ title?, description?, visibility? }` |
| DELETE | `/vods/:id` | deletes local + B2 + R2 objects + row |

`status`: `pending → recording → ready | failed` (derived; failures come from
health quarantine: corrupt / zero-byte / missing file).

**Recording formats** (inherited codec-passthrough behavior — VODs are *not*
always `.webm`): RTMP and RTP-H.264 record by lossless stream copy into a
fragmented **`.mp4`** (audio → AAC on the RTP path); RTP-VP8/VP9 copies into
**`.webm`** (Opus copied); exotic codecs fall back to a libvpx re-encode with a
lossless `.master.mkv` recovery archive. A `.seekable` sidecar is remuxed every
60 s during recording so `/v/:id` is DVR-seekable while live.

### Clips

| method | path | notes |
|---|---|---|
| POST | `/clips` | `{ vod_id, start_s, end_s, title?, user_id?, visibility? }` → **202** `{ id, status: 'processing' }`; cut runs in background (from the local file or a presigned B2/R2 URL); duplicate windows are deduplicated; live recordings are clamped to flushed footage. Multipart `video` = direct upload of an already-cut blob → **201** ready |
| GET | `/clips/:id` | status: `processing | ready | failed` |
| GET | `/clips?limit&offset&vod_id&stream_id&user_id&channel_user_id&hide_self&include_private&order` | list; `channel_user_id` = clipped-channel owner; `include_private` app-key only |
| PUT | `/clips/:id` | `{ title?, visibility? }` |
| DELETE | `/clips/:id` | local + offloaded objects + row |

### Pastes

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
`{ "event": "vod.ready"|"vod.failed"|"clip.ready"|"clip.failed", "app_id", "data" }`
and header `X-OVMedia-Signature: sha256=<hex hmac-sha256 of the raw body with
the app's webhook_secret>`. 3 attempts with backoff, 10 s timeout.

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
| `GET /live/:msid/frame.jpg` | **live frame API** — near-realtime JPEG frame of an actively-live stream slot (`msid` = managed stream id), extracted from its in-progress recording. Optional `?w=64..1920` scales the width, `?app=` selects the tenant (default `live`). Cached **5s per slot** (that cache is the rate limit), CORS-open (`Access-Control-Allow-Origin: *`) for external APIs/bots/dashboards. `404` when the slot isn't live, `503` when a frame can't be cut. |

Private items respond 403/404 unless the request bears the owning app's API
key or the owning user's JWT.

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
