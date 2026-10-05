# Materialized clips over the source's bytes (F3.6, design)

**Status:** design, 2026-10-05 (plan T4, `docs/media-fabric.md` §4 "Materialized clip"). It replaces the full
re-encode of `clip.cut` (`server/vod/clip-cutter.js`, libvpx at about 3.3× realtime) with a clip whose interior
segments **name the source's bytes** and whose two edges are re-encoded. It depends on F3.4 (PR #35, merged
2026-10-05): any number of objects may name one location, a location's bytes are deleted only when no row of any
object names it, and `removeObject` deletes its rows first and checks `isNamed` after commit.

## What a materialized clip is

A clip object with **its own persisted `media_timeline` rows** for the `source` rendition. Media already plays an
object from its own rows when it has them (`objects/routes.js` `timelineOf`), and a virtual clip from `clipRows` over
its source when it has none.

For a window `[start, end)` over the source's media segments:

| part | rows | bytes |
|---|---|---|
| **interior** | every source segment wholly inside the window, `seq` renumbered from the clip's first, times made relative to `start` | the source's location (`key`/`local_path`/`durable_provider`, `packed_object_id`/`byte_offset`/`byte_length`) and `sha256`, copied: no bytes are written |
| **head edge** | the source segment containing `start`, when `start` is more than 100 ms after its start | re-encoded `[start, segment end)` into a new segment that begins on a keyframe, stored under the clip's own key prefix |
| **tail edge** | the source segment containing `end`, when `end` is more than 100 ms before its end | re-encoded `[segment start, end)` likewise |
| **init** | the source's `seq 0` init for the interior; one init per re-encoded edge | the interior init is the source's location; each edge init is the clip's own |

When an edge falls within 100 ms of a segment boundary it is not re-encoded: the clip starts or ends on that boundary
(a lossless clip, like a virtual one, but persisted).

### Why the edges get their own init

The source's segments are a **stream copy** of the broadcaster's encoding (`server/jobs/cmaf.js` runs `ffmpeg -c copy`),
so their codec parameters (H.264 SPS/PPS, resolution, profile) are whatever the encoder sent. A re-encoded edge cannot be
made to share the source's init byte for byte. Each edge therefore carries its own init, and the playlist switches
inits at the boundary with `#EXT-X-DISCONTINUITY` and a new `#EXT-X-MAP` (valid for the `#EXT-X-VERSION:7` playlists
Media writes; `EXT-X-MAP` needs v5+).

## Schema (one migration)

- `ALTER TABLE media_timeline ADD COLUMN IF NOT EXISTS init_name text`: the name of the init row a media segment decodes
  with. `NULL` keeps today's meaning (the rendition's `seq 0` init), so every existing row is unchanged.
- Edge inits are rows of the clip's rendition with **negative `seq`** (`-1` head, `-2` tail) named `init-head.mp4` /
  `init-tail.mp4`. `migrations/0002_media_timeline.sql` declares `seq … CHECK (seq >= 0)`: the migration replaces that
  constraint with `CHECK (seq >= 0 OR name IN ('init-head.mp4', 'init-tail.mp4'))`. The primary key
  `(object_id, rendition, seq)` already allows the two distinct negative values; it needs no change.

Every reader that assumes `seq 0` is the only init must handle the edge inits:

| reader | change |
|---|---|
| `segments()` (`seq > 0`) | none |
| `list()` | returns the edge inits first; callers below |
| `mediaPlaylist` | see Playlist |
| the segment route (`objects/routes.js` `SEGMENT_NAME = /^(init\.mp4\|\d{6,}\.m4s)$/`, name lookup and MIME) | accept `init-head.mp4` / `init-tail.mp4`, and answer every init row (seq ≤ 0) as `video/mp4`, not `video/iso.segment` |
| the sprite job (`jobs/previews.js`: one `initRow = seq 0` prepended to every piece) | pick each segment's init by its `init_name`, falling back to `seq 0` |
| `clipRows` (a virtual clip whose source is itself a materialized clip) | keep the edge init rows a selected segment's `init_name` names, or refuse to build a virtual clip over a clip |
| `replace()` (tail `DELETE … seq > last`) | also delete negative-seq rows not in the new `rows`; the materialized clip's rows are written by the pinning transaction below, not by `replace` |
| pack (F3.3) | packs the clip's own edge segments like any object's; skips local-only edges as it skips other local-only segments |

## Playlist

`timeline.mediaPlaylist(rows)` emits `#EXT-X-MAP` for the first media segment's init (its `init_name`, or `seq 0`), and
before any segment whose init differs from the previous segment's: `#EXT-X-DISCONTINUITY` then
`#EXT-X-MAP:URI="<init name>"`. A playlist with no edge inits is byte-for-byte what it is today.

## The materialize job (`clip.cut`, timeline path)

When `MEDIA_HLS_ENABLED` and the clip's source has a source timeline:

1. Read the source's rows and plan the head, interior and tail from the window.
2. Re-encode each edge from the source segment's bytes (init + segment, read like the sprite job reads them: local copy,
   packed slice, or a 206 ranged GET from the durable copy, sha256 verified) with ffmpeg into one fMP4 segment plus its
   init, starting on a keyframe. Place them like `object.cmaf` places segments (`jobs/cmaf.js`: the durable provider
   when one is configured, else local with the same retry mode), under the clip's own content-addressed keys.
3. **Insert the clip's rows in one transaction that pins the source's rows it names**:
   `SELECT … FROM media_timeline WHERE object_id = <source> AND seq IN (…) FOR SHARE`, and abort (the job retries) when
   any named source row is gone or **any of its location columns differs from the row the plan was built from**
   (`key`, `local_path`, `durable_provider`, `packed_object_id`, `byte_offset`, `byte_length`, `sha256`: the whole
   location, as `timeline.replace`'s `expect` compares, not the sha alone — a pack between the read and the pin keeps
   the sha and moves the bytes into a chunk). With the pin:
   - a source `removeObject` whose row DELETE has not committed waits for the clip's commit; its post-commit
     `isNamed` check then sees the clip's rows and keeps the bytes;
   - one that committed first leaves the clip's locked read without those rows, and the clip aborts;
   - a pack that committed first changes the location columns, and the clip aborts and re-plans from the chunk.
4. Mark the clip ready with its own timeline: `storage_provider` stays `'timeline'` and the clip's metadata gains
   `materialized: true`. `model.js`'s clip projection derives `virtual` from "no file and storage `'timeline'`", which a
   materialized clip also is: keep `virtual: true` in the projection (it means "no location of its own" to readiness,
   `playableSql` and the verify job) and add `materialized: true` beside it. Readiness then counts the clip
   `bytes_verified`/playable as it does a virtual clip, and the verify job keeps skipping it. Emit `clip.ready`; the
   virtual playback keeps working until the commit, as today.

Without a source timeline (or with the flag off), `clip.cut` keeps the full re-encode.

## Downloads

A clip with only a timeline has no file. `GET /c/:id` already 302s a file-less `storage_provider === 'timeline'` clip to
its master playlist; a materialized one does the same.

A downloadable single file cannot be a lossless concat: segments whose SPS/PPS differ cannot share one MP4 sample
description, so `-c copy` across the edges is not decodable. A download therefore **transcodes on demand** — the cost
moves from every clip's creation to the clips someone actually downloads — through `object.remux`, which gains a
timeline input branch (init + segments read from `media_timeline` like the sprite job) when `resolveSource` finds no
file, and caches the result as a §5 derivative. Until then `…/download?format=mp4` answers with the playlist for a
materialized clip rather than queueing a job that cannot read its input.

## Deletion and holds

- Holds still inherit through `clip_of` (`heldSql` / `isHeldRow`); the delete path keeps checking them.
- **Deleting the clip** must call `timeline.removeObject(clip.object_id)` for a `storage_provider === 'timeline'` clip
  with rows of its own: today the clip DELETE route calls `deleteVodObjects` only when `storage_key` is set, and
  `deleteVodObjects` returns early without a `file_path`. `removeObject` then deletes the clip's edge bytes and only
  the interior locations no other row names.
- **Deleting the source** keeps every location a clip names (F3.4); the clip stays playable.

## Tests (the implementation PR)

- A 30 s window over a packed source: interior rows name the source's chunk bytes, exactly two segments are
  re-encoded, the playlist carries two discontinuities with the right maps, and every segment and edge init serves
  through `/o/<clip>/source/<name>` with the right MIME.
- A browser check (hls.js, pinned minimum version) plays across both discontinuities and switches init at each.
- Edges within 100 ms of a boundary are not re-encoded.
- Deleting the clip leaves the source's bytes; deleting the source leaves the clip playable; a source removal racing
  the clip's insert either aborts the insert or keeps the bytes; a pack racing it aborts and re-plans.
- Readiness counts the clip playable and the verify job skips it; sprites of a materialized clip decode its edges with
  their own inits.
- A source without a timeline still gets the full re-encode.
