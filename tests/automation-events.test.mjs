import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {automationFixture} from './automation-fixture.mjs';
import {recordMessage} from '../dist/server/apps/runner/src/message-record.js';
import {WhatsAppBotService} from '../dist/server/apps/api/src/whatsapp-bot.service.js';
import {Authorization} from '../dist/server/apps/api/src/authorization.js';
import {ConnectServer,verifyWebhook} from '../packages/sdk/dist/server.js';
import {webhookEnvelope} from '../dist/server/apps/runner/src/webhooks.js';
import {signature} from '../dist/server/apps/api/src/security.js';

test('Signed events: ordinary message then normalized selection with same provider ID emits one durable selection, including concurrent duplicates',async()=>{
 const h=await automationFixture();try{
 const session=(await h.q('SELECT * FROM wa_sessions WHERE id=$1',[h.session]))[0],bots=new WhatsAppBotService(h.store,new Authorization(h.store));session.bot_ready_at=Date.now()-1000;
 const server=new ConnectServer({apiUrl:await h.listen(),installationId:h.installation,secret:h.secret}),hook=await server.automations(h.personal.Authorization.slice(7)).webhooks.create('https://synthetic-consumer.example.test/webhook','event-hook-001');
 const ordinary={id:'synthetic-inbound-001',from:'15550000002@c.us',to:'15550000001@c.us',fromMe:false,type:'chat',body:'Confermo',t:Math.floor(Date.now()/1000)};
 await recordMessage(h.store,bots,session,ordinary,true);
 const selection={...ordinary,type:'interactive_response',body:'Confermo',selectedButtonId:'appointment-confirm-synthetic'};
 await Promise.all(Array.from({length:10},()=>recordMessage(h.store,bots,session,selection,true)));
 await recordMessage(h.store,bots,session,{...selection,selectedButtonId:'contradictory-duplicate'},true);
 await recordMessage(h.store,bots,session,ordinary,true);
 const messages=await h.q('SELECT * FROM messages');assert.equal(messages.length,1);assert.equal(messages[0].body.selectedButtonId,selection.selectedButtonId);
 const events=await h.q('SELECT * FROM events ORDER BY created_at,id');assert.equal(events.length,2);
 assert.equal(events.filter(e=>e.kind==='message.interactive_response').length,1);
 const response=events.find(e=>e.kind==='message.interactive_response');
 assert.equal(response.payload.body.selectedButtonId,selection.selectedButtonId);
 for(const event of events){
  assert.equal(event.installation_id,h.installation);assert.equal(event.session_id,h.session);
  assert.equal(event.payload.sessionId,h.session);assert.equal(event.payload.archiveId,h.archive);assert.equal(event.payload.providerId,ordinary.id);
  assert.equal(event.payload.direction,'in');assert.equal(event.payload.fromMe,false);assert.equal(event.payload.senderId,ordinary.from);assert.equal(event.payload.recipientId,ordinary.to);assert.equal(event.payload.timestampSource,'provider');assert(event.payload.addressingVerified);assert(event.payload.observedAt);assert(event.payload.occurredAt);
 }
 assert.equal((await h.q('SELECT * FROM deliveries')).length,2);
 // Synthetic consumer: original-body verifier plus durable event-ID dedup and installation/session/direction scope.
 const seen=new Set(),effects=[];
 function consume(raw,ts,sig){if(!verifyWebhook(hook.secret,raw,ts,sig))return false;const e=JSON.parse(raw);if(e.installationId!==h.installation||e.sessionId!==h.session||e.kind!=='message.interactive_response'||e.payload.direction!=='in'||!e.payload.addressingVerified||e.payload.timestampSource!=='provider')return false;if(seen.has(e.id))return false;seen.add(e.id);effects.push(e.id);return true;}
 const envelope=webhookEnvelope(response),raw=JSON.stringify(envelope),ts=String(Math.floor(Date.now()/1000));
 assert(consume(raw,ts,signature(hook.secret,ts,raw)));assert(!consume(raw,ts,signature(hook.secret,ts,raw)));assert(!consume(raw,ts,'0'.repeat(64)));
 const cross=JSON.stringify({...envelope,id:randomUUID(),installationId:h.otherInstallation});assert(!consume(cross,ts,signature(hook.secret,ts,cross)));assert.equal(effects.length,1);
 }finally{await h.close();}
});

test('Events: fromMe, unverifiable provenance, stale session callbacks and connection rotation cannot become a customer selection',async()=>{
 const h=await automationFixture();try{
 const session=(await h.q('SELECT * FROM wa_sessions WHERE id=$1',[h.session]))[0],bots=new WhatsAppBotService(h.store,new Authorization(h.store));
 const message={id:'synthetic-from-me',fromMe:true,chatId:'15550000002@c.us',type:'interactive_response',body:'Outgoing',selectedButtonId:'not-a-customer',t:Date.now()/1000};
 await recordMessage(h.store,bots,session,message,true);
 let events=await h.q('SELECT * FROM events');assert.equal(events.length,1);assert.equal(events[0].payload.direction,'out');assert.equal(events[0].payload.fromMe,true);assert.equal(events[0].kind,'message.received');
 await recordMessage(h.store,bots,session,{id:'unknown-source',chatId:'15550000002@c.us',type:'chat',body:'No direction or timestamp'},true);
 events=await h.q("SELECT * FROM events WHERE payload->>'providerId'='unknown-source'");assert.equal(events[0].payload.addressingVerified,false);assert.equal(events[0].payload.timestampSource,'connect');assert.equal(events[0].payload.direction,'unknown');
 await recordMessage(h.store,bots,{...session,id:randomUUID()},{...message,id:'nonexistent-session'},true);
 await recordMessage(h.store,bots,{...session,installation_id:h.otherInstallation},{...message,id:'wrong-installation'},true);
 assert.equal((await h.q('SELECT * FROM events')).length,2);
 await h.q("UPDATE wa_sessions SET state='disconnected',closed_at=now() WHERE id=$1",[h.session]);
 await recordMessage(h.store,bots,session,{...message,id:'stale-callback'},true);assert.equal((await h.q('SELECT * FROM events')).length,2);
 const next=randomUUID();await h.q("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'synthetic-runner',$3,'15550000001','connected')",[next,h.installation,h.archive]);
 const nextSession=(await h.q('SELECT * FROM wa_sessions WHERE id=$1',[next]))[0];
 await recordMessage(h.store,bots,nextSession,{id:'new-connection-response',fromMe:false,chatId:'15550000002@c.us',type:'interactive_response',body:'Yes',selectedButtonId:'yes',t:Date.now()/1000},true);
 const responses=await h.q("SELECT * FROM events WHERE kind='message.interactive_response'");assert.equal(responses.length,1);assert.equal(responses[0].payload.sessionId,next);assert.equal(responses[0].payload.archiveId,h.archive);
 await recordMessage(h.store,bots,nextSession,{id:'response-without-provider-time',fromMe:false,chatId:'15550000002@c.us',type:'interactive_response',body:'Yes',selectedButtonId:'yes'},true);
 const incomplete=(await h.q("SELECT * FROM events WHERE kind='message.interactive_response' AND payload->>'providerId'='response-without-provider-time'"))[0];assert.equal(incomplete.payload.timestampSource,'connect');
 assert.equal((await h.q('SELECT * FROM outbox')).length,0);
 }finally{await h.close();}
});
