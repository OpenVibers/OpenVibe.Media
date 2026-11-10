#!/usr/bin/env node
'use strict';
/**
 * Repair recordings that do not decode (server/vod/vod-repair.js), for the operator.
 *
 * A recording is a stream copy of a WebRTC ingest: a lost RTP fragment leaves a truncated H.264 access unit. The muxer
 * writes it, ffprobe calls the file healthy, and a browser stops the whole playback on it (VODs 6297/6298, the robot
 * phone's 2026-11-10 streams: one corrupt P-frame each). The finalize decode check marks such a recording
 * `needs_repair` and hides it; the health job repairs it on its next idle pass. This script is the explicit path for
 * a known id (and for recordings finalized before the check existed).
 *
 *   node scripts/repair-vod-decode.js [--ids 6297,6298] [--days 7] [--limit 50] [--app live] [--full]
 *                                     [--no-recut] [--apply] [--json]
 *       Dry run (the default): decode the opening 10 s of each finished VOD (--full: the whole file) and report the
 *       ones that fail, with the first decoder errors. Changes nothing.
 *       --apply: re-encode each broken file in place (the corrupt access unit becomes the decoder's concealed picture;
 *       duration and the original timing are kept), verify it, update the duration/size/health through Media's own row
 *       writes, lift the quarantine, announce vod.ready and queue a fresh object.cmaf cut (--no-recut skips the cut)
 *       so the streaming playlist serves the repaired bytes too. The running service's worker cuts it on its next poll.
 *   (the database is the service's: DATABASE_URL, and MEDIA_HLS_ENABLED for the re-cut, from its env file)
 *
 * Exit codes: 0 done, 1 error, 2 bad usage.
 */
(async () => {
    const args = process.argv.slice(2);
    const has = (name) => args.includes(`--${name}`);
    const arg = (name, d = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
    const usage = (msg) => { console.error(`repair-vod-decode: ${msg}`); process.exit(2); };
    for (const flag of ['ids', 'days', 'limit', 'app']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
    const APPLY = has('apply');
    const FULL = has('full');
    const RECUT = !has('no-recut');
    const days = Number(arg('days', 7));
    const limit = Number(arg('limit', 50));
    if (!(days > 0) || !(limit > 0)) usage('--days and --limit are positive numbers');
    const ids = arg('ids') ? arg('ids').split(',').map(Number).filter((n) => n > 0) : null;
    if (has('ids') && (!ids || !ids.length)) usage('--ids needs one or more VOD ids');

    await require('../server/db/database').initDb();   // PostgreSQL (DATABASE_URL), as the service
    const db = require('../server/db/database');
    const repair = require('../server/vod/vod-repair');
    if (APPLY) {
        await require('../server/events').initWriter();
        if (RECUT && !require('../server/config').hls.enabled) console.warn('repair-vod-decode: MEDIA_HLS_ENABLED is off — files are repaired, no timeline is cut');
    }

    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const vods = ids
        ? await db.all('SELECT * FROM vods WHERE id = ANY(?) ORDER BY id DESC', [ids])
        : await db.all(`SELECT * FROM vods WHERE COALESCE(is_recording, 0) = 0 AND created_at >= ?
            ${has('app') ? 'AND app_id = ?' : ''} ORDER BY id DESC LIMIT ?`, has('app') ? [since, arg('app'), limit] : [since, limit]);
    if (!vods.length) usage('no VODs matched');

    const report = [];
    for (const vod of vods) {
        const out = { vod: vod.id, title: vod.title, health: vod.health_status };
        report.push(out);
        try {
            const r = await repair.repairVod(vod, { full: FULL, apply: APPLY, recut: RECUT, announceReady: APPLY });
            Object.assign(out, r);
        } catch (err) {
            out.error = String(err.message || err).slice(0, 300);
        }
    }
    if (has('json')) console.log(JSON.stringify(report, null, 2));
    else {
        for (const r of report) {
            const what = r.error ? `error: ${r.error}` : r.skipped === 'clean' ? 'clean'
                : r.skipped === 'needs_repair' && !APPLY ? `needs repair (${(r.before.errors || [])[0] || `exit ${r.before.code}`})`
                : r.skipped ? `skip: ${r.skipped}`
                : r.ok ? `repaired → ${r.duration}s, ${(r.size / 1048576).toFixed(1)}MB${r.recut ? `, re-cut queued ${r.recut}` : ''}${r.recutError ? ` (re-cut error: ${r.recutError})` : ''}`
                : 'failed';
            console.log(`vod ${r.vod}  ${what}`);
        }
        const broken = report.filter((r) => r.before && !r.before.ok).length;
        console.log(`${report.length} checked, ${broken} do not decode${APPLY ? `, ${report.filter((r) => r.ok && !r.skipped).length} repaired` : broken && !FULL ? ' (dry run: --apply repairs; --full decodes the whole file)' : ''}`);
    }
    process.exit(report.some((r) => r.error) ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
