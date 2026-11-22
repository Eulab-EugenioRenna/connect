import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {automationFixture} from './automation-fixture.mjs';
import {runOutbox,recoverInterruptedOutbox} from '../dist/server/apps/runner/src/outbox.js';

test('PostgreSQL: kill the real synthetic worker before and after effect; neither receipt can be automatically resent',{skip:!process.env.CONNECT_AUTOMATION_TEST_DATABASE_URL},async()=>{
 const h=await automationFixture();try{
 await h.q('CREATE TABLE synthetic_provider_effects(outbox_id uuid PRIMARY KEY)');
 const schema=(await h.q('SELECT current_schema() AS name'))[0].name;
 const url=new URL(process.env.CONNECT_AUTOMATION_TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 for(const stage of ['before','after']){
  const key='real-process-crash-'+stage,queued=await h.send(h.message,key);assert.equal(queued.status,201);
  const child=fork(new URL('./automation-crash-worker.mjs',import.meta.url),[],{execArgv:[],env:{...process.env,DATABASE_URL:url.href,SYNTHETIC_OUTBOX_ID:queued.body.id,SYNTHETIC_CRASH_STAGE:stage},stdio:['ignore','pipe','pipe','ipc']});
  let errors='';child.stderr.on('data',b=>errors+=b);
  try{
   const received=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error('worker exited '+code+': '+errors);}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('worker boundary timeout: '+errors)),15000);t.unref();})]);
   assert.equal(received[0].stage,stage);
   const exited=once(child,'exit');child.kill('SIGKILL');await exited;
   assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.body.id]))[0].state,'sending');
   await recoverInterruptedOutbox(h.store,'synthetic-runner');
   await Promise.all(Array.from({length:4},()=>runOutbox(h.store,queued.body.id,'synthetic-runner',async()=>async()=>{throw new Error('MUST_NOT_SEND');})));
   assert.equal((await h.send(h.message,key)).body.state,'uncertain');
   assert.equal((await h.q('SELECT * FROM synthetic_provider_effects WHERE outbox_id=$1',[queued.body.id])).length,stage==='after'?1:0);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
 }
 assert.equal((await h.q('SELECT * FROM synthetic_provider_effects')).length,1);
 }finally{await h.close();}
});
