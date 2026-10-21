import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {CatalogService} from '../apps/api/src/catalog.service.js';
import {Database} from '../apps/api/src/database.js';
import {AdminController} from '../apps/api/src/admin.controller.js';
import {ConnectorsController} from '../apps/api/src/connectors.controller.js';
import {WhatsAppService} from '../apps/api/src/whatsapp.service.js';
import {Authorization} from '../apps/api/src/authorization.js';
import {RequestContext} from '../apps/api/src/auth.js';
process.env.DATA_ENCRYPTION_KEY='a'.repeat(64);
const req:RequestContext={headers:{},principal:{admin:true,technician:true,server:false,subject:'operator',accessToken:'test-access-token'}};
async function setup(){
 const pg=new PGlite();await pg.exec(await readFile('infra/postgres/001-connect.sql','utf8'));await pg.exec(await readFile('infra/postgres/004-function-sources.sql','utf8'));await pg.exec(await readFile('infra/postgres/005-wordpress-guardian.sql','utf8'));
 const store={query:async(sql:string,params:unknown[]=[])=> (await pg.query(sql,params)).rows,
 transaction:async(fn:any)=>pg.transaction(async tx=>fn({query:async(sql:string,params:unknown[]=[])=>{const r=await tx.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};}}))} as unknown as Database;
 return {catalogs:new CatalogService(store),pg,store,admin:new AdminController(store,new CatalogService(store)),auth:new Authorization(store)};
}
test('Catalogo, licenza, membership, link esplicito e revoche: catena SQL completa',async()=>{
 const {catalogs,pg,store,admin,auth}=await setup();try{
 const c=await admin.customer({name:'Cliente A'},req);await admin.app({id:'demo',name:'Demo'},req);
 await catalogs.publish('demo',{version:1,features:[{key:'whatsapp',name:'WhatsApp'}],permissions:[{key:'whatsapp.send',name:'Invia',feature:'whatsapp'}]},req.principal.subject!);
 const i=await admin.installation({customerId:c.id,appId:'demo',domain:'https://a.example'},req);
 assert(!JSON.stringify(await admin.overview()).includes(i.secret));
 await admin.identity({subject:'person',displayName:'Persona',enabled:true},req);
 const p={admin:false,technician:false,server:true,subject:'person',installationId:i.id};
 assert.equal((await auth.check(p,i.id,'whatsapp.send')).allowed,false);
 await admin.license({customerId:c.id,appId:'demo',state:'active',expiresAt:null,features:[{key:'whatsapp',purchased:true,enabled:true}],reason:'Acquisto manuale'},req);
 const role=await admin.role({customerId:c.id,appId:'demo',name:'Operatore',permissions:['whatsapp.send'],reason:'Assegnazione esplicita'},req);
 await admin.membership({subject:'person',customerId:c.id,enabled:true,roleIds:[role.id]},req);
 assert.equal((await auth.check(p,i.id,'whatsapp.send')).reason,'identity_not_linked');
 await admin.link({installationId:i.id,localUserId:'42',subject:'person'},req);assert.equal((await auth.check(p,i.id,'whatsapp.send')).allowed,true);
 const second=await admin.installation({customerId:c.id,appId:'demo',domain:'https://b.example'},req);
 assert.equal((await auth.check(p,second.id,'whatsapp.send')).allowed,false);
 await catalogs.publish('demo',{version:2,features:[{key:'whatsapp',name:'WhatsApp'},{key:'reports',name:'Report'}],permissions:[{key:'whatsapp.send',name:'Invia',feature:'whatsapp'},{key:'report.read',name:'Leggi report',feature:'reports'},{key:'whatsapp.new',name:'Nuovo permesso',feature:'whatsapp'}]},req.principal.subject!);
 assert.equal((await auth.check(p,i.id,'report.read')).allowed,false);assert.equal((await auth.check(p,i.id,'whatsapp.new')).allowed,false);
 assert.equal((await store.query("SELECT * FROM entitlements WHERE feature_key='reports'")).length,0);
 await admin.license({customerId:c.id,appId:'demo',state:'suspended',expiresAt:null,features:[],reason:'Sospensione'},req);
 assert.equal((await auth.check(p,i.id,'whatsapp.send')).reason,'license_inactive');assert.equal((await auth.check(req.principal,i.id,'whatsapp.send')).allowed,true);
 assert((await admin.audit()).length>=10);
 }finally{await pg.close();}
});
test('Ruoli di un altro cliente e cataloghi retrogradi non sono accettati; rollback atomico',async()=>{
 const {catalogs,pg,admin,store}=await setup();try{
 const a=await admin.customer({name:'A'},req),b=await admin.customer({name:'B'},req);await admin.app({id:'demo',name:'Demo'},req);
 const role=await admin.role({customerId:a.id,appId:'demo',name:'R',permissions:[],reason:'Creazione'},req);await admin.identity({subject:'u',displayName:'U',enabled:true},req);
 await assert.rejects(()=>admin.membership({subject:'u',customerId:b.id,enabled:true,roleIds:[role.id]},req));
 assert.equal((await store.query('SELECT * FROM memberships')).length,0);
 await catalogs.publish('demo',{version:1,features:[{key:'x',name:'X'}],permissions:[]},req.principal.subject!);
 await assert.rejects(()=>catalogs.publish('demo',{version:1,features:[{key:'x',name:'X'}],permissions:[]},req.principal.subject!));
 }finally{await pg.close();}
});
test('Codice monouso: dominio, consumo atomico e rotazione credenziali',async()=>{
 const {catalogs,pg,admin,store,auth}=await setup();try{
 const c=await admin.customer({name:'A'},req);await admin.app({id:'demo',name:'Demo'},req);const i=await admin.installation({customerId:c.id,appId:'demo',domain:'https://a.example'},req);
 const {code}=await admin.pairing(i.id,req),connectors=new ConnectorsController(store,auth,new CatalogService(store));
 await assert.rejects(()=>connectors.redeem({code,domain:'https://other.example'}));
 const paired=await connectors.redeem({code,domain:'https://a.example'});assert.equal(paired.installationId,i.id);assert.notEqual(paired.secret,i.secret);
 await assert.rejects(()=>connectors.redeem({code,domain:'https://a.example'}));
 }finally{await pg.close();}
});
test('Numero unico globale; riconnessione allo stesso archivio; isolamento nuovo dominio',async()=>{
 const {catalogs,pg,admin,store}=await setup();try{
 const c=await admin.customer({name:'A'},req);await admin.app({id:'demo',name:'Demo'},req);
 const a=await admin.installation({customerId:c.id,appId:'demo',domain:'https://a.example'},req),b=await admin.installation({customerId:c.id,appId:'demo',domain:'https://b.example'},req);
 const archiveA=randomUUID(),archiveB=randomUUID(),s1=randomUUID(),s2=randomUUID();
 await store.query('INSERT INTO wa_archives VALUES($1,$2,$3,now()),($4,$5,$3,now())',[archiveA,a.id,'39333',archiveB,b.id]);
 await store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'runner', $3,'39333','connected')",[s1,a.id,archiveA]);
 await assert.rejects(()=>store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'runner',$3,'39333','connected')",[s2,b.id,archiveB]));
 await store.query("INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body) VALUES($1,$2,$3,'provider-1','chat','in','text','{}')",[randomUUID(),s1,archiveA]);
 await store.query("UPDATE wa_sessions SET state='disconnected',closed_at=now() WHERE id=$1",[s1]);
 await store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'runner',$3,'39333','connected')",[s2,a.id,archiveA]);
 assert.equal((await store.query('SELECT * FROM messages WHERE archive_id=$1',[archiveA])).length,1);
 assert.equal((await store.query('SELECT * FROM messages WHERE archive_id=$1',[archiveB])).length,0);
 await store.query("INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body) VALUES($1,$2,$3,'provider-1','chat','in','text','{}') ON CONFLICT(archive_id,provider_id) DO NOTHING",[randomUUID(),s2,archiveA]);
 assert.equal((await store.query('SELECT * FROM messages')).length,1);
 const wa=new WhatsAppService(store);
 const one=await wa.enqueue(a.id,s2,{kind:'text',to:'39333@c.us',text:'Ciao'},'idem-12345',req.principal),two=await wa.enqueue(a.id,s2,{kind:'text',to:'39333@c.us',text:'Ciao'},'idem-12345',req.principal);
 assert.equal(one.id,two.id);assert.equal((await store.query('SELECT * FROM outbox')).length,1);
 await assert.rejects(()=>wa.enqueue(a.id,s2,{kind:'text',to:'39333@c.us',text:'Diverso'},'idem-12345',req.principal));
 await wa.onModuleDestroy();
 }finally{await pg.close();}
});
test('Import matrice: migra i gruppi storici senza perdere i diritti esistenti e senza concedere funzioni nuove',async()=>{
 const {catalogs,pg,store,admin,auth}=await setup();try{
 const c=await admin.customer({name:'Migrazione'},req);await admin.app({id:'legacy',name:'Legacy'},req);
 await catalogs.publish('legacy',{version:1,features:[{key:'whatsapp',name:'WhatsApp'}],permissions:[{key:'whatsapp.send',name:'Invia',feature:'whatsapp'}]},'operator');
 const i=await admin.installation({customerId:c.id,appId:'legacy',domain:'https://legacy.example'},req);
 await admin.identity({subject:'legacy-user',displayName:'Utente',enabled:true},req);
 const role=await admin.role({customerId:c.id,appId:'legacy',name:'Operatore',permissions:['whatsapp.send'],reason:'Collaudo'},req);
 await admin.membership({subject:'legacy-user',customerId:c.id,enabled:true,roleIds:[role.id]},req);await admin.link({installationId:i.id,localUserId:'1',subject:'legacy-user'},req);
 await admin.license({customerId:c.id,appId:'legacy',state:'active',expiresAt:null,features:[{key:'whatsapp',purchased:true,enabled:true}],reason:'Collaudo'},req);
 await catalogs.importMatrix('legacy','https://legacy.example/.well-known/eulab-connect.json',{schemaVersion:1,appId:'legacy',version:1,functions:[{key:'whatsapp.send',name:'Invia'},{key:'whatsapp.new',name:'Nuova'}]},'operator');
 const p={admin:false,technician:false,server:true,subject:'legacy-user',installationId:i.id};assert.equal((await auth.check(p,i.id,'whatsapp.send')).allowed,true);assert.equal((await auth.check(p,i.id,'whatsapp.new')).allowed,false);
 assert.equal((await store.query("SELECT * FROM entitlements WHERE feature_key='whatsapp.new'")).length,0);assert.equal((await store.query("SELECT active FROM features WHERE key='whatsapp'"))[0].active,false);
 }finally{await pg.close();}
});

test('Una licenza aziendale serve più persone con ruoli e revoche indipendenti',async()=>{
 const {pg,store,admin,auth,catalogs}=await setup();try{
 const c=await admin.customer({name:'Azienda condivisa'},req);await admin.app({id:'shared',name:'App condivisa'},req);
 await catalogs.publish('shared',{version:1,features:[{key:'read',name:'Lettura'}],permissions:[{key:'read',name:'Lettura',feature:'read'}]},'operator');
 const i=await admin.installation({customerId:c.id,appId:'shared',domain:'https://shared.example'},req);
 await admin.license({customerId:c.id,appId:'shared',state:'active',expiresAt:null,features:[{key:'read',purchased:true,enabled:true}],reason:'Licenza aziendale'},req);
 const role=await admin.role({customerId:c.id,appId:'shared',name:'Lettore',permissions:['read'],reason:'Ruolo condiviso'},req);
 for(const subject of ['anna','luca']){
  await admin.identity({subject,displayName:subject,enabled:true},req);
  await admin.membership({subject,customerId:c.id,enabled:true,roleIds:[role.id]},req);
  await admin.link({installationId:i.id,localUserId:subject,subject},req);
 }
 const principal=(subject:string)=>({admin:false,technician:false,server:false,subject,installationId:i.id});
 for(const subject of ['anna','luca'])assert.equal((await auth.check(principal(subject),i.id,'read')).allowed,true);
 assert.equal((await store.query('SELECT * FROM licenses')).length,1);
 await admin.membership({subject:'anna',customerId:c.id,enabled:false,roleIds:[role.id]},req);
 assert.equal((await auth.check(principal('anna'),i.id,'read')).reason,'membership_disabled');
 assert.equal((await auth.check(principal('luca'),i.id,'read')).allowed,true);
 await admin.license({customerId:c.id,appId:'shared',state:'suspended',expiresAt:null,features:[],reason:'Sospensione aziendale'},req);
 assert.equal((await auth.check(principal('luca'),i.id,'read')).reason,'license_inactive');
 }finally{await pg.close();}
});

test('Panoramica: anomalie reali, log recenti limitati e nessuna credenziale esposta',async()=>{
 const {pg,store,admin}=await setup();try{
 const c=await admin.customer({name:'Operazioni'},req);await admin.app({id:'ops',name:'Ops'},req);
 const i=await admin.installation({customerId:c.id,appId:'ops',domain:'https://ops.example'},req);
 await store.query("UPDATE applications SET catalog_sync_error='Sync fallita' WHERE id='ops'");
 await store.query("INSERT INTO wordpress_guardians(installation_id,secret_hash,status) VALUES($1,'secret-guardian','error')",[i.id]);
 const session=randomUUID();await store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,state) VALUES($1,$2,'test-runner','failed')",[session,i.id]);
 await store.query("INSERT INTO outbox(id,installation_id,session_id,idempotency_key,request_hash,payload,actor,authorization_cipher,state) VALUES($1,$2,$3,'test','hash','{}','operator','secret-outbox','uncertain')",[randomUUID(),i.id,session]);
 await store.query("INSERT INTO audit(actor,action,target) SELECT CASE WHEN n%2=0 THEN 'anna' ELSE 'luca' END,'test.action',n::text FROM generate_series(1,110) n");
 const result=await admin.overview();
 assert.equal(result.error_counts.reduce((n:number,r:any)=>n+r.count,0),4);
 assert.equal(result.recent_audit.length,100);assert.equal(result.recent_audit[0].target,'110');
 assert.deepEqual(new Set(result.recent_audit.map((r:any)=>r.actor)),new Set(['anna','luca']));
 assert(!JSON.stringify(result).includes('secret-guardian'));assert(!JSON.stringify(result).includes('secret-outbox'));assert(!JSON.stringify(result).includes(i.secret));
 await store.query("UPDATE applications SET catalog_sync_error=null WHERE id='ops'");await store.query("UPDATE wordpress_guardians SET enabled=false");await store.query("UPDATE wa_sessions SET closed_at=now()");await store.query("UPDATE outbox SET state='sent'");
 assert.equal((await admin.overview()).error_counts.reduce((n:number,r:any)=>n+r.count,0),0);
 }finally{await pg.close();}
});
