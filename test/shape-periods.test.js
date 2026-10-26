'use strict';
// A recording whose picture changes shape mid-stream (server/jobs/shapes.js): a phone turned from landscape to portrait,
// then WebRTC lowered the resolution. VOD 6017 was cut as one encode, and every portrait frame was stretched to the
// first 1280x720. Now the cut is one period per shape, each on its own canvas with its own init segment, and the
// playlists, virtual clips and materialized clips carry the right init for each segment.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-shapes-'));
    const dir = (name) => { const p = path.join(tmp, name); fs.mkdirSync(p, { recursive: true }); return p; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'), THUMBNAILS_PATH: dir('thumbnails'),
        PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_HLS_ENABLED: '1', MEDIA_CMAF_TRANSCODE: '1',
        MEDIA_UPLOAD_MIN_FREE_MB: '0', MEDIA_INVARIANT_SCAN_HOURS: '0',
    });
    for (const p of ['B2', 'R2']) for (const k of ['ENDPOINT', 'BUCKET', 'KEY_ID', 'APP_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) process.env[`MEDIA_${p}_${k}`] = '';
    try {
        const shapes = require('../server/jobs/shapes');
        const timeline = require('../server/objects/timeline');
        const at = (list) => list.map(([t, width, height]) => ({ t, width, height }));

        // ── Planning ──
        // VOD 6017's own keyframe sizes: 16:9 for 16 minutes, then portrait at three sizes. Two periods, the portrait one on
        // the largest portrait size; a lowered resolution is not a period of its own.
        const vod6017 = at([[0.2, 1280, 720], [976.243, 720, 1280], [1079.895, 540, 960], [1144.988, 360, 640], [1481.092, 540, 960],
            [1546.278, 360, 640], [1756.995, 540, 960], [1942.652, 360, 640], [2148.22, 540, 960], [2228.501, 360, 640],
            [2373.997, 540, 960], [2474.381, 720, 1280], [2569.747, 540, 960]]);
        assert.deepStrictEqual(shapes.plan(vod6017, { end: 2592.2 }), [
            { start: 0.2, end: 976.243, width: 1280, height: 720 },
            { start: 976.243, end: 2592.2, width: 720, height: 1280 },
        ]);
        // A two-second turn and back joins its neighbour (drawn with bars), and the two landscape runs become one.
        assert.deepStrictEqual(shapes.plan(at([[0, 1280, 720], [100, 720, 1280], [102, 1280, 720], [300, 960, 540]]), { end: 400 }),
            [{ start: 0, end: 400, width: 1280, height: 720 }]);
        // A canvas keeps its shape under MAX_SIDE, on even sides.
        assert.deepStrictEqual(shapes.plan(at([[0, 1280, 720], [50, 2161, 3841]]), { end: 100 }),
            [{ start: 0, end: 50, width: 1280, height: 720 }, { start: 50, end: 100, width: 1080, height: 1920 }]);
        // A phone turned every few seconds for an hour still has at most MAX_PERIODS periods.
        const flips = [];
        for (let t = 0; t < 3600; t += 6) flips.push([t, t % 12 ? 720 : 1280, t % 12 ? 1280 : 720]);
        const many = shapes.plan(at(flips), { end: 3600 });
        assert.ok(many.length <= shapes.MAX_PERIODS, `${many.length} periods`);
        assert.strictEqual(many[0].start, 0);
        assert.strictEqual(many[many.length - 1].end, 3600);
        for (let i = 1; i < many.length; i++) assert.strictEqual(many[i].start, many[i - 1].end, 'periods tile the video');
        assert.strictEqual(shapes.varies(at([[0, 640, 360]])), false);
        assert.strictEqual(shapes.varies(at([[0, 640, 360], [9, 320, 180]])), true);
        assert.match(shapes.fit(720, 1280), /^scale=720:1280:force_original_aspect_ratio=decrease.*pad=720:1280:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1$/);

        // ── Names ──
        assert.strictEqual(timeline.shapeInitName(2), 'init-2.mp4');
        assert.strictEqual(timeline.shapeInitSeq('init-2.mp4'), -102);
        for (const name of ['init.mp4', 'init-1.mp4', 'init-head.mp4', 'init-tail.mp4', '000002.m4s', null]) assert.strictEqual(timeline.shapeInitSeq(name), null, String(name));

        // ── The cut, the playlist and the clips (needs ffmpeg with libx264, libvpx, libopus, as cmaf-transcode) ──
        if (spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) {
            console.log('✅ shape periods: planning and names (cut skipped: ffmpeg not found)');
            return;
        }
        const ffmpeg = (...args) => {
            const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
        };
        const frames = (file) => {
            const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            return r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split(',').slice(0, 2).join(','));
        };
        // The recorder's stream copy: one VP8 track whose keyframes change size, the header naming the first (320x180).
        // The landscape part is 6 s, the portrait one 6 s at 180x320 then 4 s at 90x160, all at 10 fps; the copy starts at
        // 0.2 s, as a recording's first keyframe often does.
        const part = (name, src, size, seconds, freq) => {
            const file = path.join(tmp, name);
            ffmpeg('-f', 'lavfi', '-i', `${src}=duration=${seconds}:size=${size}:rate=10`, '-f', 'lavfi', '-i', `sine=duration=${seconds}:frequency=${freq}`,
                '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-g', '10', '-c:a', 'libopus', '-shortest', file);
            return file;
        };
        const parts = [part('a.webm', 'testsrc', '320x180', 6, 440), part('b.webm', 'testsrc2', '180x320', 6, 660), part('c.webm', 'testsrc2', '90x160', 4, 880)];
        fs.writeFileSync(path.join(tmp, 'list.txt'), parts.map((p) => `file '${p}'`).join('\n'));
        const mixed = path.join(tmp, 'mixed.webm');
        ffmpeg('-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-c', 'copy', '-output_ts_offset', '0.2', mixed);
        const sourceFrames = frames(mixed).length;

        const read = await shapes.probe({ input: mixed, remote: false });
        assert.deepStrictEqual(read.changes.map((c) => `${c.width}x${c.height}`), ['320x180', '180x320', '90x160']);
        assert.ok(Math.abs(read.changes[1].t - read.start - 6) < 0.1, `the turn at ~6 s (${read.changes[1].t - read.start})`);

        const db = require('../server/db/database');
        const model = require('../server/objects/model');
        const cmaf = require('../server/jobs/cmaf');
        await db.upsertApp({ app_id: 'live', api_key: 'shapes-test' });
        const object = async (file, mime) => {
            const id = await model.createObject({ app_id: 'live', owner_user_id: 1, visibility: 'public', lifecycle_status: 'ready',
                kind: 'file', mime_type: mime, size_bytes: fs.statSync(file).size });
            await model.upsertLocation(id, { provider: 'local', key: file, state: 'present', size_bytes: fs.statSync(file).size, verified: true });
            return id;
        };
        const run = async (id, suffix) => await cmaf.spec.run({ id: `mjob_${suffix}`, app_id: 'live', object_id: id, params: { segment_seconds: 2 } },
            { signal: new AbortController().signal });
        const vod = await object(mixed, 'video/webm');
        const made = await run(vod, 'shapes');
        assert.deepStrictEqual([made.video, made.audio, made.shapes], ['h264', 'aac', 2]);

        const rows = await timeline.list(vod, 'source');
        const init2 = rows.find((r) => r.name === 'init-2.mp4');
        assert.ok(init2, 'the portrait period has its own init');
        assert.strictEqual(Number(init2.seq), -102);
        assert.strictEqual(rows.filter((r) => Number(r.seq) <= 0).length, 2, 'two inits, one per period');
        const segs = rows.filter((r) => Number(r.seq) > 0);
        const first = segs.filter((r) => !r.init_name);
        const second = segs.filter((r) => r.init_name === 'init-2.mp4');
        assert.ok(first.length && second.length && first.length + second.length === segs.length);
        assert.ok(Number(first[first.length - 1].seq) < Number(second[0].seq), 'the periods follow each other');
        // Every frame is on its period's canvas, never the other's: the portrait part is 180x320 (its 90x160 seconds
        // scaled up into it), and no frame of either shape lands in the other's period.
        const initFile = (r) => (r.init_name ? init2 : rows.find((x) => Number(x.seq) === 0)).local_path;
        const sizes = (list) => {
            const joined = path.join(tmp, 'joined.mp4');
            const out = [];
            for (const r of list) {
                fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(initFile(r)), fs.readFileSync(r.local_path)]));
                out.push(...frames(joined));
            }
            return out;
        };
        const landscape = sizes(first);
        const portrait = sizes(second);
        assert.ok(landscape.every((s) => s === '320,180'), `landscape period: ${[...new Set(landscape)]}`);
        assert.ok(portrait.every((s) => s === '180,320'), `portrait period: ${[...new Set(portrait)]}`);
        assert.ok(Math.abs(landscape.length - 60) <= 1, `${landscape.length} landscape frames, 60 sent`);
        assert.ok(Math.abs(landscape.length + portrait.length - sourceFrames) <= 1, `${landscape.length + portrait.length} frames of ${sourceFrames}`);
        // The timeline tiles the whole video.
        assert.ok(Math.abs(Number(segs[segs.length - 1].end_ms) - 16000) < 400, `ends at ${segs[segs.length - 1].end_ms} ms`);

        // The playlist switches init with a discontinuity between the periods, exactly once.
        const playlist = timeline.mediaPlaylist(rows);
        assert.strictEqual((playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
        assert.match(playlist, /#EXT-X-MAP:URI="init\.mp4"[\s\S]*#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init-2\.mp4"/);

        // A virtual clip across the turn carries init-2 and each segment's init; one inside the portrait part opens on it.
        const turnMs = Number(second[0].start_ms);
        const across = timeline.clipRows(rows, turnMs - 2500, turnMs + 2500);
        assert.ok(across.some((r) => r.name === 'init-2.mp4' && Number(r.seq) === -102));
        assert.match(timeline.mediaPlaylist(across), /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init-2\.mp4"/);
        const inside = timeline.clipRows(rows, turnMs + 1000, turnMs + 5000);
        assert.match(timeline.mediaPlaylist(inside), /^#EXTM3U[\s\S]*?#EXT-X-MAP:URI="init-2\.mp4"/);
        assert.ok(!/DISCONTINUITY/.test(timeline.mediaPlaylist(inside)));
        // A materialized clip's own rows over the source (the edges keep refusing a virtual clip, as before).
        assert.deepStrictEqual(timeline.clipRows([...rows, { seq: -1, name: timeline.HEAD_INIT }], 0, 4000), []);
        const materialize = require('../server/vod/clip-materialize');
        const plan = materialize.planWindow(rows, Number(second[0].start_ms), Number(second[second.length - 1].end_ms));
        assert.ok(plan.sourceRows.some((r) => r.name === 'init-2.mp4'), 'the pin names the period init it copies');
        assert.ok(!plan.sourceRows.some((r) => Number(r.seq) === 0), 'and not the first period\'s');
        assert.strictEqual(plan.initOf(second[0]).name, 'init-2.mp4');
        const spanning = materialize.planWindow(rows, Number(first[0].start_ms), Number(second[second.length - 1].end_ms));
        assert.deepStrictEqual(spanning.sourceRows.filter((r) => Number(r.seq) <= 0).map((r) => r.name).sort(), ['init-2.mp4', 'init.mp4']);

        // One size throughout keeps the cut as it was: a stream copy of an H.264 MP4.
        const plain = path.join(tmp, 'plain.mp4');
        ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=5:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=duration=5',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', plain);
        const copied = await run(await object(plain, 'video/mp4'), 'plain');
        assert.deepStrictEqual([copied.video, copied.audio, copied.shapes], ['copy', 'copy', 1]);
        console.log('✅ shape periods: planning, one init per shape, frames on their canvas, playlists and clips');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
