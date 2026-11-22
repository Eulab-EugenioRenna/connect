import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {BadRequestException,ConflictException,ServiceUnavailableException} from '@nestjs/common';
import {delegatedAccountFixture} from './delegated-account-fixture.js';
const issuer=process.env.SDK_QA_ISSUER!,adminToken=process.env.SDK_QA_ADMIN_TOKEN!,clientSecret=process.env.SDK_QA_CLIENT_SECRET!,databaseUrl=process.env.CONNECT_SDK_TEST_DATABASE_URL!;
assert(issuer&&adminToken&&clientSecret&&databaseUrl,'Use scripts/check-sdk-real-provider.mjs with disposable providers');
const root=issuer.replace('/realms/','/admin/realms/');
async function provider(path:string,method='GET',body?:unknown){
 const r=await fetch(root+path,{method,headers:{Authorization:'Bearer '+adminToken,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(r.status===400)throw new BadRequestException('Provider rejected request');
 if(r.status===409)throw new ConflictException('Provider identity conflict');
 if(!r.ok)throw new ServiceUnavailableException('Disposable provider HTTP '+r.status);
 const text=await r.text();const result=text?JSON.parse(text):null;
 return {body:result,location:r.headers.get('location')};
}
async function login(username:string,password:string){
 return fetch(issuer+'/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'sdk-delegated-test',username,password}),signal:AbortSignal.timeout(10000)});
}
for(const failure of ['none','provider-response','sql-commit']){
 let loseResponse=failure==='provider-response',posts=0;
 const f=await delegatedAccountFixture({databaseUrl,realOidc:{issuer,clientSecret},providerRequest:async(path:string,method='GET',body?:unknown)=>{
  const r=await provider(path,method,body);
  if(path==='/users'&&method==='POST'){posts++;if(loseResponse){loseResponse=false;throw new ServiceUnavailableException('Injected response loss');}}
  return r;
 }});
 try{
  const suffix=randomBytes(6).toString('hex');f.input.username='worker.'+suffix;f.input.email=suffix+'@example.test';
  const original=f.h.store.transaction;
  if(failure==='none'){
   const rejected=await f.mirror({...f.input,initialPassword:'short'});assert.equal(rejected.status,400,JSON.stringify(rejected.body));assert.equal(rejected.body.code,'mirror_password_rejected');assert.equal((await provider('/users?username='+f.input.username)).body.length,0);
  }else if(failure==='sql-commit')f.h.store.transaction=(fn:any)=>original(async(tx:any)=>{await fn(tx);throw Error('Injected failure before SQL COMMIT');});
  const first=await f.mirror();
  if(failure==='none')assert.equal(first.status,201,JSON.stringify(first.body));
  else{
   assert.equal(first.status,503,JSON.stringify(first.body));f.h.store.transaction=original;
   assert.equal((await f.h.store.query('SELECT * FROM app_local_users WHERE local_user_id=$1',[f.input.localUserId])).length,0);
  }
  const again=await f.mirror({...f.input,initialPassword:'Not-Applied-Another-Password-999!'});assert.equal(again.status,201,JSON.stringify(again.body));assert.equal(again.body.applicationAccess,true);assert.equal(again.body.ssoSetupRequired,false);assert.equal(posts,1);
  assert((await login(f.input.username,f.input.initialPassword)).ok,'Original provider password works');assert(!(await login(f.input.username,'Not-Applied-Another-Password-999!')).ok,'Retry never resets password');
  const lookup=await f.h.injectRequest('/v1/app-onboarding/login-context','POST',{schemaVersion:1,sourceId:'delegated-source',appId:'delegated-app',email:f.input.email},{'content-type':'application/json','X-Connect-Source':'delegated-source',Authorization:'Bearer '+f.source.secret});
  assert.equal(lookup.status,201,JSON.stringify(lookup.body));assert.equal(lookup.body.context.user.subject,again.body.subject);
  assert.deepEqual((await f.h.store.query('SELECT role_id FROM assignments WHERE subject=$1',[again.body.subject])).map((r:any)=>r.role_id),[f.worker.id]);
  await f.h.store.query('UPDATE memberships SET enabled=false WHERE subject=$1',[again.body.subject]);
  assert.equal((await f.mirror()).status,409);assert.equal((await f.h.store.query('SELECT enabled FROM memberships WHERE subject=$1',[again.body.subject]))[0].enabled,false);
  const audit=JSON.stringify(await f.h.store.query('SELECT detail FROM audit'));assert(!audit.includes(f.input.initialPassword));
  console.log('PASS: real delegated account '+failure+'; PostgreSQL mapping, selected role, Keycloak password/login, explicit recovery and suspension');
 }finally{await f.h.close();}
}
