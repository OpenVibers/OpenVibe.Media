'use strict';
// Decode check + repair (server/vod/decode-check.js): a lost RTP access unit is a truncated H.264 slice; ffmpeg's
// muxer copies it, Chrome fails the whole playback on it (VODs 6297/6298, 2026-11-10). `scan` must catch it even when
// ffmpeg exits 0, and `repair` must turn the broken fixture into a stream that decodes cleanly. The fixture is made
// here with ffmpeg — no production media.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasX264 = hasFfmpeg && /libx264/.test(String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout));

if (!hasX264) {
    console.log('decode-check: skipped (ffmpeg with libx264 not found)');
    process.exit(0);
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-decode-'));
    const clean = path.join(tmp, 'clean.mp4');
    const make = spawnSync('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-g', '20', '-keyint_min', '20', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', clean], { encoding: null });
    assert.strictEqual(make.status, 0, String(make.stderr));

    const decode = require('../server/vod/decode-check');

    // ── 1. A clean recording passes ──
    const good = await decode.scan(clean);
    assert.strictEqual(good.ok, true, JSON.stringify(good));

    // ── 2. Corrupt one P-frame the way a lost RTP fragment corrupts it: flip bytes in the middle of the slice. ──
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-of', 'json', clean], { encoding: 'utf8' });
    const packets = JSON.parse(probe.stdout).packets || [];
    const victim = packets.find((p) => !String(p.flags || '').includes('K') && Number(p.size) > 300 && Number(p.pos) > 0);
    assert.ok(victim, 'the fixture has a P-frame to corrupt');
    const bad = path.join(tmp, 'bad.mp4');
    const bytes = fs.readFileSync(clean);
    const at = Number(victim.pos) + 4 + 120;   // past the length prefix, into the slice data
    for (let i = 0; i < 12; i++) bytes[at + i] ^= 0xff;
    fs.writeFileSync(bad, bytes);

    const broken = await decode.scan(bad);
    assert.strictEqual(broken.ok, false, 'the corrupt access unit is detected');
    assert.ok(broken.errors.some((l) => /error while decoding|corrupt decoded frame|Error processing packet/i.test(l)),
        `a decoder error is reported: ${JSON.stringify(broken.errors)}`);

    // ── 3. Repair replaces the corrupt unit with the decoder's concealed picture and verifies the output ──
    const fixed = await decode.repair(bad);
    assert.strictEqual(fixed.ok, true, JSON.stringify(fixed));
    const after = await decode.scan(bad);
    assert.strictEqual(after.ok, true, `the repaired file decodes cleanly: ${JSON.stringify(after)}`);
    assert.ok(fixed.duration >= 5.5 && fixed.duration <= 6.6, `duration is kept (${fixed.duration}s)`);
    assert.ok(fixed.size > 1024);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('✅ decode-check: a corrupt H.264 access unit is detected even on ffmpeg exit 0, and repair re-encodes a clean file with the duration kept');
})().catch((err) => { console.error(err); process.exit(1); });
