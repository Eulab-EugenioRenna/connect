import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
// @ts-ignore JS harness
import {harness} from './harness.mjs';
import {defineFunctions} from '../packages/sdk/src/functions.js';
import {ConnectApplication} from '../packages/sdk/src/application.js';

const origin='https://workshop.example',declaredApp='workshop',sourceId='workshop-deployment';
const metadata={name:'Workshop deployment',environment:'development',origins:[origin],catalogUrl:origin+'/.well-known/eulab-connect.json',oidcCallbacks:[origin+'/callback']};
const body={schemaVersion:1,sourceId,appId:declaredApp,deployment:metadata,kind:'migration',consentVersion:'2026-10-21-mandatory-v1',localTenant:{id:'workspace-1',name:'Workshop company',slug:'workshop'},localUser:{id:'local-1',email:'person@example.test',firstName:'Person',lastName:'Example',role:'owner',permissions:['projects.read']},initialPassword:'Legacy-Credential-9!'};
async function setup(){
 const h=await harness(),users=new Map<string,any>(),clients=new Map<string,any>(),calls:any[]=[];
 h.setIdentityRequest(async(path:string,method='GET',payload?:any)=>{
  calls.push({path,method,payload});
  if(path.startsWith('/clients?'))return {body:[...clients.values()].filter(c=>c.clientId===new URLSearchParams(path.split('?')[1]).get('clientId'))};
  if(path==='/clients'&&method==='POST'){const id=randomUUID();clients.set(id,{...payload,id});return {body:null};}
  if(path==='/client-scopes')return {body:[{id:'basic-scope',name:'basic'}]};
  if(path.endsWith('/default-client-scopes')){const client=clients.get(path.split('/')[2]);return {body:(client.defaultClientScopes||[]).map((name:string)=>({id:name==='basic'?'basic-scope':name,name}))};}
  if(path.endsWith('/default-client-scopes/basic-scope')&&method==='PUT'){const client=clients.get(path.split('/')[2]);client.defaultClientScopes??=[];client.defaultClientScopes.push('basic');return {body:null};}
  if(path.endsWith('/protocol-mappers/models')){const client=clients.get(path.split('/')[2]);if(!client)throw Error('Unknown client');if(method==='POST'){client.protocolMappers??=[];client.protocolMappers.push({...payload,id:randomUUID()});return {body:null};}return {body:client.protocolMappers||[]};}
  if(path.endsWith('/client-secret'))return {body:{value:'Generated-Test-Client-Secret'}};
  if(path.startsWith('/users?')){const q=new URLSearchParams(path.split('?')[1]);return {body:[...users.values()].filter(u=>!q.has('email')&&!q.has('username')||u.email===(q.get('email')||q.get('username')))};}
  if(path==='/users'&&method==='POST'){const id=randomUUID();users.set(id,{...payload,id});return {body:null,location:'https://provider.test/users/'+id};}
  if(path.endsWith('/role-mappings/realm/composite'))return {body:[]};
  if(path.startsWith('/users/'))return {body:users.get(path.split('/')[2])};
  throw Error('Unexpected identity operation');
 });
 h.setCatalogReader(async()=>defineFunctions({appId:declaredApp,version:1,functions:[{key:'projects.read',name:'Read projects'}]}));
 async function grant(extra:any={}){const r=await h.request('/v1/onboarding/presenters','POST',{name:'Technical presentation',deploymentIdentity:'verified-deployment',verifiedOrigins:[origin],expiresAt:new Date(Date.now()+86400000).toISOString(),...extra});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
 async function post(g:any,path:string,input:any=body,key?:string){return h.injectRequest('/v1/app-onboarding/'+path,'POST',input,{'content-type':'application/json',Authorization:'Bearer '+g.secret,'X-Connect-Source':input.sourceId,'X-Connect-Presenter':g.id,...(key?{'idempotency-key':key}:{})});}
 async function submit(g:any){const r=await post(g,'requests',body,'first-request-001');assert.equal(r.status,201,JSON.stringify(r.body));const p=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[r.body.requestId]))[0].practice_id;return {requestId:r.body.requestId,practiceId:p};}
 const plan={application:{mode:'create',id:declaredApp,name:'Workshop'},customer:{mode:'create',name:'Workshop customer'},installation:{mode:'create',domain:origin},license:{state:'active',expiresAt:null,features:[{key:'projects.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Workshop owner',permissions:['projects.read']}],sso:{issuer:h.issuer,clientId:'workshop-client',redirectUri:origin+'/callback',clientSecret:'Backend-Only-Client-Secret'}};
 return {h,users,clients,calls,grant,post,submit,plan};
}

test('Technical presentation: no source/app prerequisite, no anonymous credentials, provenance reserved once without access',async()=>{
 const f=await setup();try{
  assert.equal((await f.h.injectRequest('/v1/app-onboarding/requests','POST',body,{'content-type':'application/json','idempotency-key':'anonymous-001'})).status,401);
  const g=await f.grant();assert.equal((await f.post({...g,secret:'wrong'},'requests',body,'wrong-secret-001')).status,401);
  const submitted=await f.submit(g),snapshot=(await f.h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[submitted.requestId]))[0].password_cipher;
  assert.equal((await f.post(g,'requests',body,'first-request-001')).body.requestId,submitted.requestId);
  assert.equal((await f.h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[submitted.requestId]))[0].password_cipher,snapshot);
  for(const table of ['applications','customers','installations','memberships','licenses','assignments'])assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM '+table))[0].n,0,table);
  assert.equal(f.calls.length,0);
  const lookup=await f.post(g,'login-context',{...body,email:body.localUser.email,kind:undefined,consentVersion:undefined,localTenant:undefined,localUser:undefined,initialPassword:undefined});assert.equal(lookup.body.request.nextAction,'wait');
  assert.equal((await f.post(g,'configuration',{schemaVersion:1,sourceId,appId:declaredApp})).body.status,'pending');
  const [source]=await f.h.store.query('SELECT integration_approved,presenter_id,deployment_identity FROM connect_sources WHERE id=$1',[sourceId]);assert.equal(source.integration_approved,false);assert.equal(source.presenter_id,g.id);assert.equal(source.deployment_identity,'verified-deployment');
  const g2=await f.grant();assert.equal((await f.post(g2,'requests',body,'source-takeover-001')).status,409);
  assert.equal((await f.post(g,'requests',{...body,sourceId:'different-source'},'different-source-001')).status,409);
  assert.equal((await f.post(g,'requests',{...body,deployment:{...metadata,name:'Changed deployment'}},'changed-metadata-001')).status,409);
  const noPresenter=await f.h.injectRequest('/v1/app-onboarding/login-context','POST',{schemaVersion:1,sourceId,appId:declaredApp,email:body.localUser.email},{'content-type':'application/json',Authorization:'Bearer '+g.secret,'X-Connect-Source':sourceId});assert.equal(noPresenter.status,401);
  assert.equal((await f.h.request('/v1/onboarding/presenters/'+g.id,'PUT',{enabled:false})).status,200);
  assert.equal((await f.post(g,'requests',body,'revoked-grant-001')).status,401);
 }finally{await f.h.close();}
});

test('New app/company/installation: one existing practice, explicit plan, repeatable execution and secure configuration',async()=>{
 const f=await setup();try{
  const g=await f.grant(),r=await f.submit(g),path='/v1/onboarding/practices/'+r.practiceId;
  assert.equal((await f.h.request(path)).body.review.verifiedApplicationId,null);
  const saved=await f.h.request(path+'/plan','PUT',f.plan);assert.equal(saved.status,200,JSON.stringify(saved.body));assert(!JSON.stringify(saved.body).includes(f.plan.sso.clientSecret));
  const staged=await f.post(g,'configuration',{schemaVersion:1,sourceId,appId:declaredApp});assert.deepEqual(staged.body,{status:'pending',plannedAppId:declaredApp});assert(!JSON.stringify(staged.body).includes('clientSecret'));
  const sanitized={...f.plan,sso:{issuer:f.plan.sso.issuer,clientId:f.plan.sso.clientId,redirectUri:f.plan.sso.redirectUri}};assert.equal((await f.h.request(path+'/plan','PUT',sanitized)).status,200);
  const prepared=await f.h.request(path+'/prepare','POST',{});assert.equal(prepared.status,201);assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM applications'))[0].n,0);
  const execution=await f.h.request(path+'/execute','POST',{});assert.equal(execution.status,201,JSON.stringify(execution.body));assert.equal(execution.body.state,'completed',JSON.stringify(execution.body));
  const repeated=await f.h.request(path+'/execute','POST',{});assert.equal(repeated.body.installation.id,execution.body.installation.id);
  for(const table of ['applications','customers','installations','onboarding_practices','onboarding_requests','app_local_users'])assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM '+table))[0].n,1,table);
  assert.equal(f.calls.filter(c=>c.path==='/users'&&c.method==='POST').length,1);
  const discovery=await f.post(g,'login-context',{schemaVersion:1,sourceId,appId:declaredApp,email:body.localUser.email});assert.equal(discovery.body.status,'configuration_required');
  const config=await f.post(g,'configuration',{schemaVersion:1,sourceId,appId:declaredApp});assert.equal(config.body.status,'ready');assert.equal(config.body.configuration.clientSecret,f.plan.sso.clientSecret);
  const plain=JSON.stringify(await f.h.store.query('SELECT plan FROM onboarding_practices'));assert(!plain.includes(f.plan.sso.clientSecret));assert(!JSON.stringify(await f.h.store.query('SELECT detail FROM audit')).includes(f.plan.sso.clientSecret));
  assert.equal((await f.h.injectRequest('/v1/app-onboarding/configuration','POST',{schemaVersion:1,sourceId,appId:declaredApp},{'content-type':'application/json'})).status,401);
 }finally{await f.h.close();}
});

test('Existing app: declared appId is not proof; verified scope autoselects only the plan and displays conflicts',async()=>{
 const f=await setup();try{
  await f.h.request('/v1/applications','POST',{id:declaredApp,name:'Existing unverified application'});
  let g=await f.grant(),r=await f.submit(g),detail=(await f.h.request('/v1/onboarding/practices/'+r.practiceId)).body;
  assert.equal(detail.review.verifiedApplicationId,null);assert(detail.review.differences.includes('declared_app_unverified'));assert.equal(detail.plan,null);
  assert.equal((await f.h.request('/v1/onboarding/practices/'+r.practiceId+'/plan','PUT',f.plan)).status,409);
  await f.h.request('/v1/applications','POST',{id:'verified-product',name:'Verified product'});
  g=await f.grant({verifiedAppId:'verified-product'});
  const submitted=await f.post(g,'requests',{...body,sourceId:'verified-deployment'},'verified-request-001');assert.equal(submitted.status,201);
  r={requestId:submitted.body.requestId,practiceId:(await f.h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[submitted.body.requestId]))[0].practice_id};
  detail=(await f.h.request('/v1/onboarding/practices/'+r.practiceId)).body;
  assert.deepEqual(detail.plan.application,{mode:'existing',id:'verified-product'});assert.equal(detail.review.verifiedApplicationId,'verified-product');assert(detail.review.differences.includes('app_id_differs'));assert.equal(detail.source.integration_approved,false);
  assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM installations'))[0].n,0);
  f.h.setCatalogReader(async()=>defineFunctions({appId:'verified-product',version:1,functions:[{key:'projects.read',name:'Projects'}]}));
  const selected={...f.plan,application:{mode:'existing',id:'verified-product'}};
  assert.equal((await f.h.request('/v1/onboarding/practices/'+r.practiceId+'/plan','PUT',selected)).status,200);
  const execution=await f.h.request('/v1/onboarding/practices/'+r.practiceId+'/execute','POST',{});assert.equal(execution.body.state,'completed',JSON.stringify(execution.body));
  const config=await f.post(g,'configuration',{schemaVersion:1,sourceId:'verified-deployment',appId:declaredApp});assert.equal(config.body.configuration.appId,'verified-product');
  const [provenance]=await f.h.store.query('SELECT app_id,approved_app_id FROM connect_sources WHERE id=$1',['verified-deployment']);assert.equal(provenance.app_id,declaredApp);assert.equal(provenance.approved_app_id,'verified-product');
 }finally{await f.h.close();}
});

test('Existing customer/installation and identity are reused explicitly; incompatible selection and revocations stay denied',async()=>{
 const f=await setup();try{
  const g=await f.grant(),r=await f.submit(g),path='/v1/onboarding/practices/'+r.practiceId;
  const customer=(await f.h.request('/v1/customers','POST',{name:'Existing customer'})).body;
  const connection=(await f.h.request('/v1/application-connections','POST',{id:declaredApp,name:'Existing app',customerId:customer.id,domain:origin,integration:'web'})).body;
  const existing={id:'existing-subject',email:body.localUser.email,username:body.localUser.email,enabled:true,credentials:[{value:'Existing-Password-Not-Changed'}]};f.users.set(existing.id,existing);
  const plan={...f.plan,application:{mode:'existing',id:declaredApp},customer:{mode:'existing',id:customer.id},installation:{mode:'existing',id:connection.installationId},identities:{[r.requestId]:existing.id}};
  const other=(await f.h.request('/v1/customers','POST',{name:'Other customer'})).body;
  assert.equal((await f.h.request(path+'/plan','PUT',{...plan,customer:{mode:'existing',id:other.id}})).status,409);
  f.h.setCatalogReader(async()=>defineFunctions({appId:declaredApp,version:1,functions:[{key:'projects.read',name:'Projects'}]}));
  assert.equal((await f.h.request(path+'/plan','PUT',plan)).status,200);
  const execute=await f.h.request(path+'/execute','POST',{});assert.equal(execute.body.state,'completed',JSON.stringify(execute.body));assert.equal(execute.body.installation.id,connection.installationId);
  assert.equal(f.calls.filter(c=>c.path==='/users'&&c.method==='POST').length,0);assert.equal(existing.credentials[0].value,'Existing-Password-Not-Changed');
  await f.h.store.query("INSERT INTO app_access_revocations(customer_id,app_id,subject,revoked_by) VALUES($1,$2,$3,'operator')",[customer.id,declaredApp,existing.id]);
  assert.equal((await f.post(g,'login-context',{schemaVersion:1,sourceId,appId:declaredApp,email:body.localUser.email})).status,403);
  const count=(await f.h.store.query('SELECT count(*)::int AS n FROM onboarding_requests'))[0].n;
  assert.equal((await f.post(g,'requests',{...body,localUser:{...body.localUser,email:'renamed@example.test'}},'blocked-new-practice')).status,403);
  assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM onboarding_requests'))[0].n,count);
 }finally{await f.h.close();}
});


test('Technical credential rotation/expiry preserves source ownership and activation duplicate keys reuse the same practice',async()=>{
 const f=await setup();try{
  const g=await f.grant();
  const activation={schemaVersion:1,sourceId,appId:declaredApp,deployment:metadata,kind:'activation',companyName:'New company',applicant:{email:'new-person@example.test',firstName:'New',lastName:'Person'},initialPassword:'Temporary-Activation-9!'};
  const [first,duplicate]=await Promise.all([f.post(g,'requests',activation,'activation-duplicate-1'),f.post(g,'requests',activation,'activation-duplicate-2')]);assert.equal(first.status,201);assert.equal(duplicate.status,201);assert.equal(first.body.requestId,duplicate.body.requestId);
  assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM onboarding_practices'))[0].n,1);
  const rotated=await f.h.request('/v1/onboarding/presenters/'+g.id,'PUT',{rotateSecret:true});assert.equal(rotated.status,200);assert(rotated.body.secret);
  const lookup={schemaVersion:1,sourceId,appId:declaredApp,email:activation.applicant.email};assert.equal((await f.post(g,'login-context',lookup)).status,401);
  const current={...g,secret:rotated.body.secret};assert.equal((await f.post(current,'login-context',lookup)).status,201);
  assert.equal((await f.post(current,'login-context',{...lookup,sourceId:'replacement-source'})).status,409);
  await f.h.store.query("UPDATE onboarding_presenters SET expires_at=now()-interval '1 second' WHERE id=$1",[g.id]);assert.equal((await f.post(current,'login-context',lookup)).status,401);
  const listed=JSON.stringify((await f.h.request('/v1/onboarding/presenters')).body);assert(!listed.includes(rotated.body.secret)&&!listed.includes('secret_hash'));
 }finally{await f.h.close();}
});

test('Execution never reactivates a suspended existing license, installation or source binding',async()=>{
 const f=await setup();try{
  const g=await f.grant(),r=await f.submit(g),path='/v1/onboarding/practices/'+r.practiceId;
  const customer=(await f.h.request('/v1/customers','POST',{name:'Existing company'})).body;
  const connection=(await f.h.request('/v1/application-connections','POST',{id:declaredApp,name:'Existing app',customerId:customer.id,domain:origin,integration:'web'})).body;
  const plan={...f.plan,application:{mode:'existing',id:declaredApp},customer:{mode:'existing',id:customer.id},installation:{mode:'existing',id:connection.installationId}};
  await f.h.store.query('UPDATE installations SET enabled=false WHERE id=$1',[connection.installationId]);assert.equal((await f.h.request(path+'/plan','PUT',plan)).status,409);
  await f.h.store.query('UPDATE installations SET enabled=true WHERE id=$1',[connection.installationId]);
  await f.h.store.query("INSERT INTO source_installation_bindings(source_id,installation_id,app_id,enabled) VALUES($1,$2,$3,false)",[sourceId,connection.installationId,declaredApp]);assert.equal((await f.h.request(path+'/plan','PUT',plan)).status,409);
  await f.h.store.query('UPDATE source_installation_bindings SET enabled=true WHERE source_id=$1',[sourceId]);
  await f.h.store.query("INSERT INTO licenses(customer_id,app_id,state) VALUES($1,$2,'suspended')",[customer.id,declaredApp]);
  assert.equal((await f.h.request(path+'/plan','PUT',plan)).status,200);
  const execution=await f.h.request(path+'/execute','POST',{});assert.equal(execution.status,409);assert.equal((await f.h.store.query('SELECT state FROM licenses WHERE customer_id=$1 AND app_id=$2',[customer.id,declaredApp]))[0].state,'suspended');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }finally{await f.h.close();}
});

test('Preparing a presenter practice without a saved plan reports the missing plan and recovers after save',async()=>{
 const f=await setup();try{
  const g=await f.grant(),r=await f.submit(g),path='/v1/onboarding/practices/'+r.practiceId;
  const prepared=await f.h.request(path+'/prepare','POST',{});
  assert.equal(prepared.status,409);
  assert.equal(prepared.body.code,'plan_missing');
  const detail=(await f.h.request(path)).body;
  assert.equal(detail.plan,null);
  assert.equal(detail.safeError,'Nessun piano salvato: completa la proposta e premi Salva piano');
  for(const table of ['applications','customers','installations'])assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM '+table))[0].n,0);
  assert.equal((await f.h.request(path+'/plan','PUT',f.plan)).status,200);
  // A successful verification must also clear a previous recorded verification error.
  await f.h.store.query('UPDATE onboarding_practices SET safe_error=$2 WHERE id=$1',[r.practiceId,'Dati della pratica non validi']);
  const retry=await f.h.request(path+'/prepare','POST',{});
  assert.equal(retry.status,201);assert.equal(retry.body.safeError,'');
  for(const table of ['applications','customers','installations'])assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM '+table))[0].n,0);
 }finally{await f.h.close();}
});

for(const existingApp of [false,true])for(const existingUser of [false,true])test(`Resolve practice: app ${existingApp?'registered':'new'}, user ${existingUser?'existing':'new'}, guided choices, all catalog permissions, replay`,async()=>{
 const f=await setup();try{
  if(existingApp)assert.equal((await f.h.request('/v1/applications','POST',{id:declaredApp,name:'Workshop'})).status,201);
  const subject=randomUUID();
  if(existingUser)f.users.set(subject,{id:subject,email:body.localUser.email,username:body.localUser.email,enabled:true});
  f.h.setCatalogReader(async()=>defineFunctions({appId:declaredApp,version:1,functions:[{key:'projects.read',name:'Read'},{key:'projects.edit',name:'Edit'}]}));
  const g=await f.grant(),r=await f.submit(g),path='/v1/onboarding/practices/'+r.practiceId;
  const preview=await f.h.request(path+'/resolution');assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(f.clients.size,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  for(const table of ['customers','installations','licenses'])assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM '+table))[0].n,0);
  assert.equal((await f.h.request(path)).body.plan?.license,undefined);
  const chosen=preview.body.plan;
  assert.equal(chosen.identities?.[r.requestId],undefined,'No automatic identity link by email');
  if(existingUser)chosen.identities={[r.requestId]:subject};
  const resolved=await f.h.request(path+'/resolve','POST',chosen);
  assert.equal(resolved.status,201,JSON.stringify(resolved.body));assert.equal(resolved.body.state,'completed',JSON.stringify(resolved.body));
  assert.deepEqual(resolved.body.plan.roles[0].permissions,['projects.read','projects.edit']);
  assert.deepEqual(resolved.body.plan.license.features.map((f:any)=>f.key),['projects.read','projects.edit']);
  assert.equal(resolved.body.plan.application.mode,existingApp?'existing':'create');
  assert.equal(f.calls.filter(c=>c.path==='/users'&&c.method==='POST').length,existingUser?0:1);
  if(existingUser)assert.equal(resolved.body.requests[0].identitySubject,subject);
  assert.equal(f.clients.size,1);assert(!JSON.stringify(resolved.body).includes('Generated-Test-Client-Secret'));
  assert([...f.clients.values()][0].defaultClientScopes.includes('basic'),'Access tokens must include their subject through the provider basic scope');
  const audience=[...f.clients.values()][0].protocolMappers.find((m:any)=>m.name==='connect-api-audience');
  assert.equal(audience?.protocolMapper,'oidc-audience-mapper');
  assert.equal(audience?.config?.['included.client.audience'],'connect-api');
  assert.equal(audience?.config?.['access.token.claim'],'true');
  assert.equal(audience?.config?.['id.token.claim'],'false');
  assert.equal((await f.h.request(path+'/resolve','POST',chosen)).body.state,'completed');
  for(const table of ['applications','customers','installations'])assert.equal((await f.h.store.query('SELECT count(*)::int AS n FROM '+table))[0].n,1);
  const configuration=await f.post(g,'configuration',{schemaVersion:1,sourceId,appId:declaredApp});
  assert.equal(configuration.body.configuration.clientSecret,'Generated-Test-Client-Secret');
 }finally{await f.h.close();}
});
