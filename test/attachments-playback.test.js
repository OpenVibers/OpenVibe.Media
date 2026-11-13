'use strict';
// A video attachment that no browser can play as it is (server/attachments/playback.js,
// server/jobs/attachment-playback.js): the sniffer's table, the web-safe rule, the arguments and the bounds of
// the copy job, and the answer the attachment gives while the copy is being made and once it is ready.
// The parts that need ffmpeg/ffprobe are skipped without them (the table always runs).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('child_process');
const { serviceAuth, ids } = require('openvibe-contracts');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-playback-'));
    process.env.ATTACHMENTS_PATH = path.join(tmp, 'attachments');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    const db = require('../server/db/database');
    const config = require('../server/config');
    const auth = require('../server/auth');
    const routes = require('../server/attachments/routes');
    const ctypes = require('../server/objects/content-type');
    const playback = require('../server/attachments/playback');
    const job = require('../server/jobs/attachment-playback');

    // ── The sniffer's table: every container a person may attach, with the type a browser knows it by ──
    const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + brand)]);
    const ebml = (docType) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x00, 0x00, 0x00, 0x00]), Buffer.from(docType)]);
    const ts = Buffer.alloc(189, 0x47);
    const table = [
        ['mp4', ftyp('isom'), 'video/mp4'],
        ['mov', ftyp('qt  '), 'video/quicktime'],
        ['m4v', ftyp('M4V '), 'video/x-m4v'],
        ['3gp', ftyp('3gp5'), 'video/3gpp'],
        ['3g2', ftyp('3g2a'), 'video/3gpp2'],
        ['matroska', ebml('matroska'), 'video/x-matroska'],
        ['webm', ebml('webm'), 'video/webm'],
        ['avi', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]), 'video/x-msvideo'],
        ['asf', Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]), 'video/x-ms-asf'],
        ['flv', Buffer.from('FLV\x01'), 'video/x-flv'],
        ['mpegts', ts, 'video/mp2t'],
        ['mpegps', Buffer.from([0x00, 0x00, 0x01, 0xba]), 'video/mpeg'],
        ['ogg', Buffer.from('OggS'), 'video/ogg'],
    ];
    for (const [format, head, mime] of table) {
        assert.strictEqual(ctypes.sniff(head).format, format, `${format} is sniffed`);
        const got = routes.classify(head, 'application/octet-stream', 'clip.bin');
        assert.strictEqual(got.kind, 'video', `${format} is a video`);
        assert.strictEqual(got.mime, mime, `${format} keeps its own type`);
    }
    // The pictures and the sound files keep their kinds.
    assert.strictEqual(routes.classify(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'application/octet-stream', 'a.jpg').kind, 'image');
    assert.strictEqual(routes.classify(Buffer.from('ID3\x00\x00'), 'application/octet-stream', 'a.mp3').kind, 'audio');

    // ── The web-safe rule and the copy's arguments (ffmpeg) ──
    const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
    if (!HAS_FFMPEG) {
        console.log('attachments playback: the sniffer table passed; the video parts skipped (no ffmpeg)');
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
    }
    const ffmpeg = (...args) => {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
    };
    const probeOf = (file) => {
        const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', file], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        return JSON.parse(r.stdout).streams;
    };
    const fixtures = path.join(tmp, 'fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    const fast = path.join(fixtures, 'fast.mp4');
    const slow = path.join(fixtures, 'slow.mp4');
    const webm = path.join(fixtures, 'clip.webm');
    const mkv = path.join(fixtures, 'clip.mkv');
    const hevc = path.join(fixtures, 'clip.mov');
    const tall = path.join(fixtures, 'tall.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', fast);
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', slow);
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=duration=2',
        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', webm);
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mkv);
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=duration=2',
        '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', '-shortest', hevc);
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=360x1920:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', tall);

    const safeFast = await playback.probe(fast);
    assert.strictEqual(safeFast.container, 'mp4');
    assert.strictEqual(safeFast.video_codec, 'h264');
    assert.strictEqual(safeFast.audio_codec, 'aac');
    assert.strictEqual(safeFast.faststart, true, 'the faststart MP4 has its index first');
    assert.strictEqual(playback.webSafe(safeFast).safe, true, 'an MP4 with H.264, AAC and a fast index plays as it is');

    const safeSlow = await playback.probe(slow);
    assert.strictEqual(safeSlow.faststart, false, 'the plain MP4 has its index at the end');
    assert.match(playback.webSafe(safeSlow).reason, /index is at the end/);

    const safeWebm = await playback.probe(webm);
    assert.strictEqual(safeWebm.container, 'webm');
    assert.strictEqual(safeWebm.video_codec, 'vp9');
    assert.strictEqual(safeWebm.audio_codec, 'opus');
    assert.strictEqual(playback.webSafe(safeWebm).safe, true, 'a WebM with VP9 and Opus plays as it is');

    const safeMkv = await playback.probe(mkv);
    assert.strictEqual(safeMkv.container, 'matroska');
    assert.strictEqual(playback.webSafe(safeMkv).safe, false, 'an MKV is not a web container');

    const safeHevc = await playback.probe(hevc);
    assert.strictEqual(safeHevc.container, 'mov');
    assert.match(playback.webSafe(safeHevc).reason, /hevc/);

    // The copy's arguments: H.264 + AAC, faststart, at most 1080 lines tall, the frame rate up to 60.
    const args = playback.copyArgs({ input: '/in.mkv', output: '/out.mp4', info: { height: 1920, fps: 120 }, maxHeight: 1080, maxFps: 60 });
    const has = (a, b) => args.indexOf(a) >= 0 && args[args.indexOf(a) + 1] === b;
    assert.ok(has('-c:v', 'libx264'), 'H.264');
    assert.ok(has('-pix_fmt', 'yuv420p'), 'yuv420p');
    assert.ok(has('-c:a', 'aac'), 'AAC');
    assert.ok(has('-movflags', '+faststart'), 'the index comes first');
    assert.ok(has('-vf', 'scale=-2:1080'), 'at most 1080 lines tall');
    assert.ok(has('-r', '60'), 'the frame rate is capped at 60');
    assert.ok(args.includes('-autorotate'), 'the rotation is applied');
    const small = playback.copyArgs({ input: '/in.mp4', output: '/out.mp4', info: { height: 720, fps: 30 }, maxHeight: 1080, maxFps: 60 });
    assert.ok(!small.includes('-vf'), 'a small video is not scaled');
    assert.ok(small[small.indexOf('-r') + 1] === '30', 'a small frame rate is kept');

    // ── The attachment's answer: while the copy is made, and once it is ready ──
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    auth._setNetworkPublicKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }));
    const now = Math.floor(Date.now() / 1000);
    const SUBJECT = ids.newId('user');
    const OTHER = ids.newId('user');
    const personToken = (subject = SUBJECT) => jwt.sign({ iss: 'https://openvibe.network', sub: 42, subject_id: subject, aud: ['openvibe.media', 'openvibe.network'], iat: now, exp: now + 600 }, privateKey.export({ type: 'pkcs8', format: 'pem' }), { algorithm: 'RS256' });
    const serviceToken = (cap = ['media.object.upload', 'media.object.read']) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.media'], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const app = express();
    app.use(express.json());
    app.use('/api/v1/attachments', routes);
    app.use('/a', routes.publicRouter);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const upload = async (file, name, { token = personToken(), headers = {} } = {}) => {
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(file)], { type: 'application/octet-stream' }), name);
        const r = await fetch(`${base}/api/v1/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body: form });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    // A video a browser can play as it is: ready at once, playing its own bytes.
    let out = await upload(fast, 'fast.mp4');
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    assert.strictEqual(out.body.kind, 'video');
    assert.strictEqual(out.body.mime, 'video/mp4');
    assert.strictEqual(out.body.status, 'ready');
    assert.strictEqual(out.body.playback.ready, true);
    assert.strictEqual(out.body.playback.url, out.body.url, 'the original plays when it already can');
    assert.strictEqual(out.body.playback.mime, 'video/mp4');
    assert.ok(out.body.duration_s > 1.5 && out.body.duration_s < 2.5, 'the length is measured: ' + out.body.duration_s);
    assert.deepStrictEqual([out.body.width, out.body.height], [320, 180], 'the size is the one shown');
    assert.match(out.body.poster, /\/a\/att_[^/]+\/thumb\.jpg$/, 'the poster is the first frame');
    const readyId = out.body.id;

    // A video no browser can play: the copy is made in the background, the original stays.
    out = await upload(mkv, 'clip.mkv');
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    assert.strictEqual(out.body.mime, 'video/x-matroska');
    assert.strictEqual(out.body.status, 'processing');
    assert.strictEqual(out.body.playback.ready, false, 'the copy is not there yet');
    assert.strictEqual(out.body.playback.url, out.body.url, 'until then the original is named');
    const copyId = out.body.id;

    // The job makes the copy: H.264 + AAC in a faststart MP4, and the attachment says so.
    const result = await job.run({ id: 'mjob_test', params: { attachment_id: copyId } }, { signal: new AbortController().signal });
    assert.strictEqual(result.copy, 'playback.mp4');
    assert.ok(result.bytes > 0);
    const copyFile = path.join(config.attachments.path, copyId, 'playback.mp4');
    assert.ok(fs.existsSync(copyFile), 'the copy is beside the original');
    const codecs = probeOf(copyFile).map((s) => s.codec_name).sort();
    assert.deepStrictEqual(codecs, ['aac', 'h264'], 'the copy is H.264 + AAC');
    const copyProbe = await playback.probe(copyFile);
    assert.strictEqual(copyProbe.faststart, true, 'the copy has its index first');
    assert.strictEqual(playback.webSafe(copyProbe).safe, true, 'the copy plays as it is');

    let res = await fetch(`${base}/api/v1/attachments/${copyId}`, { headers: { Authorization: `Bearer ${personToken()}` } });
    assert.strictEqual(res.status, 200);
    let row = await res.json();
    assert.strictEqual(row.status, 'ready');
    assert.strictEqual(row.playback.ready, true);
    assert.match(row.playback.url, /\/a\/att_[^/]+\/playback\.mp4$/, 'the copy is named');
    assert.strictEqual(row.playback.mime, 'video/mp4');
    const bytes = await fetch(row.playback.url.replace('https://media.test', base));
    assert.strictEqual(bytes.status, 200, 'the copy is served');
    assert.strictEqual(bytes.headers.get('content-type'), 'video/mp4');

    // The service reads it for the person it names, and only for them.
    res = await fetch(`${base}/api/v1/attachments/${copyId}`, { headers: { Authorization: `Bearer ${serviceToken()}`, 'X-OV-Subject': SUBJECT } });
    assert.strictEqual(res.status, 200, 'a service reads the attachment of the person it names');
    res = await fetch(`${base}/api/v1/attachments/${copyId}`, { headers: { Authorization: `Bearer ${serviceToken()}`, 'X-OV-Subject': OTHER } });
    assert.strictEqual(res.status, 404, 'another person\'s attachment is not there');
    res = await fetch(`${base}/api/v1/attachments/${copyId}`, { headers: { Authorization: `Bearer ${personToken(OTHER)}` } });
    assert.strictEqual(res.status, 404);

    // A video longer than the bound: the copy is refused as too long, and the attachment says why.
    const maxSeconds = config.attachments.playback.maxSeconds;
    config.attachments.playback.maxSeconds = 1;
    out = await upload(slow, 'long.mp4');
    assert.strictEqual(out.body.status, 'processing');
    await assert.rejects(job.run({ id: 'mjob_long', params: { attachment_id: out.body.id } }, { signal: new AbortController().signal }),
        (err) => err.code === 'media.attachment.too_long' && err.permanent);
    res = await fetch(`${base}/api/v1/attachments/${out.body.id}`, { headers: { Authorization: `Bearer ${personToken()}` } });
    row = await res.json();
    assert.strictEqual(row.status, 'failed');
    assert.match(row.reason, /longer than the 1 s/, 'the reason says it is too long: ' + row.reason);
    assert.ok(fs.existsSync(path.join(config.attachments.path, out.body.id, out.body.name)), 'the original is kept');
    config.attachments.playback.maxSeconds = maxSeconds;

    // A picture has no playback at all, and keeps its old shape.
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 24, height: 12, channels: 3, background: '#3366ff' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'shot.png');
    res = await fetch(`${base}/api/v1/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${personToken()}` }, body: form });
    const picture = await res.json();
    assert.strictEqual(picture.kind, 'image');
    assert.strictEqual(picture.playback, null);
    assert.strictEqual(picture.status, null);

    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('attachments playback: the sniffer table, the web-safe rule, the copy and the answer all passed');
})().catch((err) => { console.error(err); process.exit(1); });
