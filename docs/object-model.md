# Object model

Roadmap Wave 4 turns Media from predecessor-shaped VOD/clip/file tables into one canonical object
platform. Every stored blob is a **media object** with an id `med_<ULID>`. The inherited
`vods`, `clips`, `files` and screenshot `pastes` rows stay as they are, and each one is now a typed
projection over an object through its `object_id` column. Every existing URL and v1 response is
unchanged. New code talks to objects through the [v2 API](#object-api-v2).

Code: `server/objects/` (`model.js`, `routes.js`, `backfill.js`, `reconcile.js`, `invariant.js`,
`signing.js`, `verify-job.js`, `copy-report.js`, `multipart.js`, `content-type.js`) and the job system in
`server/jobs/` (`queue.js`, `worker.js`, `routes.js`, `types.js`, `thumbnail.js`, `invariant-scan.js`,
`derive.js`). Schema: the bottom of `server/db/schema.sql`. Tests: `test/objects-*.test.js`, `test/jobs*.test.js`,
`test/r2-eviction-drill.test.js`.

## Tables

| table | what it holds |
|---|---|
| `media_objects` | `id` (med_…), `app_id` (tenant), `namespace` (capability namespace; = app today), `kind` (`vod` `clip` `file` `thumbnail` `screenshot` `avatar` `asset`), `owner_subject` (usr_… when known), `owner_app` + `owner_user_id` (legacy owner in the app's own user-id space), `visibility` (`public` `unlisted` `private`), `lifecycle_status` (`uploading` `ready` `failed` `archived` `deleted`), `mime_type`, `size_bytes`, `content_hash` (sha256), `canonical_provider` + `canonical_key`, `legacy_ref`, `metadata` (JSON), `created_at` / `updated_at` / `deleted_at` |
| `media_locations` | one row per provider copy (`UNIQUE(object_id, provider)`): `provider` (`local` `b2` `r2`), `bucket`, `key` (absolute path for local, object key for B2/R2), `storage_class` (`hot` local, `cold` B2, `cache` R2), `state`, `checksum`, `size_bytes`, `verified_at` |
| `media_relationships` | `from_object_id`, `relation`, `to_object_id`, `metadata`. In use: `clip_of` (clip to vod, with start/end), `thumbnail_of` (thumbnail to vod/clip). Reserved: `derived_from`, `screenshot_of` |
| `media_variants` | `object_id`, `variant_name`, `derived_object_id`, `recipe`. In use: `thumbnail` |
| `media_jobs` | derivative/maintenance jobs: `id` (mjob_…), `app_id`, `object_id`, `job_type`, `status`, `idempotency_key`, `params`, `result`, `attempts`/`max_attempts`, `run_after`, `lease_until`, `checkpoint`, `error`/`error_code`, `cancel_requested`, `created_by`, `decided_by`. See [Jobs](#jobs) |
| `media_uploads`, `media_upload_parts` | multipart upload sessions and the parts received (size, sha256). See [Multipart uploads](#multipart-uploads) |
| `media_holds` | retention holds, see [Holds](#retention-holds) |
| `media_invariant_violations` | public playback objects over the size policy, see [Invariant](#public-object-size-invariant) |

Location `state`:

- `present`: verified. The local file exists, or a HEAD answered with the right size.
- `missing`: verified absent.
- `pending`: believed there but not verified yet. Every remote copy starts here until reconciliation runs with `--verify` or the [scheduled verification](#scheduled-verification) reaches it.
- `corrupt`: the size or hash does not match.

A copy that reconciliation has verified keeps that state when the row is projected again. The
state resets only when the key changes.

### Ids and legacy refs

Ids come from `openvibe-contracts` `ids.newId('media')`. A backfilled object takes its ULID time
from the original row's `created_at`, so ids sort by creation time. Projected objects also carry
the transitional `media.media-ref@1` legacy form in `legacy_ref`, which is unique:

| row | `kind` | `legacy_ref` |
|---|---|---|
| `vods.id` | vod | `legacy:<app>:vod:<id>` |
| `clips.id` | clip | `legacy:<app>:clip:<id>` |
| `files.key` | file | `legacy:<app>:file:<key>` |
| screenshot paste | screenshot | `legacy:<app>:paste:<slug>` |
| avatar (screenshot paste with `metadata.kind = 'avatar'`) | avatar | `legacy:<app>:avatar:<slug>` |
| `vods`/`clips.thumbnail_url` (`/t/<name>`) | thumbnail | `legacy:<app>:thumbnail:<name>` |

Every v2 route that takes `:id` accepts either form. Native v2 objects have `legacy_ref = NULL`.

### How a row maps to its object

`model.sync(kind, id)` derives the object and its locations from the row as it is at that moment.
The backfill and every write hook use the same function.

- **vod / clip.**
  - Local copy: the file under `VOD_PATH` (vods, resolved by basename as playback does) or the clip's own path.
  - B2 copy (canonical, key `vods/<basename>` or `storage_key`): added when `storage_provider` is `b2`/`r2` or a `storage_key` is set.
  - R2 copy (cache): added when the provider is `r2`.
  - Canonical copy: B2 when one exists, otherwise local.
  - Lifecycle: recording → `uploading`; `corrupt`/`zero_byte`/`missing_file` → `failed`; `ready` otherwise. Clips: `processing` → `uploading`, `failed` → `failed`.
  - Visibility: `visibility`, falling back to `is_public`, the same way playback decides.
  - Clips-only (ephemeral) recordings are never projected.
- **file.** The local file under `FILES_PATH/<app>/<key>`. `visibility = public`, because `/f/:key` serves every file without auth. The row's sha256 becomes both `content_hash` and the location `checksum`.
- **screenshot / avatar.** `screenshot_path`. Text pastes have no bytes and no object; paste text belongs to Community.
- **thumbnail.** One object per vod/clip, reached through the parent's `thumbnail` variant and **updated in place** when the picture is regenerated (live recordings refresh it every couple of minutes). Visibility is `public` when the parent is public and `unlisted` otherwise, because `/t/<name>` serves anyone who has the name. An external `thumbnail_url` is skipped.

## Backfill

```
node scripts/backfill-objects.js [--dry-run] [--only-missing] [--json] [--out report.json] [--db ./data/media.db]
```

The backfill creates one object per vod, clip, file, screenshot/avatar paste and thumbnail, with
relationships and thumbnail variants.

- **Idempotent.** Objects are keyed by `legacy_ref`, so a second run updates them in place and creates nothing.
- **Never moves or deletes bytes, and never calls B2/R2.** A local copy is `present` when the file exists and `missing` when it does not. Remote copies stay `pending` until `reconcile-objects.js --verify` checks them.
- **One transaction,** with one savepoint per row: a failing row is reported and leaves nothing half-written. `--dry-run` rolls everything back and only reports.
- **Report:** counts per kind (seen, created, updated, skipped), location states, skipped rows with a reason, and errors. A real run stores the report in `media_settings` under `objects.backfill.last_report`.
- **At boot:** the service runs the `--only-missing` form itself 15 s after start, for rows with no `object_id`. The first boot after the upgrade therefore projects everything.

Skip reasons today: `clips-only recording (ephemeral, never published)`, `screenshot paste without a file path`, `external thumbnail url`.

The run holds SQLite's write lock for its duration, typically seconds. Prefer the boot backfill, or
run the script while traffic is quiet.

### Keeping the model current

The old write paths re-project their row after they change it:

| path | hook |
|---|---|
| vod create | `POST /vods` |
| recording start | `recorder` sets `file_path` |
| every finalize outcome | `finalize.finalizeVod` |
| visibility | `db.setVodVisibility` / `setClipVisibility` |
| health | `db.updateVodHealth` |
| title | `PUT /vods/:id`, `PUT /clips/:id` |
| clip create | `db.createClip` (API cuts, uploads and auto-clips) |
| clip cut / re-cut result | clips routes and `clip-jobs` |
| file upload | `db.createFile` |
| thumbnail generate / upload | `thumbnail-service`, `POST /thumbnails` |
| screenshot upload / censor | pastes routes |
| avatar ingest | `avatars/ingest` |
| tier moves | `moveToCold`, `moveToHot`, `promoteToR2`, `demoteFromR2`, sweep, `migrateLegacy`: the copy the move verified is marked `present` |

**Deletes need no hook.** A SQLite trigger on `vods`, `clips`, `files` and `pastes` marks the
object `deleted` whenever its row is deleted, which covers all of the inherited delete paths. Hooks
never throw: the legacy write has already happened, so a failed sync only logs a warning. The next
sync or backfill repairs it.

## Owner subjects

`owner_subject` names an object's owner as a Network subject (`usr_<ULID>`), so consumers such as
Live's lineage resolver (which reads `owner.subject` on the v2 object) never translate an app's own
user ids. An object gets it in one of three ways:

- **At creation,** when the caller names it: `X-OV-Subject` on `POST /api/v2/:app/objects`. Tools and
  developer-project uploads do this. A derived object (split, remux) copies its source's.
- **From the reconcile job** (`server/objects/owner-subject-job.js`), for every object that names only
  `owner_app` + `owner_user_id`: the projected vods, clips, files, screenshots, avatars and thumbnails,
  and v2 uploads that send only `user_id`. Every `MEDIA_OWNER_SUBJECT_INTERVAL_MIN` minutes (first run
  one minute after boot) it collects the distinct owners that still lack a subject and asks Network's
  `POST /internal/identity/resolve-batch` (`{ system, type: 'user', ids }`, 500 ids per call). It then
  fills their objects. Upload and projection paths never wait on Network. When nothing is missing, a
  run asks Network nothing. An owner Network does not know (a Live account not linked to Network) stays
  `NULL` until a later run finds it.
- **From the one-off backfill** `scripts/backfill-owner-subject.js`, for everything that existed before
  the job.

Rules for both job and backfill:

- A non-null `owner_subject` is never overwritten. Every write is guarded by `owner_subject IS NULL`
  and by the owner it was resolved for.
- Only the tenants whose user-id space is known are resolved (`SOURCE_SYSTEMS` in
  `server/objects/owner-subject.js`: `live` -> `live`). Others are reported and left alone.
- A re-projection keeps the subject, unless it changes the owner (`owner_app`/`owner_user_id`). Then
  the subject is dropped until the job resolves the new owner.
- Network is asked with a service token (`OV_OAUTH_CLIENT_ID`/`OV_OAUTH_CLIENT_SECRET`, capability
  `identity.subject.resolve`, audience `openvibe.network`). When Network has not granted it, the
  request uses `INTERNAL_API_KEY`.

```
node scripts/backfill-owner-subject.js [--db media.db] [--batch 500] [--json]        # dry run: counts per tenant
node scripts/backfill-owner-subject.js --apply --backup <file.json> [--batch 500]     # fill
node scripts/backfill-owner-subject.js --rollback <file.json> [--apply]               # undo (dry without --apply)
```

- **The dry run** (the default) opens the database read-only and prints per tenant: objects, already
  set, to fill, unresolvable, unsupported tenant and no owner.
- **`--apply --backup <file.json>`** first takes an online backup to `<file>.media.db` and requires
  `PRAGMA integrity_check` = `ok` on it. It then writes `<file.json>` (0600), the rows it is about to
  change, and fills them in `--batch` transactions. Finally it rewrites the file to list exactly the
  rows it changed. It refuses an existing backup name, and a re-run fills only what is still missing.
- **`--rollback <file.json> --apply`** sets `owner_subject` back to `NULL` on each listed row that
  still carries the subject the backfill wrote for the same owner. Rows changed since are counted and
  left alone. Without `--apply` it only reports, which also verifies an applied backfill. Stop the job
  first (`MEDIA_OWNER_SUBJECT_SYNC=0`, restart), or its next run fills the rows again.

The script opens the database directly, not through `server/db/database.js`, so none of the service's
boot work runs (for example, marking in-progress clip cuts failed).

## Object API v2

All routes live under `/api/v2/:app/objects`.

**Auth.** One of:

- the app's API key;
- a Network service token that grants `media.object.upload` (writes) or `media.object.read` (reads) for the namespace `:app`. `tenantAuth({ capability })` enforces this, as it does on v1.
- for `:app = prj_<ULID>` (a developer-project tenant, ADR-014): only that project's app tokens, production or sandbox. The token's `env` selects the tenant (`prj_<ULID>` or `prj_<ULID>-sandbox`), and upload URLs always name the project. Sandbox objects never get a `public_url`; `/download` signs them and `/o/:id` needs the signature, whatever their visibility. Retention holds are not available to app tokens. See the README's "Developer-project tenants".

**Owner.**

- `X-OV-Subject: usr_…` (or `user:usr_…`) sets `owner_subject`.
- With an app key, `X-OV-User-Id` acts as one of the app's users. That caller sees public and unlisted objects plus its own, and can only write its own.

**Errors** are RFC 9457 problem bodies (`openvibe-contracts` `http.sendProblem`).

| method | path | notes |
|---|---|---|
| POST | `/` | init. `{ kind, visibility (default private), mime_type, size_bytes, filename, content_hash (expected sha256), metadata (≤ 16 KB), user_id, upload_ttl (60-86400 s), multipart, part_size }` returns 201 `{ id, object, upload: { method: 'PUT', url, token, expires_at, max_bytes, content_type, complete_url, multipart_url } }`. `url` is a [presigned PUT URL](#presigned-uploads). With `multipart: true` (required above `MEDIA_OBJECT_MAX_MB`): `method: 'multipart'`, `url: null`, and `upload.multipart` is the new [session](#multipart-uploads). Checks at init: `size_bytes` against `MEDIA_OBJECT_MAX_MB` (single part) or `MEDIA_MULTIPART_MAX_MB` (413), the quota including reservations (413 `media.quota.exceeded`), the public-size invariant (422) and the [content type](#content-types) for the kind (415 `media.object.unsupported_type`) |
| POST | `/:id/upload-url` | a fresh presigned single-PUT URL for an uploading object (`{ ttl }` 60-86400 s) |
| PUT | `/:id/content` | the bytes, single part. Auth is the upload token (`?token=` from init, or `X-Upload-Token`) or the usual credential. Streams to disk computing sha256. Refuses more than the declared size or the limit (413; an object declared above `MEDIA_OBJECT_MAX_MB` goes multipart), a size mismatch (400), quota overrun (413), a type that does not suit the kind (415) and a PUT while a multipart session is open (409). Stored at `OBJECTS_PATH/<app>/<id>` with a verified local location. Mounted ahead of the JSON body parser, so any Content-Type is taken as raw bytes; the Content-Type becomes `mime_type` when init set none. Can be repeated while the object is `uploading` |
| POST | `/:id/complete` | checks the expected hash (422 `media.object.hash_mismatch`), the invariant, the quota and the bytes against the type (415 `media.object.content_mismatch`). Sets `ready` and sends the `media.object.uploaded` webhook. Also accepts the upload token |
| POST | `/:id/multipart` | start a [multipart session](#multipart-uploads) `{ part_size, size_bytes (when init declared none) }` → 201 |
| GET | `/:id/multipart/:uploadId` | the session: `parts` received (number, size, sha256), `missing`, `received_bytes`, `expires_at` |
| PUT | `/:id/multipart/:uploadId/parts/:n` | one part, raw bytes of exactly its size; optional `X-Content-SHA256` |
| POST | `/:id/multipart/:uploadId/complete` | `{ content_hash, parts: [{ part_number, sha256 }] }` (both optional): assembles, then the checks of `/complete` |
| DELETE | `/:id/multipart/:uploadId` | abort: parts deleted, the object stays `uploading` |
| GET | `/:id` | metadata: providers and states of each copy, never paths or keys |
| GET | `/` | cursor list, newest first. `?limit (≤200)&cursor&kind&visibility&status&owner (usr_…)&user_id&include_deleted` returns `{ objects, next_cursor }` |
| DELETE | `/:id` | soft delete: `lifecycle_status = deleted`, and the bytes are kept for `MEDIA_DELETE_RETENTION_DAYS` (default 30). 409 `media.object.held` under a hold. 409 `media.object.legacy_managed` for projected objects, which are deleted through their v1 route |
| POST | `/:id/restore` | undo a soft delete within the retention period (410 once purged) |
| GET | `/:id/download` | public or unlisted: 302 to the public location (the inherited URL for projected objects such as `/v/:id`, `/c/:id`, `/f/:key`, `/t/:name`, `/p/:slug/screenshot`; otherwise `/o/:id`). Private: `{ url, expires_at }` signed for `?ttl` seconds (30 to 3600, default `MEDIA_SIGNED_URL_TTL_S` = 300), or a 302 with `?redirect=1`. `?format=json` always answers JSON. 410 when deleted |
| GET | `/:id/holds` | active holds (`?all=1` includes released ones) |
| POST | `/:id/holds` | **app key only.** `{ kind, reason, created_by }` |
| DELETE | `/:id/holds/:holdId` | **app key only.** Releases the hold (`released_at`, `released_by`) |

**Public bytes: `GET /o/:id`.**

- Public and unlisted `ready` objects are served openly.
- Private objects need a valid `?exp=&sig=` from `/download`. Without one the answer is 404, so a private object cannot be told apart from a missing one.
- A deleted object answers 410 — after the check above, so a deleted private object is a 404 without a signature.
- A local copy streams with Range support. Otherwise the route redirects 302 to a presigned R2 URL, then a presigned B2 URL.
- Headers: `X-Content-Type-Options: nosniff` and `X-Robots-Tag: noindex`. Content is `inline` only for images (not SVG), video, audio, PDF and plain text, and `attachment` for everything else.

**Signing.** HMAC-SHA256 keyed with `MEDIA_SIGNING_SECRET` over a purpose and what the link may do:
downloads (`get`) over the object id and expiry; upload tokens (`put2`) over the tenant, the object,
its size and the expiry; multipart sessions (`mpart`) over the tenant, the object, the session, its
total size and the expiry. A signature for one purpose is never valid for another. Without the
secret, a random per-process secret is used and a warning is logged, so links stop working at the
next restart. **Set `MEDIA_SIGNING_SECRET` in production.**

### Presigned uploads

The `url` from init (or `POST /:id/upload-url`) is a presigned single-PUT URL:
`…/objects/<id>/content?token=v2.<exp>.<size>.<mac>`. No other credential is needed, so a browser
can send the bytes straight to Media. The token is scoped:

- to the **tenant** and the **object**: a token for another object or another tenant never verifies,
  and the URL must address the object's tenant;
- to the **size** the object declared (the PUT must be exactly that many bytes). An object created
  without a size gets a size-0 token: any size up to `MEDIA_OBJECT_MAX_MB`;
- in **time**: `upload_ttl` / `ttl` (60 s to 24 h, default `MEDIA_UPLOAD_TOKEN_TTL_S`).

The size is part of the signature, so it cannot be edited. Tokens of the earlier form `<exp>.<mac>`
(object only) are accepted until they expire. These are Media-signed URLs: the bytes land on Media's
disk, not directly in a bucket.

### Multipart uploads

For objects above `MEDIA_OBJECT_MAX_MB` (up to `MEDIA_MULTIPART_MAX_MB`, default 20 GB), or whenever a
client asks with `multipart: true`. Code: `server/objects/multipart.js`.

1. **Initiate** at init (`multipart: true`) or with `POST /:id/multipart`. The object must declare its
   size. `part_size` is `MEDIA_MULTIPART_MIN_PART_MB` (5) to `MEDIA_MULTIPART_MAX_PART_MB` (256) MB,
   default `MEDIA_MULTIPART_PART_MB` (64), and grows if there would be more than 10,000 parts. The
   answer carries `upload_id`, `parts_expected`, and a session `token` (`mp1.…`) already in
   `part_url_template`, `status_url`, `complete_url` and `abort_url`. The quota is checked (the
   declared size is reserved from init), and there must be free disk for twice the size plus
   `MEDIA_UPLOAD_MIN_FREE_MB` (507 `media.storage.insufficient`). A new session replaces an open one.
2. **Upload parts** (`PUT …/parts/<n>`, any order, in parallel). Every part but the last is exactly
   `part_size` bytes and the last is the rest; any other size is refused (400/413). A part is written
   to a temp file and renamed when complete, so a dropped connection leaves nothing half-written.
   Sending a part again replaces it. `X-Content-SHA256` is checked when sent.
3. **Resume** after a drop: `GET` the session and send the parts in `missing`.
4. **Complete**: every part must be there (409 `media.upload.parts_missing` lists `missing`); a
   `parts` list with sha256 values must match what was received. The parts are concatenated into
   `OBJECTS_PATH/<app>/<id>` while hashing, the parts are deleted, and the checks of `/complete`
   follow (expected hash, invariant, quota, content). If one of those fails, the object stays
   `uploading` with its content and can be sent again. Completing a completed session again (a
   retry after a lost answer) returns the object.
5. **Abort** (`DELETE`) deletes the parts; the object stays `uploading`. A single-part PUT is refused
   while a session is open (409 `media.upload.multipart_active`).

Sessions expire after `MEDIA_MULTIPART_TTL_HOURS` (24): the hourly purge deletes their parts and any
part directory no session owns. `media_uploads_open` on `/metrics` counts open sessions, and
reconciliation reports sessions left open past their expiry (`incomplete_multipart`).

### Content types

Code: `server/objects/content-type.js`.

- **The type must suit the kind** (415 `media.object.unsupported_type`, at init or at the PUT when
  init declared none): `vod` video/* or audio/*, `clip` video/*, `thumbnail` / `screenshot` / `avatar`
  image/* but not SVG. `file` and `asset` take any well-formed type.
- **Inline-served bytes must be what their type says** (415 `media.object.content_mismatch` at
  complete): `/o/:id` serves image/*, video/*, audio/* and PDF inline, so for those types (and every
  kind with a rule) the first bytes must match a known signature of that family: JPEG, PNG, GIF, WebP,
  BMP, AVIF/HEIC; Matroska/WebM, MP4/MOV, Ogg, AVI, MPEG-TS; MP3, WAV, FLAC, M4A; PDF.
- Everything else is served as an attachment with `nosniff`, so its declared type is taken as given.
  The declared type wins over the PUT's `Content-Type` (declared at init: the PUT header is ignored).

**Quota.** `apps.quota_bytes` is compared against v1 file bytes plus native objects that are
`uploading` (their declared size counts as a reservation) or `ready`. Soft-deleted objects do not
count, except in developer-project tenants, where they count until their bytes are purged. The v1 files route still counts only v1 files, so its response is unchanged.

**Purge.** Every hour, the service removes the bytes of native objects whose retention period has
passed and that have no active hold. The object row stays `deleted` with `metadata.purged_at`.
Projected objects are never purged by this job.

## Retention holds

`media_holds(object_id, kind, reason, created_by, created_at, released_at, released_by)`. The
`kind` is one of `moderation`, `dmca`, `creator_pin`, `admin`, `evidence`. While any hold is
unreleased:

- **No delete path works.**
  - v2 `DELETE` answers 409.
  - The v1 deletes for vods, clips and files, and the admin bulk delete, answer 409 or report `held`.
  - Quarantine cleanup skips the object.
  - `deleteVodObjects` keeps the bytes.
  - Paste screenshot removal keeps the file, and censor answers 409.
  - A `BEFORE DELETE` trigger on each projected table, plus a trigger on `media_objects.lifecycle_status`, refuses the change, so paths nobody has hooked are still covered.
- **No tier move.** `moveToCold`, `promoteToR2` and `demoteFromR2` return `{ ok: false, held: true }`, and the sweep counts these as `skippedHeld` instead of errors. A hold freezes an object's placement. `moveToHot` (restoring a copy to local disk) is still allowed.

## Reconciliation

```
node scripts/reconcile-objects.js [--verify] [--hash] [--app live] [--json] [--out report.json] [--db ./data/media.db]
```

**Modes.**

- **Default: read-only.** Checks local files and database consistency, writes nothing and calls no provider.
- `--verify`: also HEADs every B2/R2 location with the storage engine's S3 client, and records what it finds on `media_locations` (`state`, `size_bytes`, `verified_at`). An unconfigured provider counts as *unverifiable*, never as *missing*.
- `--hash`: computes the sha256 of local files ≤ 512 MB for objects that carry a `content_hash`.

The exit code is 1 when issues were found.

**Issues reported** (each with a count and up to 200 examples):

| issue | meaning |
|---|---|
| `no_canonical_location` | a ready object with no location row for its canonical provider |
| `canonical_missing_replica_present` | the canonical copy is missing or corrupt while another copy is present (for example B2 lost it but R2 has it) |
| `no_present_copy` | a ready object whose every copy is missing or corrupt |
| `missing_local_file` | a ready object's local copy is not on disk |
| `remote_missing` | a ready object's B2/R2 copy answered 404 (`--verify`) |
| `size_mismatch` / `hash_mismatch` | the bytes differ from the object's size or sha256 |
| `orphan_location` | a location row whose object does not exist |
| `deleted_publicly_reachable` | a deleted object whose inherited row still serves it, or a thumbnail of a deleted object that is still served by name |
| `missing_projection` | an inherited row with no object yet (run the backfill) |
| `incomplete_multipart` | a multipart session still open past its expiry (the hourly purge should have removed it) |

**Not covered yet:** orphan *provider* objects (bucket keys with no row, which needs bucket
listing). `server/objects/reconcile.js` takes a `head` function,
so tests run it against a fake provider.

## Scheduled verification

`server/objects/verify-job.js` runs inside the service (started from `server/index.js`, two minutes
after boot, then every `MEDIA_VERIFY_INTERVAL_MIN`). Each run takes the `MEDIA_VERIFY_BATCH` ready
objects verified least recently (never-verified first), so every object is covered over time: with
the defaults, 7,200 objects a day.

For each object it:

1. **Checks every copy**, with the same rules as `reconcile-objects.js --verify`. A local copy is `present` when the file exists, and `corrupt` when the object carries a `content_hash` and the file (≤ `MEDIA_VERIFY_HASH_MAX_MB`) hashes differently. A B2/R2 copy is `missing` on a 404 and `corrupt` when its size differs. An unconfigured or unreachable provider is *unverifiable* and keeps its state. The verdict goes to `media_locations` (`state`, `size_bytes`, `verified_at`), but only if the location still has the key that was checked.
2. **Restores a missing B2/R2 copy** by uploading a verified-good local copy (right size, hash not contradicted) to the same key through the storage engine's `uploadFile`. That call HEADs the upload afterwards and fails on a size mismatch. At most `MEDIA_VERIFY_MAX_REUPLOADS` uploads run per run, and the rest wait for the next one. A `corrupt` remote copy is overwritten only when `MEDIA_VERIFY_REPAIR_CORRUPT=1`.
3. **Records the outcome.** `media_verifications` gets one row per object (`verified_at`, `status` `good` / `no_good_copy` / `unverifiable`, `good_providers`, per-location `detail`). `media_verify_runs` gets one summary row per run.

**It never deletes anything.** No file, remote object or row is removed, and no lifecycle is changed.

**No good copy.** A ready object has *no good copy* when none of its locations is `present` or
`pending`. This includes ready objects with no location row at all. They show up in three places:

- `media_objects_no_good_copy` on `/metrics`, next to `media_verify_last_run_timestamp_seconds`.
- The optional `object_copies` check in `/api/ready`. It is degraded while the count is above zero and never makes Media not-ready.
- The report, which lists each one for an operator to decide on:

  ```
  node scripts/no-good-copy-report.js [--app live] [--json] [--out report.json] [--db ./data/media.db]
  ```

  For each object it prints the owner (app, `owner_user_id`, `owner_subject`), `legacy_ref`, the `vods`/`clips`/`files`/`pastes` rows that point at it, its relationships, variants and holds, every location with its state and `verified_at`, and the last verification. The report opens the database read-only. It exits 1 when there are any.

## Public object-size invariant

This is roadmap W4 deliverable 5, stated as **policy** rather than a copied constant:

| setting | env | default |
|---|---|---|
| max: no public playback object above this | `MEDIA_PUBLIC_OBJECT_MAX_MB` | 500 |
| target | `MEDIA_PUBLIC_OBJECT_TARGET_MB` | 256 |
| warn | `MEDIA_PUBLIC_OBJECT_WARN_MB` | 384 |

A *public playback object* is a `ready` vod or clip whose visibility is `public` or `unlisted`.

- **Validator.** `server/objects/invariant.js` classifies a size as `ok`, `above_target`, `warn` or `violation`. The functions are pure.
- **Upload time.** v2 refuses to init or complete a public playback object above the max (422 `media.invariant.public_object_too_large`). Private objects are not playback objects.
- **Violations table.** Every vod/clip sync records warn and violation levels in `media_invariant_violations`, one row per object. The row is resolved when the object shrinks, becomes private or is deleted.
- **Report.**

  ```
  node scripts/object-invariant.js [--dry-run] [--app live] [--json] [--db ./data/media.db]
  ```

  Lists every public playback object above target, largest first, records the rows, and resolves rows that no longer apply. `--dry-run` writes nothing.

- **Validator job.** `invariant.scan` (see [Jobs](#jobs)) runs per tenant every
  `MEDIA_INVARIANT_SCAN_HOURS` (24) and on demand. It records the violations and **proposes** one job
  per public playback object above the max: `object.split` into stream-copy parts of about the target
  size when the duration is known, `object.remux` when it is not (the remux writes the duration, so a
  split can be planned next). **Proposals never run by themselves**: they wait in status `proposed`
  until the owner approves or cancels them. A cancelled proposal is not proposed again; a proposal
  whose object stopped violating (made private, deleted) is withdrawn. `scripts/media-jobs.js scan`
  shows what would be proposed without writing anything.

**Nothing is re-encoded, and nothing is made private automatically.** A split makes private parts next
to the unchanged source; the source stays a violation until its owner decides (make the parts public
and the source private, or leave it). The segment-native model (roadmap W4 deliverable 7, capture in
W7) is what will make every new recording fit.

## Jobs

Code: `server/jobs/`. Tests: `test/jobs.test.js`, `test/jobs-invariant.test.js`.

**States.** `proposed` (waiting for the owner; the worker never takes it) → `queued` → `running` →
`succeeded` | `failed` | `cancelled`. A failed attempt goes back to `queued` with `run_after` (backoff
30 s, 2 min, 8 min, …, at most 1 h) until `max_attempts`; a handler can mark a failure permanent.

**Events.** Every state change and its `media.job.<transition>` event (`proposed`, `queued`,
`started`, `retrying`, `succeeded`, `failed`, `cancelled`; subject `job <id>`) commit in one SQLite
transaction through Media's outbox, the same rule as the outcome events (`webhooks.announce()`): no
change without its event, no event for a change that rolled back. Progress events are `low`
priority; outcomes and proposals are `important`. Job events go to OpenVibe.Events only, not to app
webhooks.

The payload is the event projection (`queue.jobEvent`, contracts `media.job.<transition>@1`), not
the job as the API answers it:

```json
{ "app_id": "live", "id": "mjob_…", "object_id": "med_…", "type": "object.split",
  "status": "succeeded", "attempts": 1, "max_attempts": 3, "error_code": null,
  "cancel_requested": false, "has_result": true,
  "run_after": null, "decided_at": null, "created_at": "2026-09-23T21:06:24.000Z",
  "updated_at": "…Z", "started_at": "…Z", "finished_at": "…Z" }
```

`object_id` is null for a tenant-wide job (`invariant.scan`). `status` is the job's state after the
change (`retrying` carries `queued`, `started` carries `running`); times are ISO 8601 UTC or null;
`error_code` is the stable code only. The tenant's `params`, the `idempotency_key`, the free-text
`error`, the `result` (a thumbnail URL of a private VOD, for one), `created_by`/`decided_by` and
`owner_user_id` (tenant-local user ids) are left out: events travel beyond the tenant. A consumer
that needs them GETs the job with its own tenant-scoped token (`GET /api/v2/:app/jobs/:id`);
`has_result` says whether there is a result to fetch.

**Idempotency.** `Idempotency-Key` (or `idempotency_key`) is unique per tenant: the same key with the
same request (type, object, params) answers with the job it made (`Idempotent-Replayed: true`); a
different request under a used key is 409 `media.job.idempotency_conflict`. At most 50 jobs per tenant
may be queued or running (429 `media.job.too_many`).

**Cancellation, by the owner.** A proposed or queued job is cancelled at once. A running job gets
`cancel_requested`; the worker aborts it (its ffmpeg is killed) and it ends `cancelled`. Finished
jobs answer 409. The owner is the tenant (app key, service token for the namespace, or the project's
app token); a caller acting for one of the app's users (`X-OV-User-Id`) sees and decides only the jobs
it created and the jobs on objects it owns.

**Worker.** In-process, polling every `MEDIA_JOBS_POLL_MS`, in two lanes: `light`
(`MEDIA_JOBS_LIGHT_CONCURRENCY`, 2) and `heavy` (`MEDIA_JOBS_HEAVY_CONCURRENCY`, 1; waits while a
recording runs unless `MEDIA_JOBS_HEAVY_WHILE_RECORDING=1`). A running job holds a lease
(`MEDIA_JOBS_LEASE_S`) renewed by a heartbeat; at start, jobs the previous process left `running` are
requeued (or failed when out of attempts). Handlers checkpoint progress and resume from it.
`MEDIA_JOBS_ENABLED=0` stops the worker. Finished thumbnail jobs are pruned after
`MEDIA_JOBS_RETENTION_DAYS`; other jobs are kept.

| type | lane | what it does |
|---|---|---|
| `thumbnail.regenerate` | light | (Re)generates a vod/clip thumbnail from its media (local file or presigned cloud copy). `params { kind, id }`, or an object that is a projected vod/clip. Result `{ url }` |
| `invariant.scan` | light | The [size-invariant validator](#public-object-size-invariant): records violations, proposes `object.split` / `object.remux`, withdraws moot proposals. Tenant-wide (no object) |
| `object.split` | heavy | Stream-copies a vod/clip (or a video/audio object) into parts (`params.parts` 2-1000 or `segment_seconds`), each a new **private** object with a `derived_from` relationship (`job_id`, `part`, `start_seconds`, `duration_seconds`). Cuts land on keyframes, so neighbouring parts can overlap slightly. The source is never changed. Checkpointed per part |
| `object.remux` | heavy | Stream-copy remux of the whole source (seek index, duration, MP4 faststart) into one new private object; also the source's `remux` variant |

Split and remux refuse a source that is not ready, a tenant quota the output would exceed, and too
little free disk (the source size plus `MEDIA_UPLOAD_MIN_FREE_MB`; retried after 30 min).

**The v1 thumbnail route runs as a job.** `POST /api/v1/:app/thumbnails/:kind/:id` without an image
queues `thumbnail.regenerate` (joining one already queued or running for the same item, so concurrent
requests share one ffmpeg run), runs it at once and answers `{ url, job_id }` as before; 404 when
there is no media, 500 when no frame came out. `?async=1` answers 202 `{ job }` without waiting.

**API** (`/api/v2/:app/jobs`, same auth as the objects API; writes need `media.object.upload`, reads
`media.object.read`):

| method | path | notes |
|---|---|---|
| GET | `/` | cursor list, newest first: `?status&type&object_id&limit (≤200)&cursor` → `{ jobs, next_cursor }` |
| POST | `/` | `{ type, object_id, params, max_attempts }` + `Idempotency-Key` → 202 `{ job }` (200 on a replay) |
| GET | `/:jobId` | `{ job }` |
| POST | `/:jobId/approve` | a proposal → `queued` (409 `media.job.not_proposed` otherwise) |
| POST | `/:jobId/cancel`, DELETE `/:jobId` | 200 cancelled, 202 while a running job stops, 409 when finished |

**Operator script.**

```
node scripts/media-jobs.js list [--status proposed] [--type object.split] [--app live] [--json]
node scripts/media-jobs.js show <job id>
node scripts/media-jobs.js scan [--app live] [--apply] [--json]   # dry run unless --apply
node scripts/media-jobs.js approve <job id>... [--by <who>]
node scripts/media-jobs.js cancel <job id>... [--by <who>] [--reason <text>]
```

It changes the database directly (the service's worker picks approved jobs up on its next poll) and,
when the service's outbox is on, queues each change's event in the same transaction. It never runs a
job. `media_jobs{type,status}` on `/metrics` counts jobs.

## R2 eviction drill

The exit criterion "the canonical B2 object survives R2 eviction", as a repeatable drill with a kept
artifact. Code: `scripts/r2-eviction-drill.js`; test: `test/r2-eviction-drill.test.js` (a fake S3 and
a local Media, through the real storage engine).

```
node scripts/r2-eviction-drill.js (--vod <id> | --pick) [--execute] [--base-url https://openvibe.media]
                                  [--no-http] [--max-mb 512] [--out artifact.json] [--json]
```

- **Dry run by default:** it checks the preconditions and both copies, and writes the artifact. Nothing moves.
- **Preconditions** (else it refuses, exit 2): the VOD is served from R2 (`storage_provider = r2`), is
  not recording, is not held (a hold freezes placement), and is public or unlisted for the HTTP
  checks; B2 and R2 are configured; the B2 and R2 copies have the same size (and the recorded size)
  and the same first MiB. Evicting the cache in front of a corrupt canonical copy would lose the only
  good one. `--pick` takes the smallest eligible VOD up to `--max-mb`.
- **`--execute`**, through the storage engine's own tier moves: (1) `GET <base>/v/<id>?raw=1`
  redirects to R2 and serves the expected first MiB; (2) `demoteFromR2` deletes the R2 copy (after
  checking B2) and flips the row to `b2`; (3) R2 answers 404, and `/v/<id>` redirects to B2 serving the
  same first MiB; (4) `promoteToR2` copies B2 back to R2 (verified by HEAD) and flips the row to `r2`;
  (5) `/v/<id>` redirects to R2 again with the same bytes, and `media_locations` shows B2 and R2 present.
- A failed step stops the drill (exit 1). After the eviction the VOD stays served from B2, which the
  drill has just proven works. `--no-http` checks the playback decision in-process instead of
  `GET /v`, which otherwise counts as one view from the drill's host.
- **Artifact:** JSON (default `data/drills/r2-eviction-<vod>-<time>.json`) with every step, the HEAD
  sizes, the first-MiB sha256 of each copy and of what was served, `media_locations` before, after the
  eviction and after, and the verdict (`pass`, `fail`, `refused`, `dry-run`).

Not run against production yet: it needs the owner's go-ahead.

## Configuration

| env | default | meaning |
|---|---|---|
| `OBJECTS_PATH` | `./data/objects` | native object bytes (`<app>/<id>`, `.tmp/` while uploading) |
| `MEDIA_OBJECT_MAX_MB` | 256 | single-part upload limit |
| `MEDIA_DELETE_RETENTION_DAYS` | 30 | soft-deleted native bytes are kept this long |
| `MEDIA_SIGNING_SECRET` | *(random per process)* | HMAC key for signed URLs and upload tokens |
| `MEDIA_SIGNED_URL_TTL_S` | 300 | default signed download lifetime |
| `MEDIA_UPLOAD_TOKEN_TTL_S` | 3600 | default presigned upload URL lifetime (60 s to 24 h per request) |
| `MEDIA_MULTIPART_MAX_MB` | 20480 | largest object a multipart upload may declare |
| `MEDIA_MULTIPART_MIN_PART_MB` / `_MAX_PART_MB` / `_PART_MB` | 5 / 256 / 64 | part size bounds and default |
| `MEDIA_MULTIPART_TTL_HOURS` | 24 | an unfinished multipart session is purged after this |
| `MEDIA_UPLOAD_MIN_FREE_MB` | 10240 | free disk kept in reserve by multipart uploads and split/remux jobs |
| `MEDIA_JOBS_ENABLED` | on | `0` stops the job worker |
| `MEDIA_JOBS_POLL_MS` | 5000 | worker poll interval |
| `MEDIA_JOBS_LIGHT_CONCURRENCY` / `_HEAVY_CONCURRENCY` | 2 / 1 | jobs per lane |
| `MEDIA_JOBS_HEAVY_WHILE_RECORDING` | off | `1` lets split/remux run while a recording is being written |
| `MEDIA_JOBS_LEASE_S` | 120 | running-job lease (renewed by the heartbeat) |
| `MEDIA_INVARIANT_SCAN_HOURS` | 24 | the size-invariant validator's schedule per tenant (`0` = on demand only) |
| `MEDIA_JOBS_RETENTION_DAYS` | 30 | finished thumbnail jobs are pruned after this |
| `MEDIA_PUBLIC_OBJECT_{MAX,TARGET,WARN}_MB` | 500 / 256 / 384 | invariant thresholds |
| `MEDIA_VERIFY_ENABLED` | on | `0` turns the scheduled verification off |
| `MEDIA_VERIFY_INTERVAL_MIN` | 10 | minutes between verification runs |
| `MEDIA_VERIFY_BATCH` | 50 | objects per run |
| `MEDIA_VERIFY_HASH_MAX_MB` | 64 | sha256 local copies up to this size (objects with a `content_hash`) |
| `MEDIA_VERIFY_MAX_REUPLOADS` | 2 | missing remote copies restored per run |
| `MEDIA_VERIFY_REPAIR_CORRUPT` | off | `1` also overwrites a corrupt remote copy from a good local copy |
| `MEDIA_OWNER_SUBJECT_SYNC` | on | `0` turns the owner-subject reconcile job off |
| `MEDIA_OWNER_SUBJECT_INTERVAL_MIN` | 10 | minutes between owner-subject reconcile runs |

## Not in this pass

- Presigned direct-to-bucket uploads. Presigned URLs are Media-signed and native bytes are stored locally.
- Tiering of native objects to B2/R2.
- Copy/move aliases, lifecycle rules and an S3-compatible façade.
- Clip cutting and the finalize remux still run inline, not as jobs (thumbnail regeneration was the first
  operation moved onto the job system).
- Orphan-bucket-object detection.
- The segment-native timeline.
- App assets (emotes and sounds, the `assets` table) are not projected yet. The `asset` kind exists for v2 uploads.
