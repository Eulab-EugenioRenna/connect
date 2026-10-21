import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {harness} from './harness.mjs';
import {WhatsAppRealtimeService,realtimePayload} from '../dist/server/apps/api/src/whatsapp-realtime.service.js';
import {Authorization} from '../dist/server/apps/api/src/authorization.js';
async function fixture(h){
 const c=(await h.request('/v1/customers','POST',{name:'Realtime test'})).body;
 const i=(await h.request('/v1/application-connections','POST',{id:'realtime-test',name:'Realtime',customerId:c.id,domain:'https://client.example',integration:'web'})).body;
 return {installationId:i.installationId,customerId:c.id,root:`/v1/installations/${i.installationId}/whatsapp`};
}
test('Realtime ticket: autenticazione HTTP, cifratura, uso singolo, origine e scadenza',async()=>{
 const h=await harness();try{
 const f=await fixture(h),rt=new WhatsAppRealtimeService(h.store,new Authorization(h.store));
 const issued=await h.request(f.root+'/events/ticket','POST',undefined,{Origin:'https://admin.example'});assert.equal(issued.status,201);assert.equal(issued.body.path,'/v1/whatsapp/events');
 const stored=(await h.store.query('SELECT * FROM wa_stream_tickets'))[0];assert(!stored.principal_cipher.includes('accessToken'));assert.notEqual(stored.ticket_hash,issued.body.ticket);assert.equal((await rt.consume(issued.body.ticket,'https://admin.example')).installationId,f.installationId);
 await assert.rejects(()=>rt.consume(issued.body.ticket,'https://admin.example'));
 const wrong=(await h.request(f.root+'/events/ticket','POST',undefined,{Origin:'https://admin.example'})).body;await assert.rejects(()=>rt.consume(wrong.ticket,'https://evil.example'));
 const expired=(await h.request(f.root+'/events/ticket','POST')).body;await h.store.query("UPDATE wa_stream_tickets SET expires_at=now()-interval '1 second'");await assert.rejects(()=>rt.consume(expired.ticket));
 const headers={Authorization:'Bearer '+await h.token('reader',[])};assert.equal((await h.request(f.root+'/events/ticket','POST',undefined,headers)).status,403);
 assert.equal((await h.request(f.root+'/events/ticket','POST',undefined,{'X-Installation-Id':f.installationId,Authorization:'','X-Installation-Secret':'bad'})).status,401);
 for(let n=0;n<10;n++)assert.equal((await h.request(f.root+'/events/ticket','POST')).status,201);assert.equal((await h.request(f.root+'/events/ticket','POST')).status,403);
 }finally{await h.close();}
});
test('Realtime: QR solo a gestori, eventi del tenant, revoche e allegati separati',async()=>{
 const h=await harness();try{
 const f=await fixture(h),rt=new WhatsAppRealtimeService(h.store,new Authorization(h.store));
 const archive=randomUUID(),session=randomUUID();await h.store.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3)',[archive,f.installationId,'393331234567']);
 await h.store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,state,qr) VALUES($1,$2,'test',$3,'pairing','data:image/png;base64,AAAA')",[session,f.installationId,archive]);
 assert.equal((await rt.snapshot(f.installationId,false)).sessions[0].qr,null);assert.match((await rt.snapshot(f.installationId,true)).sessions[0].qr,/^data:/);assert.equal((await rt.snapshot(randomUUID(),true)).sessions.length,0);
 const id=randomUUID();await h.store.query("INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,'message.received',$4)",[id,f.installationId,session,JSON.stringify({body:{text:'Test',media:'data:secret'},accessToken:'secret'})]);
 const events=await rt.events(f.installationId,new Date(0),[]);assert.equal(events.length,1);assert.equal(events[0].payload.body.media,undefined);assert.equal(events[0].payload.accessToken,undefined);assert.equal((await rt.events(randomUUID(),new Date(0),[])).length,0);assert.equal((await rt.events(f.installationId,new Date(0),[id])).length,0);
 const principal={subject:'operator',accessToken:await h.token(),admin:true,technician:true,server:false};assert.equal((await rt.access(f.installationId,principal)).manage,true);
 h.setRevoked(true);await assert.rejects(()=>rt.access(f.installationId,principal),/AUTHENTICATION_EXPIRED/);h.setRevoked(false);
 await h.store.query('UPDATE installations SET enabled=false WHERE id=$1',[f.installationId]);await assert.rejects(()=>rt.access(f.installationId,principal),/ACCESS_REVOKED/);
 assert.deepEqual(realtimePayload({items:[{media:'x',text:'ok'}]}),{items:[{text:'ok'}]});
 }finally{await h.close();}
});
test('WebSocket reale: handshake, autenticazione nel frame, snapshot, eventi e chiusura dopo revoca',async t=>{
 const h=await harness();let socket,invalid;try{
 const f=await fixture(h);let origin;
 try{origin=await h.listen();}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Socket locale vietato dal sandbox; eseguire in Docker');return;}throw e;}
 const ticket=(await h.request(f.root+'/events/ticket','POST')).body;
 socket=new WebSocket(origin.replace('http:','ws:')+'/v1/whatsapp/events');const received=[];
 socket.on('message',data=>received.push(JSON.parse(String(data))));await once(socket,'open');socket.send(JSON.stringify({type:'authenticate',ticket:ticket.ticket}));
 async function until(predicate){const end=Date.now()+5000;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Frame realtime atteso non ricevuto');}
 await until(()=>received.some(x=>x.type==='ready')&&received.some(x=>x.type==='snapshot'));
 invalid=new WebSocket(origin.replace('http:','ws:')+'/v1/whatsapp/events');await once(invalid,'open');invalid.send(JSON.stringify({type:'authenticate',ticket:ticket.ticket}));assert.equal((await once(invalid,'close'))[0],4001);
 const archive=randomUUID(),session=randomUUID();await h.store.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3)',[archive,f.installationId,'393331234567']);await h.store.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,state) VALUES($1,$2,'test',$3,'connected')",[session,f.installationId,archive]);
 const eventId=randomUUID();await h.store.query("INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,'bot.completed','{\"outcome\":\"test\"}')",[eventId,f.installationId,session]);
 await until(()=>received.some(x=>x.type==='event'&&x.event.id===eventId));assert.equal(received.filter(x=>x.type==='event'&&x.event.id===eventId).length,1);
 const closed=once(socket,'close');await h.store.query('UPDATE installations SET enabled=false WHERE id=$1',[f.installationId]);assert.equal((await closed)[0],4003);
 }finally{socket?.terminate();invalid?.terminate();await h.close();}
});
