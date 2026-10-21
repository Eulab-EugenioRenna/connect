import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {harness} from './harness.mjs';
import {runProviderOperation} from '../dist/server/apps/runner/src/provider-operation.js';
import {Authorization} from '../dist/server/apps/api/src/authorization.js';
import {WhatsAppBotService} from '../dist/server/apps/api/src/whatsapp-bot.service.js';
const definition={name:'IVR condiviso',trigger:'VIA',sessionTimeoutMinutes:10,startNodeId:'menu',invalidReply:'Scegli di nuovo',nodes:[{id:'menu',type:'menu',text:'Come possiamo aiutarti?',speech:'Benvenuto in EULab.',options:[1,2,3,4].map(key=>({key:String(key),label:'Servizio '+key,next:'name',aliases:['opzione '+key]}))},{id:'name',type:'question',text:'Il tuo nome?',next:'end'},{id:'end',type:'end',text:'Richiesta raccolta',outcome:'request'}]};
async function setup(h){
 const customer=(await h.request('/v1/customers','POST',{name:'Cliente Unlocked'})).body;
 const installation=(await h.request('/v1/application-connections','POST',{id:'unlocked',name:'App unlocked',customerId:customer.id,domain:'https://unlocked.example',integration:'web'})).body;
 const i=installation.installationId,archive=randomUUID(),session=randomUUID(),root=`/v1/installations/${i}/whatsapp`;
 await h.store.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3)',[archive,i,'393331111111']);
 await h.store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'test',$3,'393331111111','connected')",[session,i,archive]);
 return {i,archive,session,root,bot:root+`/archives/${archive}/bot`};
}
test('Unlocked: pulsanti multipli e liste accodati senza licenza, validazione ID e isolamento',async()=>{
 const h=await harness();try{
  const x=await setup(h),content={type:'buttons',body:'Scegli',actions:[1,2,3,4].map(n=>({type:'reply',id:'choice-'+n,label:'Scelta '+n}))};
  const payload={kind:'interactive',to:'+393331111111',content};
  const verified=await h.request(x.root+`/sessions/${x.session}/messages/test`,'POST',payload);assert.equal(verified.status,201);assert.equal(verified.body.sent,false);
  assert.equal((await h.store.query('SELECT * FROM outbox')).length,0);
  const send=await h.request(x.root+`/sessions/${x.session}/messages`,'POST',payload,{'Idempotency-Key':'unlocked-buttons'});assert.equal(send.status,201);
  const [out]=await h.store.query('SELECT * FROM outbox');assert.equal(out.payload.content.actions.length,4);
  assert.equal((await h.request(x.root+`/sessions/${x.session}/messages`,'POST',payload,{'Idempotency-Key':'unlocked-buttons'})).body.id,send.body.id);
  for(const actions of [[content.actions[0],content.actions[0]],[content.actions[0],{type:'url',label:'Sito',url:'https://example.com'}]])assert.equal((await h.request(x.root+`/sessions/${x.session}/messages/test`,'POST',{...payload,content:{...content,actions}})).status,400);
  const list={type:'list',body:'Scegli',buttonLabel:'Apri',sections:[{rows:[{id:'one',title:'Uno',description:'Primo servizio'}]}]};
  assert.equal((await h.request(x.root+`/sessions/${x.session}/messages/test`,'POST',{...payload,to:'393331111111@lid',content:list})).status,201);
  assert.equal((await h.request(x.root+`/sessions/${randomUUID()}/messages/test`,'POST',payload)).status,404);
 }finally{await h.close();}
});
test('IVR: stessi pulsanti, trascrizione e DTMF; sessioni vocali persistenti, idempotenza e turni concorrenti',async()=>{
 const h=await harness();try{
  const x=await setup(h);assert.equal((await h.request(x.bot,'PUT',{definition,expectedRevision:0})).status,200);
  const start=await h.request(x.bot+'/voice-sessions','POST',{callId:'future-agent-call-1'},{'Idempotency-Key':'voice-start-0001'});assert.equal(start.status,201);
  assert.equal(start.body.result.prompt.choices.length,4);assert.match(start.body.result.prompt.speech,/premi 4/);
  assert.deepEqual((await h.request(x.bot+'/voice-sessions','POST',{callId:'future-agent-call-1'},{'Idempotency-Key':'voice-start-0001'})).body,start.body);
  const url=x.bot+`/voice-sessions/${start.body.id}/turns`,input={type:'dtmf',value:'2'};
  const next=await h.request(url,'POST',{input,expectedTurn:0},{'Idempotency-Key':'voice-turn-0001'});assert.equal(next.status,201);assert.equal(next.body.result.state.nodeId,'name');
  assert.deepEqual((await h.request(url,'POST',{input,expectedTurn:0},{'Idempotency-Key':'voice-turn-0001'})).body,next.body);
  assert.equal((await h.request(url,'POST',{input,expectedTurn:0},{'Idempotency-Key':'voice-turn-stale'})).status,409);
  assert.equal((await h.request(url,'POST',{input:{type:'speech',value:'Altro'},expectedTurn:0},{'Idempotency-Key':'voice-turn-0001'})).status,409);
  const done=await h.request(url,'POST',{input:{type:'speech',value:'Eugenio'},expectedTurn:1},{'Idempotency-Key':'voice-turn-0002'});assert.equal(done.body.result.completed,true);assert.deepEqual(done.body.result.answers,{menu:'2',name:'Eugenio'});
  assert.equal((await h.request(url,'POST',{input,expectedTurn:2},{'Idempotency-Key':'voice-turn-0003'})).status,400);
  assert.equal((await h.store.query('SELECT * FROM outbox')).length,0);
  assert.equal((await h.request(x.bot+`/voice-sessions/${randomUUID()}/turns`,'POST',{input,expectedTurn:0},{'Idempotency-Key':'unknown-session'})).status,404);
  await h.store.query('UPDATE installations SET enabled=false WHERE id=$1',[x.i]);
  // No automatic voice agent or phone call is created by the IVR API.
  assert.equal((await h.store.query('SELECT * FROM wa_operations')).length,0);
 }finally{await h.close();}
});
test('IVR runtime: scelta strutturata avanza e menu produce un documento interattivo',async()=>{
 const h=await harness();try{
  const x=await setup(h);await h.request(x.bot,'PUT',{definition,expectedRevision:0});await h.request(x.bot+'/activation','PUT',{enabled:true,expectedRevision:1});
  const runtime=new WhatsAppBotService(h.store,new Authorization(h.store)),[session]=await h.store.query('SELECT * FROM wa_sessions WHERE id=$1',[x.session]);
  async function receive(text){const id=randomUUID();await h.store.transaction(tx=>runtime.receive(tx,session,{id,provider_id:id,chat_id:'393332222222@c.us',text,occurred_at:new Date()}));}
  await receive('VIA');const [out]=await h.store.query('SELECT payload FROM outbox');assert.equal(out.payload.kind,'interactive');assert.equal(out.payload.content.actions.length,6);
  await receive('ivr:v0:menu:3');assert.equal((await h.store.query('SELECT state FROM wa_bot_conversations'))[0].state.nodeId,'menu');
  await receive(out.payload.content.actions[2].id);assert.equal((await h.store.query('SELECT state FROM wa_bot_conversations'))[0].state.nodeId,'name');
 }finally{await h.close();}
});
test('Provider: operazioni persistenti, profilo conversazione, idempotenza e nessuna ripetizione di esiti incerti',async()=>{
 const h=await harness();try{
  const x=await setup(h),url=x.root+`/sessions/${x.session}/operations`;
  const command={kind:'contact.refresh',chatId:'+393332222222'},key={'Idempotency-Key':'refresh-contact-1'};
  const op=await h.request(url,'POST',command,key);assert.equal(op.status,201);assert.equal(op.body.state,'queued');assert(!('authorization_cipher' in op.body));
  assert.equal((await h.request(url,'POST',command,key)).body.id,op.body.id);
  assert.equal((await h.request(url,'POST',{kind:'call.inspect'},key)).status,409);
  const profile={name:'Anna Rossi',pushName:'Anna',description:'Referente acquisti',avatar:'https://example.com/avatar.jpg',isBusiness:true,isGroup:false};
  let calls=0;const client={operation:async()=>{calls++;return profile;}},policy=new Authorization(h.store);
  await runProviderOperation(h.store,policy,op.body.id,'test',async()=>client,async()=>{});
  await runProviderOperation(h.store,policy,op.body.id,'test',async()=>client,async()=>{});assert.equal(calls,1);
  const stored=await h.request(x.root+'/operations/'+op.body.id);assert.equal(stored.body.state,'completed');assert.deepEqual(stored.body.result,profile);
  await h.store.query("INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body,occurred_at) VALUES($1,$2,$3,'fixture','393332222222@c.us','in','chat',$4,now())",[randomUUID(),x.session,x.archive,JSON.stringify({text:'Ciao'})]);
  assert.equal((await h.request(x.root+`/archives/${x.archive}/conversations`)).body[0].contact.name,'Anna Rossi');
  const inspect=await h.request(url,'POST',{kind:'call.inspect'},{'Idempotency-Key':'inspect-failure-1'});
  const failedClient={operation:async()=>{calls++;throw new Error('PROVIDER_DISCONNECTED');}};
  await runProviderOperation(h.store,policy,inspect.body.id,'test',async()=>failedClient,async()=>{});
  await runProviderOperation(h.store,policy,inspect.body.id,'test',async()=>failedClient,async()=>{});assert.equal(calls,2);assert.equal((await h.request(x.root+'/operations/'+inspect.body.id)).body.state,'uncertain');
  assert.equal((await h.request(url,'POST',{kind:'call.end',call:{id:'a',sessionId:randomUUID(),generation:'g'}},{'Idempotency-Key':'wrong-call-session'})).status,409);
 }finally{await h.close();}
});
