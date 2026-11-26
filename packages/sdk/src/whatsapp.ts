import type {InteractiveContent,ProviderCommand,ProviderOperation,ConversationContact,CallIdentity,CallCapabilities,CallSnapshot,CallActionResult} from './interactive.js';
import type {IVRInput,IVRChannel,VoiceIVRSession} from './bot.js';
import {subscribeWhatsApp} from './realtime.js';
import type {RealtimeConfig,WhatsAppSubscribeOptions} from './realtime.js';
import type {WhatsAppBotDefinition,WhatsAppBotState,WhatsAppBot,WhatsAppBotTurn} from './bot.js';
/** sync_mode: full on the first link of a number on the licence, update when the same number is linked again. */
export interface WhatsAppSession {id:string;created_at:string;number:string|null;state:string;archive_id:string|null;runner_id:string;runner_online:boolean;closed_at:string|null;delete_requested:boolean;sync_count:number;sync_status:string;sync_limit:string;sync_mode?:'full'|'update'|null}
export interface WhatsAppArchive {id:string;number:string;installation_id:string;history_synced_at?:string|null}
export interface Conversation {chat_id:string;messages:number;last_message_at:string;preview:string;kind:string;direction:string;contact:ConversationContact|null}
export interface WhatsAppMessage {id:string;chat_id:string;direction:string;kind:string;occurred_at:string;body:{text?:string;media?:string;mediaAvailable?:boolean;filename?:string;mimetype?:string;selectedButtonId?:string;interactive?:InteractiveContent;senderName?:string;quotedText?:string}}
export type WhatsAppPayload={kind:'interactive';to:string;content:InteractiveContent}|{kind:'text';to:string;text:string}|{kind:'image'|'document'|'audio'|'video';to:string;data:string;filename:string;caption?:string}|{kind:'poll';to:string;question:string;options:string[]};
/** state: queued (also between attempts), sending, sent, failed, uncertain, cancelled. attempts counts verified failed tries. */
export interface OutboxItem {id:string;session_id:string;state:string;provider_id:string|null;error:string|null;attempts:number;created_at:string}
export type Request=<T=any>(path:string,method?:string,body?:unknown,headers?:Record<string,string>)=>Promise<T>;
export function whatsappClient(request:Request,installationId:string,realtime:RealtimeConfig={apiUrl:''}){
 const root=`/v1/installations/${encodeURIComponent(installationId)}/whatsapp`;
 const session=(id:string)=>root+`/sessions/${encodeURIComponent(id)}`;
 const archive=(id:string)=>root+`/archives/${encodeURIComponent(id)}`;
 return {
  subscribe:(options:WhatsAppSubscribeOptions)=>subscribeWhatsApp(request,root,realtime,options),
  bot:{
   get:(archiveId:string)=>request<WhatsAppBot>(archive(archiveId)+'/bot'),
   configure:(archiveId:string,definition:WhatsAppBotDefinition,expectedRevision:number)=>request<WhatsAppBot>(archive(archiveId)+'/bot','PUT',{definition,expectedRevision}),
   activate:(archiveId:string,enabled:boolean,expectedRevision:number)=>request<WhatsAppBot>(archive(archiveId)+'/bot/activation','PUT',{enabled,expectedRevision}),
   preview:(definition:WhatsAppBotDefinition,input:string|IVRInput,state:WhatsAppBotState|null=null,channel:IVRChannel='whatsapp')=>request<WhatsAppBotTurn&{sent:false}>(root+'/bot/preview','POST',{definition,input,state,channel})
  },
  ivr:{
   get:(archiveId:string,id:string)=>request<VoiceIVRSession>(archive(archiveId)+`/bot/voice-sessions/${encodeURIComponent(id)}`),
   start:(archiveId:string,callId:string,idempotencyKey=crypto.randomUUID())=>request<VoiceIVRSession>(archive(archiveId)+'/bot/voice-sessions','POST',{callId},{'Idempotency-Key':idempotencyKey}),
   advance:(archiveId:string,id:string,input:IVRInput,expectedTurn:number,idempotencyKey=crypto.randomUUID())=>request<VoiceIVRSession>(archive(archiveId)+`/bot/voice-sessions/${encodeURIComponent(id)}/turns`,'POST',{input,expectedTurn},{'Idempotency-Key':idempotencyKey})
  },
  operations:{
   get:<T=unknown>(id:string)=>request<ProviderOperation<T>>(root+`/operations/${encodeURIComponent(id)}`),
   list:()=>request<ProviderOperation[]>(root+'/operations'),
   submit:(id:string,command:ProviderCommand,idempotencyKey=crypto.randomUUID())=>request<ProviderOperation>(session(id)+'/operations','POST',command,{'Idempotency-Key':idempotencyKey})
  },
  calls:{
   inspect:(id:string)=>request<ProviderOperation<{capabilities:CallCapabilities;active:CallSnapshot|null}>>(session(id)+'/operations','POST',{kind:'call.inspect'},{'Idempotency-Key':crypto.randomUUID()}),
   start:(id:string,to:string,key=crypto.randomUUID())=>request<ProviderOperation<CallActionResult>>(session(id)+'/operations','POST',{kind:'call.start',to},{'Idempotency-Key':key}),
   control:(id:string,action:'accept'|'reject'|'end'|'mute',call:CallIdentity,muted=false,key=crypto.randomUUID())=>request<ProviderOperation<CallActionResult>>(session(id)+'/operations','POST',{kind:'call.'+action,call,...action==='mute'?{muted}:{}},{'Idempotency-Key':key})
  },
  refreshContact:(id:string,chatId:string)=>request<ProviderOperation<ConversationContact>>(session(id)+'/operations','POST',{kind:'contact.refresh',chatId},{'Idempotency-Key':crypto.randomUUID()}),
  sessions:()=>request<WhatsAppSession[]>(root+'/sessions'),
  /** With phone (international form) WhatsApp gives an 8-character code to type on the phone instead of a QR. */
  connect:(options:{phone?:string}={})=>request<{id:string;state:string}>(root+'/sessions','POST',options),
  /** linkCode: set while pairing by phone number; the phone asks for it in «Collega con il numero di telefono». */
  qr:(id:string)=>request<{state:string;method:'qr'|'phone';qr:string|null;linkCode:string|null}>(session(id)+'/qr'),
  send:(id:string,payload:WhatsAppPayload,idempotencyKey=crypto.randomUUID())=>request<{id:string;state:string}>(session(id)+'/messages','POST',payload,{'Idempotency-Key':idempotencyKey}),
  test:(id:string,payload:WhatsAppPayload)=>request<{valid:boolean;kind:string;to:string;connected:boolean;sent:false}>(session(id)+'/messages/test','POST',payload),
  outbox:()=>request<OutboxItem[]>(root+'/outbox'),
  /** One message by its outbox ID, with state, attempts and error. */
  outboxItem:(outboxId:string)=>request<OutboxItem>(root+'/outbox/'+encodeURIComponent(outboxId)),
  /** Withdraws a message not yet left (waiting or between attempts); returns its state afterwards. */
  cancelMessage:(outboxId:string)=>request<OutboxItem>(root+'/outbox/'+encodeURIComponent(outboxId)+'/cancel','POST',{}),
  sendText:(id:string,to:string,text:string,idempotencyKey=crypto.randomUUID())=>request<{id:string;state:string}>(session(id)+'/messages','POST',{kind:'text',to,text},{'Idempotency-Key':idempotencyKey}),
  reconnect:(id:string)=>request(session(id)+'/reconnect','POST'),disconnect:(id:string)=>request(session(id)+'/disconnect','POST'),
  /** Closes a connection. History is never deleted: it stays per licence and number (it goes only with the licence). */
  deleteConnection:(id:string)=>request<{removed:boolean;state:string;historyKept:true}>(session(id),'DELETE'),
  archives:()=>request<WhatsAppArchive[]>(root+'/archives'),
  messages:(id:string,before?:string,chat?:string)=>request<WhatsAppMessage[]>(archive(id)+`/messages?${new URLSearchParams({...before?{before}:{},...chat?{chat}:{}})}`),
  conversations:(id:string)=>request<Conversation[]>(archive(id)+'/conversations'),
  media:(archiveId:string,messageId:string)=>request<{data:string|null;state:'available'|'queued'}>(archive(archiveId)+`/messages/${encodeURIComponent(messageId)}/media`)
 };
}
