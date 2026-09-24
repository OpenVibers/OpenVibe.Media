'use strict';
// POST /api/v1/:app/vods/:id/ingest/rtmp makes ffmpeg connect to the URL it is given, so it is an SSRF
// vector. The recorder only pulls from allow-listed RTMP servers (MEDIA_RTMP_PULL_ALLOW, default
// Live's on this host: 127.0.0.1 / localhost / [::1] port 1935), with a strict URL shape that a URL
// parser and ffmpeg cannot read differently. Refused URLs answer 400 and start nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-rtmp-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
Object.assign(process.env, {
    DB_PATH: path.join(tmp, 'media.db'), VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
    THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'),
});
delete process.env.MEDIA_RTMP_PULL_ALLOW;

const config = require('../server/config');
const recorder = require('../server/vod/recorder');
const { checkRtmpUrl } = recorder;

assert.deepStrictEqual(config.rtmpPull.allow, ['127.0.0.1:1935', 'localhost:1935', '[::1]:1935'], 'default: Live\'s RTMP server on this host');

// ── 1. The allow-list and the URL shape ──
for (const ok of ['rtmp://127.0.0.1:1935/live/abc123', 'rtmp://localhost:1935/live/Key_9-x', 'rtmp://127.0.0.1/live/k', 'rtmp://[::1]:1935/live/k',
    'RTMP://127.0.0.1:1935/live/k', 'rtmp://127.0.0.1:1935/live/k?token=a%2Fb&x=1']) {
    assert.ok(checkRtmpUrl(ok).ok, `allowed: ${ok}`);
}
assert.deepStrictEqual([checkRtmpUrl('rtmp://127.0.0.1/live/k').host, checkRtmpUrl('rtmp://127.0.0.1/live/k').port], ['127.0.0.1', 1935], 'no port = 1935');
assert.strictEqual(checkRtmpUrl('RTMP://127.0.0.1:1935/live/K').url, 'rtmp://127.0.0.1:1935/live/K', 'ffmpeg gets a lower-case scheme');
const refused = [
    'rtmp://10.0.0.5:1935/live/k',                  // another host on the network
    'rtmp://169.254.169.254:80/latest/meta-data',   // cloud metadata
    'rtmp://127.0.0.1:22/x',                        // a local port that is not the RTMP server
    'rtmp://127.0.0.1:4100/x',                      // Media itself
    'rtmp://evil.example/live',
    'rtmp://user:pass@127.0.0.1:1935/x',            // user info
    'rtmp://127.0.0.1:1935@evil.example/x',         // parser differential
    'rtmp://127.0.0.1:1935\\@evil.example/x',
    'rtmp://127.0.0.1:1935/live/k -i file:///etc/passwd',
    'rtmp://127.0.0.1:1935/x\r\nfoo',
    'rtmp://0x7f.0.0.1:1935/x',                     // alternative spellings of loopback are not on the list
    'rtmp://127.1:1935/x',
    'rtmps://127.0.0.1/x',                          // 443 is not the RTMP server
    'rtmpt://127.0.0.1:1935/x', 'http://127.0.0.1:1935/', 'file:///etc/passwd', 'concat:rtmp://127.0.0.1:1935/x', '', null, 42,
    `rtmp://127.0.0.1:1935/${'a'.repeat(3000)}`,
];
for (const bad of refused) assert.strictEqual(checkRtmpUrl(bad).ok, false, `refused: ${JSON.stringify(bad)}`);
assert.ok(/not an allowed RTMP ingest/.test(checkRtmpUrl('rtmp://10.0.0.5:1935/live/k').error));
assert.ok(checkRtmpUrl('rtmp://ingest.openre.stream:1936/live/k', ['ingest.openre.stream:1936']).ok, 'the list is configuration (OpenRe on 1936, say)');
console.log('✅ only allow-listed host:port pairs with a plain URL shape pass');

(async () => {
    // ── 2. The recorder and the route refuse before anything starts ──
    const db = require('../server/db/database');
    db.upsertApp({ app_id: 'live', api_key: 'live-key-rtmp-test' });
    const vodId = Number(db.createVod({ app_id: 'live', title: 'x' }).lastInsertRowid);
    const r = recorder.startRtmp(db.getVodById(vodId), 'rtmp://10.0.0.5:1935/live/k');
    assert.deepStrictEqual([r.ok, r.status], [false, 400]);
    assert.strictEqual(recorder.activeCount(), 0, 'no ffmpeg was started');
    assert.strictEqual(db.getVodById(vodId).is_recording, 0);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/:app/vods', require('../server/vod/routes'));
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const post = (p, body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer live-key-rtmp-test' } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
        req.on('error', reject);
        req.end(data);
    });
    for (const url of ['rtmp://169.254.169.254:80/x', 'rtmp://127.0.0.1:1935@evil.example/x', 'file:///etc/passwd']) {
        const res = await post(`/api/v1/live/vods/${vodId}/ingest/rtmp`, { rtmp_url: url });
        assert.strictEqual(res.status, 400, `${url} → ${res.status}`);
    }
    assert.strictEqual(recorder.activeCount(), 0);
    server.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('✅ POST …/ingest/rtmp answers 400 for a URL off the list, and starts no ffmpeg');
    console.log('\n✅ All RTMP allow-list tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
