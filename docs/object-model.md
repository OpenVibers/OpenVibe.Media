# Object model

Roadmap Wave 4 turns Media from predecessor-shaped VOD/clip/file tables into one canonical object
platform. Every stored blob is a **media object** with an id `med_<ULID>`. The inherited
`vods`, `clips`, `files` and screenshot `pastes` rows stay as they are, and each one is now a typed
projection over an object through its `object_id` column. Every existing URL and v1 response is
unchanged. New code talks to objects through the [v2 API](#object-api-v2).

Code: `server/objects/` (`model.js`, `routes.js`, `backfill.js`, `reconcile.js`, `invariant.js`,
`signing.js`). Schema: the bottom of `server/db/schema.sql`. Tests: `test/objects-*.test.js`.

## Tables

| table | what it holds |
|---|---|
| `media_objects` | `id` (med_…), `app_id` (tenant), `namespace` (capability namespace; = app today), `kind` (`vod` `clip` `file` `thumbnail` `screenshot` `avatar` `asset`), `owner_subject` (usr_… when known), `owner_app` + `owner_user_id` (legacy owner in the app's own user-id space), `visibility` (`public` `unlisted` `private`), `lifecycle_status` (`uploading` `ready` `failed` `archived` `deleted`), `mime_type`, `size_bytes`, `content_hash` (sha256), `canonical_provider` + `canonical_key`, `legacy_ref`, `metadata` (JSON), `created_at` / `updated_at` / `deleted_at` |
| `media_locations` | one row per provider copy (`UNIQUE(object_id, provider)`): `provider` (`local` `b2` `r2`), `bucket`, `key` (absolute path for local, object key for B2/R2), `storage_class` (`hot` local, `cold` B2, `cache` R2), `state`, `checksum`, `size_bytes`, `verified_at` |
| `media_relationships` | `from_object_id`, `relation`, `to_object_id`, `metadata`. In use: `clip_of` (clip to vod, with start/end), `thumbnail_of` (thumbnail to vod/clip). Reserved: `derived_from`, `screenshot_of` |
| `media_variants` | `object_id`, `variant_name`, `derived_object_id`, `recipe`. In use: `thumbnail` |
| `media_jobs` | generic derivative/maintenance jobs (`job_type`, `status`, `attempts`, `checkpoint`, `error`). **Schema only in this pass:** nothing enqueues or consumes jobs yet |
| `media_holds` | retention holds, see [Holds](#retention-holds) |
| `media_invariant_violations` | public playback objects over the size policy, see [Invariant](#public-object-size-invariant) |

Location `state`:

- `present`: verified. The local file exists, or a HEAD answered with the right size.
- `missing`: verified absent.
- `pending`: believed there but not verified yet. Every remote copy starts here until reconciliation runs with `--verify`.
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
| POST | `/` | init. `{ kind, visibility (default private), mime_type, size_bytes, filename, content_hash (expected sha256), metadata (≤ 16 KB), user_id }` returns 201 `{ id, object, upload: { method: 'PUT', url, token, expires_at, max_bytes, complete_url } }`. Checks at init: `size_bytes` against `MEDIA_OBJECT_MAX_MB` (413), the quota including reservations (413 `media.quota.exceeded`), and the public-size invariant (422) |
| PUT | `/:id/content` | the bytes, single part. Auth is the upload token (`?token=` from init, or `X-Upload-Token`) or the usual credential. Streams to disk computing sha256. Refuses more than the declared size or the limit (413), a size mismatch (400) and quota overrun (413). Stored at `OBJECTS_PATH/<app>/<id>` with a verified local location. Mounted ahead of the JSON body parser, so any Content-Type is taken as raw bytes; the Content-Type becomes `mime_type` when init set none. Can be repeated while the object is `uploading` |
| POST | `/:id/complete` | checks the expected hash (422 `media.object.hash_mismatch`), the invariant and the quota. Sets `ready` and sends the `media.object.uploaded` webhook. Also accepts the upload token |
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

**Signing.** HMAC-SHA256 over the purpose (`get` or `put`), the object id and the expiry, keyed with
`MEDIA_SIGNING_SECRET`. A download signature cannot be used as an upload token, or the other way
round. Without the secret, a random per-process secret is used and a warning is logged, so links
stop working at the next restart. **Set `MEDIA_SIGNING_SECRET` in production.**

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

**Not covered yet:** orphan *provider* objects (bucket keys with no row, which needs bucket
listing) and incomplete multipart uploads. `server/objects/reconcile.js` takes a `head` function,
so tests run it against a fake provider.

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

**Nothing is re-encoded in this pass.** Most whole-stream VODs are far above 500 MB. They will show
up as violations until the segment-native model lands (roadmap W4 deliverable 7, capture in W7),
which splits playback into objects that fit.

## Configuration

| env | default | meaning |
|---|---|---|
| `OBJECTS_PATH` | `./data/objects` | native object bytes (`<app>/<id>`, `.tmp/` while uploading) |
| `MEDIA_OBJECT_MAX_MB` | 256 | single-part upload limit |
| `MEDIA_DELETE_RETENTION_DAYS` | 30 | soft-deleted native bytes are kept this long |
| `MEDIA_SIGNING_SECRET` | *(random per process)* | HMAC key for signed URLs and upload tokens |
| `MEDIA_SIGNED_URL_TTL_S` | 300 | default signed download lifetime |
| `MEDIA_UPLOAD_TOKEN_TTL_S` | 3600 | upload token lifetime |
| `MEDIA_PUBLIC_OBJECT_{MAX,TARGET,WARN}_MB` | 500 / 256 / 384 | invariant thresholds |

## Not in this pass

- Multipart uploads and presigned direct-to-bucket uploads. Native bytes are stored locally.
- Tiering of native objects to B2/R2.
- Copy/move aliases, lifecycle rules and an S3-compatible façade.
- A `media_jobs` worker.
- Orphan-bucket-object and incomplete-multipart detection.
- The segment-native timeline.
- App assets (emotes and sounds, the `assets` table) are not projected yet. The `asset` kind exists for v2 uploads.
