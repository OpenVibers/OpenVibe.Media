/**
 * OpenVibe.Media — the picture's shapes over a video, and cutting it in one period per shape (docs/media-fabric.md §3).
 *
 * A recording is a stream copy of what the broadcaster sent. When their phone turns, or WebRTC lowers 720p to 360p on a
 * weak network, the frames change size at a keyframe while the file's header still names the first size. One encode
 * then scales every later frame to that first size (VOD 6017: a portrait street stretched into 16:9), and a stream copy
 * carries frames its init segment does not describe. So a cut that must re-encode reads the shapes first:
 *
 *   probe(source)          → { start, changes: [{ t, width, height }] }: the input's start time and each keyframe whose
 *                            size differs from the one before (one decode of the keyframes only; t in the input's own
 *                            seconds). `from`/`to` read only that window (a clip).
 *   plan(changes, { end }) → [{ start, end, width, height }]: the periods. Sizes within SAME_SHAPE of one aspect ratio
 *                            are one shape (a lowered resolution is not a new period); each period is drawn on the canvas
 *                            of its shape's largest size (long side at most MAX_SIDE). A period shorter than MIN_PERIOD_S
 *                            joins a neighbour, and there are at most MAX_PERIODS.
 *   fit(width, height)     the filter that puts any frame on a width×height canvas without stretching it: scaled to fit,
 *                          centred, bars for the rest. A frame of the period's own shape fills the canvas exactly.
 *   cut({ … })             one ffmpeg run per period into `out`, each with its own init segment (the first period's is
 *                          init.mp4; period n ≥ 2's is timeline.shapeInitName(n)) → the produced segments in order,
 *                          [{ name, seconds, init }] for segments.publishRendition. The playlist puts
 *                          #EXT-X-DISCONTINUITY + #EXT-X-MAP between periods (timeline.mediaPlaylist), so a player shows
 *                          each part at its own shape, the way an adaptive stream switches renditions.
 *
 * Periods are cut on the input's own timestamps (-copyts, trim/atrim at the period's edges, the next period sought to its
 * first keyframe), so no frame of one shape lands in the other's period; each period's timestamps continue where the
 * last one's ended, with no gap at the join (negative composition offsets: Chrome's native HLS stalls on a gap there).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const derive = require('./derive');
const timeline = require('../objects/timeline');
const { JobError } = require('./queue');

const SAME_SHAPE = 0.04;   // |ln(aspect a / aspect b)|: 1280x720 and 426x240 are one shape, 16:9 and 4:3 are not
const MIN_PERIOD_S = 5;
const MAX_PERIODS = 40;
const MAX_SIDE = 1920;

const aspect = (s) => s.width / s.height;
const sameShape = (a, b) => Math.abs(Math.log(aspect(a) / aspect(b))) < SAME_SHAPE;
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const secs = (t) => Number(t).toFixed(6).replace(/\.?0+$/, '') || '0';

/** Each keyframe's size, read with ffprobe (keyframes only). Resolves { start, changes }. */
function probe(source, { signal, timeoutMs = 30 * 60000, from = null, to = null } = {}) {
    return new Promise((resolve, reject) => {
        const args = ['-v', 'error', ...derive.inputArgs(source),
            ...(from != null ? ['-read_intervals', `${secs(from)}%${secs(to)}`] : []),
            '-select_streams', 'v:0', '-skip_frame', 'nokey',
            '-show_entries', 'frame=best_effort_timestamp_time,width,height:format=start_time', '-of', 'csv=p=0', source.input];
        let proc;
        try { proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { return reject(err); }
        try { require('os').setPriority(proc.pid, 10); } catch { /* best effort */ }
        const changes = [];
        let start = null;
        let rest = '';
        let stderr = '';
        let done = false;
        const line = (l) => {
            const f = l.trim().split(',');
            if (f.length === 1) { if (f[0] && f[0] !== 'N/A') start = Number(f[0]); return; }   // format=start_time
            const [t, width, height] = f.map(Number);
            if (!Number.isFinite(t) || !(width > 0) || !(height > 0)) return;
            const last = changes[changes.length - 1];
            if (!last || last.width !== width || last.height !== height) changes.push({ t, width, height });
        };
        const kill = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
        const timer = setTimeout(kill, timeoutMs);
        const finish = (err, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', kill);
            if (err) reject(err); else resolve(value);
        };
        if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true }); }
        proc.stdout.on('data', (d) => {
            const lines = (rest + d).split('\n');
            rest = lines.pop();
            for (const l of lines) line(l);
        });
        proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
        proc.on('error', (err) => finish(err));
        proc.on('close', (code) => {
            if (rest) line(rest);
            if (code !== 0) return finish(new Error(`ffprobe exited ${code}: ${stderr.trim().slice(-300)}`));
            finish(null, { start: Number.isFinite(start) ? start : (changes[0] ? changes[0].t : 0), changes });
        });
    });
}

/** The shape a set of runs mostly shows, and its largest size: { width, height } of the canvas. */
function canvasOf(runs) {
    const groups = [];
    for (const r of runs) {
        let g = groups.find((x) => sameShape(x.lead, r));
        if (!g) groups.push(g = { lead: r, seconds: 0, runs: [] });
        g.seconds += r.end - r.start;
        g.runs.push(r);
    }
    const main = groups.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    const big = main.runs.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const k = Math.min(1, MAX_SIDE / Math.max(big.width, big.height));
    return { width: even(big.width * k), height: even(big.height * k) };
}

/**
 * The periods of a video from its size changes (probe's `changes`), up to `end` (the input's end, its own seconds).
 * One size throughout → one period on that size.
 */
function plan(changes, { end } = {}) {
    if (!changes.length) return [];
    const last = Number.isFinite(end) && end > changes[changes.length - 1].t ? end : changes[changes.length - 1].t + 1;
    const runs = changes.map((c, i) => ({ start: c.t, end: i + 1 < changes.length ? changes[i + 1].t : last, width: c.width, height: c.height }));
    // Consecutive runs of one shape are one period.
    let periods = [];
    for (const r of runs) {
        const p = periods[periods.length - 1];
        if (p && sameShape(p.runs[0], r)) { p.runs.push(r); p.end = r.end; } else periods.push({ start: r.start, end: r.end, runs: [r] });
    }
    const merge = (i, j) => {   // j = i ± 1: the two become one period
        const [a, b] = i < j ? [periods[i], periods[j]] : [periods[j], periods[i]];
        a.runs.push(...b.runs);
        a.end = b.end;
        periods.splice(periods.indexOf(b), 1);
    };
    const regroup = () => {
        const out = [];
        for (const p of periods) {
            const q = out[out.length - 1];
            if (q && sameShape(canvasOf(q.runs), canvasOf(p.runs))) { q.runs.push(...p.runs); q.end = p.end; } else out.push(p);
        }
        periods = out;
    };
    // A short period (a turn and back, a few seconds at another size) joins its shorter neighbour: its frames are drawn
    // on that canvas with bars rather than given a discontinuity of their own.
    const len = (p) => p.end - p.start;
    const shortest = () => periods.reduce((m, p, i) => (len(p) < len(periods[m]) ? i : m), 0);
    while (periods.length > 1) {
        const i = shortest();
        if (len(periods[i]) >= MIN_PERIOD_S && periods.length <= MAX_PERIODS) break;
        const prev = periods[i - 1];
        const next = periods[i + 1];
        merge(i, !next || (prev && len(prev) <= len(next)) ? i - 1 : i + 1);
        regroup();
    }
    return periods.map((p) => ({ start: p.start, end: p.end, ...canvasOf(p.runs) }));
}

/** Whether the probe found more than one size: the cut must re-encode on the planned canvases. */
function varies(changes) {
    return changes.length > 1;
}

/** Fit any frame on a width×height canvas: scaled to fit (never stretched), centred, bars for the rest. */
function fit(width, height) {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

/**
 * Cut `periods` of `source` into `out` as HLS fMP4, one ffmpeg run per period.
 *   start        the input's start time (probe().start): the first period's output starts at 0
 *   encode(p, i) the codec arguments of period i (video encoder + audio codec); `-vf`/`-af` are this module's (the
 *                period's trim, its timestamps, the fit on its canvas: a rendition passes periods on its own canvases)
 *   audio        whether the input has an audio stream (mapped and trimmed with the video)
 * → [{ name, seconds, init }] in order. Throws JobError when a run fails or writes nothing.
 */
async function cut({ source, periods, start = 0, out, segmentSeconds, encode, audio, signal, timeoutMs, niceness = 15 }) {
    const list = [];
    let next = 1;
    for (const [i, p] of periods.entries()) {
        const init = i === 0 ? timeline.INIT_NAME : timeline.shapeInitName(i + 1);
        const from = i === 0 ? start : p.start;
        const edges = [i > 0 ? `start=${secs(p.start)}` : null, i + 1 < periods.length ? `end=${secs(p.end)}` : null].filter(Boolean).join(':');
        const trim = (f) => (edges ? `${f}=${edges},` : '');
        const playlist = path.join(out, `index-${i + 1}.m3u8`);
        // -ss only finds the keyframe at or before the period's start (an absolute timestamp, nothing dropped by
        // ffmpeg itself): the trim on the input's own timestamps is what cuts.
        const r = await derive.ffmpeg(['-y', '-nostdin', '-v', 'error', ...derive.inputArgs(source), '-copyts',
            ...(i > 0 ? ['-seek_timestamp', '1', '-noaccurate_seek', '-ss', secs(p.start)] : []), '-i', source.input,
            '-map', '0:v:0', ...(audio ? ['-map', '0:a:0?'] : []),
            '-vf', `${trim('trim')}setpts=PTS-${secs(from)}/TB,${fit(p.width, p.height)}`,
            ...(audio ? ['-af', `${trim('atrim')}asetpts=PTS-${secs(from)}/TB`] : []),
            ...encode(p, i),
            '-map_metadata', '-1', '-fflags', '+bitexact', '-flags', '+bitexact',
            ...(from > start ? ['-output_ts_offset', secs(from - start)] : []),
            '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_list_size', '0', '-hls_playlist_type', 'vod',
            // Negative composition offsets (CMAF's own rule): a period's first frame is presented at its decode time.
            // Without them the encoder's B-frame delay leaves a gap at each join, which hls.js jumps and Chrome's
            // native HLS stalls on.
            '-hls_segment_type', 'fmp4', '-hls_segment_options', 'movflags=+negative_cts_offsets', '-hls_fmp4_init_filename', init,
            '-start_number', String(next), '-hls_segment_filename', path.join(out, '%06d.m4s'), playlist],
        { signal, timeoutMs, niceness });
        if (signal && signal.aborted) throw signal.reason || new Error('aborted');
        const tail = String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300);
        if (!r.ok) {
            const unsupported = /Unknown encoder|not currently supported in container|could not find tag for codec|codec not supported/i.test(r.stderr);
            throw new JobError(unsupported ? 'codec_unsupported' : 'ffmpeg_failed', `ffmpeg exited ${r.code} (period ${i + 1} of ${periods.length}): ${tail}`, { permanent: unsupported });
        }
        const made = derive.existing(playlist) ? require('./segments').parsePlaylist(fs.readFileSync(playlist, 'utf8')) : [];
        if (!made.length || !derive.existing(path.join(out, init))) {
            throw new JobError('ffmpeg_failed', `ffmpeg wrote no segments for period ${i + 1} of ${periods.length} (${secs(p.start)}-${secs(p.end)} s): ${tail}`);
        }
        for (const s of made) list.push({ ...s, init });
        next += made.length;
    }
    return list;
}

module.exports = { SAME_SHAPE, MIN_PERIOD_S, MAX_PERIODS, MAX_SIDE, probe, plan, varies, fit, cut, canvasOf };
