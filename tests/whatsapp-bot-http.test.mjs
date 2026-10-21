import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {harness} from './harness.mjs';
import {WhatsAppBotService} from '../dist/server/apps/api/src/whatsapp-bot.service.js';
import {Authorization} from '../dist/server/apps/api/src/authorization.js';
const definition={name:'Bot dell’app',trigger:'ASSISTENZA',sessionTimeoutMinutes:10,startNodeId:'menu',invalidReply:'Riprova',nodes:[{id:'menu',type:'menu',text:'Scegli',options:[{key:'1',label:'Richiesta',next:'question'}]},{id:'question',type:'question',text:'Descrivi la richiesta',next:'end'},{id:'end',type:'end',text:'Richiesta raccolta',outcome:'request'}]};
async function setup(h){
 const customer=(await h.request('/v1/customers','POST',{name:'Cliente Bot'})).body;
 const installation=(await h.request('/v1/application-connections','POST',{id:'bot-app',name:'App bot',customerId:customer.id,domain:'https://bot.example',integration:'web'})).body;
 const i=installation.installationId,archive=randomUUID(),session=randomUUID();
 await h.store.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3)',[archive,i,'393331111111']);
 await h.store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'test',$3,'393331111111','connected')",[session,i,archive]);
 return {i,archive,session,customer:customer.id,secret:installation.secret,root:`/v1/installations/${i}/whatsapp`,bot:`/v1/installations/${i}/whatsapp/archives/${archive}/bot`};
}
test('Bot API: simulazione senza QR, configurazione per numero, attivazione, revisioni e isolamento',async()=>{
 const h=await harness();try{
 const x=await setup(h);
 const preview=await h.request(x.root+'/bot/preview','POST',{definition,input:'assistenza'});assert.equal(preview.status,201);assert.equal(preview.body.sent,false);assert.equal(preview.body.state.nodeId,'menu');
 assert.equal((await h.request(x.root+'/bot/preview','POST',{definition,input:'0',state:{nodeId:'menu',history:['nonexistent'],answers:{}}})).status,400);
 assert.equal((await h.store.query('SELECT * FROM wa_bots')).length,0);assert.equal((await h.store.query('SELECT * FROM outbox')).length,0);
 const initial=await h.request(x.bot);assert.equal(initial.body.revision,0);assert.equal(initial.body.enabled,false);
 const saved=await h.request(x.bot,'PUT',{definition,expectedRevision:0});assert.equal(saved.status,200);assert.equal(saved.body.definition.trigger,'ASSISTENZA');assert.equal(saved.body.enabled,false);assert.equal(saved.body.revision,1);
 assert.equal((await h.request(x.bot,'PUT',{definition,expectedRevision:0})).status,409);
 assert.equal((await h.request(x.bot+'/activation','PUT',{enabled:true,expectedRevision:1})).body.enabled,true);
 assert.equal((await h.request(x.bot+'/activation','PUT',{enabled:false,expectedRevision:0})).status,400);
 const other=(await h.request('/v1/application-connections','POST',{id:'bot-other',name:'Altra',customerId:x.customer,domain:'https://other.example',integration:'web'})).body;
 assert.equal((await h.request(`/v1/installations/${other.installationId}/whatsapp/archives/${x.archive}/bot`)).status,404);
 assert.equal((await h.request(`/v1/installations/${other.installationId}/whatsapp/archives/${x.archive}/bot`,'PUT',{definition,expectedRevision:1})).status,404);
 await h.store.query("UPDATE wa_sessions SET state='disconnected' WHERE id=$1",[x.session]);
 assert.equal((await h.request(x.bot+'/activation','PUT',{enabled:true,expectedRevision:1})).status,409);
 assert.equal((await h.request(x.bot+'/activation','PUT',{enabled:false,expectedRevision:1})).body.enabled,false);
 assert.equal((await h.request(x.bot,'PUT',{definition:{...definition,startNodeId:'missing'},expectedRevision:1})).status,400);
 }finally{await h.close();}
});
test('Bot runtime: stato persistente, duplicati, scadenza, revoche e completamento webhook atomico',async()=>{
 const h=await harness();try{
 const x=await setup(h);await h.request(x.bot,'PUT',{definition,expectedRevision:0});await h.request(x.bot+'/activation','PUT',{enabled:true,expectedRevision:1});
 await h.store.query("INSERT INTO webhook_endpoints(id,installation_id,url,secret_cipher) VALUES($1,$2,'https://app.example/webhook','test')",[randomUUID(),x.i]);
 let runtime=new WhatsAppBotService(h.store,new Authorization(h.store));
 const [session]=await h.store.query('SELECT * FROM wa_sessions WHERE id=$1',[x.session]);
 async function receive(text,chat='393332222222@c.us',id=randomUUID(),age=0){
  const message={id,provider_id:id,chat_id:chat,text,occurred_at:new Date(Date.now()-age)};
  await h.store.transaction(tx=>runtime.receive(tx,session,message));return message;
 }
 await assert.rejects(()=>h.store.transaction(async tx=>{await runtime.receive(tx,session,{id:randomUUID(),provider_id:'rollback',chat_id:'393332222222@c.us',text:'ASSISTENZA',occurred_at:new Date()});throw new Error('rollback');}),/rollback/);assert.equal((await h.store.query('SELECT * FROM wa_bot_conversations')).length,0);
 await receive('ciao');await receive('ASSISTENZA','123@g.us');await receive('ASSISTENZA','393332222222@c.us',randomUUID(),180000);assert.equal((await h.store.query('SELECT * FROM outbox')).length,0);
 const start=await receive('ASSISTENZA');assert.equal((await h.store.query('SELECT state FROM wa_bot_conversations'))[0].state.nodeId,'menu');
 await receive('ASSISTENZA',start.chat_id,start.id);assert.equal((await h.store.query('SELECT * FROM outbox')).length,1);
 runtime=new WhatsAppBotService(h.store,new Authorization(h.store));await receive('1');assert.equal((await h.store.query('SELECT state FROM wa_bot_conversations'))[0].state.nodeId,'question');
 await receive('Errore di accesso');assert.equal((await h.store.query('SELECT * FROM wa_bot_conversations')).length,0);
 const complete=(await h.store.query("SELECT payload FROM events WHERE kind='bot.completed'"))[0];assert.deepEqual(complete.payload.answers,{menu:'1',question:'Errore di accesso'});assert.equal(complete.payload.outcome,'request');assert.equal(complete.payload.revision,1);assert.equal((await h.store.query("SELECT d.id FROM deliveries d JOIN events e ON e.id=d.event_id WHERE e.kind='bot.completed'")).length,1);
 const outbox=await h.store.query('SELECT * FROM outbox');assert.equal(outbox.length,3);assert(outbox.every(o=>o.bot_archive_id===x.archive&&o.bot_revision===1));assert(outbox.every(o=>o.authorization_cipher===''));
 await receive('ASSISTENZA');await h.store.query("UPDATE wa_bot_conversations SET updated_at=now()-interval '11 minutes'");await receive('1');assert.equal((await h.store.query('SELECT * FROM outbox')).length,4);
 await receive('ASSISTENZA');assert.equal((await h.store.query('SELECT state FROM wa_bot_conversations'))[0].state.nodeId,'menu');
 // Any edit suspends, resets conversations and cancels queued responses.
 await h.request(x.bot,'PUT',{definition:{...definition,trigger:'PRENOTA'},expectedRevision:1});assert.equal((await h.store.query('SELECT * FROM wa_bot_conversations')).length,0);assert((await h.store.query('SELECT state FROM outbox')).every(o=>o.state==='cancelled'));
 await receive('PRENOTA');assert.equal((await h.store.query('SELECT * FROM outbox')).length,5);
 await h.request(x.bot+'/activation','PUT',{enabled:true,expectedRevision:2});await receive('PRENOTA','393334444444@lid');assert.equal((await h.store.query('SELECT * FROM outbox')).length,6);
 await h.store.query('UPDATE installations SET enabled=false WHERE id=$1',[x.i]);await receive('PRENOTA');assert.equal((await h.store.query('SELECT * FROM outbox')).length,6);
 }finally{await h.close();}
});
test('Bot nelle app: cliente autorizzato nel proprio tenant, revoche e credenziali server senza utente',async()=>{
 const h=await harness();try{
 const x=await setup(h);
 const {CatalogService}=await import('../dist/server/apps/api/src/catalog.service.js');
 await new CatalogService(h.store).publish('bot-app',{version:1,features:[{key:'whatsapp',name:'WhatsApp'}],permissions:['read','manage','send'].map(v=>({key:'whatsapp.'+v,name:v,feature:'whatsapp'}))},'operator');
 await h.request('/v1/identities','PUT',{subject:'client',displayName:'Cliente',enabled:true});
 await h.request('/v1/licenses','PUT',{customerId:x.customer,appId:'bot-app',state:'active',expiresAt:null,features:[{key:'whatsapp',purchased:true,enabled:true}],reason:'Test SDK bot'});
 const role=(await h.request('/v1/roles','PUT',{customerId:x.customer,appId:'bot-app',name:'Gestore bot',permissions:['whatsapp.read','whatsapp.manage','whatsapp.send'],reason:'Test'})).body;
 await h.request('/v1/memberships','PUT',{subject:'client',customerId:x.customer,enabled:true,roleIds:[role.id]});
 await h.request('/v1/identity-links','PUT',{installationId:x.i,localUserId:'app-user',subject:'client'});
 const headers={'X-Installation-Id':x.i,'X-Installation-Secret':x.secret,Authorization:'Bearer '+await h.token('client',[])};
 assert.equal((await h.request(x.bot,'PUT',{definition,expectedRevision:0},{...headers,Authorization:''})).status,403);
 assert.equal((await h.request(x.bot,'PUT',{definition,expectedRevision:0},headers)).status,200);
 assert.equal((await h.request(x.bot+'/activation','PUT',{enabled:true,expectedRevision:1},headers)).body.enabled,true);
 const runtime=new WhatsAppBotService(h.store,new Authorization(h.store)),[bot]=await h.store.query('SELECT * FROM wa_bots');
 assert.equal(bot.technical_admin,false);assert.equal(await runtime.authorized(bot,x.i),true);
 await h.store.query("UPDATE identities SET enabled=false WHERE subject='client'");assert.equal(await runtime.authorized(bot,x.i),false);assert.equal((await h.request(x.bot,'GET',undefined,headers)).status,403);
 }finally{await h.close();}
});
