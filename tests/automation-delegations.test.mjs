import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {automationFixture} from './automation-fixture.mjs';
import {runOutbox,recoverInterruptedOutbox} from '../dist/server/apps/runner/src/outbox.js';
import {ConnectServer,verifyWebhook} from '../packages/sdk/dist/server.js';
import {seal,signature} from '../dist/server/apps/api/src/security.js';

const scope={purpose:'appointments.reminder',channel:'whatsapp',functions:['whatsapp.send']};
const ok=r=>{assert(r.status>=200&&r.status<300,JSON.stringify(r));return r.body;};

test('Automation: concurrent grant recovery, lost response, canonical conflict, actor/install boundaries and browser secrecy',async()=>{
 const h=await automationFixture();try{
 const firstCreations=await Promise.all(Array.from({length:8},()=>h.create(h.input,'concurrent-first-001')));
 for(const r of firstCreations)assert.equal(ok(r).credential,ok(firstCreations[0]).credential);
 const grants=await Promise.all(Array.from({length:8},()=>h.create()));
 for(const r of grants){const b=ok(r);assert.equal(b.delegation.id,h.grant.delegation.id);assert.equal(b.credential,h.grant.credential);assert.equal(b.delegation.createdAt,h.grant.delegation.createdAt);}
 assert.equal((await h.q('SELECT * FROM automation_delegations')).length,2);
 const recovered=ok(await h.request(h.root+'/delegations/by-key/synthetic-grant-001','GET',undefined,h.personal));assert.equal(recovered.credential,h.grant.credential);
 assert.equal((await h.create({...h.input,purpose:'other'})).status,409);
 const reordered={expiresAt:h.input.expiresAt,archiveId:h.archive,functions:['whatsapp.send','whatsapp.manage'],channel:'whatsapp',purpose:h.input.purpose};assert.equal(ok(await h.create(reordered)).credential,h.grant.credential);
 const token=await h.token('synthetic-other-author',[]),other={...h.personal,Authorization:'Bearer '+token};
 assert.equal((await h.request(h.root+'/delegations/by-key/synthetic-grant-001','GET',undefined,other)).status,404);
 assert.equal((await h.request(h.root+'/delegations/'+h.grant.delegation.id,'GET',undefined,other)).status,404);
 assert.equal((await h.create(h.input,'browser-key-001',{...h.personal,Origin:'https://synthetic.example.test'})).status,403);
 assert.equal((await h.create(h.input,'browser-key-002',{'X-Installation-Id':h.installation,Origin:'https://synthetic.example.test',Authorization:h.personal.Authorization})).status,403);
 const cross={...h.delegated,'X-Installation-Id':h.otherInstallation};
 assert.equal((await h.request(h.root.replace(h.installation,h.otherInstallation)+'/delegations/'+h.grant.delegation.id,'GET',undefined,cross)).status,404);
 assert.equal((await h.create({...h.input,subject:'synthetic-other-author',admin:true},'forged-job-001')).status,400);
 assert.equal((await h.create({...h.input,functions:['whatsapp.send']},'missing-manage-001')).status,400);
 assert.equal((await h.create({...h.input,expiresAt:new Date(Date.now()-1000).toISOString()},'expired-grant-001')).status,400);
 const safe=ok(await h.request(h.root+'/delegations/'+h.grant.delegation.id,'GET',undefined,h.delegated));assert(!JSON.stringify(safe).includes(h.grant.credential));
 for(const path of ['/v1/overview',`/v1/installations/${h.installation}/whatsapp/outbox`])assert(!JSON.stringify(await h.request(path)).includes(h.grant.credential));
 const stored=(await h.q('SELECT credential_cipher FROM automation_delegations'))[0];assert(!stored.credential_cipher.includes(h.grant.credential));
 assert(!JSON.stringify(await h.q('SELECT * FROM audit')).includes(h.grant.credential));
 }finally{await h.close();}
});

test('Automation: same outbox receipt after enqueue timeout, parallel sends, worker concurrency and no UI token',async()=>{
 const h=await automationFixture();try{
 const messages=await Promise.all(Array.from({length:8},()=>h.send()));const id=ok(messages[0]).id;
 for(const r of messages)assert.equal(ok(r).id,id);
 assert.equal((await h.q('SELECT * FROM outbox')).length,1);
 assert.equal((await h.send({...h.message,payload:{...h.message.payload,text:'Conflict'}})).status,409);
 const stored=(await h.q('SELECT * FROM outbox'))[0];assert.equal(stored.authorization_cipher,'');assert.equal(stored.actor,h.actor);
 // Revoke UI sessions in the synthetic identity provider. Durable delegation still uses current central grants.
 h.setRevoked(true);
 let sends=0;const effect=async()=>async()=>{sends++;await new Promise(r=>setTimeout(r,25));return 'synthetic-provider-id';};
 await Promise.all(Array.from({length:8},()=>runOutbox(h.store,id,'synthetic-runner',effect)));assert.equal(sends,1);
 const status=ok(await h.request(h.root+`/delegations/${h.grant.delegation.id}/messages/by-key/synthetic-message-001`,'GET',undefined,h.delegated));assert.equal(status.state,'sent');assert.equal(status.providerId,'synthetic-provider-id');
 assert.equal(ok(await h.send()).id,id);assert.equal((await h.q("SELECT * FROM events WHERE kind='message.sent'")).length,1);
 assert.equal((await h.q('SELECT * FROM outbox')).length,1);
 }finally{await h.close();}
});

test('Automation: expiry and current user, membership, role, function, feature, licence, link and installation revocations deny effects',async()=>{
 const h=await automationFixture();try{
 const changes=[
 ["UPDATE automation_delegations SET expires_at=now()-interval '1 second'", "UPDATE automation_delegations SET expires_at=now()+interval '1 day'"],
 ["UPDATE identities SET enabled=false WHERE subject='synthetic-automation-author'","UPDATE identities SET enabled=true"],
 ['UPDATE memberships SET enabled=false','UPDATE memberships SET enabled=true'],
 ["DELETE FROM role_permissions WHERE permission_key='whatsapp.manage'","INSERT INTO role_permissions SELECT id,'synthetic-automation','whatsapp.manage' FROM roles"],
 ["UPDATE permissions SET active=false WHERE key='whatsapp.send'",'UPDATE permissions SET active=true'],
 ["UPDATE features SET active=false WHERE key='whatsapp'",'UPDATE features SET active=true'],
 ["UPDATE entitlements SET enabled=false WHERE feature_key='whatsapp'",'UPDATE entitlements SET enabled=true'],
 ["UPDATE entitlements SET purchased=false WHERE feature_key='whatsapp'",'UPDATE entitlements SET purchased=true'],
 ["UPDATE licenses SET state='suspended'","UPDATE licenses SET state='active'"],
 ["UPDATE licenses SET expires_at=now()-interval '1 second'",'UPDATE licenses SET expires_at=NULL'],
 ["INSERT INTO app_access_revocations(customer_id,app_id,subject,revoked_by) SELECT id,'synthetic-automation','synthetic-automation-author','synthetic-actor' FROM customers",'DELETE FROM app_access_revocations'],
 ["DELETE FROM local_links WHERE subject='synthetic-automation-author'",`INSERT INTO local_links(installation_id,local_user_id,subject) VALUES('${h.installation}','synthetic-user','synthetic-automation-author')`],
 ['UPDATE installations SET enabled=false','UPDATE installations SET enabled=true']
 ];
 let effects=0;
 for(let n=0;n<changes.length;n++){
  const queued=ok(await h.send(h.message,'synthetic-revoke-'+n));await h.q(changes[n][0]);
  await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{effects++;return 'forbidden-effect';});
  assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'cancelled','revocation '+n);
  if(n!==0&&n!==12){assert.equal((await h.create(h.input,'denied-create-'+n)).status,403);}
  await h.q(changes[n][1]);
 }
 assert.equal(effects,0);
 // Explicit revocation cancels accepted queue entries and remains idempotent.
 const queued=ok(await h.send(h.message,'explicit-revocation-001'));
 const revoke=()=>h.request(h.root+'/delegations/'+h.grant.delegation.id,'DELETE',undefined,h.delegated);
 const revoked=ok(await revoke());assert.equal(revoked.revision,2);assert.equal(ok(await revoke()).revision,2);
 assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'cancelled');
 assert.equal(ok(await h.send(h.message,'explicit-revocation-001')).id,queued.id);
 assert.equal((await h.send(h.message,'new-after-revoke-001')).status,403);
 assert.equal(ok(await h.request(h.root+'/delegations/'+h.grant.delegation.id+'/verify','POST',scope,h.delegated)).reason,'delegation_revoked');
 }finally{await h.close();}
});

test('Automation: purpose/channel isolation and connection rotation retain archive binding',async()=>{
 const h=await automationFixture();try{
 const verify=body=>h.request(h.root+'/delegations/'+h.grant.delegation.id+'/verify','POST',body,h.delegated);
 assert.equal(ok(await verify(scope)).allowed,true);
 for(const body of [{...scope,purpose:'other'},{...scope,channel:'email'},{...scope,functions:['appointments.notify']}])assert.equal(ok(await verify(body)).reason,'delegation_scope_mismatch');
 assert.equal((await h.send({...h.message,purpose:'other'})).status,403);
 for(const channel of ['application_notification','email']){
  const input={purpose:'appointments.reminder',channel,functions:[channel==='email'?'appointments.email':'appointments.notify'],expiresAt:h.input.expiresAt};
  const grant=ok(await h.create(input,channel+'-grant-001'));
  assert.equal((await h.send(h.message,channel+'-message-001',{...h.server,'X-Connect-Delegation':grant.credential},grant.delegation.id)).status,403);
  assert.equal((await h.create({...input,functions:['whatsapp.send']},channel+'-invalid-001')).status,400);
 }
 const queued=ok(await h.send());
 await h.q("UPDATE wa_sessions SET state='disconnected',closed_at=now() WHERE id=$1",[h.session]);
 let sends=0;await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{sends++;return 'no';});assert.equal(sends,0);
 const newSession=randomUUID();await h.q("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'synthetic-runner',$3,'15550000001','connected')",[newSession,h.installation,h.archive]);
 assert.equal((await h.send({...h.message,sessionId:newSession},'rotated-session-001')).status,201);
 assert.equal((await h.send({...h.message,sessionId:newSession})).status,409);
 const foreignArchive=randomUUID();await h.q("INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,'15550000003')",[foreignArchive,h.otherInstallation]);
 assert.equal((await h.create({...h.input,archiveId:foreignArchive},'foreign-archive-001')).status,404);
 }finally{await h.close();}
});

test('Automation: crash before/after provider effect, timeouts and lost commit responses never replay an uncertain send',async()=>{
 const h=await automationFixture();try{
 let effects=0;
 // Provider received a command but its response was lost.
 const first=ok(await h.send());await runOutbox(h.store,first.id,'synthetic-runner',async()=>async()=>{effects++;throw new Error('synthetic timeout after effect');});
 assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[first.id]))[0].state,'uncertain');
 await runOutbox(h.store,first.id,'synthetic-runner',async()=>async()=>{effects++;return 'duplicate';});assert.equal(effects,1);
 assert.equal(ok(await h.send()).state,'uncertain');
 for(const stage of ['before','after']){
  const key='crash-'+stage+'-001',queued=ok(await h.send(h.message,key));
  // Persisted boundary left by an interrupted process; startup must never turn it back into queued.
  await h.q("UPDATE outbox SET state='sending' WHERE id=$1",[queued.id]);if(stage==='after')effects++;
  await recoverInterruptedOutbox(h.store,'synthetic-runner');
  await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{effects++;return 'duplicate';});assert.equal(ok(await h.send(h.message,key)).state,'uncertain');
 }
 assert.equal(effects,2);
 // A real commit succeeded but the database transport response was lost.
 const queued=ok(await h.send(h.message,'lost-commit-001'));let commits=0;
 const store={query:h.store.query,transaction:async fn=>{const result=await h.store.transaction(fn);if(++commits===3)throw new Error('synthetic response lost after commit');return result;}};
 await runOutbox(store,queued.id,'synthetic-runner',async()=>async()=>{effects++;return 'committed-provider-id';});
 assert.equal(ok(await h.send(h.message,'lost-commit-001')).state,'sent');
 await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{effects++;return 'duplicate';});assert.equal(effects,3);
 }finally{await h.close();}
});

test('Automation SDK consumer: actual HTTP, lost response after commit, stable grant/send/webhook recovery, original-body signature verification',async()=>{
 const h=await automationFixture();const originalFetch=globalThis.fetch;try{
 const server=new ConnectServer({apiUrl:await h.listen(),installationId:h.installation,secret:h.secret});
 const personal=server.automations(h.personal.Authorization.slice(7)),worker=server.automations();
 let lose=true;
 globalThis.fetch=async(...args)=>{const response=await originalFetch(...args);if(lose&&response.ok&&args[1]?.method==='POST'&&String(args[0]).endsWith('/delegations')){lose=false;await response.arrayBuffer();throw new Error('synthetic response lost');}return response;};
 await assert.rejects(()=>personal.create(h.input,'sdk-lost-grant-001'),/response lost/);
 const recovered=await personal.recover('sdk-lost-grant-001');const replay=await personal.create(h.input,'sdk-lost-grant-001');assert.equal(recovered.credential,replay.credential);
 let lostSend=true;globalThis.fetch=async(...args)=>{const response=await originalFetch(...args);if(lostSend&&response.ok&&args[1]?.method==='POST'&&String(args[0]).endsWith('/messages')){lostSend=false;await response.arrayBuffer();throw new Error('synthetic response lost');}return response;};
 await assert.rejects(()=>worker.send(recovered.delegation.id,recovered.credential,h.message,'sdk-message-key-001'),/response lost/);
 const receipt=await worker.message(recovered.delegation.id,recovered.credential,'sdk-message-key-001');assert.equal(receipt.id,(await worker.send(recovered.delegation.id,recovered.credential,h.message,'sdk-message-key-001')).id);
 let lostHook=true;globalThis.fetch=async(...args)=>{const response=await originalFetch(...args);if(lostHook&&response.ok&&args[1]?.method==='POST'&&String(args[0]).endsWith('/webhooks')){lostHook=false;await response.arrayBuffer();throw new Error('synthetic response lost');}return response;};
 await assert.rejects(()=>personal.webhooks.create('https://consumer.example.test/hook','sdk-webhook-key-001'),/response lost/);
 const hook=await personal.webhooks.recover('sdk-webhook-key-001');
 const hooks=await Promise.all(Array.from({length:8},()=>personal.webhooks.create('https://consumer.example.test/hook','sdk-webhook-key-001')));for(const item of hooks)assert.equal(item.secret,hook.secret);
 const concurrentHooks=await Promise.all(Array.from({length:8},()=>personal.webhooks.create('https://consumer.example.test/second','concurrent-hook-001')));for(const item of concurrentHooks)assert.equal(item.secret,concurrentHooks[0].secret);
 assert.equal((await h.q('SELECT * FROM webhook_endpoints')).length,2);
 await h.request(`/v1/installations/${h.installation}/whatsapp/webhooks/${hook.id}`,'PUT',{enabled:false});
 assert.equal((await personal.webhooks.recover('sdk-webhook-key-001')).enabled,false);
 assert.equal((await personal.webhooks.create('https://consumer.example.test/hook','sdk-webhook-key-001')).enabled,false);
 await assert.rejects(()=>personal.webhooks.create('https://consumer.example.test/changed','sdk-webhook-key-001'),e=>e.status===409);
 const other=server.automations(await h.token('synthetic-other-author',[]));await assert.rejects(()=>other.webhooks.recover('sdk-webhook-key-001'),e=>e.status===404);
 assert(!JSON.stringify(await h.request(`/v1/installations/${h.installation}/whatsapp/webhooks`)).includes(hook.secret));
 assert(!JSON.stringify(await h.q('SELECT * FROM audit')).includes(hook.secret));
 const raw=JSON.stringify({id:'synthetic-event',installationId:h.installation,sessionId:h.session,payload:{direction:'in'}}),timestamp=String(Math.floor(Date.now()/1000));
 assert(verifyWebhook(hook.secret,raw,timestamp,signature(hook.secret,timestamp,raw)));
 assert(!verifyWebhook(hook.secret,raw+' ',timestamp,signature(hook.secret,timestamp,raw)));
 assert(!verifyWebhook(hook.secret,raw,timestamp,'0'.repeat(64)));
 assert(!verifyWebhook(hook.secret,raw,timestamp,signature(hook.secret,timestamp,raw),Date.now()+301000));
 assert((await worker.get(recovered.delegation.id,recovered.credential)).id);
 assert((await worker.verify(recovered.delegation.id,scope,recovered.credential)).allowed);
 assert((await worker.revoke(recovered.delegation.id,recovered.credential)).revokedAt);
 // Legacy manual webhook contract is retained.
 assert.equal((await h.request(`/v1/installations/${h.installation}/whatsapp/webhooks`,'POST',{url:'https://manual.example.test/hook'})).status,201);
 }finally{globalThis.fetch=originalFetch;await h.close();}
});


test('Automation: revocation committed after claim but before effect is rechecked; manual API/runner remains session-bound',async()=>{
 const h=await automationFixture();try{
 const queued=ok(await h.send());let boundaries=0,effects=0;
 await runOutbox(h.store,queued.id,'synthetic-runner',async()=>{
  if(++boundaries===2)ok(await h.request(h.root+'/delegations/'+h.grant.delegation.id,'DELETE',undefined,h.delegated));
  return async()=>{effects++;return 'must-not-send';};
 });
 assert.equal(effects,0);assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'cancelled');
 const manualRoot=`/v1/installations/${h.installation}/whatsapp/sessions/${h.session}/messages`;
 const manual=ok(await h.request(manualRoot,'POST',h.message.payload,{...h.personal,'Idempotency-Key':'manual-compatibility-001'}));
 await runOutbox(h.store,manual.id,'synthetic-runner',async()=>async()=>{effects++;return 'manual-synthetic-id';});assert.equal(effects,1);
 const expired=ok(await h.request(manualRoot,'POST',h.message.payload,{...h.personal,'Idempotency-Key':'manual-expired-ui-001'}));
 h.setRevoked(true);await runOutbox(h.store,expired.id,'synthetic-runner',async()=>async()=>{effects++;return 'must-not-send';});assert.equal(effects,1);
 assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[expired.id]))[0].state,'cancelled');
 }finally{await h.close();}
});


test('Automation: current synthetic identity provider disable/delete and outages are checked independently from UI session',async()=>{
 const h=await automationFixture();try{
 for(const state of ['disabled','missing']){
  const queued=ok(await h.send(h.message,'provider-'+state+'-001'));
  if(state==='disabled')h.providerUsers.set(h.actor,{id:h.actor,enabled:false});else h.providerUsers.delete(h.actor);
  assert.equal((await h.create(h.input,'provider-denied-'+state)).status,403);
  let effects=0;await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{effects++;return 'forbidden';});assert.equal(effects,0);
  assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'cancelled');
  h.providerUsers.set(h.actor,{id:h.actor,enabled:true});
 }
 const queued=ok(await h.send(h.message,'provider-unavailable-001'));h.setIdentityUnavailable(true);
 assert.equal((await h.create(h.input,'provider-unavailable-grant')).status,503);
 await assert.rejects(()=>runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{throw new Error('MUST_NOT_SEND');}));
 assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'queued');
 h.setIdentityUnavailable(false);
 }finally{await h.close();}
});


test('Automation: licence revocation while provider identity check is in flight is observed before effect',{skip:!process.env.CONNECT_AUTOMATION_TEST_DATABASE_URL},async()=>{
 const h=await automationFixture();try{
 const queued=ok(await h.send());let reads=0,effects=0;
 h.setBeforeProviderRead(async()=>{if(++reads===2)await h.q("UPDATE licenses SET state='suspended'");});
 await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{effects++;return 'must-not-send';});
 assert.equal(reads,2);assert.equal(effects,0);assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'cancelled');
 }finally{await h.close();}
});

test('Automation: interactive buttons/lists use the existing payload contract and secrets never enter emitted logs',async()=>{
 const h=await automationFixture(),errors=[],warn=console.warn,error=console.error;
 try{
 console.warn=(...args)=>errors.push(args);console.error=(...args)=>errors.push(args);
 const contents=[
 {type:'buttons',body:'Synthetic confirmation',actions:[{type:'reply',id:'synthetic-confirm',label:'Confirm'}]},
 {type:'list',body:'Synthetic choice',buttonLabel:'Choose',sections:[{rows:[{id:'synthetic-option',title:'Synthetic option'}]}]}
 ];
 for(let n=0;n<contents.length;n++){
  const queued=ok(await h.send({...h.message,payload:{kind:'interactive',to:h.message.payload.to,content:contents[n]}},'interactive-delegated-'+n));
  const stored=(await h.q('SELECT payload FROM outbox WHERE id=$1',[queued.id]))[0];assert.deepEqual(stored.payload.content,contents[n]);
  await runOutbox(h.store,queued.id,'synthetic-runner',async()=>async()=>{throw new Error(h.grant.credential);});
  assert.equal((await h.q('SELECT state FROM outbox WHERE id=$1',[queued.id]))[0].state,'uncertain');
 }
 assert.equal((await h.send(h.message,'bad-credential-001',{...h.server,'X-Connect-Delegation':'wrong-credential'})).status,404);
 assert.equal((await h.request(h.root+'/webhooks','POST',{url:'https://consumer.example.test/hook'},{...h.personal,Origin:'https://synthetic.example.test','Idempotency-Key':'browser-webhook-001'})).status,403);
 assert(!JSON.stringify(errors).includes(h.grant.credential));assert(!JSON.stringify(errors).includes(h.secret));
 assert(!JSON.stringify(await h.q('SELECT * FROM audit')).includes(h.grant.credential));
 }finally{console.warn=warn;console.error=error;await h.close();}
});
