# Recordings: one video per stream, however it was stored

Owner, 2026-10-27: "instead of having it list like 'The stream was recorded in 2 parts: Part 1 (this one) · Part 2' it
should automatically just have them as a single vod … appears to users like it's one big vod that seeks just fine but
behind the scenes it has this smart chunked / multi file system … available and shared for other things across our
network … be aware of server storage … scalable … also consider how we can implement this into our sdk/api", and "it
needs to combine 'clips from this stream' across all the vods", and on clipping: "the system used for clipping videos and
clipping active live streams across the different services [should be] shared / multi purpose / intelligent".

This is the design of record for that. It builds on the [Media Fabric](media-fabric.md), whose segment-native video
already does most of the storage side: CMAF segments, the timeline index, ~60 s packed chunks, virtual and materialized
clips, and the placement engine. What it adds is the **recording**: one playable video over any number of stored parts.

## 1. How it works today (review, 2026-10-27)

**What is stored.** Live's recorder writes one VOD per *recording session*. A broadcaster who drops and comes back gets
a second VOD for the same stream: BIRD DRAMA (stream 2795) is VOD 6025 (0–11:17) and VOD 6026 (11:21–43:18). A recorder
restart or a deploy does the same. After finalize, `object.cmaf` cuts each VOD's file into a CMAF timeline: 175 rows for
6025 and 487 for 6026. `object.pack` packs those into ~60 s chunks: 11 and 31 objects. The picture turning (portrait ↔
landscape) is already *not* a new VOD: it is a new shape period inside one timeline (Media#182).

**What people see.**
- openvibe.video shows two watch pages and two cards. Each has its own transcript, chapters, chat replay, downloads,
  view count, comments thread and AI overview, and an "About" line linking the other part (MediaHub#143).
- Live's channel lists both VODs.
- Seeking stops at a part's end. The player jumps to the next part at the end (Live#380), but the scrubber never covers
  the whole stream.
- Clips are already gathered per stream: Live lists them by `stream_id`. A clip's times are in its part's time, though,
  and a clip cannot cross the join.
- AI analysis, transcripts, moments and auto-clips all run per part.

**Clipping today: five ways in, two engines.**

| where | how | engine |
|---|---|---|
| Live player, the Clip button while live | Live `POST /api/vods/clips` `{ stream_id, live: true, at, duration }` | Media cuts from the active recording's file |
| Live studio (broadcaster), "Clip that" | the same, with `stream_time: true` (Live#379) | the same, placed on the right part through stream history |
| Live player, rewinding (DVR) | the same, with `stream_time` | the same |
| openvibe.video, Clip menu | MediaHub → Live `POST /api/vods/clips` `{ vod_id, start_time, end_time }` | a virtual clip when the VOD has a timeline, else `clip.cut` |
| auto-clips (chat spikes live, AI moments after) | Live's auto-clip job → Media | the same two |
| uploaded clip (old client) | the browser's own recording, uploaded | a file |

**AI titles.** A clip with no title gets Live's placeholder "Clip: <stream title>". Live's `clip-title` job renames it from
the clip's AI overview, once the clip's own analysis has run. The live auto-clip path writes an AI title through
`publicTitle`. The weak spots, from production on 2026-10-27:
- Clips whose analysis failed are never named. Clips 494, 497 and 498 are still "Clip: Seattle".
- The VOD auto-clip path keeps a frame-caption fallback as a final title: "A Person Is Standing In A Living Room,
  Facing".
- A clip of an upload (no stream) keeps "Clip: <video title>", because the placeholder check only knows stream titles.

## 2. The model

A **recording** is one video made of ordered **parts**. Every part is an ordinary stored video object with its own
timeline: Live's VOD of a session, a rolled-over file, an uploaded file. The recording is a **virtual object**. Its
timeline is the parts' rows joined end to end, so no byte is copied, moved or re-encoded to make it.

```
media_recordings        id rec_…, app_id, group_key (the app's own key: "stream:2795"), vod_id/object_id (the
                        recording's own VOD row and object: its public /v/<id>), state open|closed
media_recording_parts   recording_id, seq, vod_id, object_id, gap_before_ms (wall time not recorded before it)
```

**Playback.** `timeline.joinRows(parts)` builds the recording's rows from the parts' rows. Part k's media segments keep
their bytes (key, local path, packed chunk and byte range) and get:
- times shifted by the parts before it;
- names prefixed `p<k>-`, so names never collide;
- `init_name` `p<k>-init.mp4`, or `p<k>-init-<n>.mp4` for a shape period.

`mediaPlaylist()` already writes `#EXT-X-DISCONTINUITY` + `#EXT-X-MAP` wherever the init changes, so the join is a clean
decoder reset. hls.js and Safari treat it exactly like a shape change, which they already play (VOD 6026). The gap between
parts (4 s for 2795) is not played. Its wall time is kept in `gap_before_ms`, so stream time ↔ recording time stays
exact.

**Time.** Three clocks, and one place that converts them.

| clock | zero | used by |
|---|---|---|
| part time | the part's first frame | Media's files, old clip windows |
| recording time | the recording's first frame, gaps removed | the player, clips, transcripts, chapters, links (`?t=`) |
| stream time | Live's `streams.started_at` | chat replay, live captions, stream history, the Rundown |

`GET /api/v1/:app/recordings/:id` answers the parts with `start_ms` (recording time), `duration_ms`, `gap_before_ms` and,
for Live, `stream_offset_ms`. Every service converts with that one table: Live's `stream-history.js`, MediaHub's chat
replay, the transcript merge.

**Ids.** The recording's VOD row is the one public id: `/v/<id>`, on openvibe.media, openvibe.video and Live.
- A part keeps its id and its own playback, so nothing that linked it breaks.
- Pages redirect a part to the recording at the right second: `/v/6026` → `/v/<recording>?t=681`.
- Lists show recordings, not parts. `include_parts=1` lists the parts too, for staff and tools.

**When a recording forms.** A part is created with the app's group key (Live: `stream:<id>`; any app may send its own).
- **The first part** is the recording, with no new row: one id, nothing new to show.
- **The second part** turns it into a recording. Media creates the recording's VOD row and object, adds both parts, and
  sends `media.recording.updated`.
- **A reconnect window decides "same recording":** a part whose group key matches a recording still `open` joins it. Live
  closes a recording when the stream ends; Mux's equivalent is a 60 s reconnect window, configurable to 30 min.
- **A stream that ends and goes live again** is a new stream, and so a new recording.

**When a part forms (splitting).** A new part is only needed when a session really ends: a disconnect, or a recorder or
host restart. A shape change is a period inside a part. Storage is no reason to split. Packing already makes ~60 s chunk
objects, and the timeline index finds any second without opening a file, so a ten-hour part costs no more to serve than
ten one-hour parts.

One storage rule does cut parts: **rollover**. A part is closed and a new one opened every `MEDIA_PART_MAX_HOURS` (4)
or `MEDIA_PART_MAX_GB` (8). That bounds the work a crash can lose: the unfinalized tail, the DVR copy (Media#162's disk
pressure), and a single remux, upload or move. A rolled part joins the recording like any other, so viewers never see it.

## 3. Storage, cost and scale

- **Bytes are written once.** Joining, clipping and re-cutting are row operations. Locations are content-addressed and
  reference-counted by the rows that name them ([media-fabric §4](media-fabric.md#4-clips-reuse-the-source)).
- **Object count.** Two-second CMAF segments are packed after finalize into ~60 s chunks, about 30× fewer objects, PUTs
  and HEADs. The player reads them with `EXT-X-BYTERANGE`.
  - Byte ranges over one big file are the cheapest for object count, but a CDN may fetch more from the origin than the
    range asked for.
  - Many small files cache best, but cost one operation each.
  - 60 s chunks sit between the two.
- **Tiers** (the placement engine, [media-fabric §6](media-fabric.md#6-placement-one-engine-every-class-down-to-the-segment-bucket)):

  | tier | holds | cost |
  |---|---|---|
  | local NVMe | live, new and hot video | |
  | Cloudflare R2 | what is watched | $0.015/GB-month, $0.36 per million reads, no egress fee |
  | Backblaze B2 | everything durable | about $6.95/TB-month; egress free up to 3× the stored volume, and free through Cloudflare's Bandwidth Alliance |

  For comparison, S3 egress is about $0.09/GB. A recording's parts tier independently, chunk by chunk. A long stream
  whose first hour is never watched keeps that hour on B2 only.
- **Derivatives are caches.**
  - Lower renditions are made on demand (F4).
  - The download MP4 of a whole recording is a lazy remux of its joined playlist, kept like any derivative and
    dropped when cold.
  - When the parts' shapes differ, the download is one MP4 per shape period, offered together in the Download menu,
    because one MP4 track cannot change its picture size.
- **The live DVR copy** (2–3× the recording's size while live, Media#162) is deleted at finalize, once the timeline is
  durable.

## 4. Clips: one system over recordings

A clip is a window over a recording: `{ recording, start_ms, end_ms }`. Every way in becomes the same call:

| way in | what it sends |
|---|---|
| Live player, live | "the last N seconds", resolved to the open recording's live edge |
| Live player, rewinding; Live studio | stream time → recording time (one conversion, §2) |
| openvibe.video | recording time from the player |
| auto-clips | recording time from the moment |
| any app (SDK) | `media.clips.create({ recording, start, end })` |

- **Instant first.** The clip is virtual at once: a manifest over the recording's segments, segment-accurate. This is
  what Mux calls an instant clip and what MediaPackage's harvest does from a live window. It works while the stream is
  still live, because the open recording's timeline grows, and it can cross a part boundary: the window simply covers
  rows of two parts.
- **Exact when it matters.** A clip that is downloaded, shared outside, or watched past a threshold is materialized:
  only its two edge segments are re-encoded, frame-accurate ([materialized-clips.md](materialized-clips.md)).
- **Named by AI when nobody named it.** The form says so ("Leave empty: AI names it").
  - **Placeholders.** Live's placeholder titles are a closed set, plus "Clip: <the stream's or the video's title>".
  - **Provisional titles.** An auto-clip's title is marked `title_provisional` and is replaced the same way.
  - **When the analysis fails, the name comes from the recording's transcript.** The transcript lines inside the window,
    from the full pass or the live captions, plus the stream's title, go to the same `live.stream.titles` template. A
    clip with no speech and no overview is named "<stream title> at <time>". No clip keeps a placeholder for more than
    one sweep after its window has a transcript.
- **One maker in the UI.** The shared player gets the clip maker: start and end from the current time, the AI-title
  note, and keyboard marks. Live's player, Live's studio and openvibe.video all use it, so it looks and behaves the same.
- **Clips from this stream** are the recording's clips. Their places are drawn on the recording's scrubber.

## 5. Uploads and other apps

- **Big uploads** use Media's existing multipart sessions (`media_uploads`), which are resumable part by part:
  openvibe.video's upload page moves to them. The finished file is cut into a CMAF timeline like a recording part.
  Several files of one event (a camera that splits at 4 GB) are one recording, by group key.
- **Any app can record.** A Space, a Bot robot camera or an OpenRestream session sends parts with its own group key
  and gets the same playback, clips, tiers and AI.

## 6. API, events and SDK

Media (`/api/v1/:app`, tenant token; capability `media.vod.write` for writes, `media.vod.read` for reads):

| route | what |
|---|---|
| `POST /vods` (`recording_key`) | a part, joined to the open recording with that key (Live sends `stream:<id>`) |
| `GET /recordings/:id` | the recording: its VOD row, `duration_ms`, `parts[]` (vod_id, start_ms, duration_ms, gap_before_ms, stream_offset_ms), state |
| `GET /recordings/by-key/:key` | the same by group key |
| `GET /vods/:id/recording` | a part's recording and its place in it (where to redirect, `?t=`) |
| `POST /recordings/:id/close` | no more parts (Live: the stream ended) |
| `POST /recordings/:id/clips` | `{ start_ms, end_ms, title?, materialize? }`: a clip over the recording (§4) |
| public `/o/<recording object>/master.m3u8` | the joined playlist; `/v/<recording vod>` plays it |

Events on OpenVibe.Events: `media.recording.updated` (a part joined, the recording closed, its duration changed).

SDK (`openvibe-sdk/media`): `recordings.get(id | { key })`, `recordings.close(id)`, `recordings.clip(id, { start, end })`,
`recordings.toRecordingTime(parts, streamMs)` and `toStreamTime(…)` (the one conversion, shared), and `vods.create({
recordingKey })`. Contracts: the routes above in `media.json`, and the event in `events.json`.

## 7. Build order

1. **Media: recordings.**
   - Migration `0015_recordings`; `timeline.joinRows`; the recording's VOD row and object.
   - Joined HLS playback; clips over a recording, including across a join.
   - The routes and the event.
   - Existing multi-part streams joined by a backfill script (a dry run first).
2. **Live.**
   - Recorder parts carry `recording_key`, and the recording is closed at stream end.
   - The channel's videos list recordings.
   - The VOD route answers a recording: its transcript, AI state and chat replay over the parts in recording time.
   - Clips are created over recordings.
   - AI titles: provisional titles and the transcript-window fallback.
3. **MediaHub.**
   - A recording's watch page: one player, one transcript, chat replay, chapters and clips on the whole scrubber.
   - Parts redirect to it; downloads offer the recording.
4. **Shared player: the clip maker** (openvibe-shared), used by Live and MediaHub.
5. **SDK and Contracts.**
6. **Rollover and uploads.**
   - Live's recorder rolls parts at the limits.
   - openvibe.video uploads use multipart sessions.

Research behind the choices (2026-10-27):
- Mux's [reconnect windows](https://www.mux.com/docs/guides/handle-live-stream-disconnects) (one asset across
  reconnects, 60 s default, up to 1800 s) and [instant clips](https://www.mux.com/docs/guides/create-instant-clips)
  (trimmed manifests, segment-accurate, no re-encode);
- AWS MediaPackage [live-to-VOD harvest jobs](https://docs.aws.amazon.com/mediapackage/latest/ug/ltov.html) (clips from
  the live window, segment-accurate);
- R2, B2 and S3 prices ([R2 vs S3 vs B2](https://mecanik.dev/en/posts/cloudflare-r2-pricing-explained-real-costs-vs-s3-and-backblaze/),
  [B2 pricing](https://www.backblaze.com/cloud-storage/pricing));
- byte-range against segment-file trade-offs for HLS
  ([single-file HLS](https://command-tab.com/2026/08/14/single-file-http-live-streaming/));
- `EXT-X-DISCONTINUITY` + `EXT-X-MAP` for joining parts
  ([the discontinuity tag](https://www.forasoft.com/learn/video-streaming/glossary/terms-streaming/discontinuity-tag)).
