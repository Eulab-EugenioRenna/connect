import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {harness} from './harness.mjs';
import {smtpConfig} from '../apps/api/src/mail.service.js';

test('Notifiche: isolamento destinatario, lettura reversibile, cursore e creazione solo admin',async()=>{
 const h=await harness();try{
 const user=randomUUID(),other=randomUUID();h.setIdentityRequest(async()=>({body:{id:user,email:'person@example.test',emailVerified:true}}));
 const headers={Authorization:'Bearer '+await h.token(user,[])};const otherHeaders={Authorization:'Bearer '+await h.token(other,[])};
 const create=async(title:string,key=randomUUID())=>h.request('/v1/notifications','POST',{subject:user,title,body:'Test personale'},{'Idempotency-Key':key});
 assert.equal((await h.injectRequest('/v1/notifications')).status,401);
 assert.equal((await h.request('/v1/notifications','POST',{subject:user,title:'No',body:'No'},{...headers,'Idempotency-Key':randomUUID()})).status,403);
 assert.equal((await create('Prima')).status,201);const second=await create('Seconda');assert.equal(second.status,201);
 await h.store.query("UPDATE notifications SET created_at='2026-10-19T10:00:00.123456Z'");
 const firstPage=await h.request('/v1/notifications?limit=1','GET',undefined,headers);assert.equal(firstPage.status,200);assert.equal(firstPage.body.items.length,1);assert.equal(firstPage.body.unreadCount,2);assert(firstPage.body.next);
 const lastPage=await h.request('/v1/notifications?'+new URLSearchParams(firstPage.body.next),'GET',undefined,headers);assert.equal(lastPage.body.items.length,1);assert.notEqual(lastPage.body.items[0].id,firstPage.body.items[0].id);assert.equal(lastPage.body.next,null);
 assert.equal((await h.request('/v1/notifications','GET',undefined,otherHeaders)).body.items.length,0);
 const id=second.body.id;assert.equal((await h.request(`/v1/notifications/${id}/read`,'PUT',{read:true},otherHeaders)).status,404);
 const read=await h.request(`/v1/notifications/${id}/read`,'PUT',{read:true},headers);assert(read.body.read_at);
 assert.equal((await h.request(`/v1/notifications/${id}/read`,'PUT',{read:true},headers)).body.read_at,read.body.read_at);
 assert.equal((await h.request('/v1/notifications?unread=true','GET',undefined,headers)).body.unreadCount,1);
 await h.request(`/v1/notifications/${id}/read`,'PUT',{read:false},headers);
 assert.equal((await h.request('/v1/notifications/read-all','POST',{},headers)).body.updated,2);
 assert.equal((await h.request('/v1/notifications?unread=true','GET',undefined,headers)).body.items.length,0);
 assert.equal((await h.request('/v1/notifications?limit=10000','GET',undefined,headers)).status,400);
 assert.equal((await h.request('/v1/notifications?before=invalid','GET',undefined,headers)).status,400);
 }finally{await h.close();}
});
test('SMTP notifiche: indirizzo verificato, idempotenza e nessun reinvio dopo esito incerto',async()=>{
 const previous={...process.env};Object.assign(process.env,{SMTP_HOST:'smtp.example.test',SMTP_FROM:'no-reply@example.test',SMTP_USER:'smtp-user',SMTP_PASSWORD:'fixture-only',SMTP_SECURITY:'starttls'});
 const h=await harness();try{
 let sends=0,verified=true,uncertain=false;
 h.setIdentityRequest(async()=>({body:{email:'person@example.test',emailVerified:verified}}));
 h.setMailSend(async(to:string)=>{assert.equal(to,'person@example.test');sends++;if(uncertain)throw Object.assign(new Error('no response after DATA'),{code:'ETIMEDOUT',command:'DATA'});return {accepted:[to]};});
 const body={subject:randomUUID(),title:'Email',body:'Comunicazione',email:true},key=randomUUID();
 const create=(payload=body,idem=key)=>h.request('/v1/notifications','POST',payload,{'Idempotency-Key':idem});
 assert.equal((await create()).body.emailState,'accepted');assert.equal(sends,1);
 verified=false;assert.equal((await create()).body.replayed,true);assert.equal(sends,1);
 assert.equal((await create(body,randomUUID())).status,409);assert.equal(sends,1);verified=true;
 assert.equal((await create({...body,title:'Diversa'})).status,409);
 uncertain=true;const uncertainKey=randomUUID();assert.equal((await create(body,uncertainKey)).body.emailState,'uncertain');assert.equal(sends,2);
 assert.equal((await create(body,uncertainKey)).body.emailState,'uncertain');assert.equal(sends,2);
 const audit=await h.store.query('SELECT detail FROM audit');assert(!JSON.stringify(audit).includes('fixture-only'));
 }finally{await h.close();for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
test('Sicurezza account: MFA e dispositivi senza segreti, revoca solo del proprio dispositivo',async()=>{
 const h=await harness();try{
 const subject=randomUUID(),device=randomUUID(),calls:{path:string;method:string}[]=[];
 h.setIdentityRequest(async(path:string,method='GET')=>{calls.push({path,method});if(path.endsWith('/credentials'))return {body:[{id:device,type:'eulab-trusted-device',userLabel:'Portatile',credentialData:JSON.stringify({expiresAt:Date.now()+100000}),secretData:'never-return-this'},{id:'otp',type:'otp',secretData:'never-return-this'}]};if(path.endsWith('/logout'))return {body:null};if(method==='DELETE')return {body:null};return {body:{emailVerified:true,requiredActions:[]}};});
 const headers={Authorization:'Bearer '+await h.token(subject,[])};
 const me=await h.request('/v1/security/me','GET',undefined,headers);assert.equal(me.body.totp,true);assert.equal(me.body.trustedDevices[0].id,device);assert(!JSON.stringify(me.body).includes('never-return'));
 assert.equal((await h.request('/v1/security/devices/otp','DELETE',undefined,headers)).status,404);
 assert.equal((await h.request('/v1/security/devices/'+randomUUID(),'DELETE',undefined,headers)).status,404);
 const revoke=await h.request('/v1/security/devices/'+device,'DELETE',undefined,headers);assert.equal(revoke.body.revoked,true);assert(calls.some(c=>c.path===`/users/${subject}/credentials/${device}`&&c.method==='DELETE'));assert(calls.some(c=>c.path===`/users/${subject}/logout`));
 assert.equal((await h.request('/v1/security/settings','GET',undefined,headers)).status,403);
 assert.equal((await h.request('/v1/security/remember-me','PUT',{enabled:true,idleSeconds:1000,maxSeconds:500})).status,400);
 }finally{await h.close();}
});
test('Account personale: nome modificabile e rimozione della propria app senza toccare altri',async()=>{
 const h=await harness();try{
 const subject=randomUUID(),otp=randomUUID(),device=randomUUID(),calls:{path:string;method:string;body?:any}[]=[];
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{calls.push({path,method,body});if(path.endsWith('/credentials'))return {body:[{id:otp,type:'otp',userLabel:'Telefono'},{id:device,type:'eulab-trusted-device',credentialData:'{}'}]};if(method!=='GET')return {body:null};return {body:{id:subject,email:'person@example.test',firstName:'Old',lastName:'Name',emailVerified:true,requiredActions:[]}};});
 const headers={Authorization:'Bearer '+await h.token(subject,[])};
 assert.equal((await h.request('/v1/security/me/profile','PUT',{firstName:'',lastName:'X'},headers)).status,400);
 assert.equal((await h.request('/v1/security/me/profile','PUT',{firstName:'A',lastName:'B',email:'x@y.z'},headers)).status,400);
 const saved=await h.request('/v1/security/me/profile','PUT',{firstName:' Anna ',lastName:'Neri'},headers);
 assert.equal(saved.status,200);assert.deepEqual(saved.body,{firstName:'Anna',lastName:'Neri',email:'person@example.test'});
 const put=calls.find(c=>c.method==='PUT'&&c.path===`/users/${subject}`);assert.equal(put?.body.firstName,'Anna');assert.equal(put?.body.email,'person@example.test');
 // Only an authenticator app, never a trusted device or an unknown id, through the personal route.
 assert.equal((await h.request('/v1/security/me/authenticators/'+device,'DELETE',undefined,headers)).status,404);
 const removed=await h.request('/v1/security/me/authenticators/'+otp,'DELETE',undefined,headers);
 assert.equal(removed.status,200);assert.equal(removed.body.revoked,true);
 assert(calls.some(c=>c.method==='DELETE'&&c.path===`/users/${subject}/credentials/${otp}`));
 assert(calls.some(c=>c.method==='DELETE'&&c.path===`/users/${subject}/credentials/${device}`));
 assert(calls.some(c=>c.path===`/users/${subject}/logout`));
 }finally{await h.close();}
});
test('SMTP: nessuna modalità senza TLS, porte e indirizzi validati',()=>{
 const previous={...process.env};try{Object.assign(process.env,{SMTP_HOST:'smtp.example.test',SMTP_FROM:'no-reply@example.test',SMTP_SECURITY:'none'});assert.throws(smtpConfig);process.env.SMTP_SECURITY='starttls';process.env.SMTP_PORT='70000';assert.throws(smtpConfig);process.env.SMTP_PORT='587';process.env.SMTP_USER='user';delete process.env.SMTP_PASSWORD;assert.throws(smtpConfig);}finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
test('SMTP SSO: sincronizzazione riservata, credenziali mai restituite o inserite nell’audit',async()=>{
 const previous={...process.env};Object.assign(process.env,{SMTP_HOST:'smtp.example.test',SMTP_FROM:'no-reply@example.test',SMTP_USER:'smtp-user',SMTP_PASSWORD:'fixture-only',SMTP_SECURITY:'tls',SMTP_PORT:'465'});
 const h=await harness();try{
 let realm:any={rememberMe:true,ssoSessionIdleTimeout:1800,ssoSessionMaxLifespan:36000,smtpServer:{password:'fixture-only'}},updates:any[]=[];
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{assert.equal(path,'');if(method==='PUT'){updates.push(body);realm={...realm,...body};}return {body:realm};});
 const user={Authorization:'Bearer '+await h.token(randomUUID(),[])};
 assert.equal((await h.request('/v1/security/smtp/sync','POST',{},user)).status,403);
 const sync=await h.request('/v1/security/smtp/sync','POST');assert.equal(sync.status,201);assert.equal(updates[0].smtpServer.password,'fixture-only');assert.equal(updates[0].smtpServer.ssl,'true');assert.equal(updates[0].smtpServer.starttls,'false');
 assert(!JSON.stringify((await h.request('/v1/security/settings')).body).includes('fixture-only'));
 assert(!JSON.stringify(await h.store.query('SELECT detail FROM audit')).includes('fixture-only'));
 }finally{await h.close();for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
test('Revoca dispositivo: fallimento chiusura sessioni restituisce esito parziale esplicito',async()=>{
 const h=await harness();try{
 let deleted=false;const id=randomUUID();h.setIdentityRequest(async(path:string,method='GET')=>{if(path.endsWith('/credentials'))return {body:[{id,type:'eulab-trusted-device'}]};if(path.endsWith('/logout'))throw new Error('SSO logout offline');if(method==='DELETE')deleted=true;return {body:null};});
 const result=await h.request('/v1/security/devices/'+id,'DELETE');assert.equal(result.status,200);assert.equal(result.body.revoked,true);assert.equal(result.body.sessionsLoggedOut,false);assert.equal(deleted,true);
 }finally{await h.close();}
});
test('Sicurezza per utente: preferenze canoniche, isolamento e revoca MFA senza accesso alle password',async()=>{
 const h=await harness();try{
 const subject=randomUUID(),other=randomUUID(),calls:{path:string;method:string;body:any}[]=[];
 let attributes:any={existing:['preserved']},credentials=[{id:'app',type:'otp',secretData:'hidden-secret'},{id:'trusted',type:'eulab-trusted-device',secretData:'hidden-secret'},{id:'password',type:'password',secretData:'hidden-secret'}];
 h.setIdentityRequest(async(path:string,method='GET',body?:any)=>{
  calls.push({path,method,body});
  if(path.endsWith('/logout'))return {body:null};
  if(path.endsWith('/credentials'))return {body:credentials};
  if(method==='DELETE'){credentials=credentials.filter(c=>!path.endsWith('/'+c.id));return {body:null};}
  if(method==='PUT')attributes=body.attributes;
  return {body:{id:subject,firstName:"Nome preservato",emailVerified:true,attributes}};
 });
 const user={Authorization:'Bearer '+await h.token(subject,[])};
 assert.equal((await h.request('/v1/security/users/'+other,'GET',undefined,user)).status,403);
 assert.equal((await h.request('/v1/security/users/'+other+'/preferences','PUT',{preferredMethod:'email'},user)).status,403);
 assert.equal((await h.request('/v1/security/users/'+other+'/credentials/app','DELETE',undefined,user)).status,403);
 assert.equal((await h.request('/v1/security/me/preferences','PUT',{preferredMethod:'none'},user)).status,400);
 assert.equal((await h.request('/v1/security/me/preferences','PUT',{preferredMethod:'email',subject:other},user)).status,400);
 const own=await h.request('/v1/security/me/preferences','PUT',{preferredMethod:'email'},user);assert.equal(own.body.preferredMethod,'email');assert.deepEqual(attributes.existing,['preserved']);assert.equal(calls.find(c=>c.method==='PUT')?.body.firstName,'Nome preservato');assert(calls.some(c=>c.path===`/users/${subject}`&&c.method==='PUT'));
 const state=await h.request('/v1/security/users/'+subject);assert.equal(state.body.authenticators[0].id,'app');assert(!JSON.stringify(state.body).includes('hidden-secret'));
 assert.equal((await h.request(`/v1/security/users/${subject}/credentials/password`,'DELETE')).status,404);
 const removed=await h.request(`/v1/security/users/${subject}/credentials/app`,'DELETE');assert.equal(removed.body.sessionsLoggedOut,true);assert.deepEqual(credentials.map(c=>c.id),['password']);assert(calls.some(c=>c.path===`/users/${subject}/logout`));
 assert(!JSON.stringify(await h.store.query('SELECT detail FROM audit')).includes('hidden-secret'));
 }finally{await h.close();}
});
