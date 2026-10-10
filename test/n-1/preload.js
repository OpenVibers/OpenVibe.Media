'use strict';
/**
 * Loaded with `node -r` into a release booted by test/n-1/service.js (N-1 at record time, N in the
 * test), from that release's directory:
 * The restore-drill sandbox (MEDIA_DRILL: no outbound connection, program, listener or timer) is
 * kept, but its read-only guard is lifted, so the old client's writes reach their routes.
 */
const path = require('path');

const cwd = process.cwd();
const drill = require(path.join(cwd, 'server', 'drill'));
drill.readOnly = (req, res, next) => next();
