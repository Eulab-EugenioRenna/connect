import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {harness} from './harness.mjs';
test('API HTTP: JWT verificato, revoca SSO, collegamento atomico e accesso tecnico monouso',async()=>{
 const h=await harness();try{
 assert.equal((await h.request('/v1/health','GET',undefined,{Authorization:''})).status,200);
 assert.equal((await h.request('/v1/overview','GET',undefined,{Authorization:''})).status,401);
 const userToken=await h.token('customer',[]);
 assert.equal((await h.request('/v1/overview','GET',undefined,{Authorization:`Bearer ${userToken}`})).status,403);
 assert.equal((await h.request('/v1/overview','GET',undefined,{Authorization:'Bearer invalid'})).status,401);
 assert.equal((await h.request('/v1/sso-identities','GET',undefined,{Authorization:`Bearer ${userToken}`})).status,403);
 assert.equal((await h.request('/v1/sso-identities','POST',{username:'new-user',email:'new@example.test',displayName:'Nuovo',userType:'admin',password:'short',temporaryPassword:true})).status,400);
 const c=(await h.request('/v1/customers','POST',{name:'Cliente HTTP'})).body;
 const connected=await h.request('/v1/application-connections','POST',{name:'Sito WordPress',description:'Sito principale',customerId:c.id,domain:'https://wp.example',integration:'wordpress',basePath:'/blog'});
 assert.equal(connected.status,201);const i=connected.body;assert.equal(i.fallbackUrl,'https://wp.example/blog/eulab/connect/functions');
 const overview=await h.request('/v1/overview');assert.equal(overview.body.installations[0].integration,'wordpress');assert(!JSON.stringify(overview).includes(i.secret));
 const invalid=await h.request('/v1/application-connections','POST',{name:'Esterno',customerId:c.id,domain:'https://wp.example',integration:'web',fallbackUrl:'https://evil.example/functions'});assert.equal(invalid.status,400);
 assert.equal((await h.request('/v1/overview')).body.applications.length,1);
 const context=await h.request('/v1/context','GET',undefined,{'X-Installation-Id':i.installationId,'X-Installation-Secret':'wrong',Authorization:''});assert.equal(context.status,401);
 const pluginHeaders={'X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret,Authorization:''};
 assert.equal((await h.request('/v1/wordpress/users/sync','POST',{generation:randomUUID(),start:true,complete:true,users:[{id:'2',username:'marco.rossi',displayName:'Marco Rossi',email:'marco@example.test',roles:['administrator']}]},pluginHeaders)).status,201);
 const ticket=(await h.request('/v1/technical/tickets','POST',{installationId:i.installationId,localUserId:'2'})).body;assert.equal(ticket.technicalUrl,'https://wp.example/blog/?eulab_technical=1');
 const serverHeaders={'X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret,Authorization:''};
 const accessAs={localUserId:'2',localUsername:'marco.rossi'};
 assert.equal((await h.request('/v1/technical/access-as','POST',accessAs,serverHeaders)).status,403);
 assert.equal((await h.request('/v1/technical/access-as','POST',accessAs)).status,403);
 const operatorHeaders={'X-Installation-Id':i.installationId,'X-Installation-Secret':i.secret};
 assert.equal((await h.request('/v1/technical/access-as','POST',accessAs,{...operatorHeaders,Authorization:`Bearer ${userToken}`})).status,403);
 const technicianToken=await h.token('technician',['eulab-technician']);
 assert.equal((await h.request('/v1/technical/access-as','POST',accessAs,{...operatorHeaders,Authorization:`Bearer ${technicianToken}`})).status,403);
 assert.equal((await h.request('/v1/technical/access-as','POST',{...accessAs,localUserId:'-1'},operatorHeaders)).status,400);
 const accessed=await h.request('/v1/technical/access-as','POST',accessAs,operatorHeaders);assert.equal(accessed.status,201);assert.equal(accessed.body.scope,'eulab-access-as');
 const entry=(await h.store.query("SELECT * FROM audit WHERE action='technical.access_as'"))[0];assert.equal(entry.actor,'operator');assert.equal(entry.target,i.installationId);assert.equal(entry.detail.localUserId,'2');
 assert.equal((await h.request('/v1/catalogs','POST',{version:1,features:[{key:'whatsapp',name:'WhatsApp'}],permissions:[]},serverHeaders)).status,410);
 assert.equal((await h.request('/v1/technical/redeem','POST',{ticket:ticket.ticket},serverHeaders)).status,201);
 assert.equal((await h.request('/v1/technical/redeem','POST',{ticket:ticket.ticket},serverHeaders)).status,401);
 const missingOrigin=await h.request('/v1/context','GET',undefined,{'X-Installation-Id':i.installationId,Authorization:`Bearer ${userToken}`});assert.equal(missingOrigin.status,401);
 h.setRevoked(true);assert.equal((await h.request('/v1/overview')).status,401);h.setRevoked(false);
 const archiveId=randomUUID(),sessionId=randomUUID();
 await h.store.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3)',[archiveId,i.installationId,'393331234567']);
 await h.store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'test-runner',$3,'393331234567','connected')",[sessionId,i.installationId,archiveId]);
 const mediaId=randomUUID();
 for(let index=0;index<60;index++)await h.store.query("INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body,occurred_at) VALUES($1,$2,$3,$4,'chat','in','image',$5,$6)",[index===59?mediaId:randomUUID(),sessionId,archiveId,`message-${index}`,JSON.stringify({text:'Storico',media:'data:image/png;base64,AAAA',mediaAvailable:true}),new Date(1000*index)]);
 const root=`/v1/installations/${i.installationId}/whatsapp`;
 const first=(await h.request(root+`/archives/${archiveId}/messages`)).body;assert.equal(first.length,50);assert.equal(first[0].body.media,undefined);
 const second=(await h.request(root+`/archives/${archiveId}/messages?before=${first.at(-1).id}`)).body;assert.equal(second.length,10);
 assert.equal((await h.request(root+`/archives/${archiveId}/conversations`)).body[0].messages,60);
 assert.equal((await h.request(root+`/archives/${archiveId}/messages/${mediaId}/media`)).body.data,'data:image/png;base64,AAAA');
 assert.equal((await h.request(root+`/archives/${randomUUID()}/messages/${mediaId}/media`)).status,404);
 const payloads=[{kind:'text',text:'Prova'},{kind:'poll',question:'Preferenza?',options:['Uno','Due']},...['image','document','audio','video'].map((kind,index)=>({kind,data:`data:${['image/png','application/pdf','audio/mpeg','video/mp4'][index]};base64,AAAA`,filename:'test.file'}))];
 for(const payload of payloads){const r=await h.request(root+`/sessions/${sessionId}/messages/test`,'POST',{...payload,to:'+39 333 1234567'});assert.equal(r.status,201);assert.equal(r.body.sent,false);assert.equal(r.body.to,'393331234567@c.us');}
 assert.equal((await h.store.query('SELECT * FROM outbox')).length,0);
 const recoveryJobs=[];h.setWhatsAppQueue(runner=>({add:async(name,data,options)=>{recoveryJobs.push({runner,name,data,options});}}));
 await h.store.query("INSERT INTO runners(id,capacity) VALUES('test-runner',2)");
 await h.store.query("UPDATE messages SET body=body-'media' WHERE id=$1",[mediaId]);
 const recovery=await h.request(root+`/archives/${archiveId}/messages/${mediaId}/media`);assert.equal(recovery.status,200);assert.equal(recovery.body.state,'queued');assert.equal(recovery.body.data,null);assert.equal(recoveryJobs[0].data.sessionId,sessionId);assert.equal(recoveryJobs[0].name,'recover-media');
 assert.equal((await h.request(root+`/archives/${randomUUID()}/messages/${mediaId}/media`)).status,404);assert.equal(recoveryJobs.length,1);
 await h.store.query("UPDATE wa_sessions SET state='disconnected' WHERE id=$1",[sessionId]);assert.equal((await h.request(root+`/archives/${archiveId}/messages/${mediaId}/media`)).status,404);assert.equal(recoveryJobs.length,1);

 assert.equal((await h.request(root+`/sessions/${sessionId}/messages/test`,'POST',{kind:'poll',to:'+39 333 1234567',question:'?',options:['Solo']})).status,400);
 assert.equal((await h.request(root+`/sessions/${randomUUID()}/messages/test`,'POST',{kind:'text',to:'+39 333 1234567',text:'Prova'})).status,404);
 assert.equal((await h.request(root+`/sessions/${sessionId}/messages`,'POST',{kind:'interactive',to:'393331234567@c.us',content:{type:'buttons',body:'Prova',actions:[{type:'reply',id:'yes',label:'Conferma'}]}},{'Idempotency-Key':'buttons-test-123'})).status,409);
 const docs=await h.request('/v1/docs-json');assert.equal(docs.status,200);const spec=docs.body;assert(spec.paths['/v1/application-connections']);assert(spec.paths['/v1/application-connections'].post.requestBody.content['application/json'].schema.properties.domain);
 }finally{await h.close();}
});

test('Admin CRUD, audit query e WhatsApp: revoche, isolamento e cancellazione differita dello storico',async()=>{
 const h=await harness();try{
 const c=(await h.request('/v1/customers','POST',{name:'Cliente CRUD'})).body;
 assert.equal((await h.request(`/v1/customers/${c.id}`,'PUT',{name:'Cliente aggiornato',reference:'test'})).status,200);
 const i=(await h.request('/v1/application-connections','POST',{id:'crud',name:'App CRUD',customerId:c.id,domain:'https://crud.example',integration:'web'})).body;
 assert.equal((await h.request('/v1/applications/crud','PUT',{name:'Nuovo nome',description:'Descrizione'})).status,200);
 assert.equal((await h.request(`/v1/customers/${c.id}`,'DELETE')).status,409);
 assert.equal((await h.request('/v1/applications/crud','DELETE')).status,409);
 assert.equal((await h.request(`/v1/installations/${i.installationId}`,'PUT',{enabled:true,domain:'https://updated.example',integration:'wordpress',basePath:'/blog'})).status,200);
 const installation=(await h.request('/v1/overview')).body.installations[0];assert.equal(installation.fallback_url,'https://updated.example/blog/eulab/connect/functions');
 assert.equal((await h.request(`/v1/installations/${i.installationId}`,'PUT',{enabled:true,fallbackUrl:'https://evil.example/x'})).status,400);
 assert.equal((await h.request(`/v1/installations/${i.installationId}`,'PUT',{enabled:true,description:'Aggiornamento'})).status,200);
 await h.request('/v1/licenses','PUT',{customerId:c.id,appId:'crud',state:'active',expiresAt:null,features:[],reason:'QA'});
 const role=(await h.request('/v1/roles','PUT',{customerId:c.id,appId:'crud',name:'Ruolo',permissions:[],reason:'QA'})).body;
 await h.request('/v1/identities','PUT',{subject:'person',displayName:'Persona',enabled:true});
 await h.request('/v1/memberships','PUT',{subject:'person',customerId:c.id,enabled:true,roleIds:[role.id]});
 assert.equal((await h.request(`/v1/roles/${role.id}`,'DELETE')).status,200);assert.equal((await h.store.query('SELECT * FROM assignments')).length,0);
 assert.equal((await h.request(`/v1/memberships/person/${c.id}`,'DELETE')).status,200);
 const root=`/v1/installations/${i.installationId}/whatsapp`,archive=randomUUID(),session=randomUUID(),message=randomUUID(),event=randomUUID(),endpoint=randomUUID();
 await h.store.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3)',[archive,i.installationId,'393331234567']);
 await h.store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'qa',$3,'393331234567','connected')",[session,i.installationId,archive]);
 await h.store.query("INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body) VALUES($1,$2,$3,'msg','393339999999@c.us','in','text','{\"text\":\"Ultimo messaggio\"}')",[message,session,archive]);
 const conversations=await h.request(root+`/archives/${archive}/conversations`);assert.equal(conversations.status,200);assert.equal(conversations.body[0].preview,'Ultimo messaggio');
 const send=await h.request(root+`/sessions/${session}/messages`,'POST',{kind:'text',to:'+39 333 1234567',text:'Prova'},{'Idempotency-Key':'phone-number-test'});assert.equal(send.status,201);
 assert.equal((await h.store.query('SELECT payload FROM outbox'))[0].payload.to,'393331234567@c.us');
 assert.equal((await h.request(root+`/sessions/${session}/messages`,'POST',{kind:'text',to:'numero sbagliato',text:'Prova'},{'Idempotency-Key':'invalid-phone-test'})).status,400);
 assert.equal((await h.request(`/v1/installations/${i.installationId}`,'DELETE')).status,409);
 await h.store.query("INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,'test','{}')",[event,i.installationId,session]);
 await h.store.query("INSERT INTO webhook_endpoints(id,installation_id,url,secret_cipher) VALUES($1,$2,'https://webhook.example','test')",[endpoint,i.installationId]);
 await h.store.query('INSERT INTO deliveries(id,event_id,endpoint_id) VALUES($1,$2,$3)',[randomUUID(),event,endpoint]);
 const other=(await h.request('/v1/installations','POST',{customerId:c.id,appId:'crud',domain:'https://other.example'})).body;
 const otherRoot=`/v1/installations/${other.id}/whatsapp`;
 assert.equal((await h.request(otherRoot+`/archives/${archive}`,'DELETE')).status,404);
 const removed=await h.request(root+`/sessions/${session}`,'DELETE');assert.equal(removed.status,200);assert.equal(removed.body.state,'disconnecting');
 assert.equal((await h.store.query('SELECT * FROM messages')).length,1);
 assert.equal((await h.store.query('SELECT * FROM wa_sessions'))[0].delete_requested,true);
 // Owning runner acknowledges authentication cleanup before the purge may complete.
 await h.store.query("UPDATE wa_sessions SET closed_at=now(),state='disconnected' WHERE id=$1",[session]);
 assert.equal((await h.request(root+`/archives/${archive}`,'DELETE')).body.removed,true);
 for(const table of ['messages','wa_sessions','wa_archives','outbox','events','deliveries'])assert.equal((await h.store.query(`SELECT * FROM ${table}`)).length,0,table);
 await h.store.query("INSERT INTO audit(actor,action,target,created_at) VALUES('old','old.action','old',now()-interval '2 hours')");
 const recent=await h.request('/v1/audit');assert(!recent.body.some(r=>r.actor==='old'));
 const expanded=await h.request('/v1/audit?from='+encodeURIComponent(new Date(Date.now()-10800000).toISOString())+'&actor=old&action=old.action&target=old');assert.equal(expanded.body.length,1);
 const paged=await h.request('/v1/audit?limit=2');assert.equal(paged.body.length,2);
 const next=await h.request('/v1/audit?limit=2&before='+paged.body[1].id);assert(next.body.every(r=>Number(r.id)<Number(paged.body[1].id)));
 assert.equal((await h.request('/v1/audit?from=invalid')).status,400);
 assert.equal((await h.request('/v1/audit?limit=201')).status,400);
 assert.equal((await h.request(`/v1/installations/${i.installationId}`,'DELETE')).status,200);
 assert.equal((await h.request(`/v1/installations/${other.id}`,'DELETE')).status,200);
 assert.equal((await h.request(`/v1/licenses/${c.id}/crud`,'DELETE')).status,200);
 assert.equal((await h.request('/v1/applications/crud','DELETE')).status,200);
 assert.equal((await h.request(`/v1/customers/${c.id}`,'DELETE')).status,200);
 assert((await h.store.query("SELECT * FROM audit WHERE action='customer.delete'")).length);
 }finally{await h.close();}
});

test('SSO admin: configurazione condivisa, sync timeout app e protezione autoeliminazione',async()=>{
 const h=await harness(),baseFetch=globalThis.fetch;const previousSecret=process.env.OIDC_IDENTITY_ADMIN_SECRET;process.env.OIDC_IDENTITY_ADMIN_SECRET='test-management-secret';
 const realm={accessTokenLifespan:300,ssoSessionIdleTimeout:1800,ssoSessionMaxLifespan:36000};
 const clients=[{id:'admin',clientId:'connect-admin',standardFlowEnabled:true,redirectUris:['https://admin.example/'],attributes:{'access.token.lifespan':'999',custom:'keep'}},{id:'wp',clientId:'connect-wordpress',standardFlowEnabled:true,attributes:{}},{id:'service',clientId:'service',standardFlowEnabled:false,attributes:{}}];
 globalThis.fetch=async(input,options={})=>{
  const url=String(input),method=options.method||'GET';
  if(url.endsWith('/protocol/openid-connect/token')&&String(options.body).includes('client_credentials'))return Response.json({access_token:'management',expires_in:60});
  if(url.endsWith('/admin/realms/eulab')){if(method==='PUT'){Object.assign(realm,JSON.parse(options.body));return new Response(null,{status:204});}return Response.json(realm);}
  if(url.endsWith('/admin/realms/eulab/clients?max=1000'))return Response.json(clients);
  const client=clients.find(c=>url.endsWith('/admin/realms/eulab/clients/'+c.id));if(client&&method==='PUT'){Object.assign(client,JSON.parse(options.body));return new Response(null,{status:204});}
  return baseFetch(input,options);
 };
 try{
  const settings=await h.request('/v1/sso-settings');assert.equal(settings.status,200);assert.equal(settings.body.clients.length,2);assert.equal(settings.body.clients[0].overrides['access.token.lifespan'],'999');
  const token=await h.token('user',[]);assert.equal((await h.request('/v1/sso-settings','GET',undefined,{Authorization:`Bearer ${token}`})).status,403);
  assert.equal((await h.request('/v1/sso-settings','PUT',{accessTokenLifespan:600,ssoSessionIdleTimeout:300,ssoSessionMaxLifespan:36000,syncClients:true})).status,400);
  const saved=await h.request('/v1/sso-settings','PUT',{accessTokenLifespan:120,ssoSessionIdleTimeout:900,ssoSessionMaxLifespan:7200,syncClients:true});assert.equal(saved.status,200);assert.equal(saved.body.failed.length,0);assert.deepEqual(saved.body.synced,['connect-admin','connect-wordpress']);assert.equal(clients[0].attributes.custom,'keep');assert.equal(clients[0].attributes['access.token.lifespan'],undefined);assert.equal(realm.ssoSessionIdleTimeout,900);
  const subject='12345678-1234-4234-8234-123456789abc',own=await h.token(subject,['eulab-admin']);
  assert.equal((await h.request('/v1/sso-identities/'+subject,'DELETE',undefined,{Authorization:`Bearer ${own}`})).status,403);
 }finally{globalThis.fetch=baseFetch;if(previousSecret===undefined)delete process.env.OIDC_IDENTITY_ADMIN_SECRET;else process.env.OIDC_IDENTITY_ADMIN_SECRET=previousSecret;await h.close();}
});

test('WordPress: elenco admin filtrato, snapshot completo atomico e ticket legato al solo utente scelto',async()=>{
 const h=await harness();try{
  const c=(await h.request('/v1/customers','POST',{name:'Directory WP'})).body;
  const one=(await h.request('/v1/application-connections','POST',{id:'directory',name:'WordPress',customerId:c.id,domain:'https://directory.example',integration:'wordpress'})).body;
  const two=(await h.request('/v1/installations','POST',{customerId:c.id,appId:'directory',domain:'https://other.example',integration:'wordpress'})).body;
  const headers={'X-Installation-Id':one.installationId,'X-Installation-Secret':one.secret,Authorization:''};
  const otherHeaders={'X-Installation-Id':two.id,'X-Installation-Secret':two.secret,Authorization:''};
  const root=`/v1/installations/${one.installationId}/wordpress`,generation=randomUUID();
  const users=Array.from({length:25},(_,index)=>({id:String(index+1),username:'user'+(index+1),displayName:'Utente '+String(index+1).padStart(2,'0'),email:`user${index+1}@example.test`,roles:[index<2?'administrator':index===2?'editor':'subscriber']}));
  assert.equal((await h.request('/v1/wordpress/users/sync','POST',{generation,start:true,users})).status,403);
  assert.equal((await h.request('/v1/wordpress/users/sync','POST',{generation,start:true,users:[{...users[0],password:'forbidden'}]},headers)).status,400);
  assert.equal((await h.request('/v1/wordpress/users/sync','POST',{generation,start:true,users:[{...users[0],roles:['eulab_technician']}]},headers)).status,400);
  assert.equal((await h.request('/v1/wordpress/users/sync','POST',{generation,start:true,users},headers)).status,201);
  assert.equal((await h.request(root+'/users')).body.total,0); // partial generation is not visible
  assert.equal((await h.request('/v1/wordpress/users/sync','POST',{generation,complete:true,users:[]},headers)).status,201);
  const list=(await h.request(root+'/users')).body;assert.equal(list.total,25);assert.equal(list.items.length,20);assert(list.syncedAt);assert.equal(list.syncing,false);
  assert.equal((await h.request(root+'/users?page=2')).body.items.length,5);
  assert.equal((await h.request(root+'/users?role=administrator')).body.total,2);
  assert.equal((await h.request(root+'/users?search=user3%40example.test')).body.total,1);
  assert.equal((await h.request(root+'/users?page=0')).status,400);
  const ordinary=await h.token('customer',[]),technician=await h.token('technician',['eulab-technician']);
  assert.equal((await h.request(root+'/users','GET',undefined,{Authorization:`Bearer ${ordinary}`})).status,403);
  assert.equal((await h.request(`/v1/installations/${two.id}/wordpress/users`)).body.total,0);
  assert.equal((await h.request('/v1/technical/tickets','POST',{installationId:one.installationId})).status,403);
  assert.equal((await h.request('/v1/technical/tickets','POST',{installationId:one.installationId,localUserId:'999'})).status,403);
  assert.equal((await h.request('/v1/technical/tickets','POST',{installationId:one.installationId,localUserId:'3'},{Authorization:`Bearer ${technician}`})).status,403);
  const ticket=(await h.request('/v1/technical/tickets','POST',{installationId:one.installationId,localUserId:'3'})).body;
  assert.equal((await h.request('/v1/technical/redeem','POST',{ticket:ticket.ticket},otherHeaders)).status,401);
  assert.equal((await h.request('/v1/technical/redeem','POST',{ticket:ticket.ticket,localUserId:'1'},headers)).status,400);
  const redeemed=await h.request('/v1/technical/redeem','POST',{ticket:ticket.ticket},headers);assert.equal(redeemed.status,201);assert.equal(redeemed.body.localUserId,'3');assert.equal(redeemed.body.scope,'eulab-wordpress-user');
  assert.equal((await h.request('/v1/technical/redeem','POST',{ticket:ticket.ticket},headers)).status,401);
  const adminPlugin={...headers,Authorization:undefined};delete adminPlugin.Authorization;
  assert.equal((await h.request('/v1/technical/access-as','POST',{localUserId:'3',localUsername:'wrong'},adminPlugin)).status,403);
  assert.equal((await h.request('/v1/technical/access-as','POST',{localUserId:'3',localUsername:'user3'},adminPlugin)).status,201);
  const next=randomUUID();await h.request('/v1/wordpress/users/sync','POST',{generation:next,start:true,users:users.slice(0,2)},headers);
  assert.equal((await h.request(root+'/users')).body.total,25); // previous complete version remains available
  assert.equal((await h.request('/v1/wordpress/users/sync','POST',{generation,complete:true,users:[]},headers)).status,409);
  await h.request('/v1/wordpress/users/sync','POST',{generation:next,complete:true,users:[]},headers);
  assert.equal((await h.request(root+'/users')).body.total,2);
  assert.equal((await h.request('/v1/technical/tickets','POST',{installationId:one.installationId,localUserId:'3'})).status,403);
  await h.request(root+'/sync','POST');assert.equal((await h.request('/v1/wordpress/sync-status','GET',undefined,headers)).body.requested,true);
  assert((await h.store.query("SELECT * FROM audit WHERE action='technical.ticket.issue'" )).some(a=>a.detail.localUserId==='3'));
 }finally{await h.close();}
});
