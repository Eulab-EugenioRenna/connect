import type {Request,WhatsAppSession} from './whatsapp.js';
export interface WhatsAppRealtimeEvent {id:string;session_id:string;kind:string;created_at:string;payload:Record<string,any>}
export interface WhatsAppSnapshot {
 sessions:(WhatsAppSession&{qr:string|null})[];
 outbox:{id:string;session_id:string;state:string;provider_id:string|null;error:string|null;created_at:string}[];
 bots:{archive_id:string;revision:number;enabled:boolean}[];
}
export type WhatsAppRealtimeStatus='connecting'|'connected'|'reconnecting'|'closed'|'unauthorized'|'error';
export interface WhatsAppSubscribeOptions {
 onEvent?:(event:WhatsAppRealtimeEvent)=>void;
 onSnapshot?:(snapshot:WhatsAppSnapshot)=>void;
 onStatus?:(status:WhatsAppRealtimeStatus)=>void;
 onError?:(error:Error)=>void;
 reconnect?:boolean;
}
export interface WhatsAppSubscription {close():void;readonly status:WhatsAppRealtimeStatus}
export interface RealtimeConfig {apiUrl:string;register?:(close:()=>void)=>()=>void}
/** Receive only: reconnecting this stream never replays an outbound message. */
export function subscribeWhatsApp(request:Request,root:string,config:RealtimeConfig,options:WhatsAppSubscribeOptions):WhatsAppSubscription {
 let stopped=false,socket:WebSocket|undefined,timer:ReturnType<typeof setTimeout>|undefined,attempt=0,status:WhatsAppRealtimeStatus='connecting';
 const seen=new Set<string>();let unregister:(()=>void)|undefined;
 function call<T>(fn:((arg:T)=>void)|undefined,value:T){try{fn?.(value);}catch(error){try{options.onError?.(error instanceof Error?error:new Error(String(error)));}catch{}}}
 function setStatus(value:WhatsAppRealtimeStatus){status=value;call(options.onStatus,value);}
 function finish(value:WhatsAppRealtimeStatus){if(stopped)return;stopped=true;clearTimeout(timer);socket?.close();unregister?.();setStatus(value);}
 function retry(){
  if(stopped)return;
  if(options.reconnect===false||attempt>=8){finish('error');return;}
  setStatus('reconnecting');timer=setTimeout(()=>void connect(),Math.min(1000*2**attempt++,15000));
 }
 async function connect(){
  if(stopped)return;
  let opened:WebSocket|undefined;
  try{
   const ticket=await request<{ticket:string;path:string;expiresAt:string}>(root+'/events/ticket','POST');
   if(stopped)return;
   if(ticket.path!=='/v1/whatsapp/events')throw new Error('Endpoint realtime non valido');
   const url=new URL(config.apiUrl+ticket.path,typeof location==='undefined'?undefined:location.origin);
   if(!['http:','https:'].includes(url.protocol))throw new Error('URL API HTTP(S) richiesto');
   url.protocol=url.protocol==='https:'?'wss:':'ws:';
   socket=opened=new WebSocket(url);let authTimer:ReturnType<typeof setTimeout>|undefined=setTimeout(()=>opened!.close(),10000);
   opened.onopen=()=>{if(stopped){opened!.close();return;}opened!.send(JSON.stringify({type:'authenticate',ticket:ticket.ticket}));};
   opened.onmessage=message=>{
    if(stopped||socket!==opened||typeof message.data!=='string')return;
    let frame:any;try{frame=JSON.parse(message.data);}catch{return;}
    if(frame.type==='ready'){clearTimeout(authTimer);attempt=0;setStatus('connected');}
    else if(frame.type==='snapshot'&&Array.isArray(frame.sessions)&&Array.isArray(frame.outbox)&&Array.isArray(frame.bots))call(options.onSnapshot,{sessions:frame.sessions,outbox:frame.outbox,bots:frame.bots});
    else if(frame.type==='event'&&typeof frame.event?.id==='string'&&typeof frame.event?.kind==='string'){
     if(seen.has(frame.event.id))return;seen.add(frame.event.id);if(seen.size>5000)seen.delete(seen.values().next().value!);call(options.onEvent,frame.event);
    }
   };
   opened.onerror=()=>{call(options.onError,new Error('Connessione realtime non disponibile'));};
   opened.onclose=event=>{clearTimeout(authTimer);if(stopped||socket!==opened)return;if(event.code===4003){finish('unauthorized');return;}retry();};
  }catch(error){
   if(stopped)return;call(options.onError,error instanceof Error?error:new Error(String(error)));
   if([401,403].includes((error as {status?:number})?.status||0)||/401|403|Accedi|scaduta|revocata|session_expired/.test(String(error)))finish('unauthorized');else retry();
  }
 }
 const handle:WhatsAppSubscription={close:()=>finish('closed'),get status(){return status;}};
 unregister=config.register?.(handle.close);setStatus('connecting');void connect();return handle;
}
