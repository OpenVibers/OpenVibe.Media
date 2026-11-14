# Composer attachments (composer.attachment@1)

One person's file, stored before it is sent, so every site's composer attaches the same way. Media owns the
bytes and the answer; a site keeps the attachment with the message it belongs to.

    POST   /api/v1/attachments               multipart field `file` -> composer.attachment@1
    POST   /api/v1/attachments/import        { url } -> one remote picture, brought in (a service token)
    GET    /api/v1/attachments/:id           the person (or a service naming them) asks where it stands
    POST   /api/v1/attachments/:id/keep      { message_id } -> kept with that message (its owner only)
    DELETE /api/v1/attachments/:id           the person who uploaded it -> 204
    GET    /a/:id/:name                      the bytes (public, unguessable id)
    GET    /a/:id/thumb.jpg                  the preview (an image's own copy, a video's first frame)
    GET    /a/:id/playback.mp4               the web copy of a video (when one was made)

Credentials: the person's own Network token (the browser), or a first-party service token holding
`media.object.upload` (or `media.object.read` for the read) with the person named in `X-OV-Subject` (a
site's server). A service may only read or keep the attachments of the person it names: another person's
attachment is a 404, exactly like one that does not exist. A service may also keep the attachments **it brought
in itself** (see the import below) without naming a person: the picture belongs to the service that fetched it.
Nobody else may keep an attachment.

Limits: image 20 MB, video 300 MB, audio 50 MB, anything else 25 MB (code included). An unkept attachment
expires 24 hours after upload; a keep names the message it belongs to and moves it to the kept window
(30 days). The CORS allow-list is every first-party origin (server/attachments/origins.js); the bytes route
is public.

## The kept window

A keep moves the attachment out of its 24-hour life into the kept window: **30 days**
(`MEDIA_ATTACHMENT_KEEP_DAYS`) from that keep, and every later keep moves it out again. The picture is
therefore kept for as long as a message shows it: a card whose picture was brought in for one message keeps it
with that message, and a second message that shows the same picture keeps it again.

A picture may be shown by more than one message, and all of them are written down: `media_attachment_keeps`
holds one row per (attachment, message), and the answer names them (`kept_for`).

After the window passes, the expiry sweep deletes the row and the bytes with it. The card that showed the
picture does not break: it keeps its title, its description and its link, and the page drops the picture that
does not load.

## The answer

```json
{
  "id": "att_01JZ0M0Q8F3K2V7YB6N4T5R9WQX",
  "kind": "video",
  "name": "7224.mp4",
  "size": 24819344,
  "mime": "video/mp4",
  "url": "https://openvibe.media/a/att_01JZ0M0Q8F3K2V7YB6N4T5R9WQX/7224.mp4",
  "thumb": "https://openvibe.media/a/att_01JZ0M0Q8F3K2V7YB6N4T5R9WQX/thumb.jpg",
  "poster": "https://openvibe.media/a/att_01JZ0M0Q8F3K2V7YB6N4T5R9WQX/thumb.jpg",
  "w": 1920, "h": 1080,
  "width": 1920, "height": 1080,
  "duration_s": 73.4,
  "playback": { "url": "https://openvibe.media/a/att_01JZ0M0Q8F3K2V7YB6N4T5R9WQX/7224.mp4", "mime": "video/mp4", "ready": true },
  "status": "ready",
  "reason": null,
  "expires_at": "2026-11-14T12:13:00.000Z"
}
```

* `kind` is sniffed from the bytes, never taken from the browser: image, video, audio, file or code.
  An executable is refused at upload (415).
* `playback` names what plays it: the original's `url` when a browser can play it as it is, the copy's
  `url` once it is made, and `ready: false` while the copy is being made. A picture has no playback
  (`null`).
* `duration_s`, `width` and `height` are the video's own facts; the size is the one shown (the rotation
  applied).
* `poster` is the first frame (the same bytes as `thumb`).
* `status` is `ready`, `processing` (the copy is being made) or `failed` (it could not be made; `reason`
  says why). The original is never touched: a failed copy keeps the file as it was uploaded.
* `GET /api/v1/attachments/:id` answers the same shape, with the state as it is now.
* `message_id` and `kept_at` are the message the attachment is kept with and when it was kept (null while
  it is unkept); a keep answers `kept_for`, the messages it is kept with.

## One remote picture, brought in

A picture that lives on somebody else's host is fetched once, by Media, and kept here: a site's server (a
first-party service token with `media.object.upload`) posts the address to

    POST /api/v1/attachments/import   { "url": "https://…/picture.png" }

and Media answers with the same shape as an upload (`id`, `kind`, `mime`, `url`, `thumb`, `w`, `h`,
`expires_at`). The bytes are served from `openvibe.media`, never from the other host.

The fetch is the guarded one (server/avatars/ingest.js): https only, no credentials in the address, the port
must be 443, at most three redirects with every hop checked again, the name resolved first and refused when
any address is private, loopback, link-local, CGNAT or otherwise not public, and the connection pinned to the
address that was checked (so a name that changes its answer between the check and the connect cannot reach
an internal service). At most 2 MB, images only: a body that is not a picture is refused (415), and one that
is larger is refused (422). A service that names no person in `X-OV-Subject` may still import: the row then
belongs to the service (`svc:…`).

The picture is kept like any attachment that was never sent to a message: it is unlisted (the id is
unguessable and it is in no listing) and it expires 24 hours after it was brought in.

The row belongs to the service that brought the picture in (`svc:…`), so that service may keep it with the
message it shows under (`POST /api/v1/attachments/:id/keep`, `{ "message_id": "…" }`) and the picture then
lives in the kept window (30 days) instead of the 24-hour one. Another service, and any person, may not keep
it: for them it is a 404, exactly like an attachment that does not exist.

## The sniffer's table

The bytes decide the kind and the type (server/objects/content-type.js). The type is the real one, so a
browser and a server agree on what the file is.

| Bytes | Container | Type |
|---|---|---|
| `FF D8 FF` | JPEG | image/jpeg |
| `89 PNG` | PNG | image/png |
| `GIF87a`/`GIF89a` | GIF | image/gif |
| `RIFF….WEBP` | WebP | image/webp |
| `BM` | BMP | image/bmp |
| `ftyp avif/heic/mif1` | HEIF | image/heic, image/avif |
| `ftyp isom/mp42/avc1…` | MP4 | video/mp4 |
| `ftyp qt  ` | QuickTime | video/quicktime |
| `ftyp M4V ` | M4V | video/x-m4v |
| `ftyp 3gp…` | 3GP | video/3gpp |
| `ftyp 3g2…` | 3G2 | video/3gpp2 |
| `1A 45 DF A3` + DocType `matroska` | Matroska | video/x-matroska |
| `1A 45 DF A3` + DocType `webm` | WebM | video/webm |
| `OggS` | Ogg | video/ogg, audio/ogg |
| `RIFF….AVI ` | AVI | video/x-msvideo |
| `30 26 B2 75…` | ASF/WMV | video/x-ms-asf |
| `FLV` | FLV | video/x-flv |
| `00 00 01 BA` | MPEG-PS | video/mpeg |
| `47 … 47` (188 bytes apart) | MPEG-TS | video/mp2t |
| `RIFF….WAVE` | WAV | audio/wav |
| `fLaC` | FLAC | audio/flac |
| `ID3`/`FF Ex` | MP3 | audio/mpeg |
| `ftyp M4A ` | M4A | audio/mp4 |
| `%PDF-` | PDF | application/pdf |

## The web-safe rule

A video plays as it is when all of this is true (server/attachments/playback.js):

* the container is **MP4** or **WebM**;
* the video is **H.264**, **VP8**, **VP9** or **AV1**;
* the audio is **AAC**, **Opus** or **Vorbis**, or there is no audio;
* an MP4 has its **moov atom first** (faststart): the index at the end means the player has to fetch the
  whole file before it can start.

Anything else gets a **web copy** made in the background by the `attachment.playback` job: H.264
(yuv420p) + AAC in an MP4 with the index first, at most **1080 lines tall**, the source frame rate up to
**60**, the rotation applied. The copy runs inside the transcode budget the CMAF job uses
(`transcodeBudgetMs`), and a video longer than `MEDIA_ATTACHMENT_PLAYBACK_MAX_SECONDS` (4 hours by
default) is refused as too long: the attachment says so (`status: "failed"`, the reason) and keeps the
original.

The job is `attachment.playback` (the `playback` lane, `MEDIA_JOBS_PLAYBACK_CONCURRENCY`), and it is off
with `MEDIA_ATTACHMENT_PLAYBACK_ENABLED=0`.
