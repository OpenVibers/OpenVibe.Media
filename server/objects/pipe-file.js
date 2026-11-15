'use strict';
/**
 * A file (or a byte range of it) to a response, and the file closed however the response ends.
 *
 * `fs.createReadStream(…).pipe(res)` alone keeps the file open when the viewer goes away mid-transfer: pipe stops
 * writing but never destroys its source. Video players abort a range request at every seek, so each abandoned slice
 * held a descriptor; once a VOD was offloaded and its local copy deleted, those descriptors kept the deleted bytes on
 * disk (11-15: 4.6 GB of four offloaded VODs on a nearly full disk, after the same leak held 80 GB once before in
 * public/routes.js). Here the stream is destroyed on the response's close, finish or error, and a read error ends
 * the response.
 *
 *   pipeFile(res, file, { start, end }?) → the read stream
 */
const fs = require('fs');

function pipeFile(res, file, opts) {
    const stream = fs.createReadStream(file, opts);
    const done = () => { try { stream.destroy(); } catch { /* already closed */ } };
    res.on('close', done); res.on('finish', done); res.on('error', done);
    stream.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
    stream.pipe(res);
    return stream;
}

module.exports = { pipeFile };
