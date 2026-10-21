import React,{useState} from 'react';
import type {Conversation,WhatsAppMessage} from '../../../packages/sdk/src/whatsapp';
const number=(id:string)=>id.endsWith('@c.us')?'+'+id.split('@')[0]:id.endsWith('@g.us')?'Gruppo WhatsApp':id.endsWith('@lid')?'Contatto WhatsApp':id;
export function ContactAvatar({contact,size='normal'}:{contact:Conversation|null|undefined;size?:'normal'|'large'}){
 const [failed,setFailed]=useState('');const profile=contact?.contact;
 const name=profile?.name||profile?.pushName||number(contact?.chat_id||'WA');
 const url=profile?.avatar;
 const safe=url&&(/^(https:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(url));
 return <span className={`wa-avatar ${size}`} aria-hidden="true">{safe&&failed!==url?<img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(url)}/>:name.replace(/[^\p{L}\p{N} ]/gu,'').split(/\s+/).filter(Boolean).slice(0,2).map(v=>v[0]).join('').toLocaleUpperCase()||'WA'}</span>;
}
export function ConversationItem({conversation:c,active,onSelect}:{conversation:Conversation;active:boolean;onSelect:()=>void}){
 return <button className={`chat-contact wa-contact ${active?'active':''}`} onClick={onSelect} aria-pressed={active}><ContactAvatar contact={c}/><span className="wa-contact-content"><span className="wa-contact-title"><strong>{c.contact?.name||c.contact?.pushName||number(c.chat_id)}</strong><time>{new Date(c.last_message_at).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}</time></span><span className="wa-contact-preview">{c.direction==='out'?'Tu: ':''}{c.preview||`Allegato · ${c.kind}`}</span><span className="wa-contact-meta">{c.contact?.isBusiness?'Account business · ':''}{c.messages} messaggi</span></span></button>;
}
export function ConversationHeading({conversation:c,connected,busy,onRefresh}:{conversation:Conversation|undefined;connected:boolean;busy:boolean;onRefresh:()=>void}){
 return <header className="chat-header wa-conversation-heading"><ContactAvatar contact={c} size="large"/><div><h2>{c?.contact?.name||c?.contact?.pushName||(c?number(c.chat_id):'Le tue conversazioni')}</h2><p className="small muted">{c?number(c.chat_id)+' · ':''}{connected?'Numero collegato':'Archivio consultabile'}</p>{c?.contact?.description&&<p className="wa-contact-description">{c.contact.description}</p>}{c?.contact?.isBusiness&&<span className="wa-business">Account business</span>}</div>{c&&<button type="button" className="btn" disabled={busy||!connected} onClick={onRefresh}>Aggiorna profilo</button>}</header>;
}
export function MessageContent({message:m}:{message:WhatsAppMessage}){
 return <>{m.body.senderName&&m.direction==='in'&&<strong className="wa-message-sender">{m.body.senderName}</strong>}{m.body.quotedText&&<blockquote className="wa-quote">{m.body.quotedText}</blockquote>}<p>{m.body.text}</p>{m.body.interactive&&<div className="wa-interactive-message"><p>{m.body.interactive.body}</p><div className="interactive-preview">{m.body.interactive.type==='buttons'?m.body.interactive.actions.map((a,i)=><span key={i}>{a.label}</span>):m.body.interactive.sections.flatMap(s=>s.rows).map(r=><span key={r.id}>{r.title}</span>)}</div>{m.body.interactive.footer&&<small>{m.body.interactive.footer}</small>}</div>}{m.body.selectedButtonId&&<small className="wa-selection">Scelta: {m.body.text||m.body.selectedButtonId}</small>}</>;
}
