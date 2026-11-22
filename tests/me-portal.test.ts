import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {harness} from './harness.mjs';
import {entryUrl} from '../apps/api/src/me.controller.js';

test('Profilo personale: solo le app usabili, con il link di accesso, senza diritti admin',async()=>{
 const h=await harness();try{
 const q=(sql:string,args:unknown[]=[])=>h.store.query(sql,args);
 const me=randomUUID(),other=randomUUID(),customer=randomUUID(),closed=randomUUID();
 const ready=randomUUID(),first=randomUUID(),suspended=randomUUID(),stranger=randomUUID();
 h.setIdentityRequest(async()=>({body:{firstName:'Anna',lastName:'Neri',email:'anna@example.test',emailVerified:true}}));
 await q("INSERT INTO identities(subject,display_name) VALUES($1,'Anna Neri'),($2,'Altro')",[me,other]);
 await q("INSERT INTO customers(id,name) VALUES($1,'Salone Uno'),($2,'Salone Chiuso')",[customer,closed]);
 await q("INSERT INTO applications(id,name,description) VALUES('portal-a','App A','Agenda'),('portal-b','App B',''),('portal-c','App C','')");
 await q("INSERT INTO memberships(subject,customer_id) VALUES($1,$2),($1,$3)",[me,customer,closed]);
 const install=(id:string,c:string,app:string,domain:string)=>q("INSERT INTO installations(id,customer_id,app_id,domain,base_path,fallback_url,secret_hash) VALUES($1,$2,$3,$4,'/admin/',$4,'h')",[id,c,app,domain]);
 await install(ready,customer,'portal-a','https://a.example.test');
 await install(first,customer,'portal-b','https://b.example.test');
 await install(suspended,closed,'portal-c','https://c.example.test');
 await install(stranger,customer,'portal-c','https://d.example.test');
 await q("INSERT INTO licenses(customer_id,app_id,state) VALUES($1,'portal-a','active'),($1,'portal-b','active'),($2,'portal-c','suspended'),($1,'portal-c','active')",[customer,closed]);
 await q("INSERT INTO local_links(installation_id,local_user_id,subject) VALUES($1,'u1',$2)",[ready,me]);
 const role=randomUUID();await q("INSERT INTO roles(id,customer_id,app_id,name) VALUES($1,$2,'portal-b','Cassa')",[role,customer]);
 await q("INSERT INTO assignments(subject,customer_id,app_id,role_id) VALUES($1,$2,'portal-b',$3)",[me,customer,role]);
 const headers={Authorization:'Bearer '+await h.token(me,[])};
 const res=await h.request('/v1/me','GET',undefined,headers);
 assert.equal(res.status,200);assert.equal(res.body.admin,false);assert.equal(res.body.email,'anna@example.test');
 // Linked app ready, assigned-but-not-linked app on first access; suspended licence and app without role/link excluded.
 assert.deepEqual(res.body.applications.map((a:any)=>[a.appId,a.state,a.url]),[['portal-a','ready','https://a.example.test/admin/'],['portal-b','first_access','https://b.example.test/admin/']]);
 const empty=await h.request('/v1/me','GET',undefined,{Authorization:'Bearer '+await h.token(other,[])});
 assert.deepEqual(empty.body.applications,[]);
 // The portal never opens the admin console.
 assert.equal((await h.request('/v1/overview','GET',undefined,headers)).status,403);
 }finally{await h.close();}
});

test('Link di accesso: solo http(s), percorso dell’installazione',()=>{
 assert.equal(entryUrl('https://x.test','/admin/'),'https://x.test/admin/');
 assert.equal(entryUrl('x.test',''),'https://x.test/');
 assert.equal(entryUrl('javascript:alert(1)','/'),'');
});
