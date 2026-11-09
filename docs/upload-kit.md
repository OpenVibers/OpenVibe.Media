# Resumable uploads for OpenVibe apps

Media's native object API already accepts resumable multipart uploads. Its contract is
`media.upload@1`; `/openapi.json` is built from `openvibe-contracts` and lists the create,
part, status, complete and abort operations. The canonical behavior and limits remain in
[the object model](object-model.md#multipart-uploads).

1. Create an object with `POST /api/v2/:app/objects` and `multipart: true`, a known
   `size_bytes`, and `part_size: 8388608` (8 MiB). The caller needs a service or
   developer-app token with `media.object.upload`. Do not put an app key in browser code.
2. Save the returned `id` and `upload.multipart.upload_id` before sending bytes. The
   `part_url_template` carries a short-lived upload token. Send parts 1 through N to
   the template's URL. Three can run concurrently; failed parts can be retried with
   backoff. Parts may arrive out of order. Every part except the last is exactly the
   session's `part_size`.
3. After a disconnect or reload, fetch
   `GET /api/v2/:app/objects/:id/multipart/:uploadId`. Its `parts`, `missing`, and
   `received_bytes` fields tell the app what Media has stored. Compare the original
   file's size and hashes before resuming. An upload token or a suitable service
   credential can read the session.
4. Complete with `POST /api/v2/:app/objects/:id/multipart/:uploadId/complete`.
   `content_hash` and each part's SHA-256 can be supplied for verification. The
   answer is a ready object. A repeated completion of an already completed upload
   returns that same object. To discard an upload, `DELETE` its session URL.

`openvibe-sdk/media-upload` exposes `createUploadClient({ app, tokenClient })`. Its
`upload(file, { onSession, onProgress })` uses 8 MiB parts and three concurrent
requests; `resume({ objectId, uploadId }, file, { onProgress })` sends only missing or
changed parts. The app is responsible for securely storing a file and its session
reference between page loads. A browser must receive a scoped upload path from its
own app server; Media's v2 create route does not accept a Network user JWT directly.

Progress in a page is `OVUpload.progress(el)` from the pinned
`/shared/ov-upload.js` and `/shared/ov-upload.css`. The SDK also exposes
`ov.ui.progress(el)` as a wrapper. Keep transfer, processing, retry, and done as
distinct states; a completed transfer can still need server processing.
