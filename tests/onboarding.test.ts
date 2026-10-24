import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BadRequestException} from '@nestjs/common';
import {unsealMigrationValue} from '../apps/api/src/security.js';
// @ts-ignore JavaScript harness
import {harness} from './harness.mjs';
import {defineFunctions} from '../packages/sdk/src/functions.js';

const origin='https://alora.example';
const catalogUrl=origin+'/.well-known/eulab-connect.json';

function provider(h:any){
 const users=new Map<string,any>(),calls:any[]=[],control={rejectPassword:undefined as string|undefined,failNextPostAfterCreate:false,beforeCreate:undefined as undefined|(()=>Promise<void>)};
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{
  calls.push({path,method,body});
  if(path.startsWith('/users?')){
   const q=new URLSearchParams(path.split('?')[1]);
   const email=q.get('email'),username=q.get('username');
   return {body:[...users.values()].filter((u:any)=>
    (email!==null&&String(u.email||'').toLowerCase()===email.toLowerCase())||
    (username!==null&&String(u.username||'').toLowerCase()===username.toLowerCase()))};
  }
  if(path==='/users'&&method==='POST'){
   await control.beforeCreate?.();
   if(control.rejectPassword===body.credentials?.[0]?.value)throw new BadRequestException('Provider password policy');
   const user={...body,id:randomUUID()};users.set(user.id,user);
   if(control.failNextPostAfterCreate){control.failNextPostAfterCreate=false;throw new Error('Risposta provider persa');}
   return {body:null,location:'https://sso.test/users/'+user.id};
  }
  if(path.endsWith('/role-mappings/realm/composite'))return {body:[]};
  if(path.endsWith('/logout')&&method==='POST')return {body:null};
  if(path.startsWith('/users/')&&method==='DELETE'){users.delete(decodeURIComponent(path.split('/')[2]));return {body:null};}
  if(path.startsWith('/users/'))return {body:users.get(decodeURIComponent(path.split('/')[2]))};
  throw new Error('Percorso identità non previsto: '+path);
 });
 return {users,calls,control,posts:()=>calls.filter(c=>c.method==='POST').length};
}

async function createSource(h:any,{id,appId}:{id:string;appId:string}){
 const r=await h.request('/v1/connect-sources','POST',{id,appId,name:'ALORA '+appId,environment:'development',origins:[origin],catalogUrl,oidcCallbacks:[origin+'/oauth/callback'],deploymentIdentity:'alora-local-docker'});
 assert.equal(r.status,201,JSON.stringify(r.body));
 assert.equal(typeof r.body.secret,'string');
 return {...r.body,app_id:r.body.appId,source_id:r.body.id};
}
function sourceHeaders(source:any){return {Authorization:'Bearer '+source.secret,'X-Connect-Source':source.id,'Content-Type':'application/json'};}
async function sourcePost(h:any,source:any,path:string,body:any,key?:string){
 return h.injectRequest('/v1/app-onboarding/'+path,'POST',body,{...sourceHeaders(source),...(key?{'Idempotency-Key':key}:{})});
}
function migrationBody(source:any,overrides:any={}){
 return {schemaVersion:1,appId:source.app_id,sourceId:source.id,kind:'migration',consentVersion:'2026-10-21-mandatory-v1',
  localTenant:{id:'tenant-1',name:'Azienda ALORA',slug:'azienda-alora'},
  localUser:{id:'local-1',email:'persona@example.test',firstName:'Nome',lastName:'Cognome',role:'owner',permissions:['agenda.read']},
  initialPassword:'Correct-Horse-9!',...overrides};
}

test('Onboarding: bootstrap prima dell’app, lookup solo su collegamenti espliciti e revoche autorevoli',async()=>{
 const h=await harness();try{
 assert.equal((await h.injectRequest('/v1/connect-sources','POST',{})).status,401);
 const insecure=await h.request('/v1/connect-sources','POST',{id:'alora-http',appId:'alora-http',name:'Sorgente HTTP',environment:'production',origins:['http://localhost:8088'],oidcCallbacks:[],deploymentIdentity:'test'});
 assert.equal(insecure.status,400);
 const source=await createSource(h,{id:'alora',appId:'alora-bootstrap'});
 assert.equal('secretHash' in source,false);
 const listed=await h.request('/v1/connect-sources');assert.equal(listed.status,200);
 assert.equal(JSON.stringify(listed.body).includes(source.secret),false);
 assert.equal(JSON.stringify(listed.body).includes('secret_hash'),false);
 assert.equal((await h.request('/v1/connect-sources/'+source.id)).body.catalogUrl,catalogUrl);
 assert.equal((await h.injectRequest('/v1/app-onboarding/login-context','POST',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'},{'Content-Type':'application/json'})).status,401);
 assert.equal((await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'})).body.status,'not_found');
 assert.equal((await sourcePost(h,source,'login-context',{schemaVersion:1,appId:'other-app',sourceId:source.id,email:'persona@example.test'})).status,403);
 assert.equal((await sourcePost(h,{...source,secret:'x'},'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'})).status,401);

 const p=provider(h);
 p.users.set('person-1',{id:'person-1',username:'persona@example.test',email:'persona@example.test',firstName:'Nome',lastName:'Cognome',enabled:true,attributes:{}});
 const customer=(await h.request('/v1/customers','POST',{name:'Azienda ALORA'})).body;
 const connection=await h.request('/v1/application-connections','POST',{id:source.app_id,name:'ALORA',customerId:customer.id,domain:origin,integration:'web'});
 assert.equal(connection.status,201,JSON.stringify(connection.body));
 const i=connection.body;
 await h.store.query("INSERT INTO features(app_id,key,name) VALUES($1,'agenda.read','Agenda')",[source.app_id]);
 await h.store.query("INSERT INTO permissions(app_id,key,feature_key,name) VALUES($1,'agenda.read','agenda.read','Leggi agenda')",[source.app_id]);
 await h.request('/v1/licenses','PUT',{customerId:customer.id,appId:source.app_id,state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}],reason:'Licenza demo'});
 await h.request('/v1/identities','PUT',{subject:'person-1',displayName:'Persona',enabled:true});
 const role=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:source.app_id,name:'Reception',permissions:['agenda.read'],reason:'Ruolo demo'})).body;
 await h.request('/v1/memberships','PUT',{subject:'person-1',customerId:customer.id,enabled:true,roleIds:[role.id]});
 const localAssignment={installationId:i.installationId,localTenantId:'tenant-1',localUserId:'local-1',subject:'person-1',email:'persona@example.test',firstName:'Nome',lastName:'Cognome',role:'reception',permissions:['agenda.read'],enabled:true};
 const bound=await h.request('/v1/connect-sources/'+source.id+'/local-users','POST',localAssignment);
 assert.equal(bound.status,201,JSON.stringify(bound.body));
 assert.equal((await h.request('/v1/connect-sources/'+source.id+'/local-users','POST',localAssignment)).status,201);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM local_links'))[0].n,1);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM app_local_users'))[0].n,1);
 p.users.set('person-2',{id:'person-2',username:'altra@example.test',email:'altra@example.test',firstName:'Altra',lastName:'Persona',enabled:true,attributes:{}});
 const linkConflict=await h.request('/v1/connect-sources/'+source.id+'/local-users','POST',{...localAssignment,subject:'person-2',email:'altra@example.test'});
 assert.equal(linkConflict.status,409,JSON.stringify(linkConflict.body));
 const found=await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'Persona@Example.Test'});
 assert.equal(found.status,201);assert.equal(found.body.status,'connect');
 assert.equal(found.body.context.tenant.id,'tenant-1');assert.equal(found.body.context.binding.customerId,customer.id);
 assert.equal(found.body.context.binding.installationId,i.installationId);assert.equal(found.body.context.binding.secret,i.secret);
 assert.equal(found.body.context.user.id,'local-1');assert.equal(found.body.context.user.subject,'person-1');assert.equal(found.body.context.user.role,'reception');
 assert.deepEqual(found.body.context.user.permissions,['agenda.read']);
 const access=await h.injectRequest('/v1/access','GET',undefined,{Authorization:'Bearer '+await h.token('person-1',[]),'X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret});
 assert.equal(access.status,200);assert.equal(access.body.appId,source.app_id);assert.equal(access.body.installationId,i.installationId);assert.equal(access.body.localUserId,'local-1');assert.equal(access.body.subject,'person-1');assert.equal(access.body.canLogin,true);

 await h.store.query('INSERT INTO app_access_revocations(customer_id,app_id,subject,revoked_by) VALUES($1,$2,$3,$4)',[customer.id,source.app_id,'person-1','operator']);
 assert.equal((await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'})).status,403);
 await h.store.query('DELETE FROM app_access_revocations');
 await h.store.query('UPDATE identities SET enabled=false WHERE subject=$1',['person-1']);
 assert.equal((await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'})).status,403);
 await h.store.query('UPDATE identities SET enabled=true WHERE subject=$1',['person-1']);
 await h.store.query('UPDATE app_local_users SET enabled=false WHERE local_user_id=$1',['local-1']);
 assert.equal((await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'})).status,403);
 await h.store.query('UPDATE app_local_users SET enabled=true WHERE local_user_id=$1',['local-1']);

 const second=(await h.request('/v1/installations','POST',{customerId:customer.id,appId:source.app_id,domain:origin,description:'Seconda installazione'})).body;
 await h.request('/v1/connect-sources/'+source.id+'/local-users','POST',{installationId:second.id,localTenantId:'tenant-1',localUserId:'local-2',subject:'person-1',email:'persona@example.test',firstName:'Nome',lastName:'Cognome',role:'reception',permissions:['agenda.read'],enabled:true});
 assert.equal((await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'})).status,409);
 const removable=randomUUID();
 p.users.set(removable,{id:removable,username:'rimovibile@example.test',email:'rimovibile@example.test',firstName:'R',lastName:'M',enabled:true,attributes:{}});
 await h.request('/v1/identities','PUT',{subject:removable,displayName:'Rimosso',enabled:true});
 await h.request('/v1/connect-sources/'+source.id+'/local-users','POST',{installationId:second.id,localTenantId:'tenant-1',localUserId:'local-3',subject:removable,email:'rimovibile@example.test',firstName:'R',lastName:'M',role:'reception',permissions:['agenda.read'],enabled:true});
 const removed=await h.request('/v1/sso-identities/'+removable,'DELETE');assert.equal(removed.status,200,JSON.stringify(removed.body));
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM app_local_users WHERE subject=$1',[removable]))[0].n,0);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM local_links WHERE subject=$1',[removable]))[0].n,0);
 }finally{await h.close();}
});

test('Migrazione: password cifrata usa-e-getta, piano, esecuzione idempotente e contesto verificabile',async()=>{
 const h=await harness();try{
 const source=await createSource(h,{id:'alora-mig',appId:'alora-mig-app'});
 const p=provider(h);
 h.setCatalogReader(async(url:string)=>{assert.equal(url,catalogUrl);return structuredClone(defineFunctions({appId:source.app_id,version:1,functions:[{key:'agenda.read',name:'Leggi agenda'}]}));});
 const submitted=await sourcePost(h,source,'requests',migrationBody(source),'idem-key-0001');
 assert.equal(submitted.status,201);assert.deepEqual(Object.keys(submitted.body).sort(),['nextAction','requestId','state']);assert.equal(submitted.body.state,'pending');
 const requestId=submitted.body.requestId;
 assert.equal((await sourcePost(h,source,'requests',migrationBody(source),'idem-key-0001')).body.requestId,requestId);
 assert.equal((await sourcePost(h,source,'requests',migrationBody(source,{localUser:{...migrationBody(source).localUser,lastName:'Diverso'}}),'idem-key-0001')).status,409);
 const stored=(await h.store.query('SELECT id,practice_id,password_cipher,password_expires_at,state FROM onboarding_requests WHERE id=$1',[requestId]))[0];
 assert.equal(stored.state,'pending');assert.ok(stored.password_cipher);assert.equal(stored.password_cipher.includes('Correct-Horse-9!'),false);
 assert.ok(stored.password_expires_at);
 const cipher=stored.password_cipher;
 const sameKey=await sourcePost(h,source,'requests',migrationBody(source,{initialPassword:'Altra-Password-9!'}),'idem-key-0001');
 assert.equal(sameKey.status,201);assert.equal(sameKey.body.requestId,requestId);
 assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[requestId]))[0].password_cipher,cipher);
 await h.store.query("UPDATE onboarding_requests SET state='expired',password_cipher=null,password_deleted_at=now(),password_expires_at=now()-interval '1 second' WHERE id=$1",[requestId]);
 const revived=await sourcePost(h,source,'requests',migrationBody(source),'idem-key-0001');
 assert.equal(revived.status,201);assert.equal(revived.body.requestId,requestId);assert.equal(revived.body.state,'pending');
 const revivedCipher=(await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[requestId]))[0].password_cipher;
 assert.ok(revivedCipher);assert.notEqual(revivedCipher,cipher);
 await h.store.query("UPDATE onboarding_requests SET state='failed',action_required='new_request_required',password_cipher=null,password_deleted_at=now() WHERE id=$1",[requestId]);
 const recovered=await sourcePost(h,source,'requests',migrationBody(source),'idem-key-0001');
 assert.equal(recovered.status,201);assert.equal(recovered.body.requestId,requestId);assert.equal(recovered.body.state,'pending');
 const recoveredCipher=(await h.store.query('SELECT password_cipher,action_required FROM onboarding_requests WHERE id=$1',[requestId]))[0];
 assert.ok(recoveredCipher.password_cipher);assert.equal(recoveredCipher.action_required,'');
 assert.equal((await sourcePost(h,source,'requests',migrationBody(source),'idem-key-0002')).body.requestId,requestId);
 assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[requestId]))[0].password_cipher,recoveredCipher.password_cipher);
 assert.equal(p.posts(),0);
 const audit=JSON.stringify(await h.store.query('SELECT detail FROM audit'));assert.equal(audit.includes('Correct-Horse-9!'),false);assert.equal(audit.includes(cipher),false);assert.equal(audit.includes(recoveredCipher.password_cipher),false);
 assert.equal(audit.includes('password_cipher'),false);
 const detail=(await h.request('/v1/onboarding/practices/'+stored.practice_id)).body;
 assert.equal(detail.requests.length,1);assert.equal(detail.requests[0].credentialPresent,true);
 assert.equal(JSON.stringify(detail).includes('Correct-Horse-9!'),false);assert.equal(JSON.stringify(detail).includes(cipher),false);
 assert.equal(detail.canExecute,false);

 const plan={license:{state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Titolare',permissions:['agenda.read']}]};
 const unlicensed=await h.request('/v1/onboarding/practices/'+stored.practice_id+'/plan','PUT',{...plan,license:{...plan.license,features:[{key:'agenda.read',purchased:false,enabled:false}]}});
 assert.equal(unlicensed.status,200);assert.equal(unlicensed.body.canExecute,false);assert(unlicensed.body.missing.some((m:any)=>m.code==='license_features_missing'));
 const saved=await h.request('/v1/onboarding/practices/'+stored.practice_id+'/plan','PUT',plan);
 assert.equal(saved.status,200);assert.equal(saved.body.canExecute,true);assert.deepEqual(saved.body.missing,[]);assert.equal(saved.body.state,'approved');
 const prepared=await h.request('/v1/onboarding/practices/'+stored.practice_id+'/prepare','POST',{});
 assert.equal(prepared.status,201,JSON.stringify(prepared.body));assert.ok(prepared.body.prepared.installationId);assert.ok(prepared.body.installation.secretAvailable);
 assert.equal(prepared.body.source.id,source.id);assert.ok(prepared.body.installation.basePath===''||prepared.body.installation.basePath);

 const executed=await h.request('/v1/onboarding/practices/'+stored.practice_id+'/execute','POST',{});
 assert.equal(executed.status,201,JSON.stringify(executed.body));assert.equal(executed.body.state,'completed');assert.equal(executed.body.requests[0].state,'completed');
 assert.equal(executed.body.requests[0].credentialPresent,false);
 const after=(await h.store.query('SELECT password_cipher,password_deleted_at,identity_subject FROM onboarding_requests WHERE id=$1',[requestId]))[0];
 assert.equal(after.password_cipher,null);assert.ok(after.password_deleted_at);assert.equal(after.identity_subject,executed.body.requests[0].identitySubject);
 assert.equal(p.users.size,1);assert.equal(p.posts(),1);
 const created=[...p.users.values()][0];assert.deepEqual(created.credentials,[{type:'password',value:'Correct-Horse-9!',temporary:false}]);
 assert.equal(created.username,'persona@example.test');
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM local_links'))[0].n,1);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM app_local_users'))[0].n,1);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM roles'))[0].n,1);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM assignments'))[0].n,1);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM licenses'))[0].n,1);
 const posts=p.posts();
 const retried=await h.request('/v1/onboarding/practices/'+stored.practice_id+'/execute','POST',{});
 assert.equal(retried.body.state,'completed');assert.equal(p.posts(),posts);assert.equal(p.users.size,1);
 const closedSubmit=await sourcePost(h,source,'requests',migrationBody(source,{initialPassword:'Altra-Password-9!'}),'idem-key-0001');
 assert.equal(closedSubmit.body.requestId,requestId);assert.equal(closedSubmit.body.state,'completed');
 assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[requestId]))[0].password_cipher,null);
 assert.equal(p.posts(),posts);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM installations'))[0].n,1);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM customers'))[0].n,1);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM applications'))[0].n,1);

 const context=await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'persona@example.test'});
 assert.equal(context.status,201);assert.equal(context.body.status,'connect');
 assert.equal(context.body.context.binding.installationId,executed.body.installation.id);
 assert.equal(typeof context.body.context.binding.secret,'string');assert.ok(context.body.context.binding.secret.length>=32);
 assert.equal(context.body.context.user.id,'local-1');assert.equal(context.body.context.user.role,'owner');
 assert.deepEqual(context.body.context.user.permissions,['agenda.read']);
 const access=await h.injectRequest('/v1/access','GET',undefined,{Authorization:'Bearer '+await h.token(context.body.context.user.subject,[]),'X-Installation-Id':context.body.context.binding.installationId,'X-Installation-Secret':context.body.context.binding.secret});
 assert.equal(access.status,200);assert.equal(access.body.canLogin,true);assert.equal(access.body.appId,source.app_id);assert.equal(access.body.localUserId,'local-1');assert.equal(access.body.subject,context.body.context.user.subject);
 }finally{await h.close();}
});

test('Attivazione: pratica aziendale, assegnazione locale esplicita e stessa password dopo l’approvazione',async()=>{
 const h=await harness();try{
 const source=await createSource(h,{id:'alora-act',appId:'alora-act-app'});
 const p=provider(h);
 h.setCatalogReader(async()=>structuredClone(defineFunctions({appId:source.app_id,version:1,functions:[{key:'agenda.read',name:'Leggi agenda'}]})));
 const body={schemaVersion:1,appId:source.app_id,sourceId:source.id,kind:'activation',companyName:'Nuova Azienda',applicant:{email:'nuovo@example.test',firstName:'Nuovo',lastName:'Titolare'},initialPassword:'Activation-Pass-7!'};
 const submitted=await sourcePost(h,source,'requests',body,'activation-key-1');
 assert.equal(submitted.status,201,JSON.stringify(submitted.body));assert.deepEqual(Object.keys(submitted.body).sort(),['nextAction','requestId','state']);
 const row=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[submitted.body.requestId]))[0];
 const plan={license:{state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Titolare',permissions:['agenda.read']}],activation:{localTenantId:'tenant-new',localUserId:'local-new',localRole:'owner'}};
 const saved=await h.request('/v1/onboarding/practices/'+row.practice_id+'/plan','PUT',plan);
 assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.canExecute,true);assert.deepEqual(saved.body.missing,[]);
 const executed=await h.request('/v1/onboarding/practices/'+row.practice_id+'/execute','POST',{});
 assert.equal(executed.status,201,JSON.stringify(executed.body));assert.equal(executed.body.kind,'activation');assert.equal(executed.body.state,'completed');
 assert.equal(executed.body.tenant.localId,'tenant-new');assert.equal(executed.body.requests[0].state,'completed');
 assert.equal((await h.store.query('SELECT local_tenant_id FROM app_local_users'))[0].local_tenant_id,'tenant-new');
 assert.equal([...p.users.values()][0].credentials[0].value,'Activation-Pass-7!');
 const context=await sourcePost(h,source,'login-context',{schemaVersion:1,appId:source.app_id,sourceId:source.id,email:'nuovo@example.test'});
 assert.equal(context.status,201);assert.equal(context.body.status,'connect');assert.equal(context.body.context.tenant.id,'tenant-new');
 assert.equal(context.body.context.user.id,'local-new');assert.equal(context.body.context.user.role,'owner');
 assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE practice_id=$1',[row.practice_id]))[0].password_cipher,null);
 }finally{await h.close();}
});

test('Migrazione: risposta provider persa dopo la creazione, retry recupera la stessa identità',async()=>{
 const h=await harness();try{
 const source=await createSource(h,{id:'alora-retry',appId:'alora-retry-app'});
 const p=provider(h);
 h.setCatalogReader(async()=>structuredClone(defineFunctions({appId:source.app_id,version:1,functions:[{key:'agenda.read',name:'Leggi agenda'}]})));
 const submitted=await sourcePost(h,source,'requests',migrationBody(source,{localUser:{...migrationBody(source).localUser,email:'retry@example.test'}}),'retry-key-0001');
 const row=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[submitted.body.requestId]))[0];
 const plan={license:{state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Titolare',permissions:['agenda.read']}]};
 await h.request('/v1/onboarding/practices/'+row.practice_id+'/plan','PUT',plan);
 p.control.failNextPostAfterCreate=true;
 const first=await h.request('/v1/onboarding/practices/'+row.practice_id+'/execute','POST',{});
 assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.state,'failed');
 assert.equal(first.body.requests[0].credentialPresent,true);assert.equal(first.body.requests[0].actionRequired,'');
 assert.equal(p.users.size,1);assert.equal(p.posts(),1);
 const second=await h.request('/v1/onboarding/practices/'+row.practice_id+'/execute','POST',{});
 assert.equal(second.status,201,JSON.stringify(second.body));assert.equal(second.body.state,'completed');assert.equal(second.body.requests[0].state,'completed');
 assert.equal(p.users.size,1);assert.equal(p.posts(),1);
 assert.equal([...p.users.values()][0].credentials[0].value,'Correct-Horse-9!');
 assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[submitted.body.requestId]))[0].password_cipher,null);
 }finally{await h.close();}
});

test('Migrazione: conflitto email senza takeover, poi collegamento esplicito senza reset password',async()=>{
 const h=await harness();try{
 const source=await createSource(h,{id:'alora-link',appId:'alora-link-app'});
 const p=provider(h);
 p.users.set('existing-subject',{id:'existing-subject',username:'existing@example.test',email:'persona@example.test',firstName:'Esistente',lastName:'Utente',enabled:true,attributes:{}});
 h.setCatalogReader(async()=>structuredClone(defineFunctions({appId:source.app_id,version:1,functions:[{key:'agenda.read',name:'Leggi agenda'}]})));
 const body=migrationBody(source,{localUser:{id:'local-9',email:'persona@example.test',firstName:'Nome',lastName:'Cognome',role:'manager',permissions:['agenda.read']}});
 const submitted=await sourcePost(h,source,'requests',body,'link-key-0001');
 const requestId=submitted.body.requestId;
 const detail=(await h.request('/v1/onboarding/practices/'+(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[requestId]))[0].practice_id)).body;
 const plan={license:{state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}]},roles:[{localRole:'manager',roleName:'Manager',permissions:['agenda.read']}]};
 assert.equal((await h.request('/v1/onboarding/practices/'+detail.id+'/plan','PUT',plan)).body.canExecute,true);
 const failed=await h.request('/v1/onboarding/practices/'+detail.id+'/execute','POST',{});
 assert.equal(failed.status,201,JSON.stringify(failed.body));assert.equal(failed.body.state,'failed');
 const request=failed.body.requests[0];assert.equal(request.state,'failed');assert.equal(request.actionRequired,'explicit_link_required');assert.equal(request.credentialPresent,false);
 assert.equal(p.posts(),0);assert.equal(p.users.size,1);
 const unchanged=p.users.get('existing-subject');assert.equal(unchanged.credentials,undefined);
 const linked=await h.request('/v1/onboarding/practices/'+detail.id+'/plan','PUT',{...plan,identities:{[requestId]:'existing-subject'}});
 assert.equal(linked.body.canExecute,true);
 const done=await h.request('/v1/onboarding/practices/'+detail.id+'/execute','POST',{});
 assert.equal(done.status,201,JSON.stringify(done.body));assert.equal(done.body.state,'completed');assert.equal(done.body.requests[0].state,'completed');
 assert.equal(done.body.requests[0].identitySubject,'existing-subject');assert.equal(p.posts(),0);assert.equal(p.users.get('existing-subject').credentials,undefined);
 const link=(await h.store.query('SELECT subject FROM local_links'))[0];assert.equal(link.subject,'existing-subject');
 assert.equal((await h.store.query('SELECT subject FROM app_local_users'))[0].subject,'existing-subject');
 assert.equal((await h.store.query("SELECT count(*)::int AS n FROM identities WHERE subject='existing-subject'"))[0].n,1);
 }finally{await h.close();}
});

test('Migrazione: credenziale scaduta non viene usata e viene distrutta',async()=>{
 const h=await harness();try{
 const source=await createSource(h,{id:'alora-exp',appId:'alora-exp-app'});
 const p=provider(h);
 h.setCatalogReader(async()=>structuredClone(defineFunctions({appId:source.app_id,version:1,functions:[{key:'agenda.read',name:'Leggi agenda'}]})));
 const submitted=await sourcePost(h,source,'requests',migrationBody(source),'expiry-key-0001');
 const requestId=submitted.body.requestId;
 const row=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[requestId]))[0];
 const plan={license:{state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Titolare',permissions:['agenda.read']}]};
 await h.request('/v1/onboarding/practices/'+row.practice_id+'/plan','PUT',plan);
 await h.store.query("UPDATE onboarding_requests SET password_expires_at=now()-interval '1 minute' WHERE id=$1",[requestId]);
 const prepared=await h.request('/v1/onboarding/practices/'+row.practice_id+'/prepare','POST',{});
 assert.equal(prepared.status,201,JSON.stringify(prepared.body));
 const executed=await h.request('/v1/onboarding/practices/'+row.practice_id+'/execute','POST',{});
 assert.equal(executed.status,201,JSON.stringify(executed.body));assert.equal(executed.body.state,'failed');
 assert.equal(executed.body.requests[0].actionRequired,'new_request_required');
 assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[requestId]))[0].password_cipher,null);
 assert.equal(p.posts(),0);
 }finally{await h.close();}
});


test('Migrazione: rifiuto durante il provider restituisce conflitto senza sovrascrivere esecuzione',async()=>{
 const h=await harness();let release=()=>{};try{
 const source=await createSource(h,{id:'race-reject',appId:'race-reject-app'});
 const p=provider(h);
 h.setCatalogReader(async()=>structuredClone(defineFunctions({appId:source.app_id,version:1,functions:[{key:'agenda.read',name:'Leggi agenda'}]})));
 const submitted=await sourcePost(h,source,'requests',migrationBody(source),'race-reject-0001');
 const row=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[submitted.body.requestId]))[0];
 const base='/v1/onboarding/practices/'+row.practice_id;
 await h.request(base+'/plan','PUT',{license:{state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Titolare',permissions:['agenda.read']}]});
 let entered=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 p.control.beforeCreate=async()=>{entered();await blocked;};
 const execution=h.request(base+'/execute','POST',{});
 await started;
 try{
  const rejected=await h.request(base+'/reject','POST',{reason:'Rifiuto concorrente'});
  assert.equal(rejected.status,409,JSON.stringify(rejected.body));
  const person=await h.request(base+'/requests/'+submitted.body.requestId+'/reject','POST',{reason:'Rifiuto personale concorrente'});
  assert.equal(person.status,409,JSON.stringify(person.body));
  const second=migrationBody(source,{localUser:{...migrationBody(source).localUser,id:'local-2',email:'second@example.test'}});
  assert.equal((await sourcePost(h,source,'requests',second,'race-reject-0002')).status,409);
 }finally{release();await execution;}
 const detail=(await h.request(base)).body;
 assert.equal(detail.state,'completed');assert.equal(detail.requests[0].state,'completed');
 assert.equal(detail.requests.length,1);assert.equal(p.users.size,1);
 }finally{release();await h.close();}
});

test('Migrazione: rifiuto aziendale terminale anche per una nuova persona',async()=>{
 const h=await harness();try{
 const source=await createSource(h,{id:'terminal',appId:'terminal-app'});
 const p=provider(h);
 const first=await sourcePost(h,source,'requests',migrationBody(source),'terminal-0001');
 const row=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[first.body.requestId]))[0];
 const base='/v1/onboarding/practices/'+row.practice_id;
 assert.equal((await h.request(base+'/reject','POST',{reason:'Non autorizzata'})).body.state,'rejected');
 const second=migrationBody(source,{localUser:{...migrationBody(source).localUser,id:'local-2',email:'second@example.test'}});
 assert.equal((await sourcePost(h,source,'requests',second,'terminal-0002')).status,409);
 assert.equal((await sourcePost(h,source,'requests',migrationBody(source),'terminal-0001')).body.state,'rejected');
 assert.equal((await h.request(base+'/execute','POST',{})).status,409);
 const detail=(await h.request(base)).body;
 assert.equal(detail.state,'rejected');assert.equal(detail.requests.length,1);
 assert.equal(detail.requests[0].credentialPresent,false);assert.equal(p.posts(),0);
 }finally{await h.close();}
});

test('Migrazione: reinvio scaduto con chiave stabile o nuova conserva AAD della richiesta persistita',async()=>{
 const h=await harness();try{
 const source=await createSource(h,{id:'aad-retry',appId:'aad-retry-app'});
 const first=await sourcePost(h,source,'requests',migrationBody(source),'aad-retry-0001');
 for(const key of ['aad-retry-0001','aad-retry-0002']){
  await h.store.query("UPDATE onboarding_requests SET state='expired',password_cipher=null,password_deleted_at=now(),password_expires_at=now()-interval '1 second' WHERE id=$1",[first.body.requestId]);
  const retry=await sourcePost(h,source,'requests',migrationBody(source,{initialPassword:'Renewed-Password-8!'}),key);
  assert.equal(retry.status,201);assert.equal(retry.body.state,'pending');assert.equal(retry.body.requestId,first.body.requestId);
  const stored=(await h.store.query('SELECT id,password_cipher FROM onboarding_requests WHERE id=$1',[first.body.requestId]))[0];
  assert.equal(unsealMigrationValue(stored.password_cipher,stored.id),'Renewed-Password-8!');
 }
 }finally{await h.close();}
});


test('Password recovery: typed action, fresh source attestation, distinct keys, preservation and terminal guards',async()=>{
 const h=await harness();try{
  const source=await createSource(h,{id:'password-recovery',appId:'password-recovery-app'}),p=provider(h);
  p.control.rejectPassword='Correct-Horse-9!';
  h.setCatalogReader(async()=>defineFunctions({appId:source.app_id,version:1,functions:[{key:'agenda.read',name:'Agenda'}]}));
  const submitted=await sourcePost(h,source,'requests',migrationBody(source),'recovery-original-1');
  const id=submitted.body.requestId,practice=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[id]))[0].practice_id;
  const base='/v1/onboarding/practices/'+practice;
  await h.request(base+'/plan','PUT',{license:{state:'active',expiresAt:null,features:[{key:'agenda.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Owner',permissions:['agenda.read']}]});
  await h.request(base+'/execute','POST',{});
  const failed=(await h.store.query('SELECT state,action_required,password_cipher,identity_subject FROM onboarding_requests WHERE id=$1',[id]))[0];
  assert.equal(failed.state,'failed');assert.equal(failed.action_required,'password_change_required');assert.equal(failed.password_cipher,null);assert.equal(failed.identity_subject,null);assert.equal(p.users.size,0);
  const lookup=await sourcePost(h,source,'login-context',{schemaVersion:1,sourceId:source.id,appId:source.app_id,email:'persona@example.test'});
  assert.equal(lookup.body.request.nextAction,'choose_connect_password');assert(!JSON.stringify(lookup.body).includes('policy'));
  const noRetry=await sourcePost(h,source,'requests',migrationBody(source),'recovery-ordinary-retry');assert.equal(noRetry.body.nextAction,'choose_connect_password');assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[id]))[0].password_cipher,null);
  const recovery={schemaVersion:1,sourceId:source.id,appId:source.app_id,requestId:id,localTenantId:'tenant-1',localUserId:'local-1',email:'persona@example.test',consentVersion:'2026-10-21-mandatory-v1',newPassword:'New-Connect-Password-8!'};
  assert.equal((await sourcePost(h,source,'password-recovery',{...recovery,localTenantId:'foreign'},'recovery-new-1')).status,409);
  assert.equal((await sourcePost(h,source,'password-recovery',{...recovery,consentVersion:'wrong'},'recovery-new-1')).status,400);
  assert.equal((await sourcePost(h,source,'password-recovery',recovery,'recovery-original-1')).status,409);
  for(const state of ['migrating','rejected','expired','completed']){
   await h.store.query('UPDATE onboarding_practices SET state=$2 WHERE id=$1',[practice,state]);
   assert.equal((await sourcePost(h,source,'password-recovery',recovery,'recovery-new-1')).status,409);
  }
  await h.store.query("UPDATE onboarding_practices SET state='failed' WHERE id=$1",[practice]);
  const foreign=await createSource(h,{id:'foreign-recovery',appId:'foreign-recovery-app'});
  assert.equal((await sourcePost(h,foreign,'password-recovery',{...recovery,sourceId:foreign.id,appId:foreign.app_id},'recovery-new-1')).status,404);
  const recovered=await sourcePost(h,source,'password-recovery',recovery,'recovery-new-1');assert.equal(recovered.status,201);assert.equal(recovered.body.nextAction,'wait');
  assert.equal((await sourcePost(h,source,'requests',migrationBody(source),'recovery-new-1')).status,409);
  const stored=(await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[id]))[0].password_cipher;assert.equal(unsealMigrationValue(stored,id),recovery.newPassword);
  assert.equal((await sourcePost(h,source,'password-recovery',{...recovery,newPassword:'Must-not-replace'},'recovery-new-1')).status,201);
  assert.equal((await h.store.query('SELECT password_cipher FROM onboarding_requests WHERE id=$1',[id]))[0].password_cipher,stored);
  assert.equal((await sourcePost(h,source,'password-recovery',recovery,'recovery-new-2')).status,409);
  await h.request(base+'/execute','POST',{});const detail=(await h.request(base)).body;assert.equal(detail.state,'completed');assert.equal(p.users.size,1);
  const person=[...p.users.values()][0];assert.equal(person.credentials[0].value,recovery.newPassword);
  assert.equal((await sourcePost(h,source,'password-recovery',recovery,'recovery-new-3')).status,409);
  assert.equal((await sourcePost(h,source,'password-recovery',recovery,'recovery-new-1')).body.state,'completed');
  assert.equal(p.users.size,1);assert.equal(person.credentials[0].value,recovery.newPassword);
  const audit=JSON.stringify(await h.store.query('SELECT detail FROM audit'));assert(!audit.includes(recovery.newPassword));assert(!audit.includes('Correct-Horse-9!'));
 }finally{await h.close();}
});

test('Activation password rejection: discovery and facade route to assistance without a legacy proof or challenge',async()=>{
 const h=await harness();try{
  const source=await createSource(h,{id:'activation-action',appId:'activation-action-app'}),p=provider(h);
  const body={schemaVersion:1,sourceId:source.id,appId:source.app_id,kind:'activation',companyName:'New company',applicant:{email:'new-applicant@example.test',firstName:'New',lastName:'Applicant'},initialPassword:'Synthetic-Password-9!'};
  const submitted=await sourcePost(h,source,'requests',body,'activation-action-original');assert.equal(submitted.status,201);
  const id=submitted.body.requestId,practice=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[id]))[0].practice_id;
  await h.store.query("UPDATE onboarding_requests SET state='failed',action_required='password_change_required',password_cipher=null,password_deleted_at=now() WHERE id=$1",[id]);
  await h.store.query("UPDATE onboarding_practices SET state='failed' WHERE id=$1",[practice]);
  const lookup=await sourcePost(h,source,'login-context',{schemaVersion:1,sourceId:source.id,appId:source.app_id,email:body.applicant.email});
  assert.equal(lookup.status,201);assert.equal(lookup.body.request.nextAction,'contact_admin');
  assert.equal((await sourcePost(h,source,'requests',body,'activation-action-original')).body.nextAction,'contact_admin');
  const recovery=await sourcePost(h,source,'password-recovery',{schemaVersion:1,sourceId:source.id,appId:source.app_id,requestId:id,localTenantId:'invented-tenant',localUserId:'invented-user',email:body.applicant.email,consentVersion:'2026-10-21-mandatory-v1',newPassword:'Synthetic-New-Password-9!'},'activation-action-recovery');
  assert.equal(recovery.status,409);
  const {ConnectApplication}=await import('../packages/sdk/src/application.js');let legacyChecks=0,storeCalls=0,provisions=0;
  const application=new ConnectApplication({apiUrl:await h.listen(),allowLoopbackHttp:true,sourceId:source.id,sourceSecret:source.secret,appId:source.app_id,issuer:'https://provider.example.test/realms/qa',clientId:'qa',redirectUri:origin+'/callback',appOrigin:origin,encryptionKey:'d'.repeat(64),catalog:defineFunctions({appId:source.app_id,version:1,functions:[]}),store:{transaction:async()=>{storeCalls++;throw Error('Unexpected store access');}},accounts:{verifyLegacy:async()=>{legacyChecks++;return null;},provision:async()=>{provisions++;throw Error('Unexpected provisioning');},restrict:async()=>false}});
  for(const password of [undefined,'Synthetic-Password-9!']){
   const result=await application.auth.signIn({email:body.applicant.email,password},{origin,cookies:{}});
   assert.deepEqual(result,{status:'pending',request:{requestId:id,state:'failed',nextAction:'contact_admin'},nextAction:'contact_admin'});
  }
  assert.equal(legacyChecks,0);assert.equal(storeCalls,0);assert.equal(provisions,0);assert.equal(p.calls.length,0);
  for(const [state,required] of [['failed','new_request_required'],['expired','new_request_required']]){
   await h.store.query('UPDATE onboarding_requests SET state=$2,action_required=$3 WHERE id=$1',[id,state,required]);
   const status=await sourcePost(h,source,'login-context',{schemaVersion:1,sourceId:source.id,appId:source.app_id,email:body.applicant.email});assert.equal(status.body.request.nextAction,'contact_admin');
  }
  await h.store.query("UPDATE onboarding_requests SET state='failed',action_required='password_change_required' WHERE id=$1",[id]);
  assert.deepEqual((await h.store.query('SELECT state,password_cipher,identity_subject FROM onboarding_requests WHERE id=$1',[id]))[0],{state:'failed',password_cipher:null,identity_subject:null});
 }finally{await h.close();}
});

test('Password actions honor practice state and explicit identity links in every source response',async()=>{
 const h=await harness();try{
  const source=await createSource(h,{id:'recovery-actions',appId:'recovery-actions-app'}),p=provider(h),body=migrationBody(source);
  const submitted=await sourcePost(h,source,'requests',body,'recovery-actions-original');assert.equal(submitted.status,201);
  const id=submitted.body.requestId,practice=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[id]))[0].practice_id;
  const recovery={schemaVersion:1,sourceId:source.id,appId:source.app_id,requestId:id,localTenantId:body.localTenant.id,localUserId:body.localUser.id,email:body.localUser.email,consentVersion:body.consentVersion,newPassword:'Synthetic-Recovery-Password-9!'};
  await h.store.query("UPDATE onboarding_requests SET state='failed',action_required='password_change_required',password_cipher=null,password_deleted_at=now() WHERE id=$1",[id]);
  await h.store.query('INSERT INTO onboarding_password_recoveries(source_id,idempotency_key,request_id) VALUES($1,$2,$3)',[source.id,'recovery-actions-replay',id]);
  const cases=[
   {state:'pending',action:'choose_connect_password'},
   {state:'approved',action:'choose_connect_password'},
   {state:'failed',action:'choose_connect_password'},
   {state:'migrating',action:'wait'},
   {state:'rejected',action:'closed'},
   {state:'expired',action:'closed'},
   {state:'completed',action:'closed'},
   {state:'failed',action:'contact_admin',plan:{identities:{[id]:'admin-subject'}}},
   {state:'failed',action:'contact_admin',subject:'persisted-subject'},
   {state:'failed',action:'resubmit',personState:'expired',required:'new_request_required'},
   {state:'failed',action:'contact_admin',personState:'expired',required:'new_request_required',plan:{identities:{[id]:'admin-subject'}}},
  ];
  for(const [index,c] of cases.entries()){
   await h.store.query('UPDATE onboarding_practices SET state=$2,plan=$3 WHERE id=$1',[practice,c.state,JSON.stringify(c.plan??{})]);
   await h.store.query('UPDATE onboarding_requests SET identity_subject=$2,state=$3,action_required=$4 WHERE id=$1',[id,c.subject??null,c.personState??'failed',c.required??'password_change_required']);
   const lookup=await sourcePost(h,source,'login-context',{schemaVersion:1,sourceId:source.id,appId:source.app_id,email:body.localUser.email});assert.equal(lookup.status,201);
   assert.equal(lookup.body.request.nextAction,c.action,JSON.stringify(c));
   // An expired request permits an explicit resubmission; do not mutate it during read-only action checks.
   if(!c.personState)assert.equal((await sourcePost(h,source,'requests',body,'recovery-actions-original')).body.nextAction,c.action,JSON.stringify(c));
   const replay=await sourcePost(h,source,'password-recovery',recovery,'recovery-actions-replay');assert.equal(replay.status,201);assert.equal(replay.body.nextAction,c.action,JSON.stringify(c));
   if(c.action!=='choose_connect_password')assert.equal((await sourcePost(h,source,'password-recovery',recovery,'recovery-actions-'+index)).status,409,JSON.stringify(c));
  }
  // A local link blocks recovery by source/app/local IDs even when email and enabled flags differ.
  await h.store.query("UPDATE onboarding_practices SET state='failed',plan='{}'::jsonb WHERE id=$1",[practice]);await h.store.query("UPDATE onboarding_requests SET identity_subject=null,state='failed',action_required='password_change_required' WHERE id=$1",[id]);
  const customer=(await h.request('/v1/customers','POST',{name:'Explicit link company'})).body;
  const connection=await h.request('/v1/application-connections','POST',{id:source.app_id,name:'Actions app',customerId:customer.id,domain:origin,integration:'web'});assert.equal(connection.status,201);
  await h.store.query("INSERT INTO identities(subject,display_name) VALUES('linked-subject','Linked person')");
  await h.store.query("INSERT INTO app_local_users(source_id,installation_id,app_id,local_tenant_id,local_user_id,subject,email,email_normalized,role,enabled) VALUES($1,$2,$3,$4,$5,'linked-subject','different@example.test','different@example.test','owner',false)",[source.id,connection.body.installationId,source.app_id,body.localTenant.id,body.localUser.id]);
  const linked=await sourcePost(h,source,'login-context',{schemaVersion:1,sourceId:source.id,appId:source.app_id,email:body.localUser.email});assert.equal(linked.body.request.nextAction,'contact_admin');
  assert.equal((await sourcePost(h,source,'requests',body,'recovery-actions-original')).body.nextAction,'contact_admin');
  assert.equal((await sourcePost(h,source,'password-recovery',recovery,'recovery-actions-linked')).status,409);
  assert.equal(p.calls.length,0);
 }finally{await h.close();}
});
