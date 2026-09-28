#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — one at a time, each in its own process, and
 * fails if any of them fails (openvibe-shared/test-runner).
 *
 *   npm test                   # everything
 *   npm test -- objects jobs   # only files whose name contains one of the words
 *   npm test -- --strict       # a skipped test fails the run too
 *
 * The tests use temp SQLite databases and local servers on random ports. A few need ffmpeg (clip cuts,
 * previews, remux, duration measurement) or a non-loopback interface; without them they print
 * `<label>: skipped (<why>)`, and that file is listed with ○ and not counted as passed.
 */
'use strict';
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 300000, pad: 40, parallel: 1, hide: /^\[DB\] / });
