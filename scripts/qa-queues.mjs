import {Queue,Worker} from 'bullmq';
import {Redis} from 'ioredis';
import pg from 'pg';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
process.loadEnvFile('.env');
const connection={host:'redis',port:6379,password:process.env.REDIS_PASSWORD,maxRetriesPerRequest:null};
const redis=new Redis(connection),db=new pg.Pool({host:'postgres',user:'connect',database:'connect',password:process.env.POSTGRES_PASSWORD});
const name='qa-'+randomUUID(),queue=new Queue(name,{connection}),workers=[],counts=new Map(),owners=new Set();
try{
 for(const id of ['runner-1','runner-2']){
  assert.equal(await redis.set('runner-owner:'+id,'qa-cannot-take-ownership','EX',1,'NX'),null,'Il runner deve già avere un proprietario');
  assert((await redis.ttl('runner-owner:'+id))>0);
 }
 const runners=(await db.query("SELECT id,heartbeat_at FROM runners WHERE id IN ('runner-1','runner-2') AND heartbeat_at>now()-interval '20 seconds'")).rows;
 assert.equal(runners.length,2,'Entrambi i runner devono avere heartbeat recente');
 for(const owner of ['worker-a','worker-b'])workers.push(new Worker(name,async job=>{owners.add(owner);counts.set(job.id,(counts.get(job.id)||0)+1);await new Promise(r=>setTimeout(r,25));return owner;},{connection,concurrency:2}));
 for(let n=0;n<18;n++){
  await queue.add('synthetic',{scope:'qa-only'},{jobId:'case-'+n});
  await queue.add('synthetic',{scope:'qa-only'},{jobId:'case-'+n});
 }
 const deadline=Date.now()+15000;
 while(await queue.getCompletedCount()<18&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.equal(await queue.getCompletedCount(),18);assert.equal(counts.size,18);assert([...counts.values()].every(n=>n===1));assert.equal(owners.size,2);
 const result={status:'passed',at:new Date().toISOString(),realRedis:true,realBullMQ:true,runnersWithRecentHeartbeat:runners.map(r=>r.id),duplicateRunnerOwnerRejected:true,submittedJobs:36,uniqueJobsExecuted:18,workersUsed:owners.size,duplicateExecutions:0,whatsappSessionsMeasured:0,capacity50to500Verified:false};
 await writeFile('docs/verification/queues-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{
 await Promise.all(workers.map(w=>w.close()));await queue.obliterate({force:true});await queue.close();await redis.quit();await db.end();
}
