#!/usr/bin/env node
'use strict';
/**
 * Repair the clips the old "past the recorded edge" squeeze broke, for the operator.
 *
 * Before Media#182, a live clip asked for 30 s past a recording whose newest keyframe was older had its start pushed up to
 * the edge: a 1 s window at the edge, whose cut failed (clips 493-498 of VOD 6010, 2026-10-26: "Clip: Seattle", "@Patrick",
 * "Dude don't bah", listed on Live's home as broken cards). Since #182 the window keeps its length and ends at the edge.
 * This gives each such clip that window: the length it was asked for (--seconds, 30) ending at its end, and makes it
 * virtual over its VOD's timeline at once (as POST /clips/:id/recut does), or queues a cut where the VOD has no timeline.
 *
 *   node scripts/repair-edge-clips.js [--max-window 2] [--seconds 30] [--ids 493,494] [--apply]
 *       Dry run (the default): lists the failed clips whose window is at most --max-window seconds, with the window a
 *       repair gives them. --apply repairs them: the row's window and its object in one transaction, then the clip turns
 *       virtual (clip.ready) or is queued a cut (clip.cut). The failed cut's leftover file is left to the orphans report.
 *   (the database is the service's: DATABASE_URL, and MEDIA_HLS_ENABLED, from its env file)
 *
 * Exit codes: 0 done, 1 error, 2 bad usage.
 */

(async () => {
    const args = process.argv.slice(2);
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, d = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
    const usage = (msg) => { console.error(`repair-edge-clips: ${msg}`); process.exit(2); };
    for (const flag of ['max-window', 'seconds', 'ids']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
    const APPLY = has('apply');
    const maxWindow = Number(arg('max-window', 2));
    const seconds = Number(arg('seconds', 30));
    if (!(maxWindow > 0) || !(seconds >= 1)) usage('--max-window and --seconds are positive numbers');
    const ids = arg('ids') ? arg('ids').split(',').map(Number).filter((n) => n > 0) : null;

    await require('../server/db/database').initDb();   // PostgreSQL (DATABASE_URL), as the service
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const clipJobs = require('../server/vod/clip-jobs');
    if (APPLY) await require('../server/events').initWriter();

    const rows = await db.all(`SELECT c.id, c.vod_id, c.title, c.start_time, c.end_time, v.duration_seconds AS vod_seconds
        FROM clips c JOIN vods v ON v.id = c.vod_id
        WHERE c.status = 'failed' AND (c.end_time - c.start_time) <= ? ${ids ? 'AND c.id = ANY(?)' : ''} ORDER BY c.id`, ids ? [maxWindow, ids] : [maxWindow]);
    if (!rows.length) { console.log('repair-edge-clips: nothing to repair'); process.exit(0); }
    let repaired = 0;
    for (const r of rows) {
        const end = Math.min(Number(r.end_time), Number(r.vod_seconds) || Number(r.end_time));
        const start = Math.max(0, end - seconds);
        console.log(`clip ${r.id} (vod ${r.vod_id}, "${String(r.title || '').slice(0, 40)}"): ${Number(r.start_time).toFixed(1)}-${Number(r.end_time).toFixed(1)} s → ${start.toFixed(1)}-${end.toFixed(1)} s`);
        if (!APPLY) continue;
        await model.withObject('clip', r.id, async () => await db.run(`UPDATE clips SET start_time = ?, end_time = ?, duration_seconds = ?, file_path = NULL,
            cut_error = NULL, cut_attempts = 0, cut_next_at = NULL WHERE id = ?`, [start, end, end - start, r.id]));
        // The same recovery as POST /clips/:id/recut: virtual where its VOD has a timeline, else a cut.
        const win = await clipJobs.timelineWindow(await db.getVodById(r.vod_id), start, end);
        const virtual = !!win;
        if (win) await clipJobs.makeVirtual(r.id, win);
        else await clipJobs.recutClip(r.id, { reason: 'edge repair' });
        console.log(`  ${virtual ? 'virtual over its VOD\'s timeline' : 'queued a cut'}`);
        repaired++;
    }
    console.log(APPLY ? `repair-edge-clips: ${repaired} repaired` : `repair-edge-clips: ${rows.length} to repair (dry run; --apply repairs them)`);
    process.exit(0);
})().catch((err) => { console.error('repair-edge-clips:', err.message); process.exit(1); });
