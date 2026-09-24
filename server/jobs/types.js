/**
 * OpenVibe.Media — the job types the worker runs (docs/object-model.md#jobs).
 *
 *   thumbnail.regenerate   light   the thumbnail (re)generation the v1 thumbnail route used to do inline
 *   invariant.scan         light   the size-invariant validator: proposes object.split / object.remux
 *   object.split           heavy   stream-copy parts of a large vod/clip as new private objects
 *   object.remux           heavy   a stream-copy remux of a vod/clip as a new private object
 *   vod.finalize           finalize  finalize a recording whose finalize failed or never ran (orphans), with backoff
 *   vod.duration.reconcile heavy   stored VOD durations vs a measurement of the real file (local or B2/R2), one batch
 */
'use strict';

const queue = require('./queue');

queue.register('thumbnail.regenerate', require('./thumbnail').spec);
queue.register('invariant.scan', require('./invariant-scan').spec);
queue.register('object.split', require('./derive').split);
queue.register('object.remux', require('./derive').remux);
queue.register('vod.finalize', require('./vod-finalize').spec);
queue.register('vod.duration.reconcile', require('./duration-reconcile').spec);

module.exports = { names: () => queue.typeNames() };
