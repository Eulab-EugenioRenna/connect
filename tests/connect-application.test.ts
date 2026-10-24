import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {generateKeyPair,SignJWT,exportJWK} from 'jose';
import pg from 'pg';
import {ConnectApplication,ConnectApplicationError,PostgresConnectApplicationStore} from '../packages/sdk/src/application.js';
import type {ConnectApplicationStore,ConnectStoreTransaction,BrowserContext,CookieDirective,ConnectApplicationConfig} from '../packages/sdk/src/application.js';

/** Test-only store. Models checkpoints and rollback; never exported to consumers. */
class TestStore implements ConnectApplicationStore {
 failNextFinalCommit=false;
 records=new Map<string,{value:string;expiry:number}>();tails=new Map<string,Promise<unknown>>();
 transaction<T>(key:string,fn:(tx:ConnectStoreTransaction)=>Promise<T>):Promise<T>{
  const result=(this.tails.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{
   const writes=new Map<string,{value:string;expiry:number}|null>();
   const commit=()=>{for(const [id,value] of writes){if(value)this.records.set(id,value);else this.records.delete(id);}writes.clear();};
   const tx:ConnectStoreTransaction={
    get:async id=>{const r=writes.has(id)?writes.get(id):this.records.get(id);return r&&r.expiry>Date.now()?r.value:null;},
    put:async(id,value,expiry)=>{writes.set(id,{value,expiry});},remove:async id=>{writes.set(id,null);},checkpoint:async()=>{commit();}
   };
   const value=await fn(tx);if(this.failNextFinalCommit){this.failNextFinalCommit=false;throw Error('Injected process loss after durable checkpoint');}commit();return value;
  });this.tails.set(key,result);return result;
 }
}
const hash=(s:string)=>createHash('sha256').update(s).digest('base64url');
async function fixture(){
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='sdk-test';
 let base='',legacyCalls=0,provisions=0,refreshes=0,revoked=false,required=false,badAccess=false,badSubject=false,uncertain=false,provisionFail=false;
 const codes=new Map<string,{nonce:string;challenge:string}>(),refreshTokens=new Set(['refresh-first']);
 const context={tenant:{id:'workspace-1',name:'Workshop',slug:'workshop'},binding:{installationId:'installation-1',customerId:'customer-1',secret:'installation-secret'},user:{id:'user-1',subject:'subject-1',email:'person@example.test',firstName:'Person',lastName:'Example',role:'owner' as const,permissions:['projects.read']}};
 let malformed=false,known=true,request:any;const received:any[]=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const url=new URL(req.url!,base),path=url.pathname;
  const json=(value:any,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(path.endsWith('/certs'))return json({keys:[jwk]});
  if(path.endsWith('/.well-known/openid-configuration'))return json({issuer:base});
  if(path.endsWith('/token')){
   const params=new URLSearchParams(raw);received.push({grant:params.get('grant_type')});
   if(params.get('grant_type')==='refresh_token'){
    refreshes++;await new Promise(r=>setTimeout(r,20));
    const token=params.get('refresh_token')!;if(uncertain){res.destroy();return;}if(revoked||!refreshTokens.delete(token))return json({error:'invalid_grant'},400);
    const next='refresh-'+refreshes;refreshTokens.add(next);return json({access_token:'access-fresh',refresh_token:next,expires_in:300});
   }
   const proof=codes.get(params.get('code')!);codes.delete(params.get('code')!);if(!proof||hash(params.get('code_verifier')!)!==proof.challenge)return json({},400);
   if(required)return json({error:'required_action'},400);
   const id=await new SignJWT({nonce:proof.nonce}).setSubject(badSubject?'another-subject':context.user.subject).setIssuer(base).setAudience('workshop').setIssuedAt().setExpirationTime('5m').setProtectedHeader({alg:'RS256',kid:'sdk-test'}).sign(privateKey);
   return json({access_token:'access-first',refresh_token:'refresh-first',expires_in:300,id_token:id});
  }
  if(path.endsWith('/logout'))return json({});
  if(path==='/v1/app-onboarding/login-context')return json(malformed?{}:known?{status:'connect',context}:{status:'not_found',...(request?{request}:{})});
  if(path==='/v1/app-onboarding/configuration')return json({status:'ready',configuration:{sourceId:'workshop-dev',appId:'workshop',issuer:base,clientId:'workshop',redirectUri:base+'/callback',clientSecret:'configuration-secret'}});
  if(path==='/v1/app-onboarding/requests'){received.push(JSON.parse(raw));request={requestId:'request-1',state:'pending',nextAction:'wait'};return json(request);}
  if(path==='/v1/app-onboarding/password-recovery'){received.push(JSON.parse(raw));return json({requestId:'request-1',state:'pending',nextAction:'wait'});}
  if(path==='/v1/access')return json({canLogin:!revoked,appId:'workshop',installationId:context.binding.installationId,subject:context.user.subject,localUserId:badAccess?'foreign-user':context.user.id});
  if(path==='/v1/authorize')return json({allowed:!revoked,reason:'permission'});
  return json({},404);
 });server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as any).port;
 const memory=new TestStore();let store:ConnectApplicationStore=memory,pool:pg.Pool|undefined,secondPool:pg.Pool|undefined,secondStore:ConnectApplicationStore|undefined;
 if(process.env.CONNECT_SDK_TEST_DATABASE_URL){pool=new pg.Pool({connectionString:process.env.CONNECT_SDK_TEST_DATABASE_URL});const namespace='test-'+randomUUID();const postgres=new PostgresConnectApplicationStore(pool,namespace);await postgres.migrate();store=postgres;secondPool=new pg.Pool({connectionString:process.env.CONNECT_SDK_TEST_DATABASE_URL});secondStore=new PostgresConnectApplicationStore(secondPool,namespace);}
 const config:ConnectApplicationConfig={apiUrl:base,sourceId:'workshop-dev',sourceSecret:'source-secret',appId:'workshop',issuer:base,clientId:'workshop',redirectUri:base+'/callback',appOrigin:base,allowLoopbackHttp:true,encryptionKey:'d'.repeat(64),store,catalog:{schemaVersion:1,appId:'workshop',version:1,functions:[{key:'projects.read',name:'Projects'}]},accounts:{
  verifyLegacy:async input=>{legacyCalls++;return input.password==='legacy-password'?{localTenant:context.tenant,localUser:((({subject,...user})=>user)(context.user))}:null;},
  provision:async(_c,op)=>{provisions++;assert(op.operationId.startsWith('handoff:'));if(provisionFail)throw new ConnectApplicationError('provision_conflict');return {localUserId:context.user.id,localTenantId:context.tenant.id};},
  restrict:async(profile,_key,resource)=>profile.localTenantId===(resource as any)?.tenantId
 }};
 const a=new ConnectApplication(config),b=new ConnectApplication({...config,store:secondStore??store});const browser:BrowserContext={origin:base,cookies:{}};
 const cookies=(directives:CookieDirective[])=>{for(const c of directives)browser.cookies[c.name]=c.value;};
 async function callback(){const start=await a.auth.signIn({email:context.user.email},browser);assert.equal(start.status,'redirect');if(start.status!=='redirect')throw Error();cookies(start.cookies);const u=new URL(start.url),code=randomUUID();codes.set(code,{nonce:u.searchParams.get('nonce')!,challenge:u.searchParams.get('code_challenge')!});return {state:u.searchParams.get('state')!,code};}
 async function session(){const input=await callback(),h=await b.auth.callback(input,browser);cookies(h.cookies);const exchange=await a.auth.exchange(h.handoff,browser);cookies(exchange.cookies);return exchange.session.sessionId;}
 return {codeFor:(url:string)=>{const u=new URL(url),code=randomUUID();codes.set(code,{nonce:u.searchParams.get('nonce')!,challenge:u.searchParams.get('code_challenge')!});return {state:u.searchParams.get('state')!,code};},a,b,config,browser,memory,store,pool,context,received,cookies,callback,session,get counts(){return {legacyCalls,provisions,refreshes};},set:(v:any)=>{if('malformed'in v)malformed=v.malformed;if('known'in v)known=v.known;if('request'in v)request=v.request;if('revoked'in v)revoked=v.revoked;if('required'in v)required=v.required;if('badAccess'in v)badAccess=v.badAccess;if('badSubject'in v)badSubject=v.badSubject;if('uncertain'in v)uncertain=v.uncertain;if('provisionFail'in v)provisionFail=v.provisionFail;},close:async()=>{await pool?.end();await secondPool?.end();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
const rejectsCode=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,(e:any)=>e instanceof ConnectApplicationError&&e.code===code);

test('Application: source-first, signed callback, cookie/state correlation, one-use handoff and concurrent replay',async()=>{
 const f=await fixture();try{
  f.set({malformed:true});await rejectsCode(()=>f.a.auth.signIn({email:f.context.user.email,password:'legacy-password'},f.browser),'provider_unavailable');assert.equal(f.counts.legacyCalls,0);f.set({malformed:false});
  const callback=await f.callback();assert.equal(f.counts.legacyCalls,0);
  const results=await Promise.allSettled([f.a.auth.callback(callback,f.browser),f.b.auth.callback(callback,f.browser)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const h=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;f.cookies(h.cookies);
  assert(!JSON.stringify(h).includes('refresh-first'));assert(!JSON.stringify(h).includes('installation-secret'));
  const exchange=await Promise.allSettled([f.a.auth.exchange(h.handoff,f.browser),f.b.auth.exchange(h.handoff,f.browser)]);
  assert.equal(exchange.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.counts.provisions,1);
  const session=(exchange.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;assert(!JSON.stringify(session).includes('access-first'));
  for(const row of f.memory.records.values())assert(!row.value.includes('installation-secret')&&!row.value.includes('refresh-first'));
  const input=await f.callback();await rejectsCode(()=>f.a.auth.callback(input,{...f.browser,cookies:{}}),'invalid_flow');await rejectsCode(()=>f.a.auth.callback(input,f.browser),'invalid_flow');
 }finally{await f.close();}
});
test('Application: two instances serialize refresh, deny foreign resources and honor revocation/logout',async()=>{
 const f=await fixture();try{
  const id=await f.session();await Promise.all([f.a.auth.refresh(id),f.b.auth.refresh(id),f.a.auth.refresh(id)]);assert.equal(f.counts.refreshes,1);
  assert.equal((await f.a.access.authorize(id,'projects.read',{tenantId:'foreign'})).allowed,false);assert.equal((await f.a.access.authorize(id,'projects.read',{tenantId:'workspace-1'})).allowed,true);
  f.set({revoked:true});await rejectsCode(()=>f.b.auth.resolve(id),'access_denied');await rejectsCode(()=>f.a.auth.resolve(id),'session_expired');
  f.set({revoked:false});const id2=await f.session();await Promise.allSettled([f.a.auth.refresh(id2),f.b.auth.logout(id2,f.browser)]);await rejectsCode(()=>f.a.auth.resolve(id2),'session_expired');assert.equal((await f.a.auth.logout(id2,f.browser)).providerRevoked,null);
 }finally{await f.close();}
});
test('Application: ambiguous rotating grant is never retried, even by another instance',async()=>{
 const f=await fixture();try{const id=await f.session();f.set({uncertain:true});await rejectsCode(()=>f.a.auth.refresh(id),'provider_unavailable');await rejectsCode(()=>f.b.auth.refresh(id),'session_expired');assert.equal(f.counts.refreshes,1);}finally{await f.close();}
});
test('Application: wrong subject/local binding and required actions cannot provision',async()=>{
 const f=await fixture();try{
  for(const flags of [{badSubject:true},{badSubject:false,badAccess:true},{badAccess:false,required:true}]){f.set(flags);const callback=await f.callback();await assert.rejects(()=>f.a.auth.callback(callback,f.browser));}
  assert.equal(f.counts.provisions,0);
  f.set({required:false});const callback=await f.callback();f.context.tenant.id='foreign-workspace';await rejectsCode(()=>f.a.auth.callback(callback,f.browser),'invalid_context');assert.equal(f.counts.provisions,0);
 }finally{await f.close();}
});
test('Application: pending migration never grants a local session; recovery requires fresh proof, consent and a different password',async()=>{
 const f=await fixture();try{
  f.set({known:false,request:{requestId:'request-1',state:'pending',nextAction:'wait'}});
  const pending=await f.a.auth.signIn({email:'person@example.test',password:'legacy-password'},f.browser);assert.equal(pending.status,'pending');assert.equal(f.counts.provisions,0);assert.equal(f.counts.legacyCalls,0);
  f.set({request:{requestId:'request-1',state:'failed',nextAction:'choose_connect_password'}});
  const prepare=async()=>{const r=await f.a.auth.signIn({email:'person@example.test',password:'legacy-password'},f.browser);assert.equal(r.status,'migration_required');if(r.status!=='migration_required')throw Error();f.cookies(r.cookies);return r;};
  let r=await prepare();await rejectsCode(()=>f.a.migration.submit({challenge:r.challenge,legacyPassword:'legacy-password',consentVersion:r.consentVersion,idempotencyKey:'recovery-key-1',newConnectPassword:'legacy-password'},f.browser),'invalid_password');
  r=await prepare();await rejectsCode(()=>f.a.migration.submit({challenge:r.challenge,legacyPassword:'legacy-password',consentVersion:'wrong',idempotencyKey:'recovery-key-1',newConnectPassword:'New-Connect-Password-9!'},f.browser),'invalid_consent');
  await f.a.migration.submit({challenge:r.challenge,legacyPassword:'legacy-password',consentVersion:r.consentVersion,idempotencyKey:'recovery-key-1',newConnectPassword:'New-Connect-Password-9!'},f.browser);
  assert.equal(f.received.at(-1).newPassword,'New-Connect-Password-9!');assert(!JSON.stringify(f.received.at(-1)).includes('legacy-password'));assert.equal(f.counts.provisions,0);
  await rejectsCode(()=>f.b.migration.submit({challenge:r.challenge,legacyPassword:'legacy-password',consentVersion:r.consentVersion,idempotencyKey:'recovery-key-2'},f.browser),'invalid_flow');
 }finally{await f.close();}
});
test('Application: handoff provisioning rollback supports idempotent reconciliation; diagnostics never certify user authorization',async()=>{
 const f=await fixture();try{
  const callback=await f.callback(),h=await f.a.auth.callback(callback,f.browser);f.cookies(h.cookies);f.set({provisionFail:true});await rejectsCode(()=>f.a.auth.exchange(h.handoff,f.browser),'provision_conflict');f.set({provisionFail:false});const s=await f.b.auth.exchange(h.handoff,f.browser);assert.equal(s.session.profile.localUserId,'user-1');
  const invalid=await ConnectApplication.diagnose({...f.config,encryptionKey:'bad-key'});assert.equal(invalid.checks[0].status,'failed');
  const d=await f.a.diagnose();assert.equal(d.checks.find(c=>c.code==='authorization')?.status,'not_checked');assert(!JSON.stringify(d).includes('source-secret'));
 }finally{await f.close();}
});

test('Application: expired callback/handoff/session cannot replay or reach provisioning',async()=>{
 const f=await fixture();try{
  const expire=async(id:string)=>f.store.transaction(id,async tx=>{const cipher=await tx.get(id);assert(cipher);await tx.put(id,cipher,Date.now()-1000);});
  let callback=await f.callback();await expire('flow:'+hash(callback.state));await rejectsCode(()=>f.b.auth.callback(callback,f.browser),'invalid_flow');assert.equal(f.counts.provisions,0);
  callback=await f.callback();const h=await f.a.auth.callback(callback,f.browser);f.cookies(h.cookies);await expire('handoff:'+hash(h.handoff));await rejectsCode(()=>f.b.auth.exchange(h.handoff,f.browser),'invalid_flow');assert.equal(f.counts.provisions,0);
  const session=await f.session();await expire('session:'+hash(session));await rejectsCode(()=>f.a.auth.resolve(session),'session_expired');assert.equal(f.counts.refreshes,0);
 }finally{await f.close();}
});
test('Application: crash after rotating grant retains durable intent and never reuses the old token',async t=>{
 if(process.env.CONNECT_SDK_TEST_DATABASE_URL){t.skip('Deterministic commit-failure injection uses the test store');return;} // The injected commit failure belongs to the deterministic test store.
 const f=await fixture();try{
  const id=await f.session();f.memory.failNextFinalCommit=true;
  await rejectsCode(()=>f.a.auth.refresh(id),'provider_unavailable');assert.equal(f.counts.refreshes,1);
  await rejectsCode(()=>f.b.auth.resolve(id),'session_expired');assert.equal(f.counts.refreshes,1);
 }finally{await f.close();}
});

test('Application: contact_admin never invokes legacy verification or creates a challenge/session',async()=>{
 const f=await fixture();try{
  f.set({known:false,request:{requestId:'request-1',state:'failed',nextAction:'contact_admin'}});
  let storeCalls=0,legacyChecks=0,provisions=0;
  const application=new ConnectApplication({...f.config,store:{transaction:async()=>{storeCalls++;throw Error('Unexpected store access');}},accounts:{...f.config.accounts,verifyLegacy:async()=>{legacyChecks++;return null;},provision:async()=>{provisions++;throw Error('Unexpected provisioning');}}});
  for(const password of [undefined,'legacy-password']){
   assert.deepEqual(await application.auth.signIn({email:'new-applicant@example.test',password},f.browser),{status:'pending',request:{requestId:'request-1',state:'failed',nextAction:'contact_admin'},nextAction:'contact_admin'});
  }
  assert.equal(legacyChecks,0);assert.equal(storeCalls,0);assert.equal(provisions,0);assert.equal(f.received.length,0);assert.equal(f.memory.records.size,0);
 }finally{await f.close();}
});


test('Application: presentation without OIDC, waiting practice, approved encrypted configuration, restart and SSO',async()=>{
 const f=await fixture();try{
  const config={...f.config,issuer:undefined,clientId:undefined,redirectUri:undefined,sourceSecret:undefined,presenter:{id:'presenter',secret:'technical-secret',deployment:{name:'Workshop',environment:'development' as const,origins:[f.browser.origin]}}};
  const first=new ConnectApplication(config);f.set({known:false});
  const challenge=await first.auth.signIn({email:'person@example.test',password:'legacy-password'},f.browser);assert.equal(challenge.status,'migration_required');if(challenge.status!=='migration_required')throw Error();f.cookies(challenge.cookies);
  const submitted=await first.migration.submit({challenge:challenge.challenge,legacyPassword:'legacy-password',consentVersion:challenge.consentVersion,idempotencyKey:'intake-first-request'},f.browser);assert.equal(submitted.state,'pending');
  assert.equal((await first.auth.signIn({email:'person@example.test'},f.browser)).status,'pending');assert.equal(f.counts.provisions,0);
  f.set({known:true});assert.equal((await first.auth.signIn({email:'person@example.test'},f.browser)).status,'configuration_required');
  const synced=await first.configuration.sync();assert.deepEqual(synced,{status:'ready',appId:'workshop'});assert(!JSON.stringify(synced).includes('configuration-secret'));
  for(const row of f.memory.records.values())assert(!row.value.includes('configuration-secret')&&!row.value.includes('legacy-password'));
  const restarted=new ConnectApplication(config),start=await restarted.auth.signIn({email:'person@example.test'},f.browser);assert.equal(start.status,'redirect');if(start.status!=='redirect')throw Error();f.cookies(start.cookies);
  const handoff=await restarted.auth.callback(f.codeFor(start.url),f.browser);f.cookies(handoff.cookies);
  const session=await restarted.auth.exchange(handoff.handoff,f.browser);assert.equal(session.session.profile.localUserId,'user-1');assert.equal(f.counts.provisions,1);assert.equal(f.counts.legacyCalls,2);assert(!JSON.stringify(session).includes('configuration-secret'));
 }finally{await f.close();}
});
