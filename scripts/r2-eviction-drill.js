#!/usr/bin/env node
'use strict';
/**
 * R2 eviction drill: the canonical B2 copy survives losing the R2 hot-cache copy (roadmap W4 exit
 * criterion; docs/object-model.md#r2-eviction-drill). Dry run unless --execute.
 *
 *   node scripts/r2-eviction-drill.js (--vod <id> | --pick) [--execute] [--base-url https://openvibe.media]
 *                                     [--no-http] [--max-mb 512] [--out artifact.json] [--json] [--db ./data/media.db]
 *
 * The VOD must be served from R2 today (storage_provider r2: a B2 canonical copy plus an R2 cache copy),
 * not recording, not under a retention hold (a hold freezes placement), and public or unlisted unless
 * --no-http. --pick chooses the smallest such VOD up to --max-mb. Before anything changes, the B2 and R2
 * copies must have the same size (and the vods row's, when it has one) and the same first MiB: evicting
 * the cache in front of a corrupt canonical copy would lose the only good one, so the drill refuses.
 *
 * With --execute, through the storage engine's own tier moves (server/vod/vod-storage.js):
 *   1. before    HEAD B2 + R2; GET <base>/v/<id>?raw=1 redirects to R2 and serves the same first MiB
 *   2. evict     demoteFromR2(id): B2 canonical checked, the R2 copy deleted, the row flipped to b2
 *   3. from B2   HEAD R2 is 404; GET /v/<id> now redirects to B2, which serves the same first MiB
 *   4. re-warm   promoteToR2(id): B2 copied back to R2 (verified by HEAD), the row flipped to r2
 *   5. after     GET /v/<id> redirects to R2 again with the same first MiB; media_locations says b2 and r2 present
 * A failed step stops the drill; the VOD then stays where the last successful step left it (after the
 * eviction that is B2, which still serves it). --no-http checks the playback decision in-process
 * (resolvePlayback) instead of GET /v, which otherwise counts as one view from this host.
 *
 * Writes a JSON artifact (--out, default ./data/drills/r2-eviction-<vod>-<time>.json) with every step,
 * the copies' sizes and first-MiB sha256, media_locations before/after, and the verdict.
 * Exit 0 = pass (or a dry run whose checks passed), 1 = a step failed, 2 = refused (preconditions).
 * Never run it against production without the owner's go-ahead.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIB = 1024 * 1024;

function parseArgs(argv) {
    const args = argv.slice(2);
    const has = (n) => args.includes(`--${n}`);
    const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
    return {
        vodId: arg('vod') != null ? Number(arg('vod')) : null,
        pick: has('pick'),
        execute: has('execute'),
        http: !has('no-http'),
        baseUrl: arg('base-url', null),
        maxMb: Number(arg('max-mb', 512)),
        out: arg('out', null),
        json: has('json'),
        db: arg('db', null),
    };
}

/** Which provider a presigned/redirect URL points at (path-style endpoint or bucket.host). */
function providerOfUrl(url, storage) {
    let u;
    try { u = new URL(url); } catch { return null; }
    for (const p of ['r2', 'b2']) {
        const bucket = storage.bucketFor(p);
        const ep = storage.endpointFor ? storage.endpointFor(p) : null;
        if (!bucket) continue;
        const host = ep ? new URL(ep).host : null;
        if (host && u.host === host && u.pathname.startsWith(`/${bucket}/`)) return p;
        if (host && u.host === `${bucket}.${host}`) return p;
        if (!host && (u.host.startsWith(`${bucket}.`) || u.pathname.startsWith(`/${bucket}/`))) return p;
    }
    return null;
}

async function firstMibSha(url, fetchImpl) {
    const res = await fetchImpl(url, { headers: { Range: `bytes=0-${MIB - 1}` } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`GET ${new URL(url).host}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const bytes = res.status === 200 ? body.subarray(0, MIB) : body;
    return { status: res.status, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, content_range: res.headers.get('content-range') };
}

/**
 * runDrill(opts, deps) -> artifact. deps: { storage (vod-storage), db, model, fetch, now } — injectable
 * so test/r2-eviction-drill.test.js runs it against a fake S3 and a local Media.
 */
async function runDrill(opts, deps) {
    const { storage, db, model } = deps;
    const fetchImpl = deps.fetch || globalThis.fetch;
    const nowIso = () => new Date((deps.now || Date.now)()).toISOString();
    const art = {
        drill: 'r2-eviction', version: 1, mode: opts.execute ? 'execute' : 'dry-run', started_at: nowIso(), finished_at: null,
        vod_id: null, object_id: null, key: null, http: !!opts.http, base_url: opts.baseUrl || null,
        buckets: { b2: storage.bucketFor('b2'), r2: storage.bucketFor('r2') },
        checks: {}, steps: [], locations: {}, verdict: null, reason: null,
    };
    const step = (name, ok, detail = {}) => { art.steps.push({ name, ok, at: nowIso(), ...detail }); return ok; };
    const locations = () => (art.object_id ? model.listLocations(art.object_id).map(l => ({ provider: l.provider, state: l.state, size_bytes: l.size_bytes, verified_at: l.verified_at })) : []);
    const refuse = (reason) => { art.verdict = 'refused'; art.reason = reason; art.finished_at = nowIso(); return art; };
    const fail = (reason) => { art.verdict = 'fail'; art.reason = reason; art.finished_at = nowIso(); art.locations.at_failure = locations(); return art; };

    if (!storage.providerConfigured('b2') || !storage.providerConfigured('r2')) return refuse('B2 and R2 must both be configured (MEDIA_B2_*, MEDIA_R2_*)');

    // ── Choose the VOD ──
    let vod = null;
    if (opts.vodId) vod = db.get('SELECT * FROM vods WHERE id = ?', [opts.vodId]);
    else if (opts.pick) {
        const cands = db.all(`SELECT * FROM vods WHERE storage_provider = 'r2' AND COALESCE(is_recording, 0) = 0 AND COALESCE(clips_only, 0) = 0
                                AND file_path IS NOT NULL AND COALESCE(file_size, 0) > 0 AND file_size <= ?
                                ${opts.http ? "AND COALESCE(visibility, CASE WHEN is_public THEN 'public' ELSE 'private' END) != 'private'" : ''}
                              ORDER BY file_size ASC LIMIT 50`, [Math.max(1, opts.maxMb) * MIB]);
        vod = cands.find(v => !model.isHeldRow(v)) || null;
        if (!vod) return refuse(`no VOD served from R2 fits (not recording, not held${opts.http ? ', public or unlisted' : ''}, at most ${opts.maxMb} MB)`);
    } else return refuse('name a VOD (--vod <id>) or --pick one');
    if (!vod) return refuse(`vod ${opts.vodId} not found`);
    art.vod_id = vod.id;
    art.object_id = vod.object_id || null;
    art.key = storage.keyForVod(vod);
    const vis = vod.visibility || (vod.is_public ? 'public' : 'private');
    art.checks.vod = { app_id: vod.app_id, storage_provider: storage.providerOf(vod), is_recording: !!vod.is_recording, visibility: vis, file_size: Number(vod.file_size) || null };
    if (storage.providerOf(vod) !== 'r2') return refuse(`vod ${vod.id} is served from ${storage.providerOf(vod)}, not R2: there is no R2 copy to evict`);
    if (vod.is_recording) return refuse(`vod ${vod.id} is recording`);
    if (vod.clips_only) return refuse(`vod ${vod.id} is a clips-only recording`);
    if (model.isHeldRow(vod)) return refuse(`vod ${vod.id} is under a retention hold (holds freeze placement)`);
    if (opts.http && vis === 'private') return refuse(`vod ${vod.id} is private: /v/<id> would not serve it anonymously (use --no-http)`);
    if (opts.http && !opts.baseUrl) return refuse('--base-url (or MEDIA_PUBLIC_URL) is needed for the HTTP checks');
    art.locations.before = locations();

    // ── Both copies agree (size, and the first MiB) ──
    const [b2, r2] = await Promise.all([storage.headObject('b2', art.key), storage.headObject('r2', art.key)]);
    art.checks.head_before = { b2, r2 };
    if (!b2) return refuse('the B2 canonical copy is missing: evicting R2 would lose the only copy');
    if (!r2) return refuse('there is no R2 copy (HEAD 404) although the row says r2');
    if (b2.size !== r2.size) return refuse(`B2 (${b2.size}) and R2 (${r2.size}) differ in size: the canonical copy may be corrupt`);
    if (vod.file_size && Number(vod.file_size) !== b2.size) return refuse(`the copies (${b2.size}) differ from the recorded size (${vod.file_size})`);
    const b2Loc = (art.locations.before || []).find(l => l.provider === 'b2');
    if (b2Loc && ['corrupt', 'missing'].includes(b2Loc.state)) return refuse(`media_locations marks the B2 copy ${b2Loc.state}`);
    const [shaB2, shaR2] = await Promise.all([
        firstMibSha(await storage.presignGet('b2', art.key, 600), fetchImpl),
        firstMibSha(await storage.presignGet('r2', art.key, 600), fetchImpl),
    ]);
    art.checks.first_mib = { b2: shaB2.sha256, r2: shaR2.sha256 };
    if (shaB2.sha256 !== shaR2.sha256) return refuse('B2 and R2 differ in their first MiB: the canonical copy may be corrupt');
    const expectSha = shaR2.sha256;

    /** Where playback goes now: GET /v/<id>?raw=1 (or resolvePlayback in-process) and the first MiB served there. */
    const served = async () => {
        if (!opts.http) {
            const plan = await storage.resolvePlayback(db.get('SELECT * FROM vods WHERE id = ?', [vod.id]));
            if (!plan || plan.kind !== 'redirect') return { provider: plan ? plan.kind : null };
            const got = await firstMibSha(plan.url, fetchImpl);
            return { via: 'resolvePlayback', provider: plan.provider, status: 302, first_mib_sha256: got.sha256 };
        }
        const url = `${String(opts.baseUrl).replace(/\/+$/, '')}/v/${vod.id}?raw=1`;
        const res = await fetchImpl(url, { redirect: 'manual', headers: { Accept: 'video/*' } });
        const location = res.headers.get('location');
        if (res.status !== 302 || !location) return { via: 'http', status: res.status, provider: null };
        const got = await firstMibSha(location, fetchImpl);
        return { via: 'http', url, status: 302, provider: providerOfUrl(location, storage), host: new URL(location).host, range_status: got.status, first_mib_sha256: got.sha256 };
    };

    if (!opts.execute) {
        const now = opts.http ? null : await served().catch(e => ({ error: e.message }));
        step('plan', true, {
            would: ['evict: demoteFromR2 (B2 canonical checked, R2 copy deleted, row -> b2)', 'prove: /v/<id> redirects to B2 and serves the same first MiB',
                're-warm: promoteToR2 (B2 copied to R2, row -> r2)', 'prove: /v/<id> redirects to R2 again'],
            served_now: opts.http ? 'not requested in a dry run (GET /v counts a view)' : now,
            size_bytes: b2.size,
        });
        art.verdict = 'dry-run';
        art.finished_at = nowIso();
        return art;
    }

    // 1. before
    const before = await served();
    if (!step('before: served from R2', before.provider === 'r2' && before.first_mib_sha256 === expectSha, before)) return fail('playback is not coming from R2 before the eviction');
    // 2. evict
    const ev = await storage.demoteFromR2(vod.id);
    const rowAfterEvict = db.get('SELECT storage_provider FROM vods WHERE id = ?', [vod.id]);
    const r2Gone = await storage.headObject('r2', art.key);
    art.locations.after_evict = locations();
    if (!step('evict: R2 copy removed', !!(ev && ev.ok) && !r2Gone && rowAfterEvict.storage_provider === 'b2', { result: ev, r2_head: r2Gone, storage_provider: rowAfterEvict.storage_provider })) {
        return fail('the eviction did not complete');
    }
    // 3. served from B2
    const fromB2 = await served();
    const b2Head = await storage.headObject('b2', art.key);
    if (!step('from B2: served from the canonical copy', fromB2.provider === 'b2' && fromB2.first_mib_sha256 === expectSha && !!b2Head && b2Head.size === b2.size, { ...fromB2, b2_head: b2Head })) {
        return fail('after the eviction the VOD is not served from B2');
    }
    // 4. re-warm
    const pr = await storage.promoteToR2(vod.id);
    const r2Back = await storage.headObject('r2', art.key);
    const rowAfterWarm = db.get('SELECT storage_provider FROM vods WHERE id = ?', [vod.id]);
    if (!step('re-warm: R2 copy restored from B2', !!(pr && pr.ok) && !!r2Back && r2Back.size === b2.size && rowAfterWarm.storage_provider === 'r2', { result: pr, r2_head: r2Back, storage_provider: rowAfterWarm.storage_provider })) {
        return fail('the re-warm did not complete (the VOD is still served from B2)');
    }
    // 5. after
    const after = await served();
    art.locations.after = locations();
    const locOk = !art.object_id || ['b2', 'r2'].every(p => (art.locations.after.find(l => l.provider === p) || {}).state === 'present');
    if (!step('after: served from R2 again', after.provider === 'r2' && after.first_mib_sha256 === expectSha && locOk, { ...after, locations_present: locOk })) {
        return fail('after the re-warm the VOD is not served from R2');
    }
    art.verdict = 'pass';
    art.finished_at = nowIso();
    return art;
}

function summarize(art) {
    const lines = [`R2 eviction drill (${art.mode}) vod ${art.vod_id ?? '-'} ${art.key || ''}: ${art.verdict}${art.reason ? ` — ${art.reason}` : ''}`];
    for (const s of art.steps) lines.push(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}`);
    return lines.join('\n');
}

if (require.main === module) {
    const opts = parseArgs(process.argv);
    if (opts.db) process.env.DB_PATH = path.resolve(opts.db);
    const config = require('../server/config');
    if (!opts.baseUrl) opts.baseUrl = config.publicUrl;
    const storage = require('../server/vod/vod-storage');
    const db = require('../server/db/database');
    const model = require('../server/objects/model');
    (async () => {
        const art = await runDrill(opts, { storage, db, model });
        const out = opts.out || path.join(path.dirname(config.db.path), 'drills', `r2-eviction-${art.vod_id ?? 'none'}-${art.started_at.replace(/[:.]/g, '-')}.json`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(art, null, 2));
        console.log(opts.json ? JSON.stringify(art, null, 2) : `${summarize(art)}\nartifact: ${out}`);
        db.close();
        process.exit(art.verdict === 'pass' || art.verdict === 'dry-run' ? 0 : art.verdict === 'refused' ? 2 : 1);
    })().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { runDrill, providerOfUrl, summarize, parseArgs };
