'use strict';
// A file sent with pipeFile (server/objects/pipe-file.js) is closed when the viewer goes away mid-transfer, as a video
// player does at every seek; plain createReadStream().pipe(res) is not (the control below), which kept offloaded VODs'
// deleted bytes on disk on 11-15. On Linux the descriptor itself is checked in /proc/self/fd.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pipeFile } = require('../server/objects/pipe-file');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pipe-'));
const file = path.join(dir, 'vod.mp4');
fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 7));   // larger than the socket's buffers: the transfer is cut mid-way
const openOnFile = () => {
    try { return fs.readdirSync('/proc/self/fd').filter((fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === file; } catch { return false; } }).length; }
    catch { return null; }   // no /proc (macOS, Windows): the stream's own state is checked
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function abortedTransfer(send) {
    let stream = null;
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); stream = send(res); });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    await new Promise((ok) => {
        const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => {
            res.once('data', () => { req.destroy(); ok(); });   // a seek: the first bytes, then gone
        });
        req.on('error', () => ok());
    });
    for (let i = 0; i < 50 && stream && !stream.destroyed; i++) await settle(20);
    await settle(50);
    server.close();
    return stream;
}

(async () => {
    // The control: a source piped and never destroyed stays open after the viewer has gone.
    const leaked = await abortedTransfer((res) => { const s = fs.createReadStream(file); s.pipe(res); return s; });
    assert.strictEqual(leaked.destroyed, false, 'control: plain pipe leaves the file open (the leak this guards)');

    const fixed = await abortedTransfer((res) => pipeFile(res, file, { start: 0, end: 32 * 1024 * 1024 - 1 }));
    assert.strictEqual(fixed.destroyed, true, 'pipeFile closes the file when the viewer goes away');
    leaked.destroy();
    await settle(100);
    const still = openOnFile();
    if (still !== null) assert.strictEqual(still, 0, `no descriptor left on the file (${still})`);

    // A whole transfer still arrives byte for byte.
    const server = http.createServer((req, res) => { res.writeHead(200); pipeFile(res, file, { start: 0, end: 1023 }); });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const got = await new Promise((ok) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => { const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => ok(Buffer.concat(parts))); }));
    server.close();
    assert.strictEqual(got.length, 1024);
    assert.ok(got.every((b) => b === 7));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('pipe-file: a file is closed when the viewer leaves mid-transfer (plain pipe is not), and a whole range arrives');
})().catch((e) => { console.error(e); process.exit(1); });
