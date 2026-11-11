'use strict';
const assert = require('assert');
const crypto = require('crypto');
process.env.MEDIA_HLS_ENABLED='1';
process.env.MEDIA_HLS_STARTUP_SECONDS='180';
(async()=>{
 const db=require('../server/db/database'), timeline=require('../server/objects/timeline');
 const model=require('../server/objects/model'), storage=require('../server/vod/vod-storage');
 const startup=require('../server/jobs/startup-tier'), config=require('../server/config');
 const obj={id:'startup-test',app_id:'live',kind:'vod',lifecycle_status:'ready'};
 const queue=require('../server/jobs/queue');
 const original={get:model.getObject,held:model.isHeld,enqueue:queue.enqueue};
 model.getObject=async()=>obj; model.isHeld=async()=>false;
 const blobs=new Map(), sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const source=(seq,start)=>{
  const bytes=Buffer.from(`segment-${seq}`), key=`startup/${seq}.m4s`; blobs.set(`b2:${key}`,bytes);
  return {seq,name:seq?`${seq}.m4s`:'init.mp4',start_ms:start,end_ms:seq?start+4000:0,keyframe_ms:seq?start:null,
   key,local_path:null,durable_provider:'b2',packed_object_id:null,byte_offset:null,byte_length:bytes.length,
   sha256:sha(bytes),durability:'durable',init_name:null};
 };
 const rows=[source(0,0),source(1,176000),source(2,180000),source(3,220000)];
 await timeline.replace(obj.id,'source',rows);
 const native={};
 for(const k of ['providerAvailable','providerConfigured','headObject','copyBetweenProviders','sha256Object','deleteObject'])native[k]=storage[k];
 storage.providerAvailable=storage.providerConfigured=()=>true;
 storage.headObject=async(p,k)=>blobs.has(`${p}:${k}`)?{size:blobs.get(`${p}:${k}`).length}:null;
 storage.copyBetweenProviders=async(a,b,k)=>{blobs.set(`${b}:${k}`,blobs.get(`${a}:${k}`));return true;};
 storage.sha256Object=async(p,k)=>{const b=blobs.get(`${p}:${k}`);return b?{size:b.length,sha256:sha(b)}:null;};
 storage.deleteObject=async(p,k)=>{blobs.delete(`${p}:${k}`);return true;};
 require('../server/jobs/queue').register('storage.startup.cleanup',startup.cleanup);
 const ctx={signal:new AbortController().signal};
 try {
  let queuedByRead=null; queue.enqueue=async request=>{queuedByRead=request;return request;};
  await startup.queueOnce(obj);
  assert.strictEqual(queuedByRead.objectId,obj.id,'master queues its existing source through the real recording-part lookup');
  queue.enqueue=original.enqueue;
  const read=storage.sha256Object;
  storage.sha256Object=async()=>({size:9,sha256:'wrong'});
  await assert.rejects(startup.spec.run({id:'startup-job-test',app_id:'live',object_id:obj.id},ctx),/verification/);
  assert((await timeline.list(obj.id)).every(r=>r.durable_provider==='b2'),'failed copy leaves every original route');
  assert(blobs.has('b2:startup/0.m4s')); assert(!blobs.has('r2:startup/0.m4s'),'uncommitted copy cleaned');
  storage.sha256Object=read;
  const copy=storage.copyBetweenProviders;
  const cancelled=new AbortController();
  storage.copyBetweenProviders=async(a,b,k)=>{await copy(a,b,k);cancelled.abort(new Error('Test cancelled'));};
  await assert.rejects(startup.spec.run({id:'cancelled-job',app_id:'live',object_id:obj.id},{signal:cancelled.signal}),/Test cancelled/);
  assert((await timeline.list(obj.id)).every(r=>r.durable_provider==='b2'),'cancellation keeps original routes');
  assert(!blobs.has('r2:startup/0.m4s'),'cancelled copies cleaned');
  let raced=false;
  storage.copyBetweenProviders=async(a,b,k)=>{
   await copy(a,b,k);
   if(!raced){raced=true;await db.run('UPDATE media_timeline SET packed_object_id = ? WHERE object_id = ? AND seq = 1',['concurrent-pack',obj.id]);}
  };
  await assert.rejects(startup.spec.run({id:'raced-job',app_id:'live',object_id:obj.id},ctx),/Timeline changed/);
  assert((await timeline.list(obj.id)).every(r=>r.durable_provider==='b2'),'a concurrent pack is never overwritten');
  await db.run('UPDATE media_timeline SET packed_object_id = NULL WHERE object_id = ?',[obj.id]);
  storage.copyBetweenProviders=copy;
  await timeline.replace('startup-alias','source',[rows[1]]);
  const result=await startup.spec.run({id:'startup-job-test',app_id:'live',object_id:obj.id},ctx);
  assert.strictEqual(result.moved,2);
  assert(blobs.has('b2:startup/0.m4s'),'old signed URLs stay readable until cleanup');
  const queued=await db.get("SELECT * FROM media_jobs WHERE job_type = 'storage.startup.cleanup'");
  assert(queued.run_after,'cleanup is durably delayed');
  assert.throws(()=>startup.cleanup.validate({appId:'live',params:{rows:[],object_ids:[]}}),/Internal/);
  const cleaned=await startup.cleanup.run({...queued,params:JSON.parse(queued.params)});
  assert.strictEqual(cleaned.kept,1,'another timeline retains its old copy');
  assert(blobs.has('b2:startup/1.m4s'));
  assert(!blobs.has('b2:startup/0.m4s'));
  assert(blobs.has('r2:startup/0.m4s'));
  assert.deepStrictEqual((await timeline.list(obj.id)).map(r=>r.durable_provider),['r2','r2','b2','b2']);
  assert.strictEqual((await startup.spec.run({id:'startup-job-test',app_id:'live',object_id:obj.id},ctx)).moved,0,'idempotent');
  const joined=[{...rows[1],object_id:'part1',rendition:'source',start_ms:179000,key:'chunk'},
   {...rows[2],object_id:'part1',rendition:'source',start_ms:181000,key:'chunk'},
   {...rows[1],object_id:'part2',rendition:'source',start_ms:220000,key:'later'}];
  assert.deepStrictEqual([...startup.plan(joined).values()].map(x=>x.provider),['r2','b2'],'whole crossing chunk stays hot; part2 uses recording time');
  assert.strictEqual(startup.playbackPreference({durability:'durable',durable_provider:'b2'}),'b2');
  assert.strictEqual(startup.playbackPreference({durability:'local',durable_provider:null}),null);
  config.hls.startupSeconds=0;
  assert.strictEqual((await startup.spec.run({id:'startup-job-test',app_id:'live',object_id:obj.id},ctx)).skipped,'startup placement disabled');
  config.hls.startupSeconds=180;
  model.isHeld=async()=>true;
  await assert.rejects(startup.spec.run({id:'startup-job-test',app_id:'live',object_id:obj.id},ctx),/Held/);
  console.log('startup tier: verified R2 prefix/B2 tail, failed-copy rollback, idempotency, packed boundary, recording time, hold and off switch passed');
 } finally {
  Object.assign(storage,native);model.getObject=original.get;model.isHeld=original.held;queue.enqueue=original.enqueue;
  await db.run('DELETE FROM media_timeline WHERE object_id IN (?, ?)',[obj.id,'startup-alias']); await db.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1});
