#!/usr/bin/env node
'use strict';
/**
 * Retire the R2 tier (plan T4): every R2 copy is a popularity cache in front of a canonical copy on B2 (or local disk
 * for a native object). This proves each canonical copy byte for byte and only then removes the R2 copy, so no object
 * can lose its last good copy. Dry run unless --execute. Deleted together with the R2 code once it has run.
 *
 *   node scripts/retire-r2.js --gates      close promotion (storage_tier r2Enabled=false, object_tier active=false)
 *                                          and note when; then restart Media: a running process does not reload
 *                                          settings, and --execute refuses until Media started after the gates closed
 *   node scripts/retire-r2.js [--execute]  VODs served from R2, then native objects with an R2 location, then any
 *                                          key no row references any more; [--concurrency 2] [--out file.json]
 *
 * Proof per VOD: B2 has the key; the B2 and R2 sizes and vods.file_size agree; the full sha256 of the B2 copy equals
 * the R2 copy's and media_objects.content_hash when there is one; then the engine's own demoteFromR2. Per native object
 * (legacy_ref IS NULL): the canonical copy (local file or B2 object) hashes to content_hash; then tiering.demote(), which
 * logs its decision. A key left in the bucket is removed only when no row still on R2 references it and B2 holds the
 * same key with the same bytes. Anything else (recording, held, unproven) is reported and kept.
 * Exit 0 = nothing left on R2 (or a clean dry run), 1 = something was refused or failed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GATES_FILE = (dataDir) => path.join(dataDir, 'drills', 'r2-gates-closed-at');

/** When openvibe-media.service last started (ms), or null when systemd cannot say. */
function mediaStartedAt() {
    try {
        const out = require('child_process').execFileSync('systemctl', ['show', 'openvibe-media.service', '-p', 'ActiveEnterTimestamp', '--value'], { encoding: 'utf8' }).trim();
        const t = Date.parse(out);
        return Number.isFinite(t) ? t : null;
    } catch { return null; }
}

function parseArgs(argv) {
    const a = argv.slice(2);
    const arg = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
    return { execute: a.includes('--execute'), gates: a.includes('--gates'), concurrency: Math.max(1, Number(arg('concurrency', 2)) || 2), out: arg('out', null) };
}

async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
    return { sha256: hash.digest('hex'), size };
}

async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function run(opts, { storage, db, model, tiering, policy, gates }) {
    const rep = { mode: opts.execute ? 'execute' : 'dry-run', started_at: new Date().toISOString(), vods: [], clips: [], objects: [], bucket: [], left: null };
    if (!storage.providerConfigured('r2')) throw new Error('R2 is not configured: nothing to retire');
    if (!storage.providerConfigured('b2')) throw new Error('B2 is not configured: the canonical copies cannot be proven');
    // Nothing may promote while copies are being removed: the gates are closed in the stored settings AND the running
    // Media loaded them (it started after they closed); otherwise a sweep could re-promote or re-verify a deleted key.
    if (opts.execute) {
        if (storage.getSettings().r2Enabled !== false || policy.settings().active !== false) throw new Error('promotion is still open: run --gates first');
        if (!gates || !gates.closedAt) throw new Error('no record of the gates closing: run --gates first');
        if (!gates.mediaStartedAt || gates.mediaStartedAt < gates.closedAt) throw new Error('Media has not restarted since the gates closed: its sweep still promotes; restart openvibe-media first');
    }

    // ── VODs served from R2 ──
    const vods = await db.all("SELECT * FROM vods WHERE storage_provider = 'r2' ORDER BY file_size ASC");
    await pool(vods, opts.concurrency, async (vod) => {
        const r = { id: vod.id, key: storage.keyForVod(vod), size: Number(vod.file_size) || null, result: null };
        rep.vods.push(r);
        try {
            if (vod.is_recording) { r.result = 'refused: recording'; return; }
            if (await model.isHeldRow(vod)) { r.result = 'refused: retention hold'; return; }
            const [b2, r2] = await Promise.all([storage.headObject('b2', r.key), storage.headObject('r2', r.key)]);
            if (!b2) { r.result = 'refused: no B2 copy'; return; }
            if (r2 && r2.size !== b2.size) { r.result = `refused: sizes differ (b2 ${b2.size}, r2 ${r2.size})`; return; }
            if (r.size && b2.size !== r.size) { r.result = `refused: B2 size ${b2.size} is not the row's ${r.size}`; return; }
            const obj = vod.object_id ? await db.get('SELECT content_hash FROM media_objects WHERE id = ?', [vod.object_id]) : null;
            const [hb, hr] = await Promise.all([storage.sha256Object('b2', r.key), r2 ? storage.sha256Object('r2', r.key) : null]);
            r.sha256 = hb && hb.sha256;
            if (!hb || hb.size !== b2.size) { r.result = 'refused: B2 read-through failed'; return; }
            if (hr && hr.sha256 !== hb.sha256) { r.result = 'refused: B2 and R2 bytes differ'; return; }
            if (obj && obj.content_hash && obj.content_hash !== hb.sha256) { r.result = 'refused: B2 bytes are not content_hash'; return; }
            if (!opts.execute) { r.result = 'verified'; return; }
            const d = await storage.demoteFromR2(vod.id, { trigger: 'manual', reason: 'R2 tier retired: the B2 copy was verified by full sha256' });
            if (!d || d.ok === false) { r.result = `failed: ${d && d.error}`; return; }
            // demoteFromR2 swallows a failed delete (the row still moves to B2): the key is then left for the bucket pass.
            r.result = (await storage.headObject('r2', r.key)) ? 'failed: the row moved to B2 but the R2 copy is still there' : 'demoted';
        } catch (err) { r.result = `failed: ${err.message}`; }
    });

    // Clips have never been promoted (nothing writes clips.storage_provider = 'r2'); any row is reported, not moved.
    for (const c of await db.all("SELECT id, storage_key FROM clips WHERE storage_provider = 'r2'")) rep.clips.push({ id: c.id, key: c.storage_key, result: 'refused: clip rows on R2 are unexpected' });

    // ── Native objects with an R2 location. A VOD's or clip's own object (legacy_ref set) is projected from its row: its
    // R2 location went with the VOD's demotion above, and one still here belongs to a row that was refused. ──
    const locs = await db.all("SELECT l.id, l.object_id, l.key, o.legacy_ref FROM media_locations l JOIN media_objects o ON o.id = l.object_id WHERE l.provider = 'r2' ORDER BY l.object_id");
    await pool(locs, opts.concurrency, async (l) => {
        const r = { object_id: l.object_id, key: l.key, result: null };
        rep.objects.push(r);
        if (l.legacy_ref) { r.result = 'kept: projected from a VOD or clip row still on R2'; return; }
        try {
            const obj = await db.get('SELECT * FROM media_objects WHERE id = ?', [l.object_id]);
            if (!obj) { r.result = 'refused: no media_objects row'; return; }
            if (await model.isHeld(obj.id)) { r.result = 'refused: retention hold'; return; }
            const canon = (await model.listLocations(obj.id)).find((x) => x.provider === obj.canonical_provider && x.provider !== 'r2');
            if (!canon || !obj.content_hash) { r.result = 'refused: no canonical copy or no content_hash to prove it'; return; }
            const h = canon.provider === 'local' ? await sha256File(canon.key).catch(() => null) : await storage.sha256Object(canon.provider, canon.key);
            if (!h || h.sha256 !== obj.content_hash) { r.result = `refused: the ${canon.provider} copy does not hash to content_hash`; return; }
            if (!opts.execute) { r.result = 'verified'; return; }
            // The engine's own demotion (canonical re-checked, R2 deleted and re-HEADed, location removed in one
            // transaction, decision logged). Its gate is closed now, so it is handed active: true for this call only.
            const d = await tiering.demote(obj.id, { trigger: 'manual', reason: 'R2 tier retired: the canonical copy was verified by full sha256', settings: { ...policy.settings(), active: true } });
            r.result = d && d.ok ? 'demoted' : `failed: ${(d && (d.error || d.outcome)) || 'no result'}`;
        } catch (err) { r.result = `failed: ${err.message}`; }
    });

    // ── Whatever the bucket still holds that no row on R2 references (a row refused above keeps its copy) ──
    const referenced = new Set();
    for (const v of await db.all("SELECT * FROM vods WHERE storage_provider = 'r2'")) referenced.add(storage.keyForVod(v));
    for (const c of await db.all("SELECT storage_key FROM clips WHERE storage_provider = 'r2' AND storage_key IS NOT NULL")) referenced.add(c.storage_key);
    for (const l of await db.all("SELECT key FROM media_locations WHERE provider = 'r2'")) referenced.add(l.key);
    const keys = await storage.listObjects('r2', '');
    await pool(keys, opts.concurrency, async (k) => {
        const r = { key: k.key, size: k.size, result: null };
        rep.bucket.push(r);
        if (referenced.has(k.key)) { r.result = 'kept: a row still on R2 references it'; return; }
        try {
            const b2 = await storage.headObject('b2', k.key);
            if (!b2 || b2.size !== k.size) { r.result = b2 ? 'kept: B2 has a different size' : 'kept: not on B2'; return; }
            const [hb, hr] = await Promise.all([storage.sha256Object('b2', k.key), storage.sha256Object('r2', k.key)]);
            if (!hb || !hr || hb.sha256 !== hr.sha256) { r.result = 'kept: B2 bytes differ'; return; }
            if (!opts.execute) { r.result = 'verified'; return; }
            await storage.deleteObject('r2', k.key);
            r.result = (await storage.headObject('r2', k.key)) ? 'failed: still there' : 'deleted';
        } catch (err) { r.result = `failed: ${err.message}`; }
    });

    const rows = await db.get("SELECT (SELECT COUNT(*) FROM vods WHERE storage_provider = 'r2') AS vods, (SELECT COUNT(*) FROM clips WHERE storage_provider = 'r2') AS clips, (SELECT COUNT(*) FROM media_locations WHERE provider = 'r2') AS locations");
    rep.left = { vods: Number(rows.vods), clips: Number(rows.clips), locations: Number(rows.locations), bucket_keys: (await storage.listObjects('r2', '')).length };
    rep.finished_at = new Date().toISOString();
    return rep;
}

function summarize(rep) {
    const count = (list) => list.reduce((m, x) => { const k = String(x.result).split(':')[0]; m[k] = (m[k] || 0) + 1; return m; }, {});
    const lines = [`R2 retirement (${rep.mode})`];
    for (const s of ['vods', 'clips', 'objects', 'bucket']) lines.push(`  ${s.padEnd(8)} ${rep[s].length} ${JSON.stringify(count(rep[s]))}`);
    for (const s of ['vods', 'clips', 'objects', 'bucket']) for (const x of rep[s]) if (!/^(verified|demoted|deleted)$/.test(x.result)) lines.push(`  ${s} ${x.id || x.object_id || x.key}: ${x.result}`);
    lines.push(`  left on R2: ${JSON.stringify(rep.left)}`);
    return lines.join('\n');
}

if (require.main === module) {
    const opts = parseArgs(process.argv);
    const config = require('../server/config');
    const storage = require('../server/vod/vod-storage');
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    const tiering = require('../server/objects/tiering');
    const quiet = { info() {}, warn: (m) => console.error(`[Tiers] ${m}`), error: (m) => console.error(`[Tiers] ${m}`) };
    (async () => {
        await db.initDb();
        await storage.tierConfig.init(storage.DEFAULTS, { log: quiet });
        const policy = require('../server/objects/tier-policy');
        await policy.init();
        if (opts.gates) {
            await storage.setSettings({ r2Enabled: false }, { actor: 'retire-r2', reason: 'R2 tier retired (plan T4)' });
            await policy.set({ active: false }, { actor: 'retire-r2', reason: 'R2 tier retired (plan T4)' });
            fs.mkdirSync(path.dirname(GATES_FILE(config.dataDir)), { recursive: true });
            fs.writeFileSync(GATES_FILE(config.dataDir), new Date().toISOString());
            console.log('R2 promotion closed (storage_tier.r2Enabled=false, object_tier.active=false). Restart Media so it loads them.');
        } else {
            let closedAt = null;
            try { closedAt = Date.parse(fs.readFileSync(GATES_FILE(config.dataDir), 'utf8').trim()) || null; } catch { /* never closed */ }
            const rep = await run(opts, { storage, db, model, tiering, policy, gates: { closedAt, mediaStartedAt: mediaStartedAt() } });
            const out = opts.out || path.join(config.dataDir, 'drills', `r2-retire-${rep.started_at.replace(/[:.]/g, '-')}.json`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, JSON.stringify(rep, null, 2));
            console.log(`${summarize(rep)}\nreport: ${out}`);
            const clean = ['vods', 'clips', 'objects', 'bucket'].every((s) => rep[s].every((x) => /^(verified|demoted|deleted)$/.test(x.result)));
            await db.close();
            process.exit(clean ? 0 : 1);
        }
        await db.close();
    })().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run, summarize, parseArgs };
