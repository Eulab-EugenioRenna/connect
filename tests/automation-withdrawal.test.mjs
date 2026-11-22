import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {automationFixture} from './automation-fixture.mjs';
import {runOutbox} from '../dist/server/apps/runner/src/outbox.js';
import {ConnectServer} from '../packages/sdk/dist/server.js';
const ok=r=>{assert(r.status>=200&&r.status<300,JSON.stringify(r));return r.body;};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const path=(h,id=h.grant.delegation.id,key='withdraw-command-001')=>h.root+`/delegations/${id}/messages/by-key/${key}/withdraw`;
const withdraw=(h,key='withdraw-command-001',input=h.message,headers=h.delegated,id=h.grant.delegation.id)=>h.request(path(h,id,key),'POST',input,headers);
const row=(h,key)=>h.q('SELECT * FROM outbox WHERE installation_id=$1 AND idempotency_key=$2',[h.installation,key]).then(rows=>rows[0]);
const postgres={skip:!process.env.CONNECT_AUTOMATION_TEST_DATABASE_URL};
async function waitForBlockedCommand(h){
 const deadline=Date.now()+7000;
 while(Date.now()<deadline){
  const [r]=await h.q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM automation_delegations WHERE id=%' AND query LIKE '%FOR UPDATE'");
  if(r.n)return;await new Promise(r=>setTimeout(r,10));
 }
 assert.fail('Concurrent command did not wait on the delegation lock');
}

test('Withdrawal: withdraw one queued command idempotently, preserve the other reminders and the shared delegation',async()=>{
 const h=await automationFixture();try{
 const a=ok(await h.send(h.message,'withdraw-command-001')),b=ok(await h.send(h.message,'other-reminder-001'));
 const results=await Promise.all(Array.from({length:8},()=>withdraw(h)));
 for(const r of results){assert.equal(ok(r).outcome,'withdrawn');assert.equal(r.body.message.id,a.id);assert.equal(r.body.message.state,'cancelled');assert.equal(r.body.message.error,'command_withdrawn');}
 const reordered={payload:{text:h.message.payload.text,to:h.message.payload.to,kind:'text'},sessionId:h.session,purpose:h.message.purpose};
 assert.equal(ok(await h.send(reordered,'withdraw-command-001')).state,'cancelled');
 assert.equal(ok(await h.request(h.root+`/delegations/${h.grant.delegation.id}/messages/by-key/withdraw-command-001`,'GET',undefined,h.delegated)).state,'cancelled');
 const effects=[];for(const id of [a.id,b.id])await runOutbox(h.store,id,'synthetic-runner',async()=>async payload=>{effects.push(payload);return 'synthetic-other-reminder';});
 assert.equal(effects.length,1);assert.equal((await row(h,'other-reminder-001')).state,'sent');
 const [d]=await h.q('SELECT revision,revoked_at FROM automation_delegations WHERE id=$1',[h.grant.delegation.id]);assert.equal(d.revision,1);assert.equal(d.revoked_at,null);
 assert.equal((await h.q("SELECT * FROM audit WHERE action='automation.message.withdraw'")).length,1);
 assert.equal((await h.q('SELECT * FROM outbox')).length,2);
 }finally{await h.close();}
});

test('Withdrawal: absent command creates a durable cancelled outbox receipt; late send/replay cannot enqueue it',async()=>{
 const h=await automationFixture();try{
 const first=ok(await withdraw(h));assert.equal(first.outcome,'withdrawn');assert.equal(first.message.state,'cancelled');
 const before=await row(h,'withdraw-command-001');assert.equal(before.authorization_cipher,'');assert.equal(before.actor,h.actor);assert.equal(before.delegation_purpose,h.message.purpose);assert.deepEqual(before.payload,h.message.payload);
 for(let n=0;n<3;n++){assert.deepEqual(ok(await withdraw(h)),first);assert.equal(ok(await h.send(h.message,'withdraw-command-001')).id,first.message.id);}
 let effects=0;await runOutbox(h.store,first.message.id,'synthetic-runner',async()=>async()=>{effects++;return 'forbidden';});assert.equal(effects,0);
 assert.equal((await h.q('SELECT * FROM outbox')).length,1);assert.deepEqual(await row(h,'withdraw-command-001'),before);
 assert.equal((await h.send({...h.message,payload:{...h.message.payload,text:'changed'}},'withdraw-command-001')).status,409);
 }finally{await h.close();}
});

test('Withdrawal: key, payload, purpose, session and delegation conflicts never change another command',async()=>{
 const h=await automationFixture();try{
 ok(await h.send(h.message,'withdraw-command-001'));const before=await row(h,'withdraw-command-001');
 for(const input of [{...h.message,purpose:'other-purpose'},{...h.message,sessionId:randomUUID()},{...h.message,payload:{...h.message.payload,text:'different'}}])assert.equal((await withdraw(h,'withdraw-command-001',input)).status,409);
 const other=ok(await h.create(h.input,'other-delegation-001'));
 assert.equal((await withdraw(h,'withdraw-command-001',h.message,{...h.server,'X-Connect-Delegation':other.credential},other.delegation.id)).status,409);
 assert.deepEqual(await row(h,'withdraw-command-001'),before);
 for(const input of [{...h.message,purpose:'other-purpose'},{...h.message,sessionId:randomUUID()}])assert.equal((await withdraw(h,'absent-conflicting-001',input)).status,409);
 const legacy=ok(await h.request(`/v1/installations/${h.installation}/whatsapp/sessions/${h.session}/messages`,'POST',h.message.payload,{...h.personal,'Idempotency-Key':'manual-owned-key-001'}));
 assert.equal((await withdraw(h,'manual-owned-key-001')).status,409);assert.equal((await row(h,'manual-owned-key-001')).id,legacy.id);assert.equal((await row(h,'manual-owned-key-001')).state,'queued');
 assert.equal((await withdraw(h,'withdraw-command-001',h.message,{...h.server,'X-Connect-Delegation':'invalid-credential'})).status,404);
 assert.equal((await withdraw(h,'withdraw-command-001',h.message,{...h.personal,'X-Connect-Delegation':h.grant.credential,Origin:'https://synthetic.example.test'})).status,403);
 assert.equal((await withdraw(h,'withdraw-command-001',h.message,h.server)).status,403);
 assert.equal((await h.q("SELECT * FROM audit WHERE action='automation.message.withdraw'")).length,0);
 }finally{await h.close();}
});

test('Withdrawal: installation boundaries deny a foreign session/grant and preserve both installations',async()=>{
 const h=await automationFixture();try{
 ok(await h.send(h.message,'withdraw-command-001'));
 const archive=randomUUID(),session=randomUUID();
 await h.q("INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,'15550000003')",[archive,h.otherInstallation]);
 await h.q("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'synthetic-runner',$3,'15550000003','connected')",[session,h.otherInstallation,archive]);
 const root=h.root.replace(h.installation,h.otherInstallation),personal={...h.personal,'X-Installation-Id':h.otherInstallation};
 const grant=ok(await h.request(root+'/delegations','POST',{...h.input,archiveId:archive},{...personal,'Idempotency-Key':'other-install-grant-001'}));
 const headers={...personal,Authorization:'','X-Connect-Delegation':grant.credential},input={...h.message,sessionId:session};
 const queued=ok(await h.request(root+`/delegations/${grant.delegation.id}/messages`,'POST',input,{...headers,'Idempotency-Key':'withdraw-command-001'}));
 assert.equal((await withdraw(h,'foreign-session-001',input)).status,409);
 assert.equal((await h.request(root+`/delegations/${h.grant.delegation.id}/messages/by-key/withdraw-command-001/withdraw`,'POST',h.message,{...headers,'X-Connect-Delegation':h.grant.credential})).status,404);
 assert.equal((await h.request(path(h),'POST',h.message,headers)).status,403);
 assert.equal((await row(h,'withdraw-command-001')).state,'queued');assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'queued');
 }finally{await h.close();}
});

test('Withdrawal: read and reserve cancellation after grant expiry/revocation, without identity-provider access or browser token',async()=>{
 const h=await automationFixture();try{
 ok(await h.send(h.message,'expired-queued-001'));
 await h.q("UPDATE automation_delegations SET expires_at=now()-interval '1 second' WHERE id=$1",[h.grant.delegation.id]);
 h.setRevoked(true);h.setIdentityUnavailable(true);
 assert.equal(ok(await withdraw(h,'expired-queued-001')).outcome,'withdrawn');
 assert.equal(ok(await withdraw(h,'expired-absent-001')).outcome,'withdrawn');
 assert.equal(ok(await h.send(h.message,'expired-absent-001')).state,'cancelled');assert.equal((await h.send(h.message,'new-expired-send-001')).status,403);
 ok(await h.request(h.root+'/delegations/'+h.grant.delegation.id,'DELETE',undefined,h.delegated));
 const r=ok(await withdraw(h,'revoked-absent-001'));assert.equal(r.outcome,'withdrawn');
 assert.equal(ok(await h.request(h.root+`/delegations/${h.grant.delegation.id}/messages/by-key/revoked-absent-001`,'GET',undefined,h.delegated)).id,r.message.id);
 assert.equal(ok(await h.send(h.message,'revoked-absent-001')).state,'cancelled');assert.equal((await h.send(h.message,'new-revoked-send-001')).status,403);
 }finally{await h.close();}
});

test('Withdrawal: sending/sent/uncertain remain effect_started; failed/cancelled remain already_terminal with no new attempt',async()=>{
 const h=await automationFixture();try{
 for(const state of ['sending','sent','uncertain','failed','cancelled']){
  const key='post-claim-'+state,queued=ok(await h.send(h.message,key));
  await h.q('UPDATE outbox SET state=$2,provider_id=$3,error=$4 WHERE id=$1',[queued.id,state,state==='sent'?'synthetic-provider-id':null,state==='cancelled'?'authorization_revoked':'synthetic-status']);
  const before=await row(h,key),r=ok(await withdraw(h,key));assert.equal(r.outcome,['failed','cancelled'].includes(state)?'already_terminal':'effect_started');assert.equal(r.message.state,state);
  assert.deepEqual(ok(await withdraw(h,key)),r);assert.deepEqual(await row(h,key),before);assert.equal(ok(await h.send(h.message,key)).state,state);
  await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{assert.fail('No new provider effect permitted');});
 }
 assert.equal((await h.q("SELECT * FROM audit WHERE action='automation.message.withdraw'")).length,0);
 }finally{await h.close();}
});

test('Withdrawal SDK: lost send/withdraw acknowledgements recover the same receipt and secret with no new keys',async()=>{
 const h=await automationFixture(),originalFetch=globalThis.fetch;try{
 const client=new ConnectServer({apiUrl:await h.listen(),installationId:h.installation,secret:h.secret}).automations();
 let loseSend=true,loseWithdraw=true;
 globalThis.fetch=async(...args)=>{
  const response=await originalFetch(...args),url=String(args[0]);
  if(response.ok&&args[1]?.method==='POST'&&(url.endsWith('/messages')&&loseSend||url.endsWith('/withdraw')&&loseWithdraw)){
   if(url.endsWith('/messages'))loseSend=false;else loseWithdraw=false;
   await response.arrayBuffer();throw new Error('synthetic acknowledgement lost after commit');
  }
  return response;
 };
 await assert.rejects(()=>client.send(h.grant.delegation.id,h.grant.credential,h.message,'lost-ack-command-001'),/acknowledgement lost/);
 await assert.rejects(()=>client.withdraw(h.grant.delegation.id,h.grant.credential,h.message,'lost-ack-command-001'),/acknowledgement lost/);
 const result=await client.withdraw(h.grant.delegation.id,h.grant.credential,h.message,'lost-ack-command-001');assert.equal(result.outcome,'withdrawn');
 assert.deepEqual(await client.message(h.grant.delegation.id,h.grant.credential,'lost-ack-command-001'),result.message);
 assert.equal((await client.send(h.grant.delegation.id,h.grant.credential,h.message,'lost-ack-command-001')).state,'cancelled');
 assert.equal((await h.q('SELECT * FROM outbox')).length,1);assert.equal((await h.q("SELECT * FROM audit WHERE action='automation.message.withdraw'")).length,1);
 loseWithdraw=true;
 await assert.rejects(()=>client.withdraw(h.grant.delegation.id,h.grant.credential,h.message,'lost-absent-ack-001'),/acknowledgement lost/);
 const absent=await client.withdraw(h.grant.delegation.id,h.grant.credential,h.message,'lost-absent-ack-001');assert.equal(absent.outcome,'withdrawn');
 assert.equal((await client.send(h.grant.delegation.id,h.grant.credential,h.message,'lost-absent-ack-001')).id,absent.message.id);
 assert.equal((await h.q('SELECT * FROM outbox')).length,2);assert.equal((await h.q("SELECT * FROM audit WHERE action='automation.message.withdraw'")).length,2);
 assert.equal(ok(await h.create()).credential,h.grant.credential);
 }finally{globalThis.fetch=originalFetch;await h.close();}
});

test('PostgreSQL withdrawal: an uncommitted send fences withdrawal until commit, then withdrawal cancels the same command',postgres,async()=>{
 const h=await automationFixture(),entered=deferred(),release=deferred();let sending,withdrawing;
 try{
 h.setBeforeProviderRead(async()=>{entered.resolve();await release.promise;});
 sending=h.send(h.message,'uncommitted-send-001');await entered.promise;
 withdrawing=withdraw(h,'uncommitted-send-001');await waitForBlockedCommand(h);
 assert.equal(await row(h,'uncommitted-send-001'),undefined);
 release.resolve();const [s,w]=await Promise.all([sending,withdrawing]);assert.equal(ok(w).message.id,ok(s).id);assert.equal(w.body.outcome,'withdrawn');
 assert.equal(ok(await h.send(h.message,'uncommitted-send-001')).state,'cancelled');
 }finally{release.resolve();await Promise.allSettled([sending,withdrawing]);await h.close();}
});

test('PostgreSQL withdrawal: an uncommitted absent-command tombstone fences a concurrent send; no late queued commit',postgres,async()=>{
 const h=await automationFixture(),entered=deferred(),release=deferred(),original=h.store.transaction;let sending,withdrawing;
 try{
 h.store.transaction=fn=>original(async tx=>{const result=await fn(tx);if(result?.outcome==='withdrawn'){entered.resolve();await release.promise;}return result;});
 withdrawing=withdraw(h,'uncommitted-withdraw-001');await entered.promise;
 sending=h.send(h.message,'uncommitted-withdraw-001');await waitForBlockedCommand(h);
 assert.equal(await row(h,'uncommitted-withdraw-001'),undefined);
 release.resolve();const [w,s]=await Promise.all([withdrawing,sending]);assert.equal(ok(s).id,ok(w).message.id);assert.equal(s.body.state,'cancelled');
 let effects=0;await runOutbox(h.store,s.body.id,'synthetic-runner',async()=>async()=>{effects++;return 'forbidden';});assert.equal(effects,0);
 }finally{release.resolve();await Promise.allSettled([sending,withdrawing]);h.store.transaction=original;await h.close();}
});

test('PostgreSQL withdrawal: runner/withdrawal races serialize; withdrawal cannot claim success after runner acquisition',postgres,async()=>{
 const h=await automationFixture();try{
 for(let n=0;n<10;n++){
  const key='runner-withdraw-race-'+n,queued=ok(await h.send(h.message,key));let effects=0;
  const [w]=await Promise.all([withdraw(h,key),runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{effects++;return 'synthetic-race-provider';})]);
  const result=ok(w),current=await row(h,key);
  if(result.outcome==='withdrawn'){assert.equal(effects,0);assert.equal(current.state,'cancelled');}else{assert.equal(result.outcome,'effect_started');assert.equal(effects,1);assert.equal(current.state,'sent');}
 }
 // Deterministically hold the real runner after its durable claim, before provider invocation.
 const queued=ok(await h.send(h.message,'runner-already-claimed')),entered=deferred(),release=deferred();let checks=0,effects=0;
 const running=runOutbox(h.store,queued.id,'synthetic-runner',async()=>{if(++checks===2){entered.resolve();await release.promise;}return async()=>{effects++;return 'synthetic-claimed-provider';};});
 try{await entered.promise;const r=ok(await withdraw(h,'runner-already-claimed'));assert.equal(r.outcome,'effect_started');assert.equal(r.message.state,'sending');}finally{release.resolve();await running;}
 assert.equal(effects,1);assert.equal((await row(h,'runner-already-claimed')).state,'sent');
 }finally{await h.close();}
});
