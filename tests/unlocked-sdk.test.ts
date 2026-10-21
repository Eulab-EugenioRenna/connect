import test from 'node:test';
import assert from 'node:assert/strict';
import {whatsappClient} from '../packages/sdk/src/whatsapp.js';
import {botTurn} from '../apps/api/src/whatsapp-bot.js';
import {botTestModel} from '../apps/web/src/WhatsAppBotLab.js';
test('SDK 0.8: documenti interattivi, operazioni e turni vocali mantengono ID e controllo concorrenza',async()=>{
 const calls:any[]=[];const request:any=async(...args:any[])=>{calls.push(args);return {id:'operation'};};
 const wa=whatsappClient(request,'installation');
 await wa.send('session',{kind:'interactive',to:'+393331111111',content:{type:'buttons',body:'Scegli',actions:[{type:'reply',id:'info',label:'Informazioni'}]}},'send-key-1');
 assert.equal(calls.at(-1)[3]['Idempotency-Key'],'send-key-1');assert.equal(calls.at(-1)[2].content.actions[0].id,'info');
 await wa.ivr.start('archive','agent-call','voice-start');assert.match(calls.at(-1)[0],/archives\/archive\/bot\/voice-sessions$/);
 await wa.ivr.advance('archive','voice',{type:'dtmf',value:'2'},3,'turn-key');assert.deepEqual(calls.at(-1)[2],{input:{type:'dtmf',value:'2'},expectedTurn:3});assert.equal(calls.at(-1)[3]['Idempotency-Key'],'turn-key');
 await wa.ivr.get('archive','voice');assert.match(calls.at(-1)[0],/voice-sessions\/voice$/);
 await wa.refreshContact('session','393331111111@lid');assert.equal(calls.at(-1)[2].kind,'contact.refresh');
 await wa.calls.inspect('session');assert.equal(calls.at(-1)[2].kind,'call.inspect');
 await wa.calls.control('session','mute',{id:'call',sessionId:'session',generation:'generation'},true,'mute-key');assert.equal(calls.at(-1)[2].muted,true);
 const turn=botTurn(botTestModel,{type:'start'},null,'voice');assert.equal(turn.prompt?.choices.length,4);
});
