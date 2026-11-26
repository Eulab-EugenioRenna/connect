import test from 'node:test';
import assert from 'node:assert/strict';
import {syncHistory,UPDATE_OVERLAP_SECONDS} from '../apps/runner/src/history-sync.js';

/** One archive per licence and number; messages unique per archive (as ON CONFLICT DO NOTHING). */
function store(){
 const archive:{history_synced_at:Date|null}={history_synced_at:null};
 const messages=new Map<string,number>(),session:any={};
 const db:any={query:async(sql:string,params:any[]=[])=>{
  if(sql.startsWith('SELECT a.history_synced_at'))return [{history_synced_at:archive.history_synced_at,last_at:messages.size?new Date(Math.max(...messages.values())*1000):null}];
  if(sql.includes('UPDATE wa_archives SET history_synced_at'))archive.history_synced_at=new Date();
  if(sql.startsWith('UPDATE wa_sessions')){if(sql.includes('sync_mode'))session.mode=params[1];if(sql.includes("'available_history_synced'"))session.status='done';if(sql.includes("'partial'"))session.status='partial';}
  return [];
 }};
 const record=async(m:any)=>{messages.set(m.id,m.t);};
 return {db,archive,messages,session,record};
}
const phone=(chats:Record<string,number[]>)=>{
 const reads:string[]=[];
 return {reads,client:{
  getAllChats:async()=>Object.entries(chats).map(([id,times])=>({id,t:Math.max(...times)})),
  getAllMessagesInChat:async(id:string)=>{reads.push(id);return chats[id].map(t=>({id:`${id}_${t}`,t}));},
 }};
};

test('Storico per numero: primo collegamento completo, poi solo aggiornamento (anche A → B → A), senza doppioni',async()=>{
 const s=store(),session={id:'s',archive_id:'a'},T=1_800_000_000;
 // Number A, first link: everything.
 let p=phone({'1@c.us':[T-90000,T-80000],'2@c.us':[T-70000]});
 let r=await syncHistory(s.db,session,p.client,s.record,()=>true);
 assert.deepEqual([r.mode,r.count,r.complete],['full',3,true]);assert.equal(s.messages.size,3);assert.ok(s.archive.history_synced_at);
 // A again later (after B was used on another archive): only chats and messages newer than the archive.
 p=phone({'1@c.us':[T-90000,T-80000],'2@c.us':[T-70000,T-100],'3@c.us':[T-50]});
 r=await syncHistory(s.db,session,p.client,s.record,()=>true);
 assert.equal(r.mode,'update');assert.deepEqual(p.reads,['2@c.us','3@c.us']);
 assert.equal(r.count,3,'the message inside the overlap is read again');assert.equal(s.messages.size,5,'…but stored once');
 // Messages inside the overlap are read again but stored once.
 p=phone({'3@c.us':[T-50,T-50+UPDATE_OVERLAP_SECONDS-10]});
 await syncHistory(s.db,session,p.client,s.record,()=>true);assert.equal(s.messages.size,6);
});

test('Storico per numero: una prima lettura interrotta ricomincia completa la volta dopo',async()=>{
 const s=store(),session={id:'s',archive_id:'a'};
 const failing={getAllChats:async()=>[{id:'1@c.us',t:5}],getAllMessagesInChat:async()=>{throw new Error('boom');}};
 const r=await syncHistory(s.db,session,failing,s.record,()=>true);
 assert.equal(r.complete,false);assert.equal(s.session.status,'partial');assert.equal(s.archive.history_synced_at,null);
 const again=await syncHistory(s.db,session,phone({'1@c.us':[5]}).client,s.record,()=>true);assert.equal(again.mode,'full');
});
