import {z} from 'zod';
import type {WhatsAppBotDefinition,WhatsAppBotNode,WhatsAppBotState,WhatsAppBotTurn,IVRChannel,IVRInput} from '../../../packages/sdk/src/bot.js';
const id=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),text=z.string().trim().min(1).max(4000);
const option=z.object({key:z.string().trim().min(1).max(20),label:z.string().trim().min(1).max(120),next:id,aliases:z.array(z.string().trim().min(1).max(120)).max(10).optional()}).strict();
export const botDefinitionSchema=z.object({name:z.string().trim().min(1).max(160),startNodeId:id,trigger:z.string().trim().min(1).max(100).refine(v=>v!=='0','La frase di avvio non può essere 0'),sessionTimeoutMinutes:z.number().int().min(1).max(1440),invalidReply:z.string().trim().min(1).max(500),nodes:z.array(z.discriminatedUnion('type',[
 z.object({id,type:z.literal('menu'),text,speech:text.optional(),options:z.array(option).min(1).max(30)}).strict(),
 z.object({id,type:z.literal('question'),text,speech:text.optional(),next:id}).strict(),
 z.object({id,type:z.literal('end'),text,speech:text.optional(),outcome:id.optional()}).strict()
])).min(1).max(500)}).strict().superRefine((definition,ctx)=>{
 const ids=new Set(definition.nodes.map(n=>n.id));
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(ids.size!==definition.nodes.length)fail('ID dei passaggi duplicati');
 if(!ids.has(definition.startNodeId))fail('Passaggio iniziale inesistente');
 for(const node of definition.nodes){
  const targets=node.type==='menu'?node.options.map(o=>o.next):node.type==='question'?[node.next]:[];
  if(targets.some(t=>!ids.has(t)))fail(`Destinazione inesistente nel passaggio ${node.id}`);
  if(node.type==='menu'){
   const used=new Set<string>();
   for(const o of node.options)for(const value of new Set([normalize(o.key),normalize(o.label),...(o.aliases||[]).map(normalize)])){
    if(['0','menu','__back','__menu',normalize(definition.trigger)].includes(value)||used.has(value))fail(`Scelta ambigua o riservata nel passaggio ${node.id}`);used.add(value);
   }
  }
 }
 const reachable=new Set<string>(),pending=[definition.startNodeId];
 while(pending.length){const current=pending.pop()!;if(reachable.has(current))continue;reachable.add(current);const node=definition.nodes.find(n=>n.id===current);if(node?.type==='menu')pending.push(...node.options.map(o=>o.next));if(node?.type==='question')pending.push(node.next);}
 if(definition.nodes.some(n=>!reachable.has(n.id)))fail('Sono presenti passaggi non raggiungibili');
});
export const botStateSchema=z.object({nodeId:id,history:z.array(id).max(500),answers:z.record(id,z.string().max(2000)).refine(v=>Object.keys(v).length<=500)}).strict();
export const ivrInputSchema=z.union([z.object({type:z.enum(['start','back','restart'])}).strict(),z.object({type:z.enum(['text','speech','dtmf','choice']),value:z.string().trim().min(1).max(2000)}).strict()]);
export const botPreviewSchema=z.object({definition:botDefinitionSchema,channel:z.enum(['whatsapp','voice']).default('whatsapp'),input:z.union([z.string().trim().min(1).max(2000),ivrInputSchema]),state:botStateSchema.nullable().optional()}).strict().superRefine((value,ctx)=>{
 if(!value.state)return;
 const nodes=new Map(value.definition.nodes.map(n=>[n.id,n]));
 if(!nodes.has(value.state.nodeId)||nodes.get(value.state.nodeId)?.type==='end'||value.state.history.some(id=>!nodes.has(id)||nodes.get(id)?.type==='end')||Object.keys(value.state.answers).some(id=>!nodes.has(id)))ctx.addIssue({code:'custom',path:['state'],message:'Stato incompatibile con la definizione del bot'});
});
function normalize(v:string){return v.trim().toLocaleLowerCase('it-IT');}
export function renderBotNode(node:WhatsAppBotNode){return node.text+(node.type==='menu'?'\n\n'+node.options.map(o=>`${o.key} — ${o.label}`).join('\n')+'\n\n0 — Indietro · menu — Ricomincia':node.type==='question'?'\n\n0 — Indietro · menu — Ricomincia':'');}
export function botTurn(definition:WhatsAppBotDefinition,input:string|IVRInput,previous:WhatsAppBotState|null,channel:IVRChannel='whatsapp'):WhatsAppBotTurn {
 const supplied=typeof input==='string'?input:input.type==='start'||input.type==='restart'?definition.trigger:input.type==='back'?'0':'value' in input?input.value:'';
 const nodes=new Map(definition.nodes.map(n=>[n.id,n]));
 let raw=supplied,staleChoice=false;
 if(supplied.startsWith('ivr:')){
  const prefix=`ivr:${previous?.nodeId}:`;
  staleChoice=!supplied.startsWith(prefix);
  raw=supplied.startsWith(prefix)?supplied.slice(prefix.length):supplied;
  if(nodes.get(previous?.nodeId||'')?.type!=='menu'&&!['__back','__menu'].includes(raw))staleChoice=true;
  if(raw==='__back')raw='0';if(raw==='__menu')raw='menu';
 }
 const value=normalize(raw);
 let state=previous&&nodes.has(previous.nodeId)?structuredClone(previous):null;
 const show=(current:WhatsAppBotState):WhatsAppBotTurn=>{
  const node=nodes.get(current.nodeId)!;
  const choices=node.type==='menu'?node.options.map(o=>({id:`ivr:${node.id}:${o.key}`,key:o.key,label:o.label,dtmf:/^[1-9][0-9]*$/.test(o.key)?o.key:null})):[];
  const speech=(node.speech||node.text)+(node.type==='menu'?' '+choices.map(o=>o.dtmf?`Per ${o.label}, premi ${o.dtmf}.`:o.label+'.').join(' '):'');
  const prompt={nodeId:node.id,text:node.text,speech,expects:node.type==='menu'?'choice' as const:node.type==='question'?'text' as const:'none' as const,choices};
  const presentation={prompt,channel};
  if(node.type==='end')return {...presentation,reply:channel==='voice'?speech:renderBotNode(node),state:null,completed:true,answers:current.answers,...node.outcome?{outcome:node.outcome}:{}};
  return {...presentation,reply:channel==='voice'?speech:renderBotNode(node),state:current,completed:false,answers:current.answers};
 };
 if(!state&&value!==normalize(definition.trigger))return {reply:null,state:null,completed:false,answers:{}};
 if(value==='menu'||value===normalize(definition.trigger))state=null;
 else if(state){
  const node=nodes.get(state.nodeId)!;
  if(value==='0'){state.nodeId=state.history.pop()||definition.startNodeId;delete state.answers[state.nodeId];return show(state);}
  if(staleChoice){const result=show(state);return {...result,reply:definition.invalidReply+'\n\n'+(result.reply||''),prompt:result.prompt?{...result.prompt,text:definition.invalidReply+'\n\n'+result.prompt.text,speech:definition.invalidReply+' '+result.prompt.speech}:undefined};}
  const target=node.type==='menu'?node.options.find(o=>normalize(o.key)===value||normalize(o.label)===value||(o.aliases||[]).some(alias=>normalize(alias)===value))?.next:node.type==='question'?node.next:undefined;
  if(!target){const result=show(state);return {...result,reply:definition.invalidReply+'\n\n'+(result.reply||''),prompt:result.prompt?{...result.prompt,text:definition.invalidReply+'\n\n'+result.prompt.text,speech:definition.invalidReply+' '+result.prompt.speech}:undefined};}
  state.answers[node.id]=raw.trim();state.history=[...state.history,state.nodeId].slice(-500);state.nodeId=target;return show(state);
 }
 return show({nodeId:definition.startNodeId,history:[],answers:{}});
}

/** WhatsApp presentation uses the same stable choice IDs exposed to voice agents. */
export function botPayload(to:string,turn:WhatsAppBotTurn,revision:number){
 const prompt=turn.prompt;
 if(prompt?.expects==='choice')return {kind:'interactive' as const,to,content:{type:'buttons' as const,body:prompt.text,footer:'Scegli un’opzione per continuare',actions:[...prompt.choices.map(c=>({type:'reply' as const,id:c.id.replace(/^ivr:/,`ivr:v${revision}:`),label:c.label})),{type:'reply' as const,id:`ivr:v${revision}:${prompt.nodeId}:__back`,label:'Indietro'},{type:'reply' as const,id:`ivr:v${revision}:${prompt.nodeId}:__menu`,label:'Ricomincia'}]}};
 return {kind:'text' as const,to,text:turn.reply!};
}
