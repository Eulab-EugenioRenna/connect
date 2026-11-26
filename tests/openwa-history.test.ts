import test from 'node:test';
import assert from 'node:assert/strict';
import {readChatIds} from '../apps/runner/src/openwa-history.js';

test('Storico OpenWA: i modelli chat circolari vengono proiettati in ID serializzabili',async()=>{
 const chat:any={id:'fixture@c.us',contact:{name:'Fixture'}};chat.contact.chat=chat;
 const root=globalThis as any,previous=root.WAPI;
 root.WAPI={getAllChats:async()=>[{...chat,t:1700000000},{id:{_serialized:'fixture@g.us'}}]};
 try{
  const result=await readChatIds();
  assert.deepEqual(JSON.parse(JSON.stringify(result)),[{id:'fixture@c.us',t:1700000000},{id:'fixture@g.us',t:null}]);
  assert(!('contact' in result[0]));
 }finally{if(previous===undefined)delete root.WAPI;else root.WAPI=previous;}
});
test('Storico OpenWA: risposte non disponibili e ID mancanti non diventano una sincronizzazione vuota riuscita',async()=>{
 const root=globalThis as any,previous=root.WAPI;
 try{
  root.WAPI={getAllChats:async()=>undefined};
  await assert.rejects(readChatIds(),/HISTORY_CHATS_UNAVAILABLE/);
  root.WAPI={getAllChats:async()=>[{id:{}}]};
  await assert.rejects(readChatIds(),/HISTORY_CHAT_ID_UNAVAILABLE/);
 }finally{if(previous===undefined)delete root.WAPI;else root.WAPI=previous;}
});
