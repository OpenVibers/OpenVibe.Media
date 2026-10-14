'use strict';
// Migration 0007 drops the frozen paste tables (pastes moved to OpenVibe.Community; Media#75 stopped every read and
// write). On a database that already holds them, it waits out its N-1 window after 0001 and then drops the three
// tables, their trigger functions and the paste settings — and leaves the legacy screenshot objects alone: DROP TABLE
// fires no row trigger, so trg_pastes_object_deleted never marks an object deleted.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const quiet = { log() {}, warn() {}, error() {} };

(async () => {
    // The schema as production had it before this release: every migration up to 0006.
    const before = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-0006-'));
    for (const f of fs.readdirSync(MIGRATIONS)) if (/^000[1-6]_/.test(f)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(before, f));
    const db = createDb({ pglite: true, service: 'paste-drop-test' });
    await db.migrate({ dir: before, log: quiet });

    await db.exec(`INSERT INTO media_objects (id, app_id, namespace, kind, visibility, lifecycle_status, legacy_ref)
        VALUES ('med_01JZ0000000000000000000001', 'live', 'live', 'screenshot', 'public', 'ready', 'legacy:live:paste:old-shot')`);
    await db.exec(`INSERT INTO pastes (slug, type, title, object_id) VALUES ('old-shot', 'screenshot', 'An old screenshot', 'med_01JZ0000000000000000000001')`);
    await db.exec(`INSERT INTO paste_likes (paste_id, user_id) SELECT id, 7 FROM pastes WHERE slug = 'old-shot'`);

    // Within the window after 0001 the drop waits, and nothing after it runs.
    const held = await db.migrate({ dir: MIGRATIONS, log: quiet });
    assert.strictEqual(held.held.map((h) => h.id)[0], '0007', 'the contract waits for its N-1 window (and every later migration behind it)');
    assert.ok(await db.value("SELECT to_regclass('pastes')::text"), 'the tables are still there while it waits');

    // A week later it runs.
    const later = await db.migrate({ dir: MIGRATIONS, now: () => Date.now() + 8 * 86400000, log: quiet });
    assert.strictEqual(later.applied.map((a) => a.id)[0], '0007');
    for (const t of ['pastes', 'paste_likes', 'paste_comments']) {
        assert.strictEqual(await db.value(`SELECT to_regclass('${t}')::text`), null, `${t} is dropped`);
    }
    const fns = await db.many("SELECT proname FROM pg_proc WHERE proname IN ('trg_pastes_hold_guard_v2', 'trg_pastes_object_deleted')");
    assert.deepStrictEqual(fns, [], 'their trigger functions go too');
    const settings = await db.many("SELECT key FROM media_settings WHERE key LIKE 'paste%'");
    assert.deepStrictEqual(settings, [], 'and the paste settings');
    const obj = await db.maybe("SELECT lifecycle_status FROM media_objects WHERE id = 'med_01JZ0000000000000000000001'");
    assert.strictEqual(obj.lifecycle_status, 'ready', 'the legacy screenshot object is untouched (no row trigger fired)');

    await db.close();
    fs.rmSync(before, { recursive: true, force: true });
    console.log('paste tables dropped: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
