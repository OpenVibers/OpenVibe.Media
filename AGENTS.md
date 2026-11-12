# AGENTS.md — OpenVibe.Media

## Project Overview

OpenVibe.Media is the network's standalone multi-tenant media service (port 4100): VOD ingest/recording, storage
tiering (local → Backblaze B2 → Cloudflare R2), clips, generic files, avatars/attachments, thumbnails, the canonical
object model (`/api/v2`: objects, locations, variants, holds, derivatives, lifecycle, namespaces), the S3/zone
surface, and public serving, for every OpenVibe app and developer project.

- **Domain:** `openvibe.media` (plus `s3.openvibe.media`) · **Port:** 4100 · **Service id:** `media` ·
  **Env prefix:** `MEDIA`/`OV_`
- **Runtime:** Node ≥22, Express, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9,
  `ffmpeg`/`ffprobe` on PATH, S3-compatible B2/R2 when configured.
- **Read first:** [README.md](README.md) (long and authoritative), [docs/object-model.md](docs/object-model.md),
  [docs/media-fabric.md](docs/media-fabric.md), [docs/s3.md](docs/s3.md), [docs/recordings.md](docs/recordings.md),
  [.env.example](.env.example).

**Network context:** identity, JWKS, visitor sign-in (`media` OAuth client), `identity.subject.resolve` and
account export/deletion are OpenVibe.Network. OpenVibe.Live answers lineage (`live.lineage.resolve`); Live owns
channels/streams and who a VOD belongs to. Events are OpenVibe.Events (outbox; **no webhooks since 2026-10-11**).
AI reads recordings through signed URLs; Media does not analyse them. Pastes moved to OpenVibe.Community and Media
keeps only legacy screenshot files as media objects.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run init-db                # node server/db/init.js
npm start                      # node server/index.js (ffmpeg/ffprobe required)
npm test                       # every test/*.test.js, each on a migrated PGlite, local stubs, no network
npm run test:pg                # the same through PostgreSQL containers
npm run smoke                  # scripts/smoke-test.sh: boots a temp instance end to end
npm run n-1:record [ref]       # after a deploy, record the release in production as the next N-1
node --check <file.js>         # syntax check (no linter configured)
```

No build step. There is no site bundle: public pages/explorer are server-rendered and served by the app.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — boot/migrations, route mounts, app seeding, JWKS, background jobs
  (tiering sweep, health scan, junk sweep, clip re-cuts, copy verification, jobs worker, disk guardian, thumbnail
  cleanup, object purge, orphan finalize, Events relay) and graceful shutdown.
- **Config/db:** [server/config.js](server/config.js), [server/db/init.js](server/db/init.js),
  [server/db/database.js](server/db/database.js) (async `openvibe-sdk/db`, every query scoped by `app_id`).
- **Auth/tenancy:** [server/auth.js](server/auth.js) — app API key (constant-time sha256, own tenant only), Network
  user JWT (offline JWKS, audience `openvibe.media`, CORS origins), Network principal token (per verb and namespace);
  first-party tenants seeded token-only (`live`, `community`, `tools`, `games`, `wiki`, `blog`, `inventory`,
  `media-hub`); developer-project tenants (ADR-014) created on first use, production `prj_…` and sandbox
  `prj_…-sandbox`, with their own quotas and no public URLs.
- **VODs/clips:** [server/vod/](server/vod/) — `recorder.js` (RTMP pull/RTP), `media-tools.js`, `finalize.js`,
  `routes.js`, `clip-cutter.js`, `clips-routes.js`, `vod-storage.js`, `health-scanner.js`, `health-job.js`.
- **Objects/timeline/jobs:** [server/objects/](server/objects/) (`model.js`, `routes.js`, `timeline.js`,
  `multipart.js`, `signing.js`, `tiering.js`, `tier-policy.js`, `reconcile.js`, `invariant.js`, `readiness.js`,
  `review.js`, `namespaces.js`), [server/jobs/](server/jobs/) (queue/worker/leases/types, CMAF/pack/rendition/clip
  cut/finalize/duration reconcile/storage orphans/move cleanup).
- **Files/attachments/avatars/images:** [server/files/routes.js](server/files/routes.js),
  [server/attachments/](server/attachments/), [server/avatars/ingest.js](server/avatars/ingest.js),
  [server/images/](server/images/), [server/thumbnails/](server/thumbnails/).
- **Public/private and explorer:** [server/public/routes.js](server/public/routes.js), [server/me/](server/me/)
  (explorer `/me`, `/api/v2/me`, `/me/ops`), [server/admin/routes.js](server/admin/routes.js),
  [server/registry/](server/registry/) (authority resource index + control, ADR-048), [server/billing.js](server/billing.js),
  [server/announce.js](server/announce.js), [server/events.js](server/events.js), [server/account-data.js](server/account-data.js),
  [server/drill.js](server/drill.js), [server/client-ip.js](server/client-ip.js).
- **Database:** [migrations/](migrations/) — `apps`, `vods`, `clips`, `files`, `assets`, `content_views`/`content_visits`,
  `media_settings`, `media_objects/locations/relationships/variants/holds/jobs/invariant_violations`, `media_timeline`,
  `media_uploads/upload_parts`, `media_recordings/recording_parts`, `media_attachments`, `media_avatar_refs`,
  `media_access_keys`, `media_zones`, `media_tier_decisions`, `media_verify_runs`, `media_review_views`,
  `billing_readings/periods`, share tables, `token_revocations`, `subject_merges`, `event_outbox`,
  `account_data_events`, `telemetry_samples`. The legacy paste tables are dropped (`0007`); nothing may depend on
  them.
- **Deploy:** [deploy/systemd/openvibe-media.service](deploy/systemd/openvibe-media.service) (127.0.0.1:4100,
  `/etc/openvibe/media.env`, `/opt/openvibe.media`, media under `/opt/openvibe.media/data`), the socket unit and
  drop-in (requests wait across a restart), and [deploy/nginx/openvibe.media.conf](deploy/nginx/openvibe.media.conf).
  `sudo ovhost deploy media` (git-checkout, database `ov_media`, migrations at boot); it refuses a restart while a VOD
  records or an upload is in flight — use `--wait-idle`. Roll back with `sudo ovhost rollback media --to <sha>`.

## Ownership and Boundaries

Media owns VODs/recordings, clips and their cuts, files, avatars/attachments, thumbnails, the object model and its
holds/derivatives/lifecycle, timelines, namespaces/quotas, tenants and project tenants, S3 access keys and zones,
storage tier decisions, verification runs, public serving and usage readings. It does **not** own pastes (Community),
channels/streams/VOD lineage (Live), identity/accounts (Network), AI analysis (AI), event delivery (Events), or the
host/database (Host). Private data: anyone who may not see an item gets the same answer as a missing id.

## Tenancy, Auth and Namespaces

- `:app` is the tenant. Credentials: (1) an app API key, valid only for its own `:app` (403 otherwise); (2) a Network
  user JWT on browser endpoints, offline-verified, audience `openvibe.media`, `Origin` allowed by the tenant; (3) a
  Network principal token (`svc:`/`app:`/`mod:`), accepted only on verb routes and checked per namespace `ns`:
  read `media.object.read`, list `media.object.list`, write `media.object.upload`, delete `media.object.delete`,
  transform `media.derivative.create`.
- Developer-project tokens reach only their project's tenant (`prj_<ULID>` production, `prj_<ULID>-sandbox` sandbox);
  a sandbox token on any other route is 401 `token.sandbox_refused`. Sandbox content is **never public**: `/f/:key`
  and `/o/:id` answer 404 without a valid signature, `public_url` is null, `/download` always signs, and no platform
  events are emitted.
- Capabilities (audience `openvibe.media`): `media.object.upload|read|list|delete`, `media.upload.create`,
  `media.derivative.create|read`, `media.lifecycle.read|transition`, `media.resource.read|control` (first-party
  authority index/control), `media.object.s3` (an access key), `media.access_key.manage`, `media.zone.provision`.
  Outbound: `live.lineage.resolve`, `identity.subject.resolve`, `network.account.export.contribute|deletion.confirm`,
  `events.event.publish|subscription.manage`.
- Bearer secrets live only in `/etc/openvibe/media.env` (0600) and appear in code/docs by name only.

## API Surfaces

`/api/v1/:app/...`: VODs (`/vods`, ingest/chunks/finalize), clips, files, thumbnails, assets, admin storage, stats;
`/api/v2/:app/...`: objects (multipart, lifecycle, holds, derivatives, namespaces), timeline, jobs; `/api/v1/resources`
(first-party resource index), `POST /api/v1/resources/control`, project access keys/zones; `/api/v2/me` and `/me`;
public `/v /c /t /f /o`, `/p/:slug` redirects to Community. `/api/health`, `/api/ready`, `/release.json`, `/metrics`
(loopback), `/internal/events` (signed).

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter.
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Every table is `app_id`-scoped like the
  queries.
- **Jobs are leased and fenced:** a run may be retried/superseded; use the lease/fence token, make a type idempotent,
  and keep the `media.job.*` event in the state change's transaction. A job payload event carries ids/state/ISO
  times/`has_result` only — never params, result, error text or creator.
- **Events** are outbox rows in the change's transaction; a replay is one row. No webhooks (C-75).
- **Storage:** local/B2/R2 copies are verified; a failed copy is never deleted; the disk guardian never drops below
  its floor; tiering moves are CLI/jobs, not request-time. `MEDIA_DRILL` reads only and writes no byte.
- **Public serving:** private/sandbox items are 404 (not 403); `nosniff` always; only images (never SVG), video,
  audio, PDF and plain text inline — everything else `attachment`. View counts store no identifiers.
- **Client IP:** `trust proxy` is `loopback`; `req.ip` is the nginx-set `X-Forwarded-For` and the socket address
  otherwise. Never read `X-Forwarded-For`/`CF-Connecting-IP` directly for limits or view counting.
- **Egress:** recording only from `MEDIA_RTMP_PULL_ALLOW`; avatar ingestion through the SSRF guard; every other call
  goes to a configured Network/Live/Events/B2/R2 endpoint. Never fetch a user-chosen URL.
- **N-1:** every client call the previous release made must still answer compatibly, and every migration it ran must
  still be present unchanged. After a deploy, `npm run n-1:record` and commit the fixtures.
- Phone first for the explorer/public pages; no Font Awesome; "Calm reduces, only Off removes".

## Key Pitfalls

- **Tenant isolation:** an app key, project token or user JWT must never reach another tenant's rows; a project token
  names its project in the path and its sandbox cannot be named in a URL. [test/app-tenants.test.js](test/app-tenants.test.js),
  [test/app-tenant-abuse.test.js](test/app-tenant-abuse.test.js), [test/security-idor.test.js](test/security-idor.test.js).
- **Private = missing:** keep the 404 answer on every byte/read/list path; a thumbnail of a deleted/private item must
  not leak. [test/private-not-found.test.js](test/private-not-found.test.js).
- **Migration 0007 dropped the paste tables** (Pastes moved to Community); never reintroduce `pastes`,
  `paste_likes`/`paste_comments` or Media's old paste API.
- **Recordings/uploads gate deploys:** `/api/ready` names `recordings_in_progress`,
  `chunked_recordings_in_progress`, `recordings_untracked_in_progress`, `uploads_in_progress`; a restart during one
  is refused. Do not "fix" that by ignoring the check.
- **Disk safety:** under `VOD_DISK_STOP_GB` the largest running recording is stopped one a minute; only recordings
  older than a day are offloaded below 90%; under critical running recordings keep writing. Do not add a path that
  deletes a recording before finalize.
- **Drill mode** (`MEDIA_DRILL=1`) opens a restored DB copy, loopback/non-4100, no migrations, no seeding, no jobs, no
  bytes, 503 on byte routes, GET/HEAD/OPTIONS only. [test/drill-mode.test.js](test/drill-mode.test.js).
- **S3 surface:** an access key is a zone; presigned GET/PUT; never expose another zone's objects or the service's own
  secrets. See [docs/s3.md](docs/s3.md).
- **Secrets:** `OV_OAUTH_CLIENT_SECRET`, `MEDIA_SIGNING_SECRET`, `MEDIA_SECRET`, `MEDIA_B2_*`, `MEDIA_R2_*`,
  `MEDIA_INBOUND_EVENTS_SECRET`, `VIEW_HASH_SECRET` are names only; never log or commit a value.

## Testing

`npm test` runs every file in turn on a migrated PGlite (or the PostgreSQL containers with `npm run test:pg`) with
local stubs and no network: tenancy/project tenants, object model/multipart/reconcile/verification/tiering, jobs
leases/fencing, VOD finalize/durations/storage policy, clips/timeline/materialized cuts, private/IDOR/SSRF/secrets/
redirect, trust proxy, revocations/account data, outbox transaction, drill mode, actor limits and N-1. `npm run smoke`
boots a temp instance end to end. Run the narrowest file first, then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, owns/does-not-own, dependencies, capabilities, layout, visitor sign-in, tenancy,
  API, resource index, drills, N-1, client addresses, segment-native settings, limits, billing readings, health,
  public serving, review, S3/zones, object model, tiering, acceptance, security, deploy.
- [docs/object-model.md](docs/object-model.md), [docs/media-fabric.md](docs/media-fabric.md), [docs/s3.md](docs/s3.md),
  [docs/recordings.md](docs/recordings.md), [docs/materialized-clips.md](docs/materialized-clips.md),
  [docs/upload-kit.md](docs/upload-kit.md), [docs/player-starts.md](docs/player-starts.md),
  [docs/startup-tier.md](docs/startup-tier.md), [docs/cutover-media-billing-readings.md](docs/cutover-media-billing-readings.md).
- [scripts/](scripts/) — smoke, reconcile, invariant, jobs, R2 eviction drill, duration reconcile, orphans report.

