'use strict';
// A recording that does not decode must never reach a player: finalize marks it needs_repair and hides it, and
// Media's own repair re-encodes the broken file, verifies it, and lifts the quarantine (server/vod/decode-check.js,
// server/vod/finalize.js, server/vod/vod-repair.js). Fixtures are made here with ffmpeg; no production media.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasX264 = hasFfmpeg && /libx264/.test(String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout));
if (!hasX264) { console.log('vod-decode-repair: skipped (ffmpeg with libx264 not found)'); process.exit(0); }

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-vod-repair-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.FILES_PATH = dir('files');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.MEDIA_JOBS_ENABLED = '0';
    process.env.MEDIA_HLS_ENABLED = '0';

    const db = require('../server/db/database');
    const finalize = require('../server/vod/finalize');
    const repair = require('../server/vod/vod-repair');
    const decode = require('../server/vod/decode-check');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key' });

    const makeVideo = (file) => {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=10',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-g', '20', '-keyint_min', '20', '-sc_threshold', '0',
            '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', file], { encoding: null });
        assert.strictEqual(r.status, 0, String(r.stderr));
    };
    const corruptOneFrame = (file) => {
        const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-of', 'json', file], { encoding: 'utf8' });
        const victim = (JSON.parse(probe.stdout).packets || []).find((p) => !String(p.flags || '').includes('K') && Number(p.size) > 300 && Number(p.pos) > 0);
        assert.ok(victim, 'the fixture has a P-frame to corrupt');
        const bytes = fs.readFileSync(file);
        const at = Number(victim.pos) + 4 + 120;
        for (let i = 0; i < 12; i++) bytes[at + i] ^= 0xff;
        fs.writeFileSync(file, bytes);
    };
    async function makeVod(file) {
        const r = await db.run(`INSERT INTO vods (app_id, user_id, title, file_path, is_recording, duration_seconds, is_public, visibility)
            VALUES ('live', 7, 'robot', ?, 1, 0, 1, 'public') RETURNING id`, [file]);
        return Number(r.lastInsertRowid);
    }
    const row = async (id) => await db.get('SELECT * FROM vods WHERE id = ?', [id]);

    // ── 1. Finalize a corrupt recording: it is measured, hidden and marked needs_repair, never published ──
    const bad = path.join(process.env.VOD_PATH, 'robot.mp4');
    makeVideo(bad);
    corruptOneFrame(bad);
    const badId = await makeVod(bad);
    await finalize.finalizeVod(badId);
    const broken = await row(badId);
    assert.strictEqual(broken.health_status, 'needs_repair', JSON.stringify(broken.health_issues_json));
    assert.strictEqual(broken.is_recording, 0);
    assert.strictEqual(broken.is_public, 0, 'a broken recording is hidden until it is repaired');
    assert.ok(broken.quarantined_at, 'and quarantined for repair');
    assert.ok(JSON.parse(broken.health_issues_json).includes('decode_failed'));
    assert.ok(broken.duration_seconds >= 5 && broken.duration_seconds <= 7, `its measured length is kept (${broken.duration_seconds}s)`);
    assert.ok(fs.existsSync(bad), 'the bytes stay for the repair');
    console.log('✅ finalize: a corrupt recording is needs_repair, hidden, and its bytes are kept');

    // ── 2. Media's repair: re-encode, verify, lift the quarantine, restore the owner's visibility ──
    const fixed = await repair.repairVod(await row(badId), { apply: true, recut: false, announceReady: false });
    assert.strictEqual(fixed.ok, true, JSON.stringify(fixed));
    assert.ok(!fixed.skipped, 'it was not already clean');
    const good = await row(badId);
    assert.strictEqual(good.health_status, 'ok');
    assert.strictEqual(good.quarantined_at, null, 'the quarantine is lifted');
    assert.strictEqual(good.is_public, 1, 'back to the visibility its owner chose');
    assert.ok(good.duration_seconds >= 5 && good.duration_seconds <= 7, `duration kept (${good.duration_seconds}s)`);
    assert.ok(fs.statSync(bad).size > 1024);
    assert.strictEqual((await decode.scan(bad)).ok, true, 'the repaired file decodes cleanly');
    console.log('✅ repair: the file is re-encoded in place, verified, un-quarantined and public again');

    // ── 3. A clean recording is not touched and the check does not cry wolf on variable timestamps ──
    const clean = path.join(process.env.VOD_PATH, 'clean.mp4');
    makeVideo(clean);
    const cleanId = await makeVod(clean);
    const cleanSize = fs.statSync(clean).size;
    await finalize.finalizeVod(cleanId);
    const ok = await row(cleanId);
    assert.strictEqual(ok.health_status, 'ok');
    assert.strictEqual(ok.is_public, 1);
    assert.strictEqual(fs.statSync(clean).size, cleanSize, 'a clean file is not re-encoded');
    console.log('✅ finalize: a clean recording is published without touching its bytes');

    fs.rmSync(tmp, { recursive: true, force: true });
})().catch((err) => { console.error(err); process.exit(1); });
