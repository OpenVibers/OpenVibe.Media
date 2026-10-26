#!/usr/bin/env node
'use strict';
/**
 * Re-cut the recordings whose source timeline was cut as one shape although their picture changes shape mid-stream
 * (server/jobs/shapes.js, docs/media-fabric.md §3: VOD 6017 played its portrait part stretched into 16:9), for the
 * operator.
 *
 *   node scripts/recut-shapes.js [--days 30] [--limit 200] [--app live] [--ids 6017,6020] [--remote] [--apply] [--json]
 *       Dry run (the default): for each finished VOD of the window, newest first, whose object has a source timeline
 *       with one init and a local file (--remote also reads B2/R2 copies, which is egress), reads its keyframe sizes
 *       and reports the ones with more than one, with the periods a re-cut would make. Changes nothing.
 *       --apply queues object.cmaf for each of those (idempotency key object.cmaf:<object>:shapes, so a second run
 *       answers with the same job). The running service's worker cuts them on its next poll, one at a time in the heavy
 *       lane at nice 15; the new rows replace the old ones in one transaction, and playback never stops.
 *   (the database is the service's: DATABASE_URL, and MEDIA_HLS_ENABLED / MEDIA_CMAF_TRANSCODE, from its env file)
 *
 * Exit codes: 0 done, 1 error, 2 bad usage.
 */

(async () => {
    await require('../server/db/database').initDb();   // PostgreSQL (DATABASE_URL), as the service
    const args = process.argv.slice(2);
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, d = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
    const usage = (msg) => { console.error(`recut-shapes: ${msg}`); process.exit(2); };
    for (const flag of ['days', 'limit', 'app', 'ids']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
    const APPLY = has('apply');
    const days = Number(arg('days', 30));
    const limit = Number(arg('limit', 200));
    if (!(days > 0) || !(limit > 0)) usage('--days and --limit are positive numbers');
    const ids = arg('ids') ? arg('ids').split(',').map(Number).filter((n) => n > 0) : null;

    const config = require('../server/config');
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const timeline = require('../server/objects/timeline');
    const derive = require('../server/jobs/derive');
    const shapes = require('../server/jobs/shapes');
    if (!config.hls.enabled || !config.hls.transcode) usage('the re-cut needs MEDIA_HLS_ENABLED=1 and MEDIA_CMAF_TRANSCODE=1 (the service\'s env file)');
    if (APPLY) await require('../server/events').initWriter();

    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const vods = ids
        ? await db.all('SELECT id, app_id, object_id, title FROM vods WHERE id = ANY(?) ORDER BY id DESC', [ids])
        : await db.all(`SELECT id, app_id, object_id, title FROM vods WHERE is_recording = 0 AND object_id IS NOT NULL AND created_at >= ?
            ${has('app') ? 'AND app_id = ?' : ''} ORDER BY id DESC LIMIT ?`, has('app') ? [since, arg('app'), limit] : [since, limit]);
    const report = [];
    for (const v of vods) {
        const out = { vod: v.id, object: v.object_id, title: v.title };
        report.push(out);
        const obj = v.object_id && await model.getObject(v.object_id);
        if (!obj || obj.lifecycle_status !== 'ready') { out.skip = 'no ready object'; continue; }
        const rows = await timeline.list(obj.id, timeline.SOURCE);
        if (!rows.some((r) => Number(r.seq) > 0)) { out.skip = 'no source timeline (its first cut reads the shapes)'; continue; }
        if (rows.some((r) => timeline.shapeInitSeq(r.name) != null)) { out.skip = 'already cut in periods'; continue; }
        const source = await derive.resolveSource(obj);
        if (!source) { out.skip = 'no bytes'; continue; }
        if (source.remote && !has('remote')) { out.skip = 'only on B2/R2 (--remote reads it)'; continue; }
        try {
            const read = await shapes.probe(source, { timeoutMs: derive.budgetMs(obj.size_bytes) });
            if (!shapes.varies(read.changes)) { out.shapes = 1; continue; }
            const info = await derive.probeStreams(source);
            const periods = shapes.plan(read.changes, { end: read.start + info.duration });
            out.sizes = read.changes.length;
            out.periods = periods.map((p) => `${p.width}x${p.height} from ${(p.start - read.start).toFixed(1)} s`);
            if (APPLY) {
                const params = require('../server/jobs/cmaf').spec.validate({ appId: obj.app_id, obj, params: {} });
                const r = await require('../server/jobs/queue').enqueue({ appId: obj.app_id, type: 'object.cmaf', objectId: obj.id, params,
                    dedupeActive: true, idempotencyKey: `object.cmaf:${obj.id}:shapes`, createdBy: `operator:${require('os').userInfo().username}` });
                out.job = r.job ? r.job.id : null;
                out.queued = !!r.created;
            }
        } catch (err) { out.error = err.message.slice(0, 200); }
    }
    if (has('json')) console.log(JSON.stringify(report, null, 2));
    else {
        for (const r of report) {
            const what = r.skip ? `skip: ${r.skip}` : r.error ? `error: ${r.error}` : r.periods
                ? `${r.sizes} sizes → ${r.periods.join(', ')}${r.job ? `  ${r.queued ? 'queued' : 'already queued'} ${r.job}` : ''}`
                : 'one shape';
            console.log(`vod ${r.vod}  ${what}`);
        }
        const found = report.filter((r) => r.periods).length;
        console.log(`${report.length} checked, ${found} change shape${APPLY ? `, ${report.filter((r) => r.queued).length} queued` : found ? ' (dry run: --apply queues their re-cut)' : ''}`);
    }
    process.exit(report.some((r) => r.error) ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
