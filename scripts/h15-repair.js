#!/usr/bin/env node
'use strict';
/**
 * H15 repair (roadmap WS-G task 7), for the operator: every ready object with no good copy
 * (scripts/no-good-copy-report.js) gets every copy tried before anything is condemned
 * (server/objects/h15-repair.js has the rules):
 *
 *   node scripts/h15-repair.js [--out <report.json>]
 *       Dry run (the default): downloads each corrupt B2/R2 copy (to a temporary file; B2/R2 egress),
 *       probes and decodes it with ffprobe/ffmpeg, extracts each missing AI-moment frame again from
 *       its VOD's copy, and writes the plan: rebaseline, failed_recording, regenerate or lost, with the
 *       reason. Changes nothing. The report is for the owner (default <data>/reports/h15-repair-….json).
 *   node scripts/h15-repair.js --apply --backup <file.json>
 *       First an online backup of the database to <file>.media.db (checked with integrity_check), then
 *       the plan: re-records size and sha256 from a good remote copy, marks a failed recording
 *       lifecycle_status 'failed' (not playable, hidden from public players), writes a regenerated
 *       frame back to its location. <file.json> lists every change with its old values (the rollback
 *       file). Nothing is deleted, locally or remotely. Refuses to overwrite either file.
 *   node scripts/h15-repair.js --rollback <file.json> [--apply]
 *       Restores the old values of the changes the file lists, where the row still holds what the
 *       repair wrote (a regenerated file stays: it is the same frame). Without --apply it only reports.
 *   (every command takes --db <media.db>; the database is DB_PATH otherwise)
 *
 * B2/R2 credentials come from the environment (the service's /etc/openvibe/media.env names). Run it as
 * the service user so written files belong to it. Exit codes: 0 done, 1 error, 2 bad usage.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const usage = (msg) => { console.error(`h15-repair: ${msg}`); process.exit(2); };
for (const flag of ['db', 'backup', 'rollback', 'out']) if (has(flag) && !arg(flag)) usage(`--${flag} needs a value`);
if (arg('db')) process.env.DB_PATH = path.resolve(arg('db'));
const APPLY = has('apply');
const BACKUP = arg('backup') ? path.resolve(arg('backup')) : null;
const ROLLBACK = arg('rollback') ? path.resolve(arg('rollback')) : null;
if (ROLLBACK && BACKUP) usage('--rollback and --backup do not go together');
if (APPLY && !ROLLBACK && !BACKUP) usage('--apply needs --backup <file.json> (the rollback file; the database copy goes next to it)');

const config = require('../server/config');
const db = require('../server/db/database');
const copyReport = require('../server/objects/copy-report');
const h15 = require('../server/objects/h15-repair');
const vs = require('../server/vod/vod-storage');

const run = (cmd, argv, timeoutMs) => new Promise((resolve) => {
    execFile(cmd, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

/** Download a presigned URL to a file, hashing as it goes. → { size, sha256 } */
async function download(url, file) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let size = 0;
    for await (const chunk of res.body) { hash.update(chunk); size += chunk.length; if (!out.write(chunk)) await new Promise((r) => out.once('drain', r)); }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    return { size, sha256: hash.digest('hex') };
}

/** ffprobe + a full decode. → { duration, streams, errorLines } | { error } */
async function probe(file) {
    const p = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', file], 120000);
    if (p.err) return { error: (p.stderr || p.err.message).split('\n')[0] };
    let j = {}; try { j = JSON.parse(p.stdout); } catch { return { error: 'ffprobe output unreadable' }; }
    const d = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], 60 * 60 * 1000);
    return { duration: Number(j.format && j.format.duration) || 0, streams: (j.streams || []).map((s) => s.codec_name).filter(Boolean), errorLines: d.stderr.split('\n').filter(Boolean) };
}

const sha256File = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

/** The frame at `offset` seconds of VOD `vodId`, extracted from its good copy into `file`. → { size, sha256 } */
async function extractFrame(vodId, offset, file) {
    const v = db.getDb().prepare('SELECT id, storage_provider, storage_key, file_path FROM vods WHERE id = ?').get(vodId);
    if (!v) throw new Error(`VOD ${vodId} does not exist`);
    let input = v.file_path && fs.existsSync(v.file_path) ? v.file_path : null;
    if (!input && v.storage_provider && v.storage_key) { const u = await vs.presignGet(v.storage_provider, v.storage_key, 3600); input = typeof u === 'string' ? u : u.url; }
    if (!input) throw new Error(`VOD ${vodId} has no readable copy`);
    const r = await run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(offset), '-i', input, '-frames:v', '1', '-q:v', '3', '-y', file], 20 * 60 * 1000);
    if (r.err || !fs.existsSync(file) || !fs.statSync(file).size) throw new Error(`no frame at ${offset} s: ${(r.stderr || (r.err && r.err.message) || '').split('\n')[0]}`);
    return { size: fs.statSync(file).size, sha256: await sha256File(file) };
}

async function backupDatabase(dest) {
    await db.getDb().backup(dest);
    const Database = require('better-sqlite3');
    const copy = new Database(dest, { readonly: true });
    try { return { path: dest, bytes: fs.statSync(dest).size, integrity_check: copy.pragma('integrity_check', { simple: true }) }; } finally { copy.close(); }
}

async function main() {
    const h = db.getDb();
    if (ROLLBACK) {
        const file = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
        const out = (file.changes || []).map((c) => (APPLY ? h15.rollback(h, c) : { ...c, would_restore: true }));
        for (const o of out) console.log(`${o.object_id} ${o.action}: ${o.restored ? 'restored' : o.skipped || (o.would_restore ? 'would restore' : '')}`);
        return 0;
    }
    const q = { all: (sql, p = []) => h.prepare(sql).all(...p), get: (sql, p = []) => h.prepare(sql).get(...p) };
    const report = copyReport.buildReport(q, {});
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h15-repair-'));
    const steps = [];
    try {
        for (const item of report.objects) {
            const probes = {};
            const facts = {};
            for (const l of item.locations.filter((x) => (x.provider === 'b2' || x.provider === 'r2') && x.state === 'corrupt')) {
                try {
                    const u = await vs.presignGet(l.provider, l.key, 3600);
                    const file = path.join(tmp, `${item.object_id}.${l.provider}`);
                    facts[l.provider] = await download(typeof u === 'string' ? u : u.url, file);
                    probes[l.provider] = await probe(file);
                } catch (err) { probes[l.provider] = { error: err.message }; }
            }
            const step = h15.plan(item, probes);
            if (step.action === 'rebaseline') Object.assign(step, { facts: facts[step.provider], probe: { duration: probes[step.provider].duration, streams: probes[step.provider].streams } });
            if (step.action === 'failed_recording') step.probe = probes[step.provider];
            if (step.action === 'regenerate') {
                const loc = item.locations.find((l) => l.provider === 'local');
                const file = path.join(tmp, `${item.object_id}.jpg`);
                try { step.facts = await extractFrame(step.source_vod, step.offset, file); step.file = file; step.target = loc && loc.key; }
                catch (err) { Object.assign(step, { action: 'lost', reason: `the frame could not be extracted again: ${err.message}` }); }
            }
            if (step.probe && step.probe.errorLines) step.probe = { ...step.probe, errorLines: step.probe.errorLines.length };
            steps.push(step);
            console.log(`${item.object_id} ${item.kind} ${item.legacy_ref || ''}: ${step.action} — ${step.reason}`);
        }
        const record = { generated_at: new Date().toISOString(), applied: false, objects: report.count, plan: steps.map(({ file, ...s }) => s) };
        if (!APPLY) {
            const out = arg('out') ? path.resolve(arg('out')) : path.join(path.dirname(path.resolve(config.db.path)), 'reports', `h15-repair-${record.generated_at.replace(/[:.]/g, '-')}.json`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, JSON.stringify(record, null, 2));
            console.log(`\nDry run: nothing changed. Plan written to ${out}`);
            return 0;
        }
        const copyPath = BACKUP.replace(/\.json$/, '') + '.media.db';
        for (const f of [BACKUP, copyPath]) if (fs.existsSync(f)) usage(`${f} already exists; pick a new --backup name`);
        const dbCopy = await backupDatabase(copyPath);
        if (dbCopy.integrity_check !== 'ok') { console.error(`backup failed integrity_check: ${dbCopy.integrity_check}; nothing changed`); return 1; }
        const changes = [];
        for (const step of steps) {
            if (step.action === 'lost') continue;
            if (step.action === 'regenerate') {
                if (!step.target) { changes.push({ ...step, skipped: 'no local location to write to' }); continue; }
                fs.mkdirSync(path.dirname(step.target), { recursive: true });
                if (!fs.existsSync(step.target)) fs.copyFileSync(step.file, step.target);
            }
            const { file, ...s } = step;
            changes.push(h15.apply(h, s, step.facts));
        }
        Object.assign(record, { applied: true, backup: dbCopy, changes });
        fs.writeFileSync(BACKUP, JSON.stringify(record, null, 2));
        for (const c of changes) console.log(`${c.object_id} ${c.action}: ${c.skipped ? `skipped (${c.skipped})` : 'applied'}`);
        console.log(`\nApplied. Rollback file: ${BACKUP}; database copy: ${copyPath}`);
        return 0;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main().then((code) => process.exit(code), (err) => { console.error(`h15-repair: ${err.message}`); process.exit(1); });
