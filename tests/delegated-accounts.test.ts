import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

import {delegatedAccountFixture as fixture} from './delegated-account-fixture.js';

test('Delegated account: mirror -> source mapping -> selected role -> authorized login context; replay never resets password',async()=>{
 const f=await fixture();try{
  const r=await f.mirror();assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.applicationAccess,true);
  assert.deepEqual(r.body.roleIds,[f.worker.id]);assert.equal(r.body.sourceId,'delegated-source');assert.equal(r.body.localTenantId,'local-company');assert.equal(r.body.ssoSetupRequired,false);
  const mapped=(await f.h.store.query('SELECT * FROM app_local_users WHERE local_user_id=$1',[f.input.localUserId]))[0];assert.equal(mapped.subject,r.body.subject);assert.equal(mapped.role,'collaborator');assert.deepEqual(mapped.permissions,['work.read']);
  const lookup=await f.h.injectRequest('/v1/app-onboarding/login-context','POST',{schemaVersion:1,appId:'delegated-app',sourceId:'delegated-source',email:f.input.email},{'content-type':'application/json',Authorization:'Bearer '+f.source.secret,'X-Connect-Source':'delegated-source'});
  assert.equal(lookup.status,201,JSON.stringify(lookup.body));assert.equal(lookup.body.context.user.subject,r.body.subject);
  const again=await f.mirror({...f.input,initialPassword:'Different-Password-8!'});assert.equal(again.body.status,'already_linked');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert(!JSON.stringify(await f.h.store.query('SELECT * FROM audit')).includes(f.input.initialPassword));assert(!JSON.stringify(r.body).includes(f.input.initialPassword));
 }finally{await f.h.close();}
});

const beforeCreate:[string,number,(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>|void][]=[
 ['bearer missing',403,f=>{f.headers.Authorization='';}],
 ['installation credential missing',401,f=>{f.headers['X-Installation-Secret']='';}],
 ['no team.manage',403,async f=>{await f.h.store.query('DELETE FROM assignments WHERE subject=$1 AND role_id=$2',['owner',f.owner.id]);await f.h.store.query('INSERT INTO assignments VALUES($1,$2,$3,$4)',['owner',f.customer.id,'delegated-app',f.worker.id]);}],
 ['foreign source',403,f=>{f.input.application.sourceId='foreign-source';}],
 ['foreign local tenant',403,f=>{f.input.application.localTenantId='other-company';}],
 ['unapproved integration',403,async f=>{await f.h.store.query("UPDATE connect_sources SET integration_approved=false WHERE id='delegated-source'");}],
 ['disabled source',403,async f=>{await f.h.store.query("UPDATE connect_sources SET enabled=false WHERE id='delegated-source'");}],
 ['disabled binding',403,async f=>{await f.h.store.query("UPDATE source_installation_bindings SET enabled=false WHERE source_id='delegated-source'");}],
 ['foreign customer binding',403,async f=>{const other=(await f.h.request('/v1/customers','POST',{name:'Other'})).body;await f.h.store.query('UPDATE source_tenant_bindings SET customer_id=$1',[other.id]);}],
 ['operator source mapping disabled',403,async f=>{await f.h.store.query("UPDATE app_local_users SET enabled=false WHERE subject='owner'");}],
 ['foreign role',404,f=>{f.input.application.roleIds=[randomUUID()];}],
 ['role outside delegation',403,f=>{f.input.application.roleIds=[f.power.id];}],
 ['unlicensed permission',403,async f=>{await f.h.store.query("UPDATE entitlements SET enabled=false WHERE feature_key='work.read'");}],
 ['historical inactive permission',403,async f=>{await f.h.store.query("UPDATE permissions SET active=false WHERE key='work.read'");}],
 ['local owner is forbidden',400,f=>{(f.input.application as any).role='owner';}],
 ['local permissions outside selected roles',403,f=>{f.input.application.permissions=['team.manage'];}],
 ['empty roles',400,f=>{f.input.application.roleIds=[];}],
 ['duplicate roles',409,f=>{f.input.application.roleIds=[f.worker.id,f.worker.id];}],
 ['username occupied without proof',409,f=>{f.users.set('occupied',{id:'occupied',username:f.input.username,email:f.input.email,enabled:true});}],
 ['email occupied without proof',409,f=>{f.users.set('occupied',{id:'occupied',username:'another.name',email:f.input.email,enabled:true});}],
 ['legacy local link without application receipt',409,async f=>{await f.h.request('/v1/identities','PUT',{subject:'legacy',displayName:'Legacy',enabled:true});await f.h.store.query('INSERT INTO local_links VALUES($1,$2,$3)',[f.site.installationId,f.input.localUserId,'legacy']);}],
 ['initial password policy rejected',400,f=>{f.set({rejectPassword:true});}]
];
for(const [label,status,setup] of beforeCreate)test('Delegated account denies before granting: '+label,async()=>{
 const f=await fixture();try{
  await setup(f);const r=await f.mirror();assert.equal(r.status,status,JSON.stringify(r.body));
  assert.equal((await f.h.store.query('SELECT * FROM app_local_users WHERE local_user_id=$1',[f.input.localUserId])).length,0);
  assert.equal(f.users.size,label.includes('occupied')?1:0);assert(!JSON.stringify(r.body).includes(f.input.initialPassword));
 }finally{await f.h.close();}
});

const afterCreate:[string,(f:Awaited<ReturnType<typeof fixture>>,subject:string)=>Promise<void>|void][]=[
 ['mapping suspended',async(f,subject)=>{await f.h.store.query('UPDATE app_local_users SET enabled=false WHERE subject=$1',[subject]);}],
 ['identity suspended',async(f,subject)=>{await f.h.store.query('UPDATE identities SET enabled=false WHERE subject=$1',[subject]);}],
 ['membership suspended',async(f,subject)=>{await f.h.store.query('UPDATE memberships SET enabled=false WHERE subject=$1',[subject]);}],
 ['provider identity suspended',(f,subject)=>{f.users.get(subject).enabled=false;}],
 ['protected provider identity',(f,subject)=>{f.users.get(subject).protected=true;}],
 ['provider profile edited',(f,subject)=>{f.users.get(subject).firstName='Changed';}],
 ['application revocation',async(f,subject)=>{await f.h.store.query("INSERT INTO app_access_revocations VALUES($1,$2,$3,now(),'admin')",[f.customer.id,'delegated-app',subject]);}],
 ['assignments changed',async(f,subject)=>{await f.h.store.query('DELETE FROM assignments WHERE subject=$1',[subject]);}],
 ['profile changed',f=>{f.input.application.lastName='Changed';}],
 ['requested roles changed',f=>{f.input.application.roleIds=[f.owner.id];}]
];
for(const [label,edit] of afterCreate)test('Delegated account replay preserves administrative decisions: '+label,async()=>{
 const f=await fixture();try{
  const first=await f.mirror();assert.equal(first.status,201,JSON.stringify(first.body));await edit(f,first.body.subject);
  const tables=['app_local_users','assignments','local_links','memberships','identities','app_access_revocations'];
  const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(t=>f.h.store.query('SELECT * FROM '+t+' ORDER BY 1,2'))));
  const before=await snapshot(),again=await f.mirror();assert([403,409].includes(again.status),JSON.stringify(again.body));assert.equal(await snapshot(),before);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 }finally{await f.h.close();}
});

test('Delegated account: lost provider response and SQL rollback recover only on explicit retry, same profile and original password',async()=>{
 for(const failure of ['provider','sql']){
  const f=await fixture();try{
   const original=f.h.store.transaction;
   if(failure==='provider')f.set({loseResponse:true});
   else f.h.store.transaction=(fn:any)=>original(async(tx:any)=>{await fn(tx);throw Error('Injected final SQL failure');});
   const first=await f.mirror();assert.equal(first.status,503,JSON.stringify(first.body));assert.equal(first.body.code,'mirror_outcome_uncertain');
   f.h.store.transaction=original;assert.equal(f.users.size,1);assert.equal((await f.h.store.query('SELECT * FROM local_links WHERE local_user_id=$1',[f.input.localUserId])).length,0);
   const changed=await f.mirror({...f.input,application:{...f.input.application,lastName:'Different'}});assert.equal(changed.status,409);
   const retry=await f.mirror({...f.input,initialPassword:'New-Value-Not-Applied-8!'});assert.equal(retry.status,201,JSON.stringify(retry.body));assert.equal(retry.body.status,'recovered');
   assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal([...f.users.values()][0].credentials[0].value,f.input.initialPassword);
  }finally{await f.h.close();}
 }
});

test('Delegated account: concurrent creates return one durable mapping and one provider identity',async()=>{
 const f=await fixture();try{
  const results=await Promise.all([f.mirror(),f.mirror()]);for(const r of results)assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal(f.users.size,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.deepEqual(results.map(r=>r.body.subject),[results[0].body.subject,results[0].body.subject]);
 }finally{await f.h.close();}
});


test('Delegated account: valid objects from a second customer/installation/source cannot be mixed',async()=>{
 const f=await fixture();try{
  const customer=(await f.h.request('/v1/customers','POST',{name:'Foreign company'})).body;
  const site=(await f.h.request('/v1/application-connections','POST',{id:'foreign-app',name:'Foreign app',customerId:customer.id,domain:'https://foreign.test',integration:'web'})).body;
  await f.h.request('/v1/connect-sources','POST',{id:'foreign-source',appId:'foreign-app',name:'Foreign source',environment:'development',origins:['https://foreign.test'],deploymentIdentity:'foreign'});
  await f.h.request('/v1/connect-sources/foreign-source/installations','POST',{installationId:site.installationId});
  await f.h.store.query("INSERT INTO source_tenant_bindings(source_id,local_tenant_id,customer_id,app_id) VALUES('foreign-source','foreign-company',$1,'foreign-app')",[customer.id]);
  const foreign=await f.mirror({...f.input,application:{...f.input.application,sourceId:'foreign-source',localTenantId:'foreign-company'}});assert.equal(foreign.status,403);
  const installation=await f.mirror(f.input,{'X-Installation-Id':site.installationId,'X-Installation-Secret':site.secret});assert.equal(installation.status,403);
  assert.equal(f.users.size,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }finally{await f.h.close();}
});

test('Delegated account: SQL recovery cannot acquire an identity made more privileged by an administrator',async()=>{
 const f=await fixture();try{
  f.set({loseResponse:true});assert.equal((await f.mirror()).status,503);const subject=[...f.users.keys()][0];
  await f.h.request('/v1/identities','PUT',{subject,displayName:'Recovered identity',enabled:true});
  await f.h.request('/v1/memberships','PUT',{subject,customerId:f.customer.id,enabled:true,roleIds:[f.power.id]});
  const retry=await f.mirror();assert.equal(retry.status,403);assert.equal((await f.h.store.query('SELECT * FROM app_local_users WHERE subject=$1',[subject])).length,0);
  assert.equal((await f.h.store.query('SELECT role_id FROM assignments WHERE subject=$1',[subject]))[0].role_id,f.power.id);
 }finally{await f.h.close();}
});

test('Delegated account: unconfigured provider proofs fail before creating an identity',async()=>{
 const f=await fixture({providerProfile:false});try{
  const r=await f.mirror();assert.equal(r.status,503);assert.equal(r.body.code,'mirror_provider_configuration_required');assert.equal(f.users.size,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }finally{await f.h.close();}
});


test('Delegated account: temporary password requires first-login update and replay never resets it',async()=>{
 const f=await fixture();try{
  const result=await f.mirror({...f.input,initialPasswordTemporary:true});assert.equal(result.status,201);
  const user=f.users.get(result.body.subject);assert.equal(user.credentials[0].temporary,true);assert.deepEqual(user.requiredActions,['UPDATE_PASSWORD']);assert.equal(result.body.ssoSetupRequired,true);
  await f.mirror({...f.input,initialPasswordTemporary:false,initialPassword:'Replacement-must-not-apply'});
  assert.equal(user.credentials[0].value,f.input.initialPassword);assert.equal(user.credentials[0].temporary,true);assert.equal(f.calls.filter(c=>c.path==='/users'&&c.method==='POST').length,1);
 }finally{await f.h.close();}
});
