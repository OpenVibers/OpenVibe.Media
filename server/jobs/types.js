/**
 * OpenVibe.Media — the job types the worker runs (docs/object-model.md#jobs).
 *
 *   thumbnail.regenerate   light   the thumbnail (re)generation the v1 thumbnail route used to do inline
 *   invariant.scan         light   the size-invariant validator: proposes object.split / object.remux
 *   object.split           heavy   stream-copy parts of a large vod/clip as new private objects
 *   object.remux           heavy   a stream-copy remux of a vod/clip as a new private object
 */
'use strict';

const queue = require('./queue');

queue.register('thumbnail.regenerate', require('./thumbnail').spec);
queue.register('invariant.scan', require('./invariant-scan').spec);
queue.register('object.split', require('./derive').split);
queue.register('object.remux', require('./derive').remux);

module.exports = { names: () => queue.typeNames() };
