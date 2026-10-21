import React,{useEffect,useState} from 'react';
import type {WhatsAppPayload} from '../../../packages/sdk/src/whatsapp';
type Kind=WhatsAppPayload['kind'];
const formats:Record<string,string>={image:'image/png,image/jpeg,image/webp',document:'application/pdf',audio:'audio/mpeg,audio/ogg,audio/mp4',video:'video/mp4'};
export function WhatsAppComposer({to,setTo,connected,busy,act,onSend,onTest}:{to:string;setTo:(v:string)=>void;connected:boolean;busy:boolean;act:(fn:()=>Promise<unknown>)=>Promise<void>;onSend:(p:WhatsAppPayload)=>Promise<void>;onTest:(p:WhatsAppPayload)=>Promise<void>}){
 const [kind,setKind]=useState<Kind>('text'),[text,setText]=useState('Messaggio di prova EULab Connect.'),[options,setOptions]=useState('Informazioni\nAppuntamento\nAssistenza'),[file,setFile]=useState<File|null>(null),[interactiveType,setInteractiveType]=useState<'buttons'|'list'>('buttons'),[choices,setChoices]=useState('info|Informazioni\nappointment|Appuntamento\nsupport|Assistenza\nprices|Prezzi');
 const [loading,setLoading]=useState(false),[fixtureError,setFixtureError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();setFile(null);setFixtureError('');
  setText(kind==='text'?'Messaggio di prova EULab Connect.':kind==='poll'?'Quale servizio desideri provare?':'Allegato di prova EULab Connect.');
  const fixture={image:['image.png','image/png'],document:['document.pdf','application/pdf'],audio:['audio.mp3','audio/mpeg'],video:['video.mp4','video/mp4']}[kind as 'image'|'document'|'audio'|'video'];
  if(!fixture){setLoading(false);return()=>controller.abort();}
  setLoading(true);
  void (async()=>{try{const response=await fetch(new URL('whatsapp-test/'+fixture[0],new URL((window.EULAB_CONFIG?.adminBasePath||'/').replace(/\/?$/,'/'),location.origin)),{signal:controller.signal});if(!response.ok)throw new Error('Modello allegato non disponibile: seleziona un file.');const blob=await response.blob();if(!controller.signal.aborted)setFile(new File([blob],fixture[0],{type:fixture[1]}));}catch(e){if(!controller.signal.aborted)setFixtureError((e as Error).message);}finally{if(!controller.signal.aborted)setLoading(false);}})();
  return()=>controller.abort();
 },[kind]);
 async function payload():Promise<WhatsAppPayload>{
  if(kind==='text')return {kind,to,text};
  if(kind==='poll')return {kind,to,question:text,options:options.split('\n').map(v=>v.trim()).filter(Boolean)};
  if(kind==='interactive'){const rows=choices.split('\n').filter(v=>v.trim()).map(v=>{const [id,...label]=v.split('|');return {id:id.trim(),title:label.join('|').trim()};});return {kind,to,content:interactiveType==='buttons'?{type:'buttons',body:text,actions:rows.map(r=>({type:'reply',id:r.id,label:r.title}))}:{type:'list',body:text,buttonLabel:'Scegli un’opzione',sections:[{title:'Servizi',rows}]}};}
  if(!file)throw new Error('Seleziona un allegato.');
  if(file.size>10_000_000)throw new Error('Allegato troppo grande: massimo 10 MB.');
  const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Lettura allegato fallita'));reader.readAsDataURL(file);});
  return {kind,to,data,filename:file.name.replace(/[^\w.-]/g,'_').slice(-100),caption:text};
 }
 return <form className="chat-compose" onSubmit={e=>{e.preventDefault();void act(async()=>onSend(await payload()));}}>
  <label>Destinatario<input aria-label="Numero destinatario" placeholder="+39 333 1234567" value={to} onChange={e=>setTo(e.target.value)} required/></label>
  <label>Tipo di messaggio<select aria-label="Tipo di messaggio" value={kind} disabled={busy} onChange={e=>{setKind(e.target.value as Kind);}}>{[['text','Testo'],['image','Immagine'],['document','Documento PDF'],['audio','Audio'],['video','Video'],['poll','Sondaggio'],['interactive','Pulsanti e liste']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
  {formats[kind]&&<label>Allegato · massimo 10 MB{file&&<small>Selezionato: {file.name} · {(file.size/1024).toFixed(1)} KB</small>}<input key={kind} disabled={busy||loading} type="file" accept={formats[kind]} onChange={e=>setFile(e.target.files?.[0]||null)} required={!file}/></label>}
  {fixtureError&&<p role="alert">{fixtureError}</p>}
  <label>{kind==='poll'?'Domanda':kind==='text'||kind==='interactive'?'Messaggio':'Didascalia facoltativa'}<textarea aria-label="Testo messaggio" value={text} onChange={e=>setText(e.target.value)} maxLength={kind==='text'?16000:kind==='poll'?160:2000} required={kind==='text'||kind==='poll'||kind==='interactive'}/></label>
  {kind==='interactive'&&<><label>Presentazione<select aria-label="Presentazione interattiva" value={interactiveType} onChange={e=>setInteractiveType(e.target.value as 'buttons'|'list')}><option value="buttons">Pulsanti multipli</option><option value="list">Lista con selezione</option></select></label><label>Scelte · ID|Etichetta, una per riga<textarea aria-label="Scelte interattive" value={choices} onChange={e=>setChoices(e.target.value)} required/></label><div className="interactive-preview" aria-label="Anteprima pulsanti">{choices.split('\n').filter(Boolean).map((line,i)=><span key={i}>{line.split('|').slice(1).join('|')||line}</span>)}</div></>}
  {kind==='poll'&&<label>Opzioni · una per riga (da 2 a 12)<textarea aria-label="Opzioni sondaggio" value={options} onChange={e=>setOptions(e.target.value)} required/></label>}
  <button type="button" className="btn" disabled={busy||loading||!to} onClick={()=>void act(async()=>onTest(await payload()))}>Verifica senza inviare</button>
  <button className="btn primary" disabled={busy||loading||!connected||!to}>Invia messaggio</button>
  <small className="muted">Modelli di collaudo precompilati e modificabili. La verifica controlla i dati senza inviare. Per una prova reale usa il destinatario desiderato e premi Invia messaggio.</small>
 </form>;
}
