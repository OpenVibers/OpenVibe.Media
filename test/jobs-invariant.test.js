'use strict';
// The size-invariant validator job (invariant.scan) and the jobs it proposes. The validator lists public
// playback objects over MEDIA_PUBLIC_OBJECT_MAX_MB and PROPOSES object.split (duration known) or
// object.remux (duration unknown). Proposals never run by themselves: the worker leaves them alone until
// their owner approves; a rejected proposal stays rejected; a proposal whose object stopped violating is
// withdrawn; --dry-run writes nothing. Then, with ffmpeg, the approved split and a remux make private
// derived objects and leave the source untouched, and a retry resumes after the checkpointed parts.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-jobinv-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    process.env.VOD_PATH = dir('vods');
    process.env.CLIPS_PATH = dir('clips');
    process.env.FILES_PATH = dir('files');
    process.env.THUMBNAILS_PATH = dir('thumbnails');
    process.env.PASTES_PATH = dir('pastes');
    process.env.OBJECTS_PATH = dir('objects');
    process.env.MEDIA_JOBS_POLL_MS = '50';
    process.env.MEDIA_INVARIANT_SCAN_HOURS = '0';
    process.env.MEDIA_UPLOAD_MIN_FREE_MB = '0';

    const MB = 1024 * 1024;
    const stub = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
            res.statusCode = 404; res.end('{}');
        });
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 20000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
        return false;
    };
    const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

    (async () => {
        await new Promise((r) => stub.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${stub.address().port}`;
        const db = require('../server/db/database');
        const conn = db.getDb();
        await db.upsertApp({ app_id: 'live', api_key: 'live-key' });
        const events = require('../server/events');
        events.init({ eventsUrl: base, clientSecret: 's', networkUrl: base, intervalMs: 60000 });
        const config = require('../server/config');
        const model = require('../server/objects/model');
        const queue = require('../server/jobs/queue');
        const worker = require('../server/jobs/worker');
        const scan = require('../server/jobs/invariant-scan');
        const outbox = async () => (await conn.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
        const jobEvents = async (id) => (await outbox()).filter((e) => e.subject.type === 'job' && e.subject.id === id).map((e) => e.event_type);

        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/api/v2/:app/jobs', require('../server/jobs/routes'));
        const server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const api = `http://127.0.0.1:${server.address().port}`;
        const call = async (method, p, { body, headers = {} } = {}) => {
            const h = { authorization: 'Bearer live-key', ...headers };
            if (body !== undefined) h['content-type'] = 'application/json';
            const res = await fetch(api + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        const mk = async (o) => await model.createObject({ app_id: 'live', owner_user_id: 5, lifecycle_status: 'ready', mime_type: 'video/webm', ...o });

        // ── A. The validator proposes, never runs ──
        const bigVod = await mk({ kind: 'vod', visibility: 'public', size_bytes: 1536 * MB, metadata: { duration_seconds: 3600 } });
        const noDur = await mk({ kind: 'vod', visibility: 'unlisted', size_bytes: 800 * MB, metadata: {} });
        await mk({ kind: 'vod', visibility: 'private', size_bytes: 2048 * MB, metadata: { duration_seconds: 10 } });
        await mk({ kind: 'clip', visibility: 'public', size_bytes: 100 * MB });
        await mk({ kind: 'clip', visibility: 'public', size_bytes: 400 * MB, metadata: { duration_seconds: 60 } });

        const before = (await db.get('SELECT COUNT(*) AS n FROM media_jobs')).n;
        const dry = await scan.scanTenant('live', { dryRun: true });
        assert.deepStrictEqual([dry.violations, dry.proposed, dry.by_type], [2, 2, { 'object.split': 1, 'object.remux': 1 }]);
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_jobs')).n, before, '--dry-run proposes nothing');
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_invariant_violations')).n, 0, '--dry-run records nothing');

        const s1 = await queue.enqueue({ appId: 'live', type: 'invariant.scan', createdBy: 'test' });
        const ran = await worker.runNow(s1.job.id);
        assert.strictEqual(ran.status, 'succeeded', ran.error);
        const r1 = queue.jobPublic(ran).result;
        assert.deepStrictEqual([r1.violations, r1.proposed, r1.already_proposed, r1.counts.warn], [2, 2, 0, 1]);
        const proposals = (await db.all("SELECT * FROM media_jobs WHERE status = 'proposed' ORDER BY id")).map(queue.jobPublic);
        const split = proposals.find((p) => p.object_id === bigVod);
        const remux = proposals.find((p) => p.object_id === noDur);
        assert.strictEqual(split.type, 'object.split');
        assert.deepStrictEqual([split.params.parts, split.params.segment_seconds, split.params.max_bytes], [6, 600, 500 * MB], '1.5 GB in parts of about the 256 MB target');
        assert.strictEqual(remux.type, 'object.remux', 'no duration: remux first');
        assert.strictEqual(split.idempotency_key, `invariant:${bigVod}:object.split`);
        assert.deepStrictEqual(await jobEvents(split.id), ['media.job.proposed']);
        const proposedEv = (await outbox()).find((e) => e.subject.id === split.id).payload;
        assert.deepStrictEqual([proposedEv.status, proposedEv.type, proposedEv.object_id, proposedEv.decided_at, proposedEv.started_at, proposedEv.has_result], ['proposed', 'object.split', bigVod, null, null, false]);
        for (const k of ['params', 'idempotency_key', 'created_by', 'decided_by', 'owner_user_id', 'result', 'error']) assert.ok(!(k in proposedEv), `the proposal's event has no ${k}`);
        assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(proposedEv.created_at), 'ISO 8601 UTC');
        assert.strictEqual((await outbox()).find((e) => e.subject.id === split.id).priority, 'important', 'a proposal waiting for its owner is important');

        await worker.start();
        for (let i = 0; i < 5; i++) { worker.kick(); await sleep(60); }
        assert.deepStrictEqual([(await queue.get(split.id)).status, (await queue.get(remux.id)).status, (await queue.get(split.id)).attempts], ['proposed', 'proposed', 0], 'the worker never runs a proposal');

        const again = await scan.scanTenant('live');
        assert.deepStrictEqual([again.proposed, again.already_proposed], [0, 2], 'a later scan proposes nothing twice');
        let r = await call('POST', `/api/v2/live/jobs/${remux.id}/cancel`);
        assert.deepStrictEqual([r.status, r.body.job.status, r.body.job.decided_by], [200, 'cancelled', 'app:live'], 'the owner rejects a proposal');
        await scan.scanTenant('live');
        assert.strictEqual((await queue.get(remux.id)).status, 'cancelled', 'a rejected proposal stays rejected');
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_jobs WHERE object_id = ?', [noDur])).n, 1, 'and is not proposed again');
        await model.updateObject(bigVod, { visibility: 'private' });
        const w = await scan.scanTenant('live');
        assert.strictEqual(w.withdrawn, 1);
        assert.deepStrictEqual([(await queue.get(split.id)).status, (await queue.get(split.id)).decided_by], ['cancelled', 'system:invariant.scan'], 'a proposal whose object stopped violating is withdrawn');

        config.jobs.invariantScanHours = 24;
        await model.updateObject(bigVod, { visibility: 'public' });
        const scheduled = await worker.scheduleInvariantScans(Date.now());
        assert.strictEqual(scheduled, 1, 'one scheduled scan per tenant with public playback objects');
        assert.strictEqual(await worker.scheduleInvariantScans(Date.now()), 0, 'once per period');
        config.jobs.invariantScanHours = 0;
        assert.ok(await waitFor(async () => (await db.get("SELECT status FROM media_jobs WHERE job_type = 'invariant.scan' AND created_by = 'system:schedule'")).status === 'succeeded'));
        console.log('✅ invariant.scan proposes split/remux for public objects over the limit; nothing runs until the owner decides');

        // ── B. Approved and explicit split/remux jobs (ffmpeg) ──
        r = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.split', object_id: await model.createObject({ app_id: 'live', kind: 'file', lifecycle_status: 'ready', size_bytes: 1 }), params: { parts: 2 } } });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'media.job.invalid'], 'only media objects are split');
        r = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.split', object_id: bigVod, params: { parts: 1 } } });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'media.job.invalid'], 'parts 2-1000');

        if (!hasFfmpeg) {
            console.log('split/remux execution: skipped (ffmpeg not found)');
        } else {
            const src = path.join(process.env.VOD_PATH, 'rec-10.mp4');
            const mk6 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
                '-c:v', 'mpeg4', '-g', '10', '-c:a', 'aac', '-shortest', src]);
            assert.strictEqual(mk6.status, 0, String(mk6.stderr));
            const size = fs.statSync(src).size;
            await conn.prepare("INSERT INTO vods (id, app_id, user_id, title, file_path, file_size, is_public, duration_seconds) OVERRIDING SYSTEM VALUE VALUES (10, 'live', 5, 'Six seconds', ?, ?, 1, 6) RETURNING id").run(src, size);
            const vodObj = (await model.sync('vod', 10)).id;
            const srcBefore = await model.getObject(vodObj);
            const locsBefore = JSON.stringify(await model.listLocations(vodObj));

            // The validator proposes a split once the policy says the object is too large; the owner approves it.
            config.objects.publicMaxMb = 0;
            config.objects.publicTargetMb = 0;
            await scan.scanTenant('live');
            const prop = queue.jobPublic(await db.get("SELECT * FROM media_jobs WHERE object_id = ? AND status = 'proposed'", [vodObj]));
            assert.deepStrictEqual([prop.type, prop.params.segment_seconds], ['object.split', 1]);
            r = await call('POST', `/api/v2/live/jobs/${prop.id}/approve`);
            assert.deepStrictEqual([r.status, r.body.job.status, r.body.job.decided_by], [200, 'queued', 'app:live']);
            assert.ok(await waitFor(async () => ['succeeded', 'failed'].includes((await queue.get(prop.id)).status)), 'the approved split runs');
            const done = queue.jobPublic(await queue.get(prop.id));
            assert.strictEqual(done.status, 'succeeded', done.error);
            assert.deepStrictEqual(await jobEvents(prop.id), ['media.job.proposed', 'media.job.queued', 'media.job.started', 'media.job.succeeded']);
            assert.strictEqual(done.result.parts.length, 6, '6 s in 1 s parts');
            let total = 0;
            for (const p of done.result.parts) {
                const o = await model.getObject(p.object_id);
                assert.deepStrictEqual([o.visibility, o.lifecycle_status, o.kind, o.app_id, o.owner_user_id, o.legacy_ref, o.mime_type], ['private', 'ready', 'vod', 'live', 5, null, 'video/mp4']);
                const loc = (await model.listLocations(o.id))[0];
                assert.deepStrictEqual([loc.provider, loc.state, loc.size_bytes], ['local', 'present', o.size_bytes]);
                assert.ok(fs.existsSync(loc.key) && loc.key.startsWith(path.join(process.env.OBJECTS_PATH, 'live')));
                const rel = await db.get("SELECT * FROM media_relationships WHERE from_object_id = ? AND relation = 'derived_from'", [o.id]);
                assert.strictEqual(rel.to_object_id, vodObj);
                assert.deepStrictEqual([JSON.parse(rel.metadata).job_id, JSON.parse(rel.metadata).part], [prop.id, p.part]);
                total += p.duration_seconds;
            }
            assert.ok(Math.abs(total - 6) < 0.5, 'the parts cover the source');
            const srcAfter = await model.getObject(vodObj);
            assert.deepStrictEqual([srcAfter.visibility, srcAfter.size_bytes, srcAfter.lifecycle_status, srcAfter.content_hash], [srcBefore.visibility, srcBefore.size_bytes, 'ready', srcBefore.content_hash], 'the source is unchanged');
            assert.strictEqual(JSON.stringify(await model.listLocations(vodObj)), locsBefore);
            assert.strictEqual(fs.statSync(src).size, size, 'its bytes too');
            assert.ok(!fs.existsSync(path.join(process.env.OBJECTS_PATH, '.jobs', prop.id)), 'the work directory is removed');
            config.objects.publicMaxMb = 500;
            config.objects.publicTargetMb = 256;

            // A retry resumes after the parts its checkpoint names.
            const resumed = await queue.enqueue({ appId: 'live', type: 'object.split', objectId: vodObj, params: { parts: 3 }, createdBy: 'test' });
            await queue.saveCheckpoint(resumed.job.id, { parts: [{ part: 1, object_id: 'med_done_before', start_seconds: 0, duration_seconds: 2, size_bytes: 10 }] });
            assert.ok(await waitFor(async () => (await queue.get(resumed.job.id)).status === 'succeeded'));
            const rr = queue.jobPublic(await queue.get(resumed.job.id)).result;
            assert.deepStrictEqual(rr.parts.map((p) => p.part), [1, 2, 3]);
            assert.strictEqual(rr.parts[0].object_id, 'med_done_before', 'part 1 was not cut again');
            assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM media_relationships WHERE relation = 'derived_from' AND json_extract(metadata, '$.job_id') = ?", [resumed.job.id])).n, 2);

            // A remux: one private object, the source's remux variant.
            r = await call('POST', '/api/v2/live/jobs', { body: { type: 'object.remux', object_id: `legacy:live:vod:10` }, headers: { 'idempotency-key': 'remux-10' } });
            assert.strictEqual(r.status, 202);
            assert.ok(await waitFor(async () => (await queue.get(r.body.job.id)).status === 'succeeded'));
            const rm = queue.jobPublic(await queue.get(r.body.job.id)).result;
            assert.deepStrictEqual([(await model.getObject(rm.object_id)).visibility, Math.round(rm.duration_seconds), (await model.getVariant(vodObj, 'remux')).derived_object_id], ['private', 6, rm.object_id]);
            console.log('✅ an approved split and a remux make private derived objects; the source is untouched; retries resume');
        }

        // ── C. The operator script: scan (dry run by default), approve, cancel; events go to the service's outbox ──
        worker.stop();
        const { runScript } = require('./helpers/run-script');
        const script = async (...a) => { const r = await runScript(path.join(__dirname, '../scripts/media-jobs.js'), a); return { status: r.code, stdout: r.out, stderr: r.err }; };
        const jobsBefore = (await db.get('SELECT COUNT(*) AS n FROM media_jobs')).n;
        let sc = await script('scan', '--app', 'live', '--json');
        assert.strictEqual(sc.status, 0, sc.stderr);
        assert.strictEqual(JSON.parse(sc.stdout).live.dry_run, true);
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM media_jobs')).n, jobsBefore, 'scan is a dry run unless --apply');
        const manual = await queue.enqueue({ appId: 'live', type: 'object.remux', objectId: bigVod, status: 'proposed', createdBy: 'test' });
        sc = await script('approve', manual.job.id, '--by', 'owner');
        assert.strictEqual(sc.status, 0, sc.stderr);
        assert.deepStrictEqual([(await queue.get(manual.job.id)).status, (await queue.get(manual.job.id)).decided_by], ['queued', 'owner']);
        assert.ok((await jobEvents(manual.job.id)).includes('media.job.queued'), "the script's change queued its event in the outbox");
        const approvedEv = (await outbox()).filter((e) => e.subject.id === manual.job.id && e.event_type === 'media.job.queued').pop().payload;
        assert.ok(/Z$/.test(approvedEv.decided_at) && !('decided_by' in approvedEv) && !JSON.stringify(approvedEv).includes('owner'), 'the approval is dated, its decider is not published');
        sc = await script('cancel', manual.job.id, '--by', 'owner');
        assert.strictEqual(sc.status, 0, sc.stderr);
        assert.strictEqual((await queue.get(manual.job.id)).status, 'cancelled');
        assert.strictEqual((await script('approve', 'mjob_nope')).status, 1);
        sc = await script('list', '--status', 'cancelled', '--json');
        assert.ok(JSON.parse(sc.stdout).jobs.some((j) => j.id === manual.job.id));
        console.log('✅ scripts/media-jobs.js: scan dry-run, approve and cancel with their events');

        events._reset();
        server.close();
        stub.close();
        console.log('\njobs-invariant: all checks passed');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
