import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
// @ts-ignore JavaScript harness
import {harness} from './harness.mjs';
import {defineFunctions} from '../packages/sdk/src/functions.js';
import {ConnectServer} from '../packages/sdk/src/server.js';

const teamFunctions=[
 {key:'team.manage',name:'Amministra la squadra'},
 {key:'users.read',name:'Leggi utenze'},
 {key:'users.write',name:'Gestisci utenze'},
 {key:'reports.read',name:'Leggi report'},
 {key:'reports.write',name:'Scrivi report'},
 {key:'archive.manage',name:'Gestisci archivio'}
];

async function connectApp(h:any,{id,name,customerId,domain,functions,licensed}:{id:string;name:string;customerId:string;domain:string;functions:{key:string;name:string}[];licensed:string[]}){
 const installation=(await h.request('/v1/application-connections','POST',{id,name,customerId,domain,integration:'web'})).body;
 const document=defineFunctions({appId:id,version:1,functions});
 h.setCatalogReader(async(url:string)=>{assert.equal(url,domain+'/.well-known/eulab-connect.json');return structuredClone(document);});
 assert.equal((await h.request(`/v1/applications/${id}/catalog-sync`,'POST')).body.ok,true);
 assert.equal((await h.request('/v1/licenses','PUT',{customerId,appId:id,state:'active',expiresAt:null,features:licensed.map(key=>({key,purchased:true,enabled:true})),reason:'Collaudo delegato'})).status,200);
 return installation;
}

test('Squadra: delega limitata, isolamento fra aziende/app e divieto di escalation',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Azienda titolare'})).body;
 const i=await connectApp(h,{id:'team-app',name:'Team App',customerId:customer.id,domain:'https://team.example',functions:teamFunctions,licensed:['team.manage','users.read','users.write','reports.read','reports.write']});
 const origin='https://team.example';
 const auth=async(subject:string)=>({Authorization:`Bearer ${await h.token(subject,[])}`,'X-Installation-Id':i.installationId,Origin:origin});
 for(const subject of ['owner-1','collab-1','powerful-1'])await h.request('/v1/identities','PUT',{subject,displayName:subject,enabled:true});
 const ownerRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'team-app',name:'Titolare',permissions:['team.manage','users.read','users.write','reports.read','archive.manage'],reason:'Delega titolare'})).body;
 const collaboratorRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'team-app',name:'Collaboratore',permissions:['users.read'],reason:'Collaboratore'})).body;
 const powerfulRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'team-app',name:'Responsabile report',permissions:['reports.write'],reason:'Responsabile'})).body;
 await h.request('/v1/memberships','PUT',{subject:'owner-1',customerId:customer.id,enabled:true,roleIds:[ownerRole.id]});
 await h.request('/v1/memberships','PUT',{subject:'collab-1',customerId:customer.id,enabled:true,roleIds:[collaboratorRole.id]});
 await h.request('/v1/memberships','PUT',{subject:'powerful-1',customerId:customer.id,enabled:true,roleIds:[powerfulRole.id]});
 await h.request('/v1/identity-links','PUT',{installationId:i.installationId,localUserId:'1',subject:'owner-1'});
 await h.request('/v1/identity-links','PUT',{installationId:i.installationId,localUserId:'2',subject:'collab-1'});
 await h.request('/v1/identity-links','PUT',{installationId:i.installationId,localUserId:'3',subject:'powerful-1'});

 const overview=await h.request('/v1/team','GET',undefined,await auth('owner-1'));
 assert.equal(overview.status,200);assert.equal(overview.body.canManage,true);assert.equal(overview.body.customerId,customer.id);assert.equal(overview.body.appId,'team-app');
 assert.equal(overview.body.functions.find((f:any)=>f.key==='team.manage').delegable,true);
 assert.equal(overview.body.functions.find((f:any)=>f.key==='reports.write').delegable,false);
 assert.equal(overview.body.functions.some((f:any)=>f.key==='archive.manage'),false);
 assert.deepEqual(overview.body.users.map((u:any)=>u.subject).sort(),['collab-1','owner-1','powerful-1']);
 assert.equal((await h.request('/v1/team','GET',undefined,await auth('collab-1'))).status,403);
 assert.equal((await h.request('/v1/team','GET',undefined,await auth('powerful-1'))).status,403);

 const created=await h.request('/v1/team/roles','POST',{name:'Operatore report',permissions:['users.read','reports.read']},await auth('owner-1'));
 assert.equal(created.status,201);assert.equal(created.body.name,'Operatore report');assert.deepEqual(created.body.permissions.sort(),['reports.read','users.read']);
 assert.equal((await h.request('/v1/team/roles','POST',{name:'Fuori delega',permissions:['reports.write']},await auth('owner-1'))).status,403);
 assert.equal((await h.request('/v1/team/roles','POST',{name:'Fuori licenza',permissions:['archive.manage']},await auth('owner-1'))).status,403);
 assert.equal((await h.request('/v1/team/roles','POST',{name:'Sconosciuta',permissions:['unknown.permission']},await auth('owner-1'))).status,403);
 assert.equal((await h.request('/v1/team/roles','POST',{name:'Escalation',permissions:['eulab-admin']},await auth('owner-1'))).status,403);
 // Un ruolo storico che contiene una funzione non licenziata non è assegnabile in blocco.
 const mixedRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'team-app',name:'Misto storico',permissions:['users.read','archive.manage'],reason:'Ruolo preesistente'})).body;
 assert.equal((await h.request('/v1/team/users/collab-1/roles','PUT',{roleIds:[mixedRole.id]},await auth('owner-1'))).status,403);

 const assigned=await h.request('/v1/team/users/collab-1/roles','PUT',{roleIds:[created.body.id]},await auth('owner-1'));
 assert.equal(assigned.status,200);assert.deepEqual(assigned.body.roleIds,[created.body.id]);assert.equal(assigned.body.accessRestored,true);
 const collaboratorAccess=await h.request('/v1/access','GET',undefined,await auth('collab-1'));
 assert.equal(collaboratorAccess.body.canLogin,true);assert.deepEqual(collaboratorAccess.body.functions.map((f:any)=>f.key).sort(),['reports.read','users.read']);

 // Un delegato non può sostituire i ruoli di un utente con privilegi fuori dalla propria delega.
 assert.equal((await h.request('/v1/team/users/powerful-1/roles','PUT',{roleIds:[created.body.id]},await auth('owner-1'))).status,403);
 assert.deepEqual((await h.store.query('SELECT role_id FROM assignments WHERE subject=$1',['powerful-1'])).map((r:any)=>r.role_id),[powerfulRole.id]);

 // Un ruolo o un utente con funzioni fuori dalla delega del chiamante non è modificabile.
 const adminRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'team-app',name:'Report avanzati',permissions:['reports.write'],reason:'Amministrazione centrale'})).body;
 assert.equal((await h.request('/v1/team/roles/'+adminRole.id,'PUT',{name:'Manomesso',permissions:['users.read']},await auth('owner-1'))).status,403);
 assert.equal((await h.request('/v1/team/users/powerful-1','DELETE',undefined,await auth('owner-1'))).status,403);

 // Isolamento: il contesto installazione non può essere cambiato per gestire un'altra azienda o app.
 const otherCustomer=(await h.request('/v1/customers','POST',{name:'Altra azienda'})).body;
 const other=await connectApp(h,{id:'other-app',name:'Altra App',customerId:otherCustomer.id,domain:'https://other.example',functions:[{key:'users.read',name:'Leggi utenze'}],licensed:['users.read']});
 assert.equal((await h.request('/v1/team','GET',undefined,{Authorization:`Bearer ${await h.token('owner-1',[])}`,'X-Installation-Id':other.installationId,Origin:'https://other.example'})).status,403);
 const foreignRole=(await h.request('/v1/roles','PUT',{customerId:otherCustomer.id,appId:'other-app',name:'Esterno',permissions:['users.read'],reason:'Esterno'})).body;
 assert.equal((await h.request('/v1/team/roles/'+foreignRole.id,'PUT',{name:'Esterno',permissions:['users.read']},await auth('owner-1'))).status,404);
 assert.equal((await h.request('/v1/team/users/outsider-1/roles','PUT',{roleIds:[]},await auth('owner-1'))).status,404);

 // Nessuna capacità amministrativa globale tramite gli endpoint della squadra.
 assert.equal((await h.request('/v1/sso-identities','GET',undefined,await auth('owner-1'))).status,403);
 assert.equal((await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'team-app',name:'Globale',permissions:['users.read'],reason:'No'},await auth('owner-1'))).status,403);
 }finally{await h.close();}
});

test('Squadra: revoca della sola app, identità e altre app intatte, ripristino esplicito',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Azienda revoca'})).body;
 const i=await connectApp(h,{id:'revoke-app',name:'Revoke App',customerId:customer.id,domain:'https://revoke.example',functions:teamFunctions.slice(0,3),licensed:['team.manage','users.read','users.write']});
 const otherDomain='https://keep.example',otherApp='keep-app';
 const otherInstallation=await connectApp(h,{id:otherApp,name:'Keep App',customerId:customer.id,domain:otherDomain,functions:[{key:'users.read',name:'Leggi utenze'}],licensed:['users.read']});
 const auth=async(subject:string,installation=i.installationId,origin='https://revoke.example')=>({Authorization:`Bearer ${await h.token(subject,[])}`,'X-Installation-Id':installation,Origin:origin});
 for(const subject of ['owner-r','collab-r'])await h.request('/v1/identities','PUT',{subject,displayName:subject,enabled:true});
 const ownerRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'revoke-app',name:'Titolare',permissions:['team.manage','users.read','users.write'],reason:'Titolare'})).body;
 const collabRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'revoke-app',name:'Collaboratore',permissions:['users.read'],reason:'Collaboratore'})).body;
 const keepRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:otherApp,name:'Lettore',permissions:['users.read'],reason:'Altra app'})).body;
 await h.request('/v1/memberships','PUT',{subject:'owner-r',customerId:customer.id,enabled:true,roleIds:[ownerRole.id]});
 await h.request('/v1/memberships','PUT',{subject:'collab-r',customerId:customer.id,enabled:true,roleIds:[collabRole.id,keepRole.id]});
 await h.request('/v1/identity-links','PUT',{installationId:i.installationId,localUserId:'10',subject:'owner-r'});
 await h.request('/v1/identity-links','PUT',{installationId:i.installationId,localUserId:'11',subject:'collab-r'});
 await h.request('/v1/identity-links','PUT',{installationId:otherInstallation.installationId,localUserId:'11',subject:'collab-r'});
 // L'assegnazione del ruolo dell'altra app è estranea a questa applicazione.
 await h.store.query('DELETE FROM assignments WHERE subject=$1 AND app_id=$2',['collab-r',otherApp]);
 await h.store.query("INSERT INTO assignments VALUES($1,$2,$3,$4)",['collab-r',customer.id,otherApp,keepRole.id]);

 const before=await h.request('/v1/access','GET',undefined,await auth('collab-r'));assert.equal(before.body.canLogin,true);
 const otherBefore=await h.request('/v1/access','GET',undefined,await auth('collab-r',otherInstallation.installationId,otherDomain));assert.equal(otherBefore.body.canLogin,true);
 const revoked=await h.request('/v1/team/users/collab-r','DELETE',undefined,await auth('owner-r'));
 assert.equal(revoked.status,200);assert.equal(revoked.body.revoked,true);assert.equal(revoked.body.identityPreserved,true);assert.equal(revoked.body.membershipPreserved,true);assert.equal(revoked.body.otherApplicationsPreserved,true);
 assert.equal((await h.store.query('SELECT enabled FROM identities WHERE subject=$1',['collab-r']))[0].enabled,true);
 assert.equal((await h.store.query('SELECT enabled FROM memberships WHERE subject=$1 AND customer_id=$2',['collab-r',customer.id]))[0].enabled,true);
 assert.equal((await h.store.query('SELECT * FROM local_links WHERE installation_id=$1 AND subject=$2',[i.installationId,'collab-r'])).length,1);
 assert.equal((await h.store.query('SELECT * FROM local_links WHERE installation_id=$1 AND subject=$2',[otherInstallation.installationId,'collab-r'])).length,1);
 assert.equal((await h.store.query('SELECT * FROM assignments WHERE subject=$1 AND app_id=$2',['collab-r','revoke-app'])).length,0);
 const after=await h.request('/v1/access','GET',undefined,await auth('collab-r'));assert.equal(after.body.canLogin,false);assert.equal(after.body.reason,'access_revoked');
 assert.equal((await h.request('/v1/authorize','POST',{installationId:i.installationId,permission:'users.read'},await auth('collab-r'))).body.reason,'access_revoked');
 const otherAfter=await h.request('/v1/access','GET',undefined,await auth('collab-r',otherInstallation.installationId,otherDomain));assert.equal(otherAfter.body.canLogin,true);assert.equal(otherAfter.body.reason,'granted');
 // Il mirror ripetuto non cancella la revoca.
 const mirror=await h.request('/v1/users/mirror','POST',{localUserId:'11',username:'collab.r',email:'collab.r@example.test',displayName:'Collaboratore R'},{Authorization:'','X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret});
 assert.equal(mirror.body.status,'already_linked');assert.equal((await h.store.query('SELECT * FROM app_access_revocations WHERE subject=$1',['collab-r'])).length,1);
 assert.equal((await h.request('/v1/team/users/collab-r/restore','POST',undefined,await auth('owner-r'))).status,409);
 const restored=await h.request('/v1/team/users/collab-r/roles','PUT',{roleIds:[collabRole.id]},await auth('owner-r'));
 assert.equal(restored.status,200);assert.equal(restored.body.accessRestored,true);assert.equal((await h.store.query('SELECT * FROM app_access_revocations WHERE subject=$1',['collab-r'])).length,0);
 const final=await h.request('/v1/access','GET',undefined,await auth('collab-r'));assert.equal(final.body.canLogin,true);assert.deepEqual(final.body.functions.map((f:any)=>f.key),['users.read']);
 }finally{await h.close();}
});

test('Squadra: senza team.manage le modifiche sono negate, la lettura resta delegata',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Sola lettura'})).body;
 const i=await connectApp(h,{id:'readonly-app',name:'Readonly App',customerId:customer.id,domain:'https://readonly.example',functions:[
  {key:'users.read',name:'Leggi utenze'},{key:'users.write',name:'Gestisci utenze'},{key:'reports.read',name:'Leggi report'}
 ],licensed:['users.read','users.write','reports.read']});
 const auth=async(subject:string)=>({Authorization:`Bearer ${await h.token(subject,[])}`,'X-Installation-Id':i.installationId,Origin:'https://readonly.example'});
 for(const subject of ['reader-1','target-1'])await h.request('/v1/identities','PUT',{subject,displayName:subject,enabled:true});
 const readerRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'readonly-app',name:'Lettore',permissions:['users.read'],reason:'Lettura'})).body;
 const targetRole=(await h.request('/v1/roles','PUT',{customerId:customer.id,appId:'readonly-app',name:'Report',permissions:['reports.read'],reason:'Report'})).body;
 await h.request('/v1/memberships','PUT',{subject:'reader-1',customerId:customer.id,enabled:true,roleIds:[readerRole.id]});
 await h.request('/v1/memberships','PUT',{subject:'target-1',customerId:customer.id,enabled:true,roleIds:[targetRole.id]});
 await h.request('/v1/identity-links','PUT',{installationId:i.installationId,localUserId:'1',subject:'reader-1'});
 await h.request('/v1/identity-links','PUT',{installationId:i.installationId,localUserId:'2',subject:'target-1'});

 const overview=await h.request('/v1/team','GET',undefined,await auth('reader-1'));
 assert.equal(overview.status,200);assert.equal(overview.body.canManage,false);
 assert.equal(overview.body.functions.find((f:any)=>f.key==='users.read').delegable,true);
 assert.equal((await h.request('/v1/team/users','GET',undefined,await auth('reader-1'))).status,200);
 assert.equal((await h.request('/v1/team/roles','GET',undefined,await auth('reader-1'))).status,200);
 assert.equal((await h.request('/v1/team/functions','GET',undefined,await auth('reader-1'))).status,200);

 // Anche con una funzione delegata, senza team.manage non si creano o modificano ruoli e utenti.
 const rolesBefore=(await h.store.query('SELECT id FROM roles')).length;
 assert.equal((await h.request('/v1/team/roles','POST',{name:'Non consentito',permissions:['users.read']},await auth('reader-1'))).status,403);
 assert.equal((await h.request('/v1/team/roles/'+readerRole.id,'PUT',{name:'Non consentito',permissions:['users.read']},await auth('reader-1'))).status,403);
 assert.equal((await h.request('/v1/team/roles/'+readerRole.id,'DELETE',undefined,await auth('reader-1'))).status,403);
 assert.equal((await h.request('/v1/team/users/target-1/roles','PUT',{roleIds:[readerRole.id]},await auth('reader-1'))).status,403);
 assert.equal((await h.request('/v1/team/users/target-1','DELETE',undefined,await auth('reader-1'))).status,403);
 assert.equal((await h.request('/v1/team/users/target-1/restore','POST',undefined,await auth('reader-1'))).status,403);
 assert.equal((await h.store.query('SELECT id FROM roles')).length,rolesBefore);
 assert.deepEqual((await h.store.query('SELECT role_id FROM assignments WHERE subject=$1',['target-1'])).map((r:any)=>r.role_id),[targetRole.id]);
 assert.equal((await h.store.query('SELECT * FROM app_access_revocations')).length,0);
 }finally{await h.close();}
});

test('SDK squadra: stessi percorsi e token utente, nessun segreto installazione nel browser',async()=>{
 const original=globalThis.fetch;const requests:any[]=[];
 globalThis.fetch=async(input,options={})=>{requests.push({url:String(input),method:options.method,headers:options.headers,body:options.body===undefined?undefined:JSON.parse(String(options.body))});return Response.json({ok:true});};
 try{
  const sdk=new ConnectServer({apiUrl:'https://connect.example',installationId:'installation-1',secret:'server-only'});
  await sdk.teamOverview('user-token');await sdk.teamUsers('user-token');await sdk.teamRoles('user-token');await sdk.teamFunctions('user-token');
  await sdk.createTeamRole('user-token',{name:'Operatore',permissions:['users.read']});
  await sdk.updateTeamRole('user-token','role-1',{name:'Operatore',permissions:['users.read','users.write']});
  await sdk.deleteTeamRole('user-token','role-1');
  await sdk.setTeamUserRoles('user-token','subject-1',['role-1']);
  await sdk.revokeTeamUser('user-token','subject-1');await sdk.restoreTeamUser('user-token','subject-1');
  assert.deepEqual(requests.map(r=>r.url),[
   'https://connect.example/v1/team','https://connect.example/v1/team/users','https://connect.example/v1/team/roles','https://connect.example/v1/team/functions',
   'https://connect.example/v1/team/roles','https://connect.example/v1/team/roles/role-1','https://connect.example/v1/team/roles/role-1',
   'https://connect.example/v1/team/users/subject-1/roles','https://connect.example/v1/team/users/subject-1','https://connect.example/v1/team/users/subject-1/restore'
  ]);
  assert(requests.every(r=>r.headers['X-Installation-Secret']==='server-only'));
  const {ConnectBrowser}=await import('../packages/sdk/src/browser.js');
  assert.equal('mirrorUser' in ConnectBrowser.prototype,false);
 }finally{globalThis.fetch=original;}
});
