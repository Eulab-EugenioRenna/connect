import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {delegatedAccountFixture as fixture} from './delegated-account-fixture.js';
import {defineFunctions} from '../packages/sdk/src/functions.js';
async function grant(f:Awaited<ReturnType<typeof fixture>>){
 const keys=['team.manage','work.read','work.write','team.password.reset'];
 f.h.setCatalogReader(async()=>defineFunctions({appId:'delegated-app',version:2,functions:keys.map(key=>({key,name:key}))}));
 assert.equal((await f.h.request('/v1/applications/delegated-app/catalog-sync','POST')).body.ok,true);
 await f.h.request('/v1/licenses','PUT',{customerId:f.customer.id,appId:'delegated-app',state:'active',expiresAt:null,features:keys.map(key=>({key,purchased:true,enabled:true})),reason:'Test'});
 await f.h.request('/v1/roles','PUT',{id:f.owner.id,customerId:f.customer.id,appId:'delegated-app',name:'Owner',permissions:['team.manage','work.read','team.password.reset'],reason:'Explicit reset delegation'});
}
test('Delegated password reset requires explicit grant, isolates targets and never returns credentials',async()=>{
 const f=await fixture();try{
  const created=await f.mirror(),subject=created.body.subject;
  const reset=(target=subject)=>f.h.request('/v1/team/users/'+target+'/password-reset','POST',{},f.headers);
  assert.equal((await reset()).status,403);await grant(f);
  assert.equal((await reset('owner')).status,403);assert.equal((await reset(randomUUID())).status,404);
  await f.h.store.query("UPDATE app_local_users SET role='owner' WHERE subject=$1",[subject]);assert.equal((await reset()).status,403);
  await f.h.store.query("UPDATE app_local_users SET role='collaborator' WHERE subject=$1",[subject]);
  f.users.get(subject).protected=true;assert.equal((await reset()).status,403);f.users.get(subject).protected=false;
  const result=await reset();assert.equal(result.status,201);assert.deepEqual(result.body,{requested:true});
  const calls=f.calls.filter(c=>c.path.includes('/execute-actions-email'));assert.equal(calls.length,1);assert.equal(calls[0].method,'PUT');assert.deepEqual(calls[0].body,['UPDATE_PASSWORD']);
  assert.equal((await reset()).status,409);assert.equal(f.calls.filter(c=>c.path.includes('/execute-actions-email')).length,1);
  assert(!JSON.stringify(await f.h.store.query('SELECT * FROM audit')).includes(f.input.initialPassword));
 }finally{await f.h.close();}
});
test('Delegated password reset preserves revocation and suppresses automatic resend after uncertain provider response',async()=>{
 const f=await fixture();try{
  const subject=(await f.mirror()).body.subject;await grant(f);
  await f.h.store.query('INSERT INTO app_access_revocations(customer_id,app_id,subject,revoked_by) VALUES($1,$2,$3,$4)',[f.customer.id,'delegated-app',subject,'owner']);
  const reset=()=>f.h.request('/v1/team/users/'+subject+'/password-reset','POST',{},f.headers);
  assert.equal((await reset()).status,409);await f.h.store.query('DELETE FROM app_access_revocations WHERE subject=$1',[subject]);
  f.set({rejectReset:true});const result=await reset();assert.equal(result.status,503);assert.equal(result.body.code,'password_reset_outcome_uncertain');assert.equal((await reset()).status,409);
  assert.equal(f.calls.filter(c=>c.path.includes('/execute-actions-email')).length,1);
 }finally{await f.h.close();}
});
