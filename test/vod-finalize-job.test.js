'use strict';
// vod.finalize (server/jobs/vod-finalize.js): orphaned recordings (is_recording = 1, nothing holding
// them, file idle past the grace) are queued once each; a finalize that cannot settle a recording
// (nothing measurable, stat failure, a throw) queues a retry instead of just clearing is_recording;
// the job retries with backoff, never stops a live recording or a chunk upload, and lifts the
// quarantine once a later attempt measures the file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-finalize-job-'));
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.DB_PATH = path.join(tmp, 'media.db');
process.env.VOD_PATH = dir('vods');
process.env.CLIPS_PATH = dir('clips');
process.env.THUMBNAILS_PATH = dir('thumbnails');
process.env.FILES_PATH = dir('files');
process.env.PASTES_PATH = dir('pastes');
process.env.OBJECTS_PATH = dir('objects');
process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';

const db = require('../server/db/database');
const queue = require('../server/jobs/queue');
const worker = require('../server/jobs/worker');
const job = require('../server/jobs/vod-finalize');
const tools = require('../server/vod/media-tools');
const recorder = require('../server/vod/recorder');
const vodRoutes = require('../server/vod/routes');

db.upsertApp({ app_id: 'live', api_key: 'live-key' });
db.upsertApp({ app_id: 'games', api_key: 'games-key' });

const realTools = { ...tools };
const restore = () => Object.assign(tools, realTools);
const measurable = (s = 1800) => {
    tools.remuxForSeekingDetailed = async () => ({ ok: true, seconds: s, error: null });
    tools.probeDuration = async () => ({ ok: true, seconds: s, format: {}, streams: [], error: null });
};
const unmeasurable = () => {
    tools.remuxForSeekingDetailed = async () => ({ ok: false, seconds: 0, error: 'ffmpeg remux exited 1' });
    tools.probeDuration = async () => ({ ok: false, seconds: 0, format: null, streams: [], error: 'unreadable' });
    tools.streamCopyDuration = async () => ({ ok: false, seconds: 0, error: 'no packets' });
};

function makeVod(name, { idleS = 3600, app = 'live' } = {}) {
    const file = path.join(process.env.VOD_PATH, name);
    fs.writeFileSync(file, Buffer.alloc(30000, 9));
    const t = (Date.now() - idleS * 1000) / 1000;
    fs.utimesSync(file, t, t);
    const r = db.run(`INSERT INTO vods (app_id, user_id, title, file_path, is_recording, duration_seconds, is_public, visibility, created_at)
                      VALUES (?, 1, 'rec', ?, 1, 77777, 1, 'public', datetime('now', '-2 days'))`, [app, file]);
    return Number(r.lastInsertRowid);
}
const vod = (id) => db.get('SELECT * FROM vods WHERE id = ?', [id]);
const jobsFor = (id) => db.all("SELECT * FROM media_jobs WHERE job_type = 'vod.finalize' AND json_extract(params, '$.vod_id') = ? ORDER BY id", [id]);

(async () => {
    assert.ok(queue.typeNames().includes('vod.finalize'));
    assert.strictEqual(queue.typeSpec('vod.finalize').lane, 'finalize');

    // ── 1. The orphan sweep: idle orphans only; live recordings, chunk uploads and fresh files are left alone ──
    const idle = makeVod('idle.mp4');
    const fresh = makeVod('fresh.mp4', { idleS: 10 });
    const live = makeVod('live.mp4');
    const chunked = makeVod('chunked.webm');
    recorder.activeRecordings.set(live, { vodId: live });
    vodRoutes.activeChunkUploads.set(chunked, { filePath: 'x' });
    assert.deepStrictEqual(job.orphans(), [idle], 'only the idle orphan');
    assert.strictEqual(job.sweepOrphans({ force: true }), 1);
    assert.strictEqual(job.sweepOrphans({ force: true }), 0, 'a queued finalize is joined, not repeated');
    const [j1] = jobsFor(idle);
    assert.strictEqual(j1.created_by, 'system:vod.finalize:orphan');
    assert.strictEqual(j1.app_id, 'live');
    assert.ok(job.orphans({ grace: 1000 }).includes(fresh), 'a file idle past the grace is an orphan');
    console.log('✅ orphan sweep: idle recordings nothing holds are queued once; live, chunk-upload and fresh ones are not');

    // ── 2. Running it finalizes from the measured file ──
    measurable(1800.2);
    const done = await worker.runNow(j1.id);
    assert.strictEqual(done.status, 'succeeded');
    const res = JSON.parse(done.result);
    assert.deepStrictEqual([res.outcome, res.duration_seconds, res.duration_source], ['ready', 1800, 'probe']);
    assert.deepStrictEqual([vod(idle).is_recording, vod(idle).duration_seconds, vod(idle).health_status], [0, 1800, 'ok']);
    console.log('✅ vod.finalize settles an orphan to its measured duration');

    // ── 3. A finalize that cannot measure queues a retry (5 min out); the job retries with backoff ──
    unmeasurable();
    const bad = makeVod('bad.mp4');
    await require('../server/vod/finalize').finalizeVod(bad);
    assert.strictEqual(vod(bad).health_status, 'needs_review');
    let js = jobsFor(bad);
    assert.strictEqual(js.length, 1, 'one retry queued');
    assert.strictEqual(js[0].created_by, 'system:vod.finalize:probe_failed');
    const due = db.get("SELECT (julianday(run_after) - julianday('now')) * 86400 AS s FROM media_jobs WHERE id = ?", [js[0].id]).s;
    assert.ok(due > 250 && due <= 301, `first retry in ~5 minutes (${due})`);
    let r = await worker.runNow(js[0].id);
    assert.strictEqual(r.status, 'queued', 'still unmeasurable: back in the queue');
    assert.strictEqual(r.error_code, 'unmeasurable');
    assert.strictEqual(r.attempts, 1);
    assert.strictEqual(jobsFor(bad).length, 1, 'the job does not queue more of itself');
    const wait = db.get("SELECT (julianday(run_after) - julianday('now')) * 86400 AS s FROM media_jobs WHERE id = ?", [r.id]).s;
    assert.ok(wait > 250 && wait <= 301, `backoff after attempt 1 is 5 minutes (${wait})`);
    assert.deepStrictEqual([job.backoffS(1), job.backoffS(2), job.backoffS(3), job.backoffS(6)], [300, 900, 2700, 21600]);
    measurable(610);
    r = await worker.runNow(r.id);
    assert.strictEqual(r.status, 'succeeded');
    const v = vod(bad);
    assert.deepStrictEqual([v.duration_seconds, v.health_status, v.is_public, v.quarantined_at], [610, 'ok', 1, null], 'measured, un-quarantined');
    console.log('✅ unmeasurable finalize → retry job (5 min), retried with backoff, settles once the file measures');

    // ── 4. Stat failure and a thrown finalize queue a retry too (not just is_recording = 0) ──
    const gone = makeVod('gone.mp4');
    tools.probeDuration = async (p) => { if (p.endsWith('gone.mp4')) { try { fs.unlinkSync(p); } catch { /* */ } } return { ok: true, seconds: 300, format: {}, streams: [], error: null }; };
    await require('../server/vod/finalize').finalizeVod(gone);
    assert.deepStrictEqual(jobsFor(gone).map(j => j.created_by), ['system:vod.finalize:stat_failed']);
    const thrower = makeVod('thrower.mp4');
    tools.remuxForSeekingDetailed = async () => { throw new Error('boom'); };
    await assert.rejects(require('../server/vod/finalize').finalizeVod(thrower), /boom/);
    assert.deepStrictEqual(jobsFor(thrower).map(j => j.created_by), ['system:vod.finalize:finalize_failed']);
    assert.strictEqual(vod(thrower).is_recording, 1, 'still unsettled, and the job knows it');
    measurable(95);
    const tr = await worker.runNow(jobsFor(thrower)[0].id);
    assert.strictEqual(tr.status, 'succeeded');
    assert.strictEqual(vod(thrower).duration_seconds, 95);
    console.log('✅ a stat failure or a thrown finalize queues vod.finalize, which settles it later');

    // ── 5. Never touches a live recording; out of attempts the VOD waits for a person ──
    const jl = queue.enqueue({ appId: 'live', type: 'vod.finalize', params: { vod_id: live }, createdBy: 'test' }).job;
    const lr = await worker.runNow(jl.id);
    assert.strictEqual(JSON.parse(lr.result).outcome, 'skipped');
    assert.strictEqual(vod(live).is_recording, 1, 'the recording keeps going');
    recorder.activeRecordings.delete(live);
    vodRoutes.activeChunkUploads.delete(chunked);

    unmeasurable();
    const last = makeVod('last.mp4');
    const jlast = queue.enqueue({ appId: 'live', type: 'vod.finalize', params: { vod_id: last }, createdBy: 'test', maxAttempts: 1 }).job;
    const out = await worker.runNow(jlast.id);
    assert.deepStrictEqual([out.status, out.error_code], ['failed', 'unmeasurable']);
    assert.deepStrictEqual([vod(last).is_recording, vod(last).duration_seconds, vod(last).health_status, vod(last).is_public], [0, 0, 'needs_review', 0]);
    restore();
    console.log('✅ a live recording is never finalized by the job; out of attempts the VOD stays needs_review, hidden');

    // ── 6. API validation: the VOD must be the tenant's ──
    const gv = makeVod('games.mp4', { app: 'games' });
    assert.throws(() => job.spec.validate({ appId: 'live', obj: null, params: { vod_id: gv } }), (e) => e.code === 'media.job.not_found');
    assert.deepStrictEqual(job.spec.validate({ appId: 'games', obj: null, params: { vod_id: gv } }), { vod_id: gv });
    assert.throws(() => job.spec.validate({ appId: 'games', obj: null, params: {} }), (e) => e.code === 'media.job.invalid');
    console.log('✅ vod.finalize through the jobs API is scoped to the tenant\'s own VODs');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n✅ All vod.finalize job tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
