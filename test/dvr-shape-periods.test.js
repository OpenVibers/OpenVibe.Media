'use strict';
// The live rewind across a phone turn (vod/avc-shape.js, vod/fmp4-index.js periods, /v/:id/dvr/init-<offset>.mp4), and
// a live clip past the recorded edge (vod/clips-routes.js).
//
// Stream 2795 (2026-10-26) turned between 720x1280 and 1280x720. The recording is a stream copy whose moov names the
// first size, and Chrome played every rewound landscape frame squeezed into portrait (1280x2276). Now:
// - SPS parsing gives the picture size: baseline, high profile with cropping, emulation prevention bytes.
// - A fragment whose keyframe SPS names another shape starts a period; a lowered resolution of the same shape does not;
//   indexing as the file grows finds the same periods.
// - The playlist puts #EXT-X-DISCONTINUITY and the period's own init segment before it; that init (the moov rewritten
//   for the new SPS) plus the period's segment decodes at the new size. Unknown offsets are 404s.
// - A clip of a recording asked for past the recorded edge keeps its length and ends at the edge (clip 505 was squeezed
//   to 1 s and failed).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const avc = require('../server/vod/avc-shape');

// ── SPS parsing (x264 output) ──
const hex = (h) => Buffer.from(h, 'hex');
const SPS_720x1280 = hex('6742c01fd900b40a1b0110000003001000000303c0f1832480');
const SPS_1280x720 = hex('6742c01fd9005005bb0110000003001000000303c0f1832480');
const SPS_1080_HIGH = hex('67640028acd940780227e5c044000003000400000300f03c60c658');
const PPS_BASE = hex('68cb83cb20');
assert.deepStrictEqual([avc.parseSps(SPS_720x1280).width, avc.parseSps(SPS_720x1280).height], [720, 1280]);
assert.deepStrictEqual([avc.parseSps(SPS_1280x720).width, avc.parseSps(SPS_1280x720).height], [1280, 720]);
const high = avc.parseSps(SPS_1080_HIGH);
assert.deepStrictEqual([high.profile, high.width, high.height], [100, 1920, 1080], 'high profile, 1088 cropped to 1080');
assert.throws(() => avc.parseSps(PPS_BASE), /not an SPS/);
assert.ok(avc.sameShape({ width: 1280, height: 720 }, { width: 426, height: 240 }), 'a lowered resolution is the same shape');
assert.ok(!avc.sameShape({ width: 720, height: 1280 }, { width: 1280, height: 720 }), 'a turn is not');

// A length-prefixed sample: AUD, SPS, PPS, then a slice; parameter sets after the slice are not the keyframe's.
const lp = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return Buffer.concat([l, b]); };
const sample = Buffer.concat([lp(hex('0910')), lp(SPS_1280x720), lp(PPS_BASE), lp(hex('65888400')), lp(SPS_720x1280)]);
const ps = avc.parameterSets(sample, 4);
assert.ok(ps.sps.equals(SPS_1280x720) && ps.pps.equals(PPS_BASE), 'the SPS and PPS before the first slice');
assert.deepStrictEqual(avc.parameterSets(sample.subarray(0, 30), 4), { sps: null, pps: null }, 'a cut-off read keeps the whole NALs only');

(async () => {
    const ff = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (ff.status !== 0 || !/libx264/.test(ff.stdout) || spawnSync('ffprobe', ['-version']).status !== 0) {
        console.log('dvr shape periods: SPS checks passed; recording checks skipped (ffmpeg with libx264 not found)');
        process.exit(0);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-dvr-shape-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.MEDIA_PUBLIC_URL = 'https://media.test';
    process.env.MEDIA_JOBS_POLL_MS = '60000';
    const ffmpeg = (...args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); };
    const probe = (file) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim();

    // A phone stream as the recorder writes it: H.264 baseline copied into a fragmented MP4, a keyframe a second.
    // Portrait 4 s, landscape 4 s, landscape at a lowered resolution 4 s (same shape), portrait again 4 s.
    const shapes = ['144x256', '256x144', '128x72', '144x256'];
    const parts = shapes.map((s, i) => {
        const f = path.join(tmp, `p${i}.h264`);
        ffmpeg('-f', 'lavfi', '-i', `testsrc=duration=4:size=${s}:rate=10`, '-c:v', 'libx264', '-profile:v', 'baseline', '-bf', '0', '-g', '10',
            '-pix_fmt', 'yuv420p', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', f);
        return fs.readFileSync(f);
    });
    const annexb = path.join(tmp, 'all.h264');
    fs.writeFileSync(annexb, Buffer.concat(parts));
    const full = path.join(tmp, 'turn.mp4');
    ffmpeg('-r', '10', '-f', 'h264', '-i', annexb, '-c:v', 'copy', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', full);
    const bytes = fs.readFileSync(full);

    const fmp4 = require('../server/vod/fmp4-index');
    const whole = await fmp4.refresh(full);
    assert.deepStrictEqual(whole.periods.map((p) => [p.width, p.height]), [[144, 256], [256, 144], [144, 256]],
        'portrait, landscape (its lowered resolution included), portrait again');
    assert.strictEqual(whole.periods[0].offset, null, 'the first period is the file\'s own init');
    assert.ok(Math.abs(whole.periods[1].start - 4) < 0.2 && Math.abs(whole.periods[2].start - 12) < 0.2, 'periods start at the turns');
    for (const f of whole.fragments) {
        const expect = f.start < 3.9 ? 0 : f.start < 11.9 ? 1 : 2;
        assert.strictEqual(f.period, expect, `fragment at ${f.start}s is in period ${expect}`);
    }

    // Growing: the same periods when the file is read a piece at a time.
    const growing = path.join(process.env.VOD_PATH, 'vod-live-9.mp4');
    const cut = whole.fragments[7].offset + 100;
    fs.writeFileSync(growing, bytes.subarray(0, cut));
    const half = await fmp4.refresh(growing);
    assert.strictEqual(half.periods.length, 2, 'two periods so far');
    fs.appendFileSync(growing, bytes.subarray(cut));
    const grown = await fmp4.refresh(growing);
    assert.deepStrictEqual(grown.periods.map((p) => [p.offset, p.width, p.height]), whole.periods.map((p) => [p.offset, p.width, p.height]));

    // The playlist: a discontinuity and the period's init before each change; no segment spans one.
    const m3u8 = fmp4.playlist(whole, { ended: true });
    const lines = m3u8.trim().split('\n');
    assert.strictEqual(lines.filter((l) => l === '#EXT-X-DISCONTINUITY').length, 2);
    assert.deepStrictEqual(lines.filter((l) => l.startsWith('#EXT-X-MAP')), ['#EXT-X-MAP:URI="dvr/init.mp4"',
        `#EXT-X-MAP:URI="dvr/init-${whole.periods[1].offset}.mp4"`, `#EXT-X-MAP:URI="dvr/init-${whole.periods[2].offset}.mp4"`]);
    const segs = fmp4.segments(whole.fragments, 6);
    for (const s of segs) {
        const inside = whole.fragments.filter((f) => f.offset >= s.offset && f.offset < s.offset + s.length);
        assert.ok(inside.every((f) => f.period === s.period), 'a segment stays in its period');
    }
    // Before any segment: the first period's init.
    assert.ok(fmp4.playlist({ fragments: [], periods: [{ offset: null }] }).includes('#EXT-X-MAP:URI="dvr/init.mp4"'));

    // The period's init + its first segment decode at the period's size; the file's own init names the first size.
    const init = fmp4.periodInit(bytes.subarray(0, whole.initEnd), whole, whole.periods[1].offset);
    const seg = segs.find((s) => s.offset === whole.periods[1].offset);
    const landscape = path.join(tmp, 'landscape.mp4');
    fs.writeFileSync(landscape, Buffer.concat([init, bytes.subarray(seg.offset, seg.offset + seg.length)]));
    assert.strictEqual(probe(landscape), '256,144', 'the rewritten init describes the landscape period');
    assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-i', landscape, '-f', 'null', '-']).status, 0, 'and it decodes');
    assert.strictEqual(fmp4.periodInit(bytes.subarray(0, whole.initEnd), whole, 12345), null, 'no period at that offset');

    // The routes.
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
    await db.run(`INSERT INTO vods (id, app_id, user_id, title, file_path, is_public, visibility, is_recording) OVERRIDING SYSTEM VALUE
                  VALUES (9, 'live', 5, 'Turning', ?, 1, 'public', 1)`, [growing]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/', require('../server/public/routes'));
    app.use('/api/v1/:app/clips', require('../server/vod/clips-routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') }; };
    const pl = await get('/v/9/dvr.m3u8');
    assert.ok(pl.body.toString().includes(`dvr/init-${whole.periods[1].offset}.mp4`), 'the served playlist names the period inits');
    const served = await get(`/v/9/dvr/init-${whole.periods[1].offset}.mp4`);
    assert.strictEqual(served.status, 200);
    assert.strictEqual(served.type, 'video/mp4');
    assert.ok(served.body.equals(init), 'the route serves the rewritten init');
    assert.strictEqual((await get('/v/9/dvr/init-12345.mp4')).status, 404, 'an offset that starts no period');

    // A clip of the last 3 s asked for past the recorded edge (the file ends at 16 s): 3 s ending at the edge.
    const clip = await fetch(`${base}/api/v1/live/clips`, { method: 'POST', headers: { authorization: 'Bearer live-key', 'content-type': 'application/json' },
        body: JSON.stringify({ vod_id: 9, start_s: 40, end_s: 43, user_id: 5 }) });
    assert.ok(clip.status === 201 || clip.status === 202, `clip created (${clip.status})`);
    const id = (await clip.json()).id;
    const row = await db.get('SELECT start_time, end_time, duration_seconds FROM clips WHERE id = ?', [id]);
    assert.ok(Math.abs(row.end_time - 15.5) < 0.2, `ends at the recorded edge (${row.end_time})`);
    assert.ok(Math.abs(row.end_time - row.start_time - 3) < 0.01, `keeps its 3 s (${row.start_time}–${row.end_time})`);

    server.close();
    console.log('dvr shape periods: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
