/** Ask 288: the first three minutes of a recording on R2, later segments on B2. */
'use strict';
const crypto = require('crypto');
const config = require('../config');
const db = require('../db/database');
const timeline = require('../objects/timeline');
const model = require('../objects/model');
const { JobError } = require('./queue');
const MAX_BYTES = 512 * 1024 * 1024;
const recent = new Map();
const queuedAt = [];
let pending = 0;
const identity = (r) => `${r.object_id}\n${r.rendition}\n${r.key}`;

// Packed chunks that straddle the boundary stay hot as a whole. Inits are small and always hot, including later
// discontinuities. Joined recording rows carry recording time and retain their original object_id/key.
function plan(rows, seconds = config.hls.startupSeconds) {
    const groups = new Map();
    for (const row of rows) {
        const id = identity(row);
        const hot = Number(row.seq) <= 0 || Number(row.start_ms) < seconds * 1000;
        const previous = groups.get(id);
        groups.set(id, { row, provider: hot || (previous && previous.provider === 'r2') ? 'r2' : 'b2' });
    }
    return groups;
}
// The shared read router applies this preference only after its health and capability checks.
function playbackPreference(row) {
    return config.hls.startupSeconds && row.durability === 'durable' ? row.durable_provider : null;
}

async function subject(obj) {
    if (!obj || obj.kind === 'clip') return null; // A clip must not retier its source around a different zero point.
    const parent = await db.get('SELECT p.recording_object_id FROM media_recording_parts p JOIN vods v ON v.id = p.vod_id WHERE v.object_id = ? LIMIT 1', [obj.id]);
    return parent ? await model.getObject(parent.recording_object_id) : obj;
}
async function rowsOf(obj) {
    if (require('../vod/recordings').isRecording(obj)) return (await require('../objects/hls').timelineOf(obj)).rows;
    return db.all('SELECT * FROM media_timeline WHERE object_id = ? ORDER BY rendition, seq', [obj.id]);
}
function providersReady() {
    const storage = require('../vod/vod-storage');
    const providers = require('../placement/providers');
    return storage.providerAvailable('r2') && storage.providerAvailable('b2')
        && providers.placementGate('r2','online-hot').eligible
        && providers.placementGate('b2','online-canonical').eligible;
}
async function queueOnce(obj) {
    if (!config.hls.enabled || !config.hls.startupSeconds) return null;
    if (!providersReady()) return null;
    obj = await subject(obj);
    if (!obj || obj.lifecycle_status !== 'ready') return null;
    const now = Date.now();
    if (recent.has(obj.id) && now - recent.get(obj.id) < 600000) return null;
    const rows = await rowsOf(obj);
    if (!rows.some(r => Number(r.seq) > 0)) return null;
    const groups = plan(rows);
    if (![...groups.values()].some(({row,provider}) => row.durable_provider !== provider || row.durability !== 'durable')) return null;
    const hash = crypto.createHash('sha256').update(String(config.hls.startupSeconds));
    for (const [key, {row,provider}] of groups) hash.update(`${key}:${row.sha256}:${provider}\n`);
    const recentJobs = await db.get("SELECT COUNT(*) AS n FROM media_jobs WHERE job_type = 'object.startup-tier' AND created_at >= ov_now_iso('-1 hour')");
    while (queuedAt.length && queuedAt[0] <= now - 3600000) queuedAt.shift();
    if (Math.max(Number(recentJobs.n),queuedAt.length) + pending >= config.hls.backfillPerHour) return null;
    pending++;
    let result;
    try { result = await require('./queue').enqueue({appId:obj.app_id,type:'object.startup-tier',objectId:obj.id,params:{},
        dedupeActive:true,idempotencyKey:`startup-tier:${obj.id}:${hash.digest('hex').slice(0,20)}`,createdBy:'system:startup-tier'});
        if (result.created) queuedAt.push(now);
    } finally { pending--; }
    if (recent.size >= 1000) recent.delete(recent.keys().next().value);
    recent.set(obj.id,now);
    return result;
}
function validate({obj,params}) {
    if (!obj || obj.kind === 'clip') throw new JobError('media.job.invalid','Startup placement requires a recording or media object',{permanent:true});
    if (Object.keys(params || {}).length) throw new JobError('media.job.invalid','Startup placement takes no parameters',{permanent:true});
    return {};
}
async function run(job, ctx) {
    if (!config.hls.enabled || !config.hls.startupSeconds) return {skipped:'startup placement disabled'};
    const obj = await model.getObject(job.object_id);
    if (!obj || obj.app_id !== job.app_id || obj.lifecycle_status !== 'ready') throw new JobError('not_ready','Recording is not ready',{permanent:true});
    const rows = await rowsOf(obj), groups = plan(rows);
    const vs = require('../vod/vod-storage');
    if (!providersReady()) throw new JobError('provider_unavailable','R2 and B2 must both be healthy and eligible',{retryAfterS:300});
    const ids = [...new Set([obj.id,...rows.map(r=>r.object_id)])].sort();
    for (const id of ids) if (await model.isHeld(id)) throw new JobError('media.object.held','Held recording stays in place',{retryAfterS:21600});
    const originals = [];
    for (const id of ids) originals.push(...await db.all('SELECT * FROM media_timeline WHERE object_id = ?', [id]));
    const moving = originals.filter(r=>groups.has(identity(r)) && (r.durable_provider !== groups.get(identity(r)).provider || r.durability !== 'durable'));
    if (!moving.length) return {moved:0,bytes:0};
    const copies = new Map(), staged = [], updated = [];
    let bytes = 0, committed = false;
    try {
        for (const row of moving) {
            if (ctx.signal.aborted) throw ctx.signal.reason || new Error('Cancelled');
            const provider = groups.get(identity(row)).provider;
            const copyId = `${provider}\n${row.key}`;
            if (!copies.has(copyId)) {
                const local = row.local_path && require('fs').existsSync(row.local_path);
                const size = local ? require('fs').statSync(row.local_path).size
                    : Number((await vs.headObject(row.durable_provider,row.key) || {}).size);
                if (!(size > 0) || bytes + size > MAX_BYTES) throw new JobError('startup_budget','Startup move exceeds 512 MiB or has no readable source',{permanent:true});
                bytes += size;
                staged.push({...row,local_path:null,durable_provider:provider});
                if (local) await vs.uploadFile(provider,row.key,row.local_path,Number(row.seq)<=0?'video/mp4':'video/iso.segment',{signal:ctx.signal});
                else if (row.durability === 'durable') await vs.copyBetweenProviders(row.durable_provider,provider,row.key);
                else throw new JobError('segment_unreadable','No durable source',{retryAfterS:300});
                const back = await vs.sha256Object(provider,row.key);
                if (!back || back.sha256 !== (row.packed_object_id || row.sha256) || Number(back.size) !== size)
                    throw new JobError('copy_unverified','Startup copy failed size/SHA256 verification',{retryAfterS:300});
                copies.set(copyId,true);
            }
            updated.push({...row,durable_provider:provider,durability:'durable'});
        }
        if (ctx.signal.aborted) throw ctx.signal.reason || new Error('Cancelled');
        await db.getDb().tx(async()=>{
            // Same locks as timeline.replace and markPacked; the complete snapshot is checked before any row moves.
            for (const id of ids) await db.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked',[`media.timeline:${id}`]);
            for (const id of ids) if (await model.isHeld(id)) throw new JobError('media.object.held','Hold added during copy',{retryAfterS:21600});
            for (const row of moving) {
                const current = await timeline.byName(row.object_id,row.rendition,row.name);
                if (!current || ['key','sha256','durable_provider','packed_object_id','local_path'].some(k=>current[k]!==row[k]))
                    throw new JobError('media.timeline.changed','Timeline changed during startup copy',{retryAfterS:60});
            }
            const queue = require('./queue');
            await queue.enqueue({appId:queue.SYSTEM_APP,type:'storage.startup.cleanup',params:{rows:moving.map(r=>({object_id:r.object_id,durable_provider:r.durable_provider,key:r.key})),object_ids:ids},runAfterS:360,idempotencyKey:`startup-cleanup:${job.id}`,createdBy:'system:startup-tier'});
            for (const row of updated) await db.run("UPDATE media_timeline SET durable_provider = ?, durability = 'durable', updated_at = ov_now() WHERE object_id = ? AND rendition = ? AND seq = ?",[row.durable_provider,row.object_id,row.rendition,row.seq]);
        });
        committed = true;
        // Old presigned URLs (300 s) and joined-row caches (20 s) stay valid through a durable 360 s cleanup job.
        return {moved:updated.length,bytes,hot_seconds:config.hls.startupSeconds,cleanup_after_s:360};
    } finally {
        if (!committed) await timeline.deleteBytes(staged).catch(()=>{});
    }
}
const cleanup = {
    lane:'light',maxAttempts:6,timeoutMs:300000,needsObject:false,
    validate({appId,params}) {
        if (appId !== require('./queue').SYSTEM_APP) throw new JobError('media.job.forbidden','Internal cleanup only',{permanent:true});
        if (!params || !Array.isArray(params.rows) || params.rows.length > 10000 || !Array.isArray(params.object_ids))
            throw new JobError('media.job.invalid','Cleanup rows required',{permanent:true});
        return params;
    },
    async run(job) {
        cleanup.validate({appId:job.app_id,params:job.params});
        for (const id of job.params.object_ids) if (await model.isHeld(id)) throw new JobError('media.object.held','Held copies stay in place',{retryAfterS:21600});
        const result=await timeline.deleteBytes(job.params.rows.map(r=>({durable_provider:r.durable_provider,key:r.key,local_path:null})));
        if (result.failed.length) throw new JobError('cleanup_failed','Old segment copy deletion failed',{retryAfterS:600});
        return {kept:result.kept.length,removed:job.params.rows.length-result.kept.length};
    },
};
module.exports = {plan,queueOnce,playbackPreference,cleanup, spec:{lane:'heavy',maxAttempts:3,timeoutMs:30*60*1000,needsObject:true,validate,run}};
