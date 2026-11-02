'use strict';
// A recording under 1 KB is empty (2026-11-02): VOD 1803 was 526 bytes for "51 seconds", rated ok, the #1 VOD on its
// channel with a blank card and nothing to play. The scanner calls such a file zero_byte (an empty one already was),
// and the health job picks one rated ok at once instead of waiting out its 30 days.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-tiny-'));
    const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
    Object.assign(process.env, {
        VOD_PATH: dir('vods'), CLIPS_PATH: dir('clips'), FILES_PATH: dir('files'),
        THUMBNAILS_PATH: dir('thumbnails'), PASTES_PATH: dir('pastes'), OBJECTS_PATH: dir('objects'), MEDIA_INVARIANT_SCAN_HOURS: '0',
    });
    const db = require('../server/db/database');
    const scanner = require('../server/vod/health-scanner');
    await db.upsertApp({ app_id: 'live', api_key: 'live-key-tiny' });
    const V = process.env.VOD_PATH;
    const tiny = path.join(V, 'tiny.webm');
    fs.writeFileSync(tiny, Buffer.alloc(526, 1));
    const empty = path.join(V, 'empty.webm');
    fs.writeFileSync(empty, '');
    const ins = async (file, size) => Number((await db.run(`INSERT INTO vods (app_id, title, file_path, file_size, duration_seconds, is_public, visibility, health_status, last_health_scan_at)
        VALUES ('live', 't', ?, ?, 51, 1, 'public', 'ok', now()) RETURNING id`, [file, size])).lastInsertRowid);
    const tinyId = await ins(tiny, 526);
    const bigId = await ins(path.join(V, 'big.webm'), 5_000_000);   // scanned just now, a normal size: not due

    const due = (await db.getVodsNeedingHealthScan({ limit: 10 })).map((v) => Number(v.id));
    assert.ok(due.includes(tinyId), 'a tiny file rated ok is scanned at once, not in 30 days');
    assert.ok(!due.includes(bigId), 'a normal one scanned just now is not');

    const r = await scanner.scanVod({ id: tinyId, file_path: tiny, duration_seconds: 51 });
    assert.deepStrictEqual([r.status, r.issues], ['zero_byte', ['too_small']], 'under 1 KB is empty');
    const e = await scanner.scanVod({ id: 0, file_path: empty, duration_seconds: 0 });
    assert.deepStrictEqual([e.status, e.issues], ['zero_byte', ['zero_byte']], 'an empty file, as before');
    console.log('health tiny file: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
