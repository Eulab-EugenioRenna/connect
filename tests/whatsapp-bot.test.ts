import test from 'node:test';
import assert from 'node:assert/strict';
import {botDefinitionSchema,botTurn} from '../apps/api/src/whatsapp-bot.js';
import type {WhatsAppBotDefinition} from '../packages/sdk/src/bot.js';
const definition:WhatsAppBotDefinition={name:'App cliente',trigger:'PRENOTA ORA',startNodeId:'root',sessionTimeoutMinutes:5,invalidReply:'Scelta non valida',nodes:[
 {id:'root',type:'menu',text:'Scegli il servizio',options:[{key:'1',label:'Consulenza',next:'name'},{key:'2',label:'Informazioni',next:'info'}]},
 {id:'name',type:'question',text:'Come ti chiami?',next:'date'},
 {id:'date',type:'question',text:'Quando preferisci?',next:'done'},
 {id:'done',type:'end',text:'Richiesta raccolta',outcome:'request'},
 {id:'info',type:'end',text:'Informazioni',outcome:'info'}
]};
test('Bot IVR: frase personalizzata, livelli forniti dall’app e risultato completo',()=>{
 assert.equal(botDefinitionSchema.safeParse(definition).success,true);
 for(const input of ['ciao','menu','1'])assert.equal(botTurn(definition,input,null).reply,null);
 const root=botTurn(definition,' prenota ORA ',null);assert.equal(root.state?.nodeId,'root');assert.match(root.reply!,/1 — Consulenza/);
 const name=botTurn(definition,'1',root.state);assert.equal(name.state?.nodeId,'name');
 const date=botTurn(definition,'Eugenio',name.state);assert.equal(date.state?.nodeId,'date');
 const done=botTurn(definition,'Martedì',date.state);assert.equal(done.state,null);assert.equal(done.completed,true);assert.equal(done.outcome,'request');assert.deepEqual(done.answers,{root:'1',name:'Eugenio',date:'Martedì'});
 assert.equal(botTurn(definition,'1',null).reply,null);
});
test('Bot IVR: errore mantiene il nodo; indietro e menu eliminano risposte obsolete',()=>{
 const root=botTurn(definition,definition.trigger,null);const invalid=botTurn(definition,'9',root.state);assert.equal(invalid.state?.nodeId,'root');assert.match(invalid.reply!,/Scelta non valida/);
 const name=botTurn(definition,'Consulenza',root.state),date=botTurn(definition,'Marco',name.state),back=botTurn(definition,'0',date.state);
 assert.equal(back.state?.nodeId,'name');assert.equal(back.answers.name,undefined);assert.equal(date.answers.name,'Marco');
 const again=botTurn(definition,'0',back.state);assert.deepEqual(again.answers,{});
 assert.equal(botTurn(definition,'2',again.state).outcome,'info');
 assert.deepEqual(botTurn(definition,'menu',date.state).state?.answers,{});
 assert.deepEqual(botTurn(definition,definition.trigger,date.state).state?.answers,{});
});
test('Bot IVR: rifiuta alberi incoerenti e scelte ambigue senza imporre contenuti o livelli',()=>{
 const invalids=[{...definition,startNodeId:'missing'},{...definition,nodes:[...definition.nodes,definition.nodes[0]]},{...definition,trigger:''},{...definition,trigger:undefined},{...definition,nodes:[...definition.nodes,{id:'orphan',type:'end',text:'Orfano'}]},{...definition,nodes:[{...definition.nodes[0],options:[{key:'1',label:'Uno',next:'missing'}]},...definition.nodes.slice(1)]}];
 for(const invalid of invalids)assert.equal(botDefinitionSchema.safeParse(invalid).success,false);
 for(const key of ['0','menu','Consulenza'])assert.equal(botDefinitionSchema.safeParse({...definition,nodes:[{...definition.nodes[0],options:[{key:'1',label:'Consulenza',next:'name'},{key,label:'Altra',next:'info'}]},...definition.nodes.slice(1)]}).success,false);
 const nodes=Array.from({length:50},(_,i)=>i===49?{id:'n'+i,type:'end' as const,text:'Fine'}:{id:'n'+i,type:'question' as const,text:'Domanda '+i,next:'n'+(i+1)});
 assert.equal(botDefinitionSchema.safeParse({...definition,startNodeId:'n0',nodes}).success,true);
});

test('IVR condiviso: vecchi pulsanti non diventano risposte libere e gli alias vocali sono deterministici',()=>{
 const root=botTurn(definition,{type:'start'},null,'voice');
 assert.match(root.prompt!.speech,/premi 1/);
 const question=botTurn(definition,{type:'choice',value:root.prompt!.choices[0].id},root.state);
 const stale=botTurn(definition,{type:'choice',value:root.prompt!.choices[0].id},question.state);
 assert.equal(stale.state?.nodeId,'name');assert.deepEqual(stale.answers,question.answers);assert.match(stale.reply!,/Scelta non valida/);
 const other=botTurn(definition,{type:'choice',value:'ivr:other:2'},root.state);assert.equal(other.state?.nodeId,'root');
 const voice=botTurn(definition,{type:'speech',value:'Consulenza'},root.state,'voice');assert.equal(voice.state?.nodeId,'name');
 const dtmf=botTurn(definition,{type:'dtmf',value:'2'},root.state,'voice');assert.equal(dtmf.outcome,'info');
});
