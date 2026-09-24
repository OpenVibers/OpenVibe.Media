'use strict';
// VOD duration truthfulness (server/vod/finalize.js, media-tools.chooseDuration): the stored duration
// is what the file says (ffprobe, else the packet timeline of a stream-copy pass), never the wall
// clock; vods.duration_source says which (probe | remux | unknown). Nothing measurable stores 0 with
// needs_review; an orphan (no recorder start time) is never measured as now - created_at; a later
// good finalize lifts the quarantine a failed one left.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-duration-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.FILES_PATH = dir('files');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');
process.env.MEDIA_JOBS_ENABLED = '0';

const tools = require('../server/vod/media-tools');

// ── 1. chooseDuration: measured values only, bounded by the recorder's run when known ──
{
    const c = tools.chooseDuration;
    assert.deepStrictEqual(c({ probeS: 600.4 }), { seconds: 600.4, source: 'probe', issues: [] });
    assert.deepStrictEqual(c({ probeS: 0, remuxS: 590 }), { seconds: 590, source: 'remux', issues: [] }, 'no container duration: the packets');
    assert.deepStrictEqual(c({}), { seconds: 0, source: 'unknown', issues: ['probe_failed'] }, 'nothing measured: 0, unknown');
    const inflated = c({ probeS: 86400, remuxS: 600 });
    assert.deepStrictEqual([inflated.seconds, inflated.source], [600, 'remux'], 'a header far longer than the packets is corrupt');
    assert.ok(inflated.issues.includes('inflated_container_duration'));
    const bounded = c({ probeS: 5000, remuxS: 0, wallS: 600 });
    assert.deepStrictEqual([bounded.seconds, bounded.source], [0, 'unknown'], 'longer than the recorder ran: refused, and the wall clock is NOT used');
    assert.ok(bounded.issues.includes('inflated_duration'));
    assert.strictEqual(c({ probeS: 5000, remuxS: 590, wallS: 600 }).source, 'remux', 'the plausible measurement wins');
    assert.strictEqual(c({ probeS: 172800 }).seconds, 172800, 'no start time (orphan): no bound either, only measurements');
    assert.strictEqual(tools.lastProgressSeconds('frame=1 time=00:00:01.00 x\rframe=2 time=01:02:03.50 bitrate'), 3723.5);
    assert.strictEqual(tools.lastProgressSeconds('time=N/A'), 0);
    console.log('✅ chooseDuration: probe, else the packet timeline, else 0/unknown; bounded by the recorder run; never the wall clock');
}

const db = require('../server/db/database');
const finalize = require('../server/vod/finalize');
db.upsertApp({ app_id: 'live', api_key: 'live-key' });

const cols = db.all('PRAGMA table_info(vods)').map(c => c.name);
assert.ok(cols.includes('duration_source'), 'vods.duration_source exists');

const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().replace('T', ' ').slice(0, 19);
function makeVod(file, { createdAt = daysAgo(2), wallDuration = 99999 } = {}) {
    const r = db.run(`INSERT INTO vods (app_id, user_id, title, file_path, is_recording, duration_seconds, created_at, is_public, visibility)
                      VALUES ('live', 7, 'rec', ?, 1, ?, ?, 1, 'public')`, [file, wallDuration, createdAt]);
    return Number(r.lastInsertRowid);
}
const row = (id) => db.get('SELECT * FROM vods WHERE id = ?', [id]);

const realTools = { ...tools };
function restore() { Object.assign(tools, realTools); }

(async () => {
    // ── 2. Probe failure: 0 + needs_review + hidden; the live wall-clock estimate is not kept ──
    {
        const file = path.join(process.env.VOD_PATH, 'garbage.mp4');
        fs.writeFileSync(file, Buffer.alloc(20000, 7));
        const id = makeVod(file);
        tools.remuxForSeekingDetailed = async () => ({ ok: false, seconds: 0, error: 'ffmpeg remux exited 1' });
        tools.probeDuration = async () => ({ ok: false, seconds: 0, format: null, streams: [], error: 'unreadable' });
        tools.streamCopyDuration = async () => ({ ok: false, seconds: 0, error: 'no packets' });
        await finalize.finalizeVod(id);
        const v = row(id);
        assert.strictEqual(v.duration_seconds, 0, 'probe failure stores 0, not the recorder\'s wall-clock estimate');
        assert.strictEqual(v.duration_source, 'unknown');
        assert.strictEqual(v.health_status, 'needs_review');
        const issues = JSON.parse(v.health_issues_json);
        assert.ok(issues.includes('probe_failed') && issues.includes('remux_failed'), `issues: ${issues}`);
        assert.strictEqual(v.is_recording, 0);
        assert.strictEqual(v.is_public, 0, 'hidden until reviewed');
        assert.ok(v.quarantined_at);

        // A later finalize that can measure it lifts the quarantine (the vod.finalize retry job does this).
        tools.probeDuration = async () => ({ ok: true, seconds: 1234.4, format: { format_name: 'mp4' }, streams: [], error: null });
        await finalize.finalizeVod(id);
        const w = row(id);
        assert.deepStrictEqual([w.duration_seconds, w.duration_source, w.health_status], [1234, 'probe', 'ok']);
        assert.strictEqual(w.quarantined_at, null, 'quarantine lifted');
        assert.strictEqual(w.is_public, 1, 'back to the visibility its owner chose');
        restore();
        console.log('✅ probe failure: duration 0, duration_source unknown, needs_review, hidden; a later good finalize lifts it');
    }

    // ── 3. Orphans (no start time) never use now - created_at; a bound applies only with a real start ──
    {
        const file = path.join(process.env.VOD_PATH, 'orphan.mp4');
        fs.writeFileSync(file, Buffer.alloc(20000, 1));
        const id = makeVod(file, { createdAt: daysAgo(3) });
        tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 3601.2, error: null });
        tools.probeDuration = async () => ({ ok: true, seconds: 3600.8, format: {}, streams: [], error: null });
        await finalize.finalizeVod(id);
        const v = row(id);
        assert.deepStrictEqual([v.duration_seconds, v.duration_source], [3601, 'probe'], 'orphan: the measured length, not 3 days');

        const file2 = path.join(process.env.VOD_PATH, 'inflated.mp4');
        fs.writeFileSync(file2, Buffer.alloc(20000, 2));
        const id2 = makeVod(file2);
        tools.probeDuration = async () => ({ ok: true, seconds: 50000, format: {}, streams: [], error: null });
        tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 50000, error: null });
        await finalize.finalizeVod(id2, { startTimeMs: Date.now() - 600 * 1000 });
        const w = row(id2);
        assert.deepStrictEqual([w.duration_seconds, w.duration_source, w.health_status], [0, 'unknown', 'needs_review'],
            'longer than the recorder ran: 0 and review, where the old code stored the wall clock');
        assert.ok(JSON.parse(w.health_issues_json).includes('inflated_duration'));

        const file3 = path.join(process.env.VOD_PATH, 'header.mp4');
        fs.writeFileSync(file3, Buffer.alloc(20000, 3));
        const id3 = makeVod(file3);
        tools.probeDuration = async () => ({ ok: true, seconds: 90000, format: {}, streams: [], error: null });
        tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 581, error: null });
        await finalize.finalizeVod(id3, { startTimeMs: Date.now() - 600 * 1000 });
        assert.deepStrictEqual([row(id3).duration_seconds, row(id3).duration_source, row(id3).health_status], [581, 'remux', 'ok'], 'the packet timeline when the header lies');
        restore();
        console.log('✅ orphans are measured, never now - created_at; impossible values need review; a lying header yields to the packets');
    }

    // ── 4. Short, corrupt and stat-failure paths also drop the wall-clock estimate ──
    {
        const file = path.join(process.env.VOD_PATH, 'short.mp4');
        fs.writeFileSync(file, Buffer.alloc(20000, 4));
        const id = makeVod(file);
        tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 1, error: null });
        tools.probeDuration = async () => ({ ok: true, seconds: 1, format: {}, streams: [], error: null });
        await finalize.finalizeVod(id);
        assert.deepStrictEqual([row(id).duration_seconds, row(id).duration_source, row(id).health_status], [1, 'probe', 'needs_review']);

        const file2 = path.join(process.env.VOD_PATH, 'corrupt.mp4');
        fs.writeFileSync(file2, Buffer.alloc(20000, 5));
        const id2 = makeVod(file2);
        tools.probeDuration = async () => ({ ok: true, seconds: 42, format: {}, streams: [], error: null });
        tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 42, error: null });
        await finalize.finalizeVod(id2, { ffmpegCorrupted: true });
        assert.deepStrictEqual([row(id2).duration_seconds, row(id2).duration_source, row(id2).health_status], [42, 'probe', 'corrupt'],
            'the corrupt path stores the measurement, not the live estimate');

        const file3 = path.join(process.env.VOD_PATH, 'vanishing.mp4');
        fs.writeFileSync(file3, Buffer.alloc(20000, 6));
        const id3 = makeVod(file3);
        tools.probeDuration = async (p) => { if (p === file3) { try { fs.unlinkSync(file3); } catch { /* */ } } return { ok: true, seconds: 300, format: {}, streams: [], error: null }; };
        tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: 300, error: null });
        await finalize.finalizeVod(id3);
        const v3 = row(id3);
        assert.deepStrictEqual([v3.is_recording, v3.duration_seconds, v3.duration_source, v3.health_status], [0, 0, 'unknown', 'needs_review']);
        assert.ok(JSON.parse(v3.health_issues_json).includes('stat_failed'));
        restore();
        console.log('✅ short, corrupt and stat-failure outcomes never keep the wall-clock estimate');
    }

    // ── 5. Real ffmpeg: an orphaned 6 s recording made 2 days ago finalizes to ~6 s (probe) ──
    if (spawnSync('ffmpeg', ['-version']).status !== 0) {
        console.log('⚠️  ffmpeg not found: the real-file finalize check is skipped');
    } else {
        const file = path.join(process.env.VOD_PATH, 'real.mp4');
        const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=160x120:rate=10',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
            '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', file]);
        assert.strictEqual(mk.status, 0, String(mk.stderr));
        const id = makeVod(file, { createdAt: daysAgo(2) });
        await finalize.finalizeVod(id);
        const v = row(id);
        assert.ok(v.duration_seconds >= 5 && v.duration_seconds <= 7, `measured ${v.duration_seconds}s`);
        assert.strictEqual(v.duration_source, 'probe');
        assert.strictEqual(v.health_status, 'ok');
        const packets = await tools.streamCopyDuration(file);
        assert.ok(packets.ok && packets.seconds > 5 && packets.seconds < 7, `stream-copy pass measured ${packets.seconds}`);
        const pr = await tools.probeDuration(path.join(tmp, 'nope.mp4'));
        assert.strictEqual(pr.ok, false, 'an unreadable source is a failed probe, not a zero-length one');
        console.log('✅ a real orphaned recording finalizes to its measured length (probe), and the packet pass agrees');
    }

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All VOD duration tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
