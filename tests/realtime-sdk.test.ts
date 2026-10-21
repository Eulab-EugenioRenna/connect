import test from 'node:test';
import assert from 'node:assert/strict';
import {subscribeWhatsApp} from '../packages/sdk/src/realtime.js';
import type {Request} from '../packages/sdk/src/whatsapp.js';
class FakeSocket {
 static sockets:FakeSocket[]=[];onopen:(()=>void)|null=null;onmessage:((e:{data:string})=>void)|null=null;onerror:(()=>void)|null=null;onclose:((e:{code:number})=>void)|null=null;sent:string[]=[];closed=false;
 constructor(readonly url:URL){FakeSocket.sockets.push(this);}
 send(data:string){this.sent.push(data);}
 close(){this.closed=true;this.onclose?.({code:1000});}
 frame(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)});}
}
const ticket={ticket:'single-use',path:'/v1/whatsapp/events',expiresAt:new Date().toISOString()};
const flush=()=>new Promise<void>(r=>setImmediate(r));
test('SDK realtime: ticket nel frame, URL WSS, deduplica, snapshot e chiusura per revoca',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'WebSocket');Object.defineProperty(globalThis,'WebSocket',{value:FakeSocket,configurable:true});FakeSocket.sockets=[];
 const calls:unknown[]=[],statuses:string[]=[],events:unknown[]=[],snapshots:unknown[]=[];
 const request:Request=async(path,method)=>{calls.push({path,method});return ticket as any;};
 const subscription=subscribeWhatsApp(request,'/v1/installations/i/whatsapp',{apiUrl:'https://connect.example'},{onStatus:s=>statuses.push(s),onEvent:e=>events.push(e),onSnapshot:s=>snapshots.push(s)});
 try{
  await flush();const socket=FakeSocket.sockets[0];assert.equal(String(socket.url),'wss://connect.example/v1/whatsapp/events');assert(!String(socket.url).includes(ticket.ticket));socket.onopen?.();assert.deepEqual(JSON.parse(socket.sent[0]),{type:'authenticate',ticket:ticket.ticket});socket.frame({type:'ready'});assert.equal(subscription.status,'connected');
  socket.frame({type:'snapshot',sessions:[],outbox:[],bots:[]});assert.equal(snapshots.length,1);
  const frame={type:'event',event:{id:'event',kind:'bot.completed',payload:{}}};socket.frame(frame);socket.frame(frame);assert.equal(events.length,1);socket.onmessage?.({data:'bad-json'});assert.equal(events.length,1);
  socket.onclose?.({code:4003});assert.equal(subscription.status,'unauthorized');assert.equal(calls.length,1);
 }finally{subscription.close();if(original)Object.defineProperty(globalThis,'WebSocket',original);else Reflect.deleteProperty(globalThis,'WebSocket');}
});
test('SDK realtime: annulla connessione ancora in preparazione e non ritenta accessi rifiutati',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'WebSocket');Object.defineProperty(globalThis,'WebSocket',{value:FakeSocket,configurable:true});FakeSocket.sockets=[];
 let resolve!:(value:any)=>void;const waiting:Request=()=>new Promise(r=>{resolve=r;});let unregistered=false;
 const sub=subscribeWhatsApp(waiting,'/root',{apiUrl:'https://connect.example',register:()=>()=>{unregistered=true;}},{});sub.close();resolve(ticket);
 try{await flush();assert.equal(FakeSocket.sockets.length,0);assert.equal(unregistered,true);
  const denied=subscribeWhatsApp(async()=>{throw new Error('Connect 403');},'/root',{apiUrl:'https://connect.example'},{});await flush();assert.equal(denied.status,'unauthorized');denied.close();
 }finally{if(original)Object.defineProperty(globalThis,'WebSocket',original);else Reflect.deleteProperty(globalThis,'WebSocket');}
});
test('SDK realtime: riconnessione ottiene un nuovo ticket senza reinviare messaggi WhatsApp',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'WebSocket');Object.defineProperty(globalThis,'WebSocket',{value:FakeSocket,configurable:true});FakeSocket.sockets=[];let tickets=0;
 const sub=subscribeWhatsApp(async()=>({...ticket,ticket:'ticket-'+ ++tickets}) as any,'/root',{apiUrl:'https://connect.example'},{});
 try{
  await flush();FakeSocket.sockets[0].onopen?.();FakeSocket.sockets[0].frame({type:'ready'});FakeSocket.sockets[0].onclose?.({code:1006});
  await new Promise(r=>setTimeout(r,1100));assert.equal(tickets,2);assert.equal(FakeSocket.sockets.length,2);FakeSocket.sockets[1].onopen?.();assert.equal(JSON.parse(FakeSocket.sockets[1].sent[0]).ticket,'ticket-2');FakeSocket.sockets[1].frame({type:'ready'});assert.equal(sub.status,'connected');assert(FakeSocket.sockets.every(s=>s.sent.every(frame=>JSON.parse(frame).type==='authenticate')));
 }finally{sub.close();if(original)Object.defineProperty(globalThis,'WebSocket',original);else Reflect.deleteProperty(globalThis,'WebSocket');}
});
