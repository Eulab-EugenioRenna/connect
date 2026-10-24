import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ServiceUnavailableException} from '@nestjs/common';
// @ts-ignore JavaScript harness
import {harness} from './harness.mjs';
import {ConnectServer} from '../packages/sdk/src/server.js';
test('Mirror da app esistente: tenant dall’installazione, idempotenza, nessuna password o assegnazione importata',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Produzione'})).body;
 const i=(await h.request('/v1/application-connections','POST',{id:'existing-app',name:'Esistente',customerId:customer.id,domain:'https://existing.example',integration:'web'})).body;
 const headers={Authorization:'','X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret};
 const users=new Map<string,any>(),calls:any[]=[];let failAfterCreate=false;
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{
  calls.push({path,method,body});
  if(path.startsWith('/users?'))return {body:[...users.values()].filter(u=>u.username===new URLSearchParams(path.split('?')[1]).get('username'))};
  if(path==='/users'&&method==='POST'){const user={...body,id:randomUUID()};users.set(user.id,user);if(failAfterCreate){failAfterCreate=false;throw new ServiceUnavailableException('Risposta persa dopo creazione');}return {body:null,location:'https://sso.test/users/'+user.id};}
  if(path.endsWith('/role-mappings/realm/composite'))return {body:[]};
  if(path.endsWith('/credentials')){const user=users.get(path.split('/').slice(-2)[0]);return {body:(user?.credentials||[]).map((c:any)=>({type:c.type}))};}
  return {body:users.get(path.split('/').pop()!)};
 });
 const local={localUserId:'existing-id-42',username:'mario.production',email:'mario@example.test',displayName:'Mario Esistente'};
 assert.equal((await h.request('/v1/users/mirror','POST',local)).status,403);
 assert.equal((await h.request('/v1/users/mirror','POST',{...local,password:'do-not-import'},headers)).status,400);
 assert.equal((await h.request('/v1/users/mirror','POST',{...local,customerId:randomUUID()},headers)).status,400);
 const result=await h.request('/v1/users/mirror','POST',local,headers);assert.equal(result.status,201);assert.equal(result.body.created,true);assert.equal(result.body.customerId,customer.id);assert.equal(result.body.localUserId,local.localUserId);assert.equal(result.body.ssoSetupRequired,true);
 assert.equal(calls.find(c=>c.method==='POST').body.credentials,undefined);assert.deepEqual(calls.find(c=>c.method==='POST').body.requiredActions,['UPDATE_PASSWORD']);assert.equal((await h.store.query('SELECT * FROM assignments')).length,0);
 const before=calls.length;const repeated=await h.request('/v1/users/mirror','POST',{...local,email:'changed@example.test',displayName:'Non sovrascrivere'},headers);assert.equal(repeated.body.subject,result.body.subject);assert.equal(repeated.body.status,'already_linked');assert.equal(calls.length,before);assert.equal(users.size,1);
 await h.store.query('UPDATE identities SET enabled=false WHERE subject=$1',[result.body.subject]);await h.store.query('UPDATE memberships SET enabled=false WHERE subject=$1',[result.body.subject]);await h.request('/v1/users/mirror','POST',local,headers);assert.equal((await h.store.query('SELECT enabled FROM identities'))[0].enabled,false);assert.equal((await h.store.query('SELECT enabled FROM memberships'))[0].enabled,false);
 const occupied={id:randomUUID(),username:'already-there',enabled:true,email:'existing@example.test'};users.set(occupied.id,occupied);assert.equal((await h.request('/v1/users/mirror','POST',{...local,localUserId:'43',username:'already-there'},headers)).status,409);
 failAfterCreate=true;const recovery={...local,localUserId:'44',username:'recoverable'};assert.equal((await h.request('/v1/users/mirror','POST',recovery,headers)).status,503);const recovered=await h.request('/v1/users/mirror','POST',recovery,headers);assert.equal(recovered.body.status,'recovered');assert.equal([...users.values()].filter(u=>u.username==='recoverable').length,1);
 const audit=JSON.stringify(await h.store.query('SELECT detail FROM audit'));assert(!audit.includes('eulab_mirror_proof'));assert(!audit.includes('do-not-import'));
 }finally{await h.close();}
});
test('SDK server mirrorUser: solo backend, riferimento locale conservato e nessuna modifica al profilo app',async()=>{
 const original=globalThis.fetch;const requests:any[]=[];
 const local=Object.freeze({localUserId:'legacy:158',username:'anna.local',email:'anna@example.test',displayName:'Anna Locale'});
 globalThis.fetch=async(input,options={})=>{requests.push({url:String(input),method:options.method,headers:options.headers,body:JSON.parse(String(options.body))});return Response.json({subject:'central-1',localUserId:local.localUserId,created:true,ssoSetupRequired:true});};
 try{const sdk=new ConnectServer({apiUrl:'https://connect.example',installationId:'installation-1',secret:'server-only'});const r=await sdk.mirrorUser(local);assert.equal(r.localUserId,'legacy:158');assert.deepEqual(requests[0].body,local);assert.equal(requests[0].url,'https://connect.example/v1/users/mirror');assert.equal(requests[0].headers['X-Installation-Secret'],'server-only');assert.equal(requests[0].headers.Authorization,undefined);assert.equal(local.username,'anna.local');}finally{globalThis.fetch=original;}
});

test('Mirror con password iniziale: nuova identità, ripetizione e identità esistente senza sovrascrittura',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Password iniziale'})).body;
 const i=(await h.request('/v1/application-connections','POST',{id:'password-app',name:'Password App',customerId:customer.id,domain:'https://password.example',integration:'web'})).body;
 const headers={Authorization:'','X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret};
 const users=new Map<string,any>(),calls:any[]=[];
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{
  calls.push({path,method,body});
  if(path.startsWith('/users?'))return {body:[...users.values()].filter(u=>u.username===new URLSearchParams(path.split('?')[1]).get('username'))};
  if(path==='/users'&&method==='POST'){const user={...body,id:randomUUID()};users.set(user.id,user);return {body:null,location:'https://sso.test/users/'+user.id};}
  if(path.endsWith('/role-mappings/realm/composite'))return {body:[]};
  if(path.endsWith('/credentials')){const user=users.get(path.split('/').slice(-2)[0]);return {body:(user?.credentials||[]).map((c:any)=>({type:c.type}))};}
  return {body:users.get(path.split('/').pop()!)};
 });
 const local={localUserId:'pw-1',username:'pw.user',email:'pw@example.test',displayName:'Password User'};
 const created=await h.request('/v1/users/mirror','POST',{...local,initialPassword:'Correct-Horse-9!'},headers);
 assert.equal(created.status,201);assert.equal(created.body.created,true);assert.equal(created.body.status,'created');assert.equal(created.body.ssoSetupRequired,false);
 assert(!JSON.stringify(created.body).includes('Correct-Horse-9!'));
 const createCall=calls.find(c=>c.method==='POST');
 assert.deepEqual(createCall.body.credentials,[{type:'password',value:'Correct-Horse-9!',temporary:false}]);
 assert.deepEqual(createCall.body.requiredActions,[]);assert(!createCall.body.requiredActions.includes('UPDATE_PASSWORD'));
 assert.equal((await h.store.query('SELECT * FROM assignments')).length,0);
 const providerUser=[...users.values()].find((u:any)=>u.username===local.username);const posts=calls.filter(c=>c.method==='POST').length;
 const repeated=await h.request('/v1/users/mirror','POST',{...local,initialPassword:'Different-Pass-0!'},headers);
 assert.equal(repeated.body.status,'already_linked');assert.equal(repeated.body.ssoSetupRequired,null);assert.equal(calls.filter(c=>c.method==='POST').length,posts);
 assert.deepEqual(providerUser.credentials,[{type:'password',value:'Correct-Horse-9!',temporary:false}]);
 const occupied={id:randomUUID(),username:'occupied.pw',enabled:true,email:'occupied@example.test'};users.set(occupied.id,occupied);
 const conflict=await h.request('/v1/users/mirror','POST',{...local,localUserId:'pw-2',username:'occupied.pw',initialPassword:'Other-Pass-2!'},headers);
 assert.equal(conflict.status,409);assert(!JSON.stringify(conflict.body).includes('Other-Pass-2!'));assert.equal(users.get(occupied.id).credentials,undefined);
 const auditText=JSON.stringify(await h.store.query('SELECT detail FROM audit'));
 for(const password of ['Correct-Horse-9!','Different-Pass-0!','Other-Pass-2!'])assert(!auditText.includes(password));
 }finally{await h.close();}
});

test('Mirror con password iniziale: risposta persa, recupero idempotente e nessuna reimpostazione',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Recupero password'})).body;
 const i=(await h.request('/v1/application-connections','POST',{id:'recovery-app',name:'Recovery App',customerId:customer.id,domain:'https://recovery.example',integration:'web'})).body;
 const headers={Authorization:'','X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret};
 const users=new Map<string,any>(),posts:any[]=[];let loseResponse=true;
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{
  if(path.startsWith('/users?'))return {body:[...users.values()].filter(u=>u.username===new URLSearchParams(path.split('?')[1]).get('username'))};
  if(path==='/users'&&method==='POST'){const user={...body,id:randomUUID()};users.set(user.id,user);posts.push(user);if(loseResponse){loseResponse=false;throw new ServiceUnavailableException('Risposta persa dopo creazione');}return {body:null,location:'https://sso.test/users/'+user.id};}
  if(path.endsWith('/role-mappings/realm/composite'))return {body:[]};
  if(path.endsWith('/credentials')){const user=users.get(path.split('/').slice(-2)[0]);return {body:(user?.credentials||[]).map((c:any)=>({type:c.type}))};}
  return {body:users.get(path.split('/').pop()!)};
 });
 const local={localUserId:'recover-pw',username:'recover.pw',email:'recover@example.test',displayName:'Recover Password'};
 const first=await h.request('/v1/users/mirror','POST',{...local,initialPassword:'First-Pass-123!'},headers);assert.equal(first.status,503);
 const recovered=await h.request('/v1/users/mirror','POST',{...local,initialPassword:'Second-Pass-456!'},headers);
 assert.equal(recovered.body.status,'recovered');assert.equal(recovered.body.created,false);assert.equal(posts.length,1);
 assert.deepEqual([...users.values()][0].credentials,[{type:'password',value:'First-Pass-123!',temporary:false}]);
 assert.equal(recovered.body.ssoSetupRequired,false);
 const auditText=JSON.stringify(await h.store.query('SELECT detail FROM audit'));assert(!auditText.includes('First-Pass-123!'));assert(!auditText.includes('Second-Pass-456!'));
 }finally{await h.close();}
});

test('SDK server: initialPassword inoltrata solo dal backend; SDK browser senza mirror',async()=>{
 const original=globalThis.fetch;const requests:any[]=[];
 const local=Object.freeze({localUserId:'legacy:159',username:'paola.local',email:'paola@example.test',displayName:'Paola Locale',initialPassword:'Local-Pass-77!'});
 globalThis.fetch=async(input,options={})=>{requests.push({url:String(input),method:options.method,headers:options.headers,body:JSON.parse(String(options.body))});return Response.json({subject:'central-2',localUserId:local.localUserId,created:true,ssoSetupRequired:false});};
 try{
  const sdk=new ConnectServer({apiUrl:'https://connect.example',installationId:'installation-1',secret:'server-only'});
  const result=await sdk.mirrorUser(local);
  assert.equal(result.localUserId,'legacy:159');assert.deepEqual(requests[0].body,local);
  assert.equal(requests[0].headers['X-Installation-Secret'],'server-only');assert.equal(requests[0].headers.Authorization,undefined);
  const {ConnectBrowser}=await import('../packages/sdk/src/browser.js');
  assert.equal('mirrorUser' in ConnectBrowser.prototype,false);
 }finally{globalThis.fetch=original;}
});

test('Mirror concorrente: una sola identità, una sola password e nessun duplicato',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Concorrenza'})).body;
 const i=(await h.request('/v1/application-connections','POST',{id:'concurrent-app',name:'Concurrent App',customerId:customer.id,domain:'https://concurrent.example',integration:'web'})).body;
 const headers={Authorization:'','X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret};
 const users=new Map<string,any>(),posts:any[]=[];
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{
  if(path.startsWith('/users?'))return {body:[...users.values()].filter(u=>u.username===new URLSearchParams(path.split('?')[1]).get('username'))};
  if(path==='/users'&&method==='POST'){const user={...body,id:randomUUID()};users.set(user.id,user);posts.push(user);return {body:null,location:'https://sso.test/users/'+user.id};}
  if(path.endsWith('/role-mappings/realm/composite'))return {body:[]};
  if(path.endsWith('/credentials')){const user=users.get(path.split('/').slice(-2)[0]);return {body:(user?.credentials||[]).map((c:any)=>({type:c.type}))};}
  return {body:users.get(path.split('/').pop()!)};
 });
 const local={localUserId:'race-1',username:'race.user',email:'race@example.test',displayName:'Race User'};
 const [first,second]=await Promise.all([
  h.request('/v1/users/mirror','POST',{...local,initialPassword:'Race-Pass-1!'},headers),
  h.request('/v1/users/mirror','POST',{...local,initialPassword:'Race-Pass-2!'},headers)
 ]);
 assert.equal(first.status,201);assert.equal(second.status,201);
 assert.equal([...users.values()].filter((u:any)=>u.username===local.username).length,1);
 assert.equal(posts.length,1);
 assert.equal([first,second].filter((r:any)=>r.body.created).length,1);
 assert.equal([first,second].filter((r:any)=>r.body.status==='already_linked').length,1);
 assert.equal((await h.store.query('SELECT * FROM local_links')).length,1);
 }finally{await h.close();}
});
