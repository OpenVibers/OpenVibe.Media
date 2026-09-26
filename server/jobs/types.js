/**
 * OpenVibe.Media — the job types the worker runs (docs/object-model.md#jobs).
 *
 *   thumbnail.regenerate   light   the thumbnail (re)generation the v1 thumbnail route used to do inline
 *   invariant.scan         light   the size-invariant validator: proposes object.split / object.remux
 *   object.split           heavy   stream-copy parts of a large vod/clip as new private objects
 *   object.remux           heavy   a stream-copy remux of a vod/clip as a new private object
 *   object.waveform        heavy   the audio waveform (PNG) of a vod/clip as the source's `waveform` variant
 *   object.sprite          heavy   a seek-preview sprite sheet (JPEG, layout in its metadata) as the `sprite` variant
 *   vod.finalize           finalize  finalize a recording whose finalize failed or never ran (orphans), with backoff
 *   clip.cut               clips   cut (or re-cut) a clip row from its VOD; retries with backoff (server/vod/clip-jobs.js)
 *   vod.duration.reconcile heavy   stored VOD durations vs a measurement of the real file (local or B2/R2), one batch
 *   object.hash            light   sha256 of local copies with no content hash yet, one bounded batch (or one object)
 *   storage.orphans.scan   light   the storage orphan report, service-wide (report only; never deletes)
 */
'use strict';

const queue = require('./queue');

queue.register('thumbnail.regenerate', require('./thumbnail').spec);
queue.register('invariant.scan', require('./invariant-scan').spec);
queue.register('object.split', require('./derive').split);
queue.register('object.remux', require('./derive').remux);
queue.register('object.waveform', require('./previews').waveform);
queue.register('object.sprite', require('./previews').sprite);
queue.register('vod.finalize', require('./vod-finalize').spec);
queue.register('clip.cut', require('../vod/clip-jobs').spec);
queue.register('vod.duration.reconcile', require('./duration-reconcile').spec);
queue.register('object.hash', require('./content-hash').spec);
queue.register('storage.orphans.scan', require('./storage-orphans').spec);

module.exports = { names: () => queue.typeNames() };
