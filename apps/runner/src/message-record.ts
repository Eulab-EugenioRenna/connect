import {randomUUID} from 'node:crypto';
import type {Database} from '../../api/src/database.js';
import type {WhatsAppBotService} from '../../api/src/whatsapp-bot.service.js';
import {interactiveContentSchema} from '../../api/src/whatsapp-interactive.js';

/** Shared by history, ordinary provider messages and normalized interactive callbacks. */
export async function recordMessage(db:Database,bots:WhatsAppBotService,session:any,m:any,emit:boolean,media?:string){
 if(!m.id||!session.archive_id)return;
 if(['buttons_response','list_response','native_flow_response','interactive'].includes(m.type))return;
 const interactive=interactiveContentSchema.safeParse(m.interactiveContent),chatId=String(m.chatId||(m.fromMe?m.to:m.from)||'');
 if(!chatId)return;
 const direction=m.fromMe===true?'out':m.fromMe===false?'in':'unknown';
 const providerTime=typeof m.t==='number'&&Number.isFinite(m.t)&&m.t>0&&m.t<8640000000000;
 const occurredAt=providerTime?new Date(m.t*1000):new Date();
 const body={timestampSource:providerTime?'provider':'connect',interactive:interactive.success?interactive.data:null,text:typeof m.body==='string'?m.body:typeof m.caption==='string'?m.caption:'',senderName:typeof m.sender?.pushname==='string'?m.sender.pushname.slice(0,200):null,quotedText:typeof m.quotedMsg?.body==='string'?m.quotedMsg.body.slice(0,2000):null,mimetype:m.mimetype||null,filename:m.filename||null,media:media||null,mediaAvailable:!!media,selectedButtonId:m.selectedButtonId||null,poll:m.pollData||null};
 await db.transaction(async tx=>{
  // Refuse stale callbacks after connection rotation, including callbacks from another installation.
  const source=(await tx.query("SELECT id,number FROM wa_sessions WHERE id=$1 AND installation_id=$2 AND archive_id=$3 AND state='connected' AND closed_at IS NULL AND NOT delete_requested",[session.id,session.installation_id,session.archive_id])).rows[0];if(!source)return;
  const result=await tx.query('INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(archive_id,provider_id) DO NOTHING RETURNING id',[randomUUID(),session.id,session.archive_id,String(m.id),chatId,direction,m.type||'text',JSON.stringify(body),occurredAt]);
  const message=(await tx.query('SELECT * FROM messages WHERE archive_id=$1 AND provider_id=$2 FOR UPDATE',[session.archive_id,String(m.id)])).rows[0];
  if(message.chat_id!==chatId||message.direction!==direction)return;
  if(!result.rowCount&&interactive.success)await tx.query('UPDATE messages SET body=body || $2::jsonb WHERE id=$1',[message.id,JSON.stringify({interactive:interactive.data})]);
  if(!result.rowCount&&media)await tx.query("UPDATE messages SET body=body || $2::jsonb WHERE id=$1 AND body->>'media' IS NULL",[message.id,JSON.stringify({media,mediaAvailable:true})]);
  const selection=m.type==='interactive_response'&&direction==='in'&&typeof m.selectedButtonId==='string'&&m.selectedButtonId.length>0;
  let newSelection=false;
  if(emit){
   const kinds=['message.received',...(selection?['message.interactive_response']:[])];
   for(const kind of kinds){
    if((await tx.query('SELECT event_id FROM wa_message_event_receipts WHERE message_id=$1 AND kind=$2',[message.id,kind])).rows.length)continue;
    // An ordinary callback after normalization must not overwrite/re-emit the selection.
    const eventId=randomUUID(),self=source.number?String(source.number).replace(/@c\.us$/,'')+'@c.us':null;
    const senderId=typeof m.from==='string'?m.from:direction==='out'?self:chatId;
    const recipientId=typeof m.to==='string'?m.to:direction==='in'?self:chatId;
    const payload={messageId:message.id,providerId:String(m.id),sessionId:session.id,messageSessionId:message.session_id,archiveId:session.archive_id,chatId,direction,fromMe:direction==='unknown'?null:direction==='out',senderId,recipientId,occurredAt:new Date(message.occurred_at).toISOString(),observedAt:new Date().toISOString(),timestampSource:message.body.timestampSource||'unknown',source:'whatsapp_provider',addressingVerified:direction!=='unknown'&&!!senderId&&!!recipientId,kind:m.type||'text',body};
    await tx.query('INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,$4,$5)',[eventId,session.installation_id,session.id,kind,JSON.stringify(payload)]);
    await tx.query('INSERT INTO wa_message_event_receipts(message_id,kind,event_id) VALUES($1,$2,$3)',[message.id,kind,eventId]);
    await tx.query('INSERT INTO deliveries(id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM webhook_endpoints WHERE installation_id=$2 AND enabled=true',[eventId,session.installation_id]);
    if(kind==='message.interactive_response')newSelection=true;
   }
  }
  if(newSelection)await tx.query('UPDATE messages SET body=body || $2::jsonb WHERE id=$1',[message.id,JSON.stringify({selectedButtonId:m.selectedButtonId,text:m.body})]);
  if(emit&&(result.rowCount||newSelection)&&direction==='in'&&['chat','text','interactive_response'].includes(m.type||'text')&&typeof m.body==='string'&&m.body.trim()&&m.body.length<=2000&&providerTime&&m.t*1000>=session.bot_ready_at-1000){
   await bots.receive(tx,session,{id:message.id,provider_id:String(m.id),chat_id:chatId,text:m.selectedButtonId||m.body,occurred_at:occurredAt});
  }
 });
}
