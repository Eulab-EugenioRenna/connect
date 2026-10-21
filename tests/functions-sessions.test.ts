import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
// @ts-ignore JavaScript harness
import {harness} from './harness.mjs';
import {SessionsService} from '../apps/api/src/sessions.service.js';
import {defineFunctions} from '../packages/sdk/src/functions.js';
import {isPublicCatalogAddress,CatalogReader} from '../apps/api/src/catalog-reader.js';
test('Matrice acquisita via GET: versione, revoche, accesso e utenze isolate',async()=>{
 const h=await harness();try{
 const customer=(await h.request('/v1/customers','POST',{name:'Matrice'})).body;
 const i=(await h.request('/v1/application-connections','POST',{id:'matrix',name:'Matrix',customerId:customer.id,domain:'https://matrix.example',integration:'web'})).body;
 let document=defineFunctions({appId:'matrix',version:1,functions:[{key:'users.read',name:'Utenti'},{key:'whatsapp.send',name:'Invia messaggi'}]});let reads=0;
 h.setCatalogReader(async(url:string)=>{reads++;assert.equal(url,'https://matrix.example/.well-known/eulab-connect.json');return structuredClone(document);});
 const sync=()=>h.request('/v1/applications/matrix/catalog-sync','POST');
 assert.equal((await sync()).body.ok,true);assert.equal(reads,1);
 assert.equal((await sync()).body.changed,false);
 assert.equal((await h.store.query('SELECT catalog_version FROM applications'))[0].catalog_version,1);
 document.functions[0].name='Cambio illecito';assert.equal((await sync()).body.ok,false);
 assert.equal((await h.request('/v1/applications/matrix/functions')).body.functions.find((f:any)=>f.key==='users.read').name,'Utenti');document.functions[0].name='Utenti';
 assert.equal((await h.request('/v1/applications/matrix/catalog-source','PUT',{url:'https://evil.example/matrix'})).status,400);
 const subject=randomUUID(),foreign=randomUUID(),role=randomUUID();
 await h.store.query('INSERT INTO identities VALUES($1,$2,true),($3,$4,true)',[subject,'Locale',foreign,'Esterno']);
 await h.store.query('INSERT INTO memberships VALUES($1,$2,true)',[subject,customer.id]);
 await h.store.query('INSERT INTO local_links VALUES($1,$2,$3)',[i.installationId,'7',subject]);
 await h.store.query("INSERT INTO roles VALUES($1,$2,'matrix','Lettore')",[role,customer.id]);
 await h.store.query("INSERT INTO assignments VALUES($1,$2,'matrix',$3)",[subject,customer.id,role]);
 await h.store.query("INSERT INTO role_permissions VALUES($1,'matrix','users.read')",[role]);
 const plan={customerId:customer.id,appId:'matrix',state:'active',expiresAt:null,features:document.functions.map(f=>({key:f.key,purchased:true,enabled:true})),reason:'Collaudo'};
 assert.equal((await h.request('/v1/licenses','PUT',plan)).status,200);
 const headers={Authorization:`Bearer ${await h.token(subject,[])}`,'X-Installation-Id':i.installationId,Origin:'https://matrix.example'};
 h.setCatalogReader(async()=>{throw new Error('Sync temporaneamente indisponibile');});assert.equal((await sync()).body.ok,false);
 const access=(await h.request('/v1/access','GET',undefined,headers)).body;assert.equal((await h.request('/v1/access','GET',undefined,{...headers,Origin:'',Referer:'https://matrix.example/app/'})).body.canLogin,true);assert.equal((await h.request('/v1/access','GET',undefined,{...headers,Origin:'',Referer:'https://evil.example/'})).status,401);
 assert.equal(access.canLogin,true);assert.equal(access.functionsStatus,'last_valid');assert.deepEqual(access.functions.map((f:any)=>f.key),['users.read']);
 const users=(await h.request('/v1/users','GET',undefined,headers)).body;assert.deepEqual(users.map((u:any)=>u.subject),[subject]);assert.equal(users[0].localUserId,'7');
 assert.equal((await h.request('/v1/authorize','POST',{installationId:i.installationId,permission:'whatsapp.send'},headers)).body.allowed,false);
 await h.request('/v1/licenses','PUT',{...plan,state:'suspended'});assert.equal((await h.request('/v1/access','GET',undefined,headers)).body.canLogin,false);assert.equal((await h.request('/v1/users','GET',undefined,headers)).status,403);
 await h.request('/v1/licenses','PUT',plan);
 h.setCatalogReader(async()=>structuredClone(document));
 document={...document,version:2,functions:[]};assert.equal((await sync()).body.ok,true);assert.deepEqual((await h.request('/v1/access','GET',undefined,headers)).body.functions,[]);
 document={...document,version:3,functions:[{key:'users.read',name:'Utenti'}]};await sync();assert.deepEqual((await h.request('/v1/access','GET',undefined,headers)).body.functions,[]);
 assert.equal((await h.store.query('SELECT * FROM role_permissions')).length,0);
 }finally{await h.close();}
});
test('Sessioni SSO: isolamento, chiusura singola e totale, piano limitato agli utenti collegati',async()=>{
 const h=await harness();try{
 const subject=randomUUID(),other=randomUUID(),id=randomUUID(),foreign=randomUUID();const calls:any[]=[];
 h.setIdentityRequest(async(path:string,method='GET')=>{calls.push({path,method});if(path===`/users/${subject}/sessions`)return {body:[{id,userId:subject,username:'Cliente',start:1000,lastAccess:2000,clients:{web:'connect-demo'}}]};if(path==='/client-session-stats')return {body:[{id:'web',active:'1'}]};if(path.startsWith('/clients/web/'))return {body:[{id,userId:subject,username:'Cliente',start:1000,lastAccess:2000,clients:{web:'connect-demo'}}]};return {body:null};});
 const headers={Authorization:`Bearer ${await h.token(subject,[])}`};
 assert.equal((await h.request('/v1/sessions','GET',undefined,headers)).body.sessions[0].subject,subject);
 assert.equal((await h.request('/v1/sessions?subject='+other,'GET',undefined,headers)).status,403);
 assert.equal((await h.request(`/v1/sessions/${foreign}/logout`,'POST',undefined,headers)).status,404);assert(!calls.some(c=>c.path===`/sessions/${foreign}`));
 assert.equal((await h.request(`/v1/sessions/${id}/logout`,'POST',undefined,headers)).status,201);
 assert(calls.some(c=>c.path===`/sessions/${id}`&&c.method==='DELETE'));
 assert.equal((await h.request('/v1/sessions/logout-all','POST',undefined,headers)).status,201);assert(calls.some(c=>c.path===`/users/${subject}/logout`));
 assert.equal((await h.request('/v1/sessions')).body.sessions.length,1);
 const c=(await h.request('/v1/customers','POST',{name:'Piano'})).body;
 const i=(await h.request('/v1/application-connections','POST',{id:'sessions',name:'Sessioni',customerId:c.id,domain:'https://sessions.example',integration:'web'})).body;
 await h.store.query('INSERT INTO identities VALUES($1,$2,true),($3,$4,true)',[subject,'Collegato',other,'Non collegato']);
 await h.store.query('INSERT INTO memberships VALUES($1,$3,true),($2,$3,true)',[subject,other,c.id]);await h.store.query('INSERT INTO local_links VALUES($1,$2,$3)',[i.installationId,'9',subject]);
 const result=await h.request('/v1/licenses','PUT',{customerId:c.id,appId:'sessions',state:'suspended',expiresAt:null,features:[],reason:'Cambio piano',revokeSessions:true});assert.equal(result.body.saved,true);assert.deepEqual(result.body.sessions.completed,[subject]);assert(!calls.some(c=>c.path===`/users/${other}/logout`));
 h.setIdentityRequest(async()=>{throw new Error('SSO offline');});const partial=await h.request('/v1/licenses','PUT',{customerId:c.id,appId:'sessions',state:'active',expiresAt:null,features:[],reason:'Ripristino',revokeSessions:true});assert.equal(partial.status,200);assert.deepEqual(partial.body.sessions.failed,[subject]);assert.equal((await h.store.query('SELECT state FROM licenses'))[0].state,'active');
 }finally{await h.close();}
});
test('Matrice SDK e protezione destinazioni del GET',async()=>{
 assert.throws(()=>defineFunctions({appId:'demo',version:1,functions:[{key:'a',name:'A'},{key:'a',name:'A'}]}));
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','::1'])assert.equal(isPublicCatalogAddress(address),false);assert.equal(isPublicCatalogAddress('8.8.8.8'),true);
 const reader=new CatalogReader();await assert.rejects(()=>reader.read('http://example.com/matrix'),/HTTPS/);await assert.rejects(()=>reader.read('https://127.0.0.1/matrix'),/non consentita/);
});
test('GET reale della matrice: mapping locale, nessun redirect e limite JSON',async(t)=>{
 const {createServer}=await import('node:http');const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/matrix'});res.end();return;}res.setHeader('content-type','application/json');res.end(req.url==='/large'?'x'.repeat(1048577):JSON.stringify({schemaVersion:1,appId:'real',version:1,functions:[]}));});
 const previous=process.env.CATALOG_INTERNAL_ORIGINS_JSON;
 try{try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Socket locale vietato dal sandbox: eseguire il test in Docker');return;}throw error;}const address=server.address();assert(address&&typeof address==='object');process.env.CATALOG_INTERNAL_ORIGINS_JSON=JSON.stringify({'http://fixture.test':`http://127.0.0.1:${address.port}`});const reader=new CatalogReader();assert.equal((await reader.read('http://fixture.test/matrix') as any).appId,'real');await assert.rejects(()=>reader.read('http://fixture.test/redirect'),/302/);await assert.rejects(()=>reader.read('http://fixture.test/large'),/grande/);}finally{if(previous===undefined)delete process.env.CATALOG_INTERNAL_ORIGINS_JSON;else process.env.CATALOG_INTERNAL_ORIGINS_JSON=previous;await new Promise<void>(r=>server.close(()=>r()));}
});
test('Protezione MU: chiave dedicata, stop persistente, isolamento e sospensione installazione',async()=>{
 const h=await harness();try{
 const c=(await h.request('/v1/customers','POST',{name:'Guardian'})).body;const i=(await h.request('/v1/application-connections','POST',{id:'guardian',name:'Guardian',customerId:c.id,domain:'https://guardian.example',integration:'wordpress'})).body;
 const root='/v1/wordpress-guardians/'+i.installationId;const enrolled=await h.request(root,'POST');assert.equal(enrolled.status,201);const secret=enrolled.body.secret;
 const check=(key=secret,status='active')=>h.request(root+'/check','POST',{status},{Authorization:'','X-Guardian-Secret':key});
 assert.equal((await check('bad-key')).status,401);assert.equal((await check()).body.enabled,true);assert(!JSON.stringify((await h.request(root)).body).includes(secret));
 await h.request(root,'PUT',{enabled:false});
 assert.equal((await h.request('/v1/access','GET',undefined,{'X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret})).status,403);assert.equal((await h.request('/v1/technical/tickets','POST',{installationId:i.installationId,localUserId:'1'})).status,403);
 assert.equal((await check()).body.enabled,false);assert.equal((await check()).body.enabled,false);
 await h.request(root,'PUT',{enabled:true});assert.equal((await check(secret,'repaired')).body.enabled,true);assert.equal((await h.request(root)).body.repairs,1);
 await h.request(`/v1/installations/${i.installationId}`,'PUT',{enabled:false});assert.equal((await check()).body.enabled,false);
 await h.request(root,'POST');assert.equal((await check()).status,401);
 const token=await h.token(randomUUID(),[]);assert.equal((await h.request(root,'PUT',{enabled:true},{Authorization:`Bearer ${token}`})).status,403);
 }finally{await h.close();}
});
test('Login SSO WordPress: collegamento esplicito dal nome selezionato, nessuna sostituzione implicita',async()=>{
 const h=await harness();try{
 const c=(await h.request('/v1/customers','POST',{name:'SSO WP'})).body;const i=(await h.request('/v1/application-connections','POST',{id:'wp-sso',name:'SSO WP',customerId:c.id,domain:'https://sso-wp.example',integration:'wordpress'})).body;
 await h.request('/v1/identities','PUT',{subject:'operator',displayName:'Admin',enabled:true});await h.request('/v1/identities','PUT',{subject:'other',displayName:'Altro',enabled:true});
 await h.request('/v1/wordpress/users/sync','POST',{generation:randomUUID(),start:true,complete:true,users:[{id:'3',username:'giulia.bianchi',displayName:'Giulia',email:'',roles:['administrator']}]},{Authorization:'','X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret});
 const path=`/v1/installations/${i.installationId}/wordpress/users/3/sso-link`;
 assert.equal((await h.request(path,'PUT',{subject:'operator',enableMembership:true})).status,200);
 const headers={'X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret};assert.equal((await h.request('/v1/context','GET',undefined,headers)).body.localUserId,'3');
 assert.equal((await h.request(path,'PUT',{subject:'other',enableMembership:true})).status,409);assert.equal((await h.request(path.replace('/users/3/','/users/999/'),'PUT',{subject:'other',enableMembership:true})).status,404);
 assert.equal((await h.request(`/v1/installations/${i.installationId}/wordpress/users`)).body.items[0].link.display_name,'Admin');assert.equal((await h.store.query('SELECT * FROM identities')).length,2);
 }finally{await h.close();}
});
