'use strict';
// The health job's layout sweep (2026-11-20; vod/mp4-layout.js): a finished MP4 left fragmented plays from a URL only
// after the browser walked the whole file (openvibe.video waited 40 s on a 370 MB recording). Checked here, on real
// MP4s ffmpeg makes (skipped without ffmpeg, like the other ffmpeg tests):
//   - layoutOf reads the first box headers from a file or over https (ranges): fragmented vs faststart; not an MP4;
//   - a fragmented local recording is remuxed into a faststart one that replaces it only after it checks out (the
//     moov first, no moof, its length); a remote one is brought here first (moveToHot); a faststart one is only marked;
//   - a remux that does not check out leaves the recording exactly as it was;
//   - a pass remuxes at most one recording.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const have = (bin) => { try { execFileSync(bin, [bin === 'openssl' ? 'version' : '-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
if (!have('ffmpeg') || !have('ffprobe') || !have('openssl')) { console.log('vod layout sweep: skipped (needs ffmpeg, ffprobe and openssl)'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-layout-'));
const make = (name, flags) => {
    const out = path.join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', '-shortest', '-movflags', flags, out]);
    return out;
};
const FRAG = make('frag.mp4', '+frag_keyframe+empty_moov+default_base_moof');
const FAST = make('fast.mp4', '+faststart');

// Stand-ins: the database, the objects view and the storage tier.
const stub = (rel, exports) => {
    const file = require.resolve(path.join(__dirname, '..', rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const runs = [];
let rows = [];
let fresh = null;
stub('server/db/database', {
    run: async (sql, params) => { runs.push([sql.replace(/\s+/g, ' ').trim(), params]); return { changes: 1 }; },
    get: async () => fresh,
    all: async () => rows,
});
stub('server/objects/model', { withObject: async (kind, id, fn) => await fn() });
const storageCalls = [];
let presigned = null;
let hotFile = null;
stub('server/vod/vod-storage', {
    localPathForVod: (v) => v.local || null,
    presignGet: async () => presigned,
    moveToHot: async (id) => { storageCalls.push(['moveToHot', id]); if (!hotFile) return { ok: false, error: 'download stalled' }; fresh = { id, local: hotFile }; return { ok: true }; },
});
const layout = require('../server/vod/mp4-layout');
const job = require('../server/vod/health-job');
// The free-disk guard keeps 5 GB or a tenth of the disk free; a test machine's /tmp (a tmpfs on our CI) may have less.
// The sweep reads it at call time, so a room-enough stand-in covers these few-KB files.
require('../server/vod/media-tools').hasRoomFor = async () => true;
const said = console.log; const warned = console.warn;
console.log = () => {}; console.warn = () => {};
const copy = (from, name) => { const to = path.join(dir, name); fs.copyFileSync(from, to); return to; };

/** A one-file https server with Range support (a stand-in for B2/R2's presigned URL). */
function serve(file) {
    const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => {
        const size = fs.statSync(file).size;
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        if (!m) { res.writeHead(200, { 'content-length': size }); return fs.createReadStream(file).pipe(res); }
        const start = Number(m[1]), end = Math.min(Number(m[2]), size - 1);
        if (start >= size) { res.writeHead(416); return res.end(); }
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
    try {
        // The layouts, from a file.
        const frag = await layout.layoutOf({ filePath: FRAG });
        assert.deepStrictEqual([frag.ok, frag.fragmented, frag.kinds.slice(0, 3)], [true, true, ['ftyp', 'moov', 'moof']]);
        const fast = await layout.layoutOf({ filePath: FAST });
        assert.deepStrictEqual([fast.ok, fast.fragmented, fast.moovFirst], [true, false, true]);
        const text = path.join(dir, 'not.mp4'); fs.writeFileSync(text, '\x1aE\xdf\xa3 not an mp4 at all, a WebM header');
        assert.deepStrictEqual([(await layout.layoutOf({ filePath: text })).ok, (await layout.layoutOf({ filePath: text })).error], [false, 'not an MP4']);

        // Over https with ranges (a presigned URL).
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const server = await serve(FRAG);
        const url = `https://127.0.0.1:${server.address().port}/v/1`;
        const remote = await layout.layoutOf({ url });
        assert.deepStrictEqual([remote.ok, remote.fragmented], [true, true], JSON.stringify(remote));

        // A fragmented local recording: remuxed, checked, in place; the row records its size and the check.
        const local = copy(FRAG, 'local.mp4');
        let out = await job._checkLayout({ id: 11, local, file_path: local, duration_seconds: 6 });
        assert.strictEqual(out.status, 'remuxed');
        const after = await layout.layoutOf({ filePath: local });
        assert.deepStrictEqual([after.fragmented, after.moovFirst], [false, true]);
        assert.ok(!fs.existsSync(local + '.layout.mp4'), 'no copy left beside it');
        assert.ok(runs.some(([sql, p]) => /SET file_size = \?, layout_checked_at = \?/.test(sql) && p[0] === fs.statSync(local).size && p[2] === 11));

        // A faststart one is only marked.
        runs.length = 0;
        const okFile = copy(FAST, 'ok.mp4');
        out = await job._checkLayout({ id: 12, local: okFile, file_path: okFile, duration_seconds: 6 });
        assert.strictEqual(out.status, 'ok');
        assert.ok(runs.length === 1 && /SET layout_checked_at = \?/.test(runs[0][0]));

        // A remote fragmented one: read through its presigned URL, brought here, remuxed.
        presigned = url; hotFile = copy(FRAG, 'hot.mp4');
        out = await job._checkLayout({ id: 13, storage_provider: 'b2', storage_key: 'vods/13.mp4', duration_seconds: 6 });
        assert.strictEqual(out.status, 'remuxed');
        assert.deepStrictEqual(storageCalls, [['moveToHot', 13]]);
        assert.strictEqual((await layout.layoutOf({ filePath: hotFile })).fragmented, false);

        // A remux that does not check out (the row says 400 s, the file is 6 s): the recording stays exactly as it was.
        const keep = copy(FRAG, 'keep.mp4');
        const before = fs.readFileSync(keep);
        out = await job._checkLayout({ id: 14, local: keep, file_path: keep, duration_seconds: 400 });
        assert.strictEqual(out.status, 'remux_failed');
        assert.ok(before.equals(fs.readFileSync(keep)), 'the original bytes are untouched');
        assert.ok(!fs.existsSync(keep + '.layout.mp4'));

        // A pass: the faststart ones are marked, and only one recording is remuxed.
        const a = copy(FAST, 'a.mp4'), b = copy(FRAG, 'b.mp4'), c = copy(FRAG, 'c.mp4');
        rows = [{ id: 23, local: a, file_path: a, duration_seconds: 6 }, { id: 22, local: b, file_path: b, duration_seconds: 6 }, { id: 21, local: c, file_path: c, duration_seconds: 6 }];
        const pass = await job._layoutSweep();
        assert.deepStrictEqual(pass.map((x) => x.status), ['ok', 'remuxed'], JSON.stringify(pass));
        assert.strictEqual((await layout.layoutOf({ filePath: c })).fragmented, true, 'the next pass takes the next one');

        server.close();
        console.log = said;
        console.log('vod layout sweep: fragmented recordings are remuxed to faststart, checked before they replace anything; one a pass');
    } catch (e) { console.log = said; console.warn = warned; console.error(e); process.exit(1); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();
