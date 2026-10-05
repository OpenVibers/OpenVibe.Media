# Materialized clips over the source's bytes (F3.6, design)

**Status:** design, 2026-10-05 (plan T4, `docs/media-fabric.md` §4 "Materialized clip"). It replaces the full
re-encode of `clip.cut` (`server/vod/clip-cutter.js`, libvpx at about 3.3× realtime) with a clip whose interior
segments **name the source's bytes** and whose two edges are re-encoded. The reference rule it depends on shipped in
F3.4 (PR #35): any number of objects may name one location, and a location's bytes are deleted only when no row of any
object names it.

## What a materialized clip is

A clip object with **its own persisted `media_timeline` rows** for the `source` rendition. Media already serves an
object from its own rows when it has them (`objects/routes.js` `timelineOf`), and a virtual clip from `clipRows` over
its source when it has none, so serving needs no new route.

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
inits at the boundary with `#EXT-X-DISCONTINUITY` and a new `#EXT-X-MAP`, which HLS (v7+) and hls.js support.

## Schema (one additive migration)

- `media_timeline.init_name text NULL`: the name of the init row a media segment decodes with. `NULL` keeps today's
  meaning (the rendition's `seq 0` init), so every existing row is unchanged.
- Edge inits are rows of the clip's rendition with **negative `seq`** (`-1` head, `-2` tail) and names `init-head.mp4` /
  `init-tail.mp4`. `segments()` (`seq > 0`) and everything that reads only media segments are unaffected;
  `list()` returns them first. Every reader of `list()` that assumes `seq 0` is the only init (pack, sprites,
  `mediaPlaylist`, `clipRows`, the segment route's name lookup) must be checked and, where needed, filter `seq < 0`.

## Playlist

`timeline.mediaPlaylist(rows)` emits `#EXT-X-MAP` for the first media segment's init (its `init_name`, or `seq 0`), and
before any segment whose init differs from the previous segment's: `#EXT-X-DISCONTINUITY` then
`#EXT-X-MAP:URI="<init name>"`. A playlist with no edge inits is byte-for-byte what it is today.

## The materialize job (`clip.cut`, timeline path)

When `MEDIA_HLS_ENABLED` and the clip's source has a source timeline:

1. Read the source's rows and plan the head, interior and tail from the window.
2. Re-encode each edge from the source segment's bytes (init + segment, read like the sprite job reads them: local copy,
   packed slice, or a 206 ranged GET from the durable copy, sha256 verified) with ffmpeg into one fMP4 segment plus its
   init, starting on a keyframe; upload/place them like `object.cmaf` does (the clip's own content-addressed keys).
3. **Insert the clip's rows in one transaction that pins the source's rows it names**:
   `SELECT … FROM media_timeline WHERE object_id = <source> AND seq IN (…) FOR SHARE`, and abort (retry later) when any
   named source row is gone or its `sha256` differs. `FOR SHARE` makes a concurrent `removeObject(source)` wait for the
   clip's commit; its post-commit `isNamed` check then sees the clip's rows and keeps the bytes. Without the pin, a source
   removal that deletes its rows between the clip's read and insert could delete bytes the new clip names.
4. Mark the clip ready with its own timeline (`storage_provider` stays `'timeline'`, `virtual` metadata false,
   `materialized: true`), emit `clip.ready`, and keep the virtual playback working until the commit (as today).

Without a source timeline (or with the flag off), `clip.cut` keeps the full re-encode.

## Downloads

A clip with only a timeline has no file. `GET /c/:id` already 302s a virtual clip to its master playlist; a
materialized one does the same. A downloadable file is produced on demand by a **remux** job (no re-encode):
`ffmpeg` concatenates the clip's segments (concat demuxer over init + segments, one discontinuity group at a time)
into one MP4, cached as a derivative under §5's rules. Players that cannot handle the parameter change at the
boundaries are why the remux exists; the playlist path never needs it.

## Packing, sprites and deletion

- **Pack** (F3.3) already re-keys every row that names a segment's old location with the same sha (F3.4), so a clip's
  interior rows follow the source into its chunks. Edge segments are the clip's own and pack with the clip.
- **Sprites** read `segmentAt` on the clip's own rows; edge rows decode with their own init (`init_name`).
- **Deleting** the source keeps every location a clip names (F3.4); deleting the clip deletes its edge bytes and only
  the interior locations no other row names.

## Tests (the implementation PR)

- A 30 s window over a packed source: interior rows name the source's chunk bytes, exactly two segments are
  re-encoded, the playlist carries two discontinuities with the right maps, and every segment serves through
  `/o/<clip>/source/<name>`.
- Edges within 100 ms of a boundary are not re-encoded.
- Deleting the clip leaves the source's bytes; deleting the source leaves the clip playable; a source removal racing
  the clip's insert either aborts the insert or keeps the bytes (never both deletes).
- A source without a timeline still gets the full re-encode.
