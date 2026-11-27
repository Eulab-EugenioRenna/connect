import type {InteractiveContent,InteractiveResponse,ProviderCommand,ConversationContact} from '../../../packages/sdk/src/interactive.js';
import {mkdir,rm} from 'node:fs/promises';
import {createDecipheriv,createHmac,hkdfSync,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {required} from '../../api/src/config.js';
import {readChatIds} from './openwa-history.js';
import {openChatInPage} from './openwa-page.js';
export {openChatInPage};
/** The provider said no before sending anything: the message did not leave. */
export class ProviderRejected extends Error {}
/** Verified on the phone: no outgoing message appeared. Safe to try again. */
export class NotSent extends Error {}
/** The message exists on the phone but WhatsApp never confirmed it: never resent, checked again later by its ID. */
export class Unconfirmed extends Error {constructor(message:string,readonly messageId?:string){super(message);}}
/** WhatsApp says the number has no account: no attempt is made. */
export class NotOnWhatsApp extends Error {}

/** Provider text without numbers, chat IDs, URLs or long tokens: safe for logs and status. */
export function providerReason(error:unknown){
 const raw=error instanceof Error?error.message:typeof error==='string'?error:'';
 const code=(error as {code?:unknown})?.code;
 if(/^[A-Z_]{3,60}$/.test(raw))return raw;
 if(typeof code==='string'&&/^[A-Z_]{3,60}$/.test(code))return code;
 const clean=raw.replace(/https?:\/\/\S+/g,'[url]').replace(/[\w.+-]*@[\w.-]+/g,'[id]').replace(/[A-Za-z0-9+/=_-]{24,}/g,'[…]').replace(/\d{3,}/g,'#').replace(/\s+/g,' ').trim().slice(0,120);
 return clean||'PROVIDER_ERROR';
}

const MEDIA_HOST='https://mmg.whatsapp.net';
const MEDIA_INFO:Record<string,string>={image:'Image',sticker:'Image',video:'Video',gif:'Video',audio:'Audio',ptt:'Audio',document:'Document'};
/**
 * WhatsApp media: AES-256-CBC with keys from HKDF(mediaKey), and a 10-byte MAC after the
 * ciphertext. The MAC is checked, then removed before decrypting (the bundled decrypter
 * kept it and failed with ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH).
 */
export function decryptMediaBytes(encrypted:Buffer,mediaKeyBase64:string,type:string,mimetype?:string){
 const kind=MEDIA_INFO[type]??(mimetype?.startsWith('image/')?'Image':mimetype?.startsWith('video/')?'Video':mimetype?.startsWith('audio/')?'Audio':'Document');
 const keys=Buffer.from(hkdfSync('sha256',Buffer.from(mediaKeyBase64,'base64'),Buffer.alloc(32),`WhatsApp ${kind} Keys`,112));
 const iv=keys.subarray(0,16),cipherKey=keys.subarray(16,48),macKey=keys.subarray(48,80);
 if(encrypted.length<=10)throw new Error('MEDIA_TOO_SHORT');
 const body=encrypted.subarray(0,-10),mac=encrypted.subarray(-10);
 const expected=createHmac('sha256',macKey).update(iv).update(body).digest().subarray(0,10);
 if(!timingSafeEqual(mac,expected))throw new Error('MEDIA_MAC_MISMATCH');
 const decipher=createDecipheriv('aes-256-cbc',cipherKey,iv);
 return Buffer.concat([decipher.update(body),decipher.final()]);
}
/** Downloads and decrypts one attachment; the result is a data URL. */
export async function decryptWhatsAppMedia(m:any):Promise<string>{
 const url=String(m.deprecatedMms3Url||m.clientUrl||'').trim();
 if(!url.startsWith('https://')||!m.mediaKey||!m.mimetype)throw new Error('MEDIA_FIELDS_MISSING');
 let response:Response|undefined;
 for(let attempt=0;attempt<3;attempt++){
  response=await fetch(url,{headers:{'User-Agent':'WhatsApp/2.2412.54 Mozilla/5.0',Origin:'https://web.whatsapp.com',Referer:'https://web.whatsapp.com/'},signal:AbortSignal.timeout(30_000)});
  if(response.ok||[403,404,410].includes(response.status))break;
  await new Promise(r=>setTimeout(r,1500));
 }
 if(!response?.ok)throw new Error(`MEDIA_DOWNLOAD_HTTP_${response?.status??0}`);
 const data=decryptMediaBytes(Buffer.from(await response.arrayBuffer()),String(m.mediaKey),String(m.type||''),String(m.mimetype));
 return `data:${String(m.mimetype).split(';')[0]};base64,${data.toString('base64')}`;
}
/**
 * Fields the decrypter needs. Recent WhatsApp Web gives only «directPath» (no clientUrl /
 * deprecatedMms3Url): the download URL is rebuilt from it. Without keys the message is read
 * again from the phone by its ID.
 */
export async function mediaSource(message:any,byId:(id:string)=>Promise<any>){
 let m={...message};
 const id=typeof m.id==='string'?m.id:m.id?._serialized;
 if((!m.mediaKey||!m.filehash||!(m.deprecatedMms3Url||m.clientUrl||m.directPath))&&id){
  const fresh=await byId(id).catch(()=>null);
  if(fresh&&typeof fresh==='object')m={...fresh,...Object.fromEntries(Object.entries(m).filter(([,v])=>v!=null&&v!==''))};
 }
 if(!m.deprecatedMms3Url&&!m.clientUrl&&typeof m.directPath==='string'&&m.directPath.startsWith('/'))m.deprecatedMms3Url=MEDIA_HOST+m.directPath;
 return m;
}
/**
 * Runs in WhatsApp Web: the chat model must exist before a photo or file can go to it.
 * Tries the current WhatsApp module (findOrCreateLatestChat, which may answer with a
 * private «@lid» chat) and then the older Store.Chat.find.
 */
interface Outgoing {id:string;type:string;body:string;caption:string;to:string;ack:number|undefined}
const serialized=(value:any):string=>typeof value==='string'?value:typeof value?._serialized==='string'?value._serialized:'';
function outgoing(m:any):Outgoing|undefined{
 if(!m||!(m.fromMe===true||m.id?.fromMe===true))return;
 const id=serialized(m.id);if(!id)return;
 return {id,type:String(m.type||''),body:String(m.body??m.content??''),caption:String(m.caption??''),to:serialized(m.to)||serialized(m.chatId),ack:typeof m.ack==='number'?m.ack:undefined};
}
const mediaTypes:Record<string,string[]>={image:['image'],video:['video','gif'],document:['document'],audio:['audio','ptt']};
/** Is this outgoing message the one we just asked for? Only one send per number runs at a time. */
function sameMessage(p:any,m:Outgoing){
 const to=String(p.to||'');
 // A phone-number chat must be the same number; a privacy ID (@lid) cannot be compared.
 if(m.to.endsWith('@c.us')&&to.endsWith('@c.us')&&m.to.replace(/\D/g,'')!==to.replace(/\D/g,''))return false;
 if(m.to.endsWith('@g.us')&&m.to!==to)return false;
 if(p.kind==='text')return m.type==='chat'&&m.body===String(p.text??'');
 if(mediaTypes[p.kind])return mediaTypes[p.kind].includes(m.type)&&m.caption===String(p.caption??'');
 if(p.kind==='poll')return m.type==='poll_creation';
 return false;
}
/**
 * Outgoing messages and acknowledgements seen on the phone. A send is verified against these,
 * not against the return value of the browser function, which can fail after sending or succeed without sending.
 */
/**
 * WhatsApp Web reports acknowledgements with the bare message key («3EB0…»), while sends and
 * outgoing messages carry the full id («true_<chat>@lid_3EB0…»). Both are matched on the key.
 */
export const messageKey=(id:string)=>id.slice(id.lastIndexOf('_')+1);
export class SendTracker {
 private readonly acks=new Map<string,number>();
 private readonly listeners=new Set<(m:Outgoing)=>void>();
 private readonly ackListeners=new Set<(id:string,ack:number)=>void>();
 message(raw:any){const m=outgoing(raw);if(!m)return;if(m.ack!==undefined)this.ack({id:m.id,ack:m.ack,fromMe:true});for(const fn of this.listeners)fn(m);}
 ack(raw:any){
  const id=serialized(raw?.id),ack=raw?.ack;if(!id||typeof ack!=='number')return;
  const key=messageKey(id),best=ack<0?ack:Math.max(ack,this.acks.get(key)??ack);this.acks.set(key,best);
  if(this.acks.size>2000)this.acks.delete(this.acks.keys().next().value!);
  for(const fn of this.ackListeners)fn(id,best);
 }
 /** Starts watching before the send so a fast confirmation is not missed. */
 watch(p:any){
  const seen:Outgoing[]=[];let wake=()=>{};
  const onMessage=(m:Outgoing)=>{if(sameMessage(p,m)){seen.push(m);wake();}};
  this.listeners.add(onMessage);
  const wait=(ms:number,done:()=>boolean)=>new Promise<void>(resolve=>{
   if(done())return resolve();
   const timer=setTimeout(finish,ms);function finish(){clearTimeout(timer);wake=()=>{};resolve();}
   wake=()=>{if(done())finish();};
  });
  return {
   message:async(id:string|undefined,ms:number)=>{
    const find=()=>id?seen.find(m=>m.id===id)??(seen.length===1?seen[0]:undefined):seen[0];
    await wait(ms,()=>!!find());return find();
   },
   ack:async(id:string,ms:number)=>{
    const current=()=>this.acks.get(messageKey(id));
    const onAck=(ackId:string)=>{if(messageKey(ackId)===messageKey(id))wake();};
    this.ackListeners.add(onAck);
    try{await wait(ms,()=>{const a=current();return a!==undefined&&(a<0||a>=1);});}finally{this.ackListeners.delete(onAck);}
    return current()??0;
   },
   close:()=>{this.listeners.delete(onMessage);},
  };
 }
}
export interface WaClient {
 sendInteractive(to:string,content:InteractiveContent):Promise<string>;
 onInteractiveResponse(fn:(response:InteractiveResponse)=>void):Promise<unknown>;
 onCallState(fn:(call:any)=>void):Promise<unknown>;
 onIncomingCall(fn:(call:any)=>void):Promise<unknown>;
 operation(command:ProviderCommand):Promise<unknown>;

 getHostNumber():Promise<string>;getAllChats():Promise<Array<{id:string;t?:number|null}>>;getAllMessagesInChat(id:string,includeMe:boolean,notifications:boolean):Promise<any[]>;
 onAnyMessage(fn:(m:any)=>void):Promise<unknown>;onStateChanged(fn:(state:string)=>void):Promise<unknown>;onAck(fn:(ack:any)=>void):Promise<unknown>;
 sendText(to:string,text:string):Promise<string>;sendFile(to:string,data:string,name:string,caption:string):Promise<string|boolean>;
 sendPoll(to:string,question:string,options:string[]):Promise<string|boolean>;
 decryptMedia(message:any):Promise<string>;logout(preserve?:boolean):Promise<boolean>;kill():Promise<unknown>;
 /** 200 has WhatsApp, 404 has not, null unknown. */
 checkNumber?(to:string):Promise<number|null>;
 /** Current acknowledgement of a sent message: -1 error, 0 waiting, 1 server, 2 delivered, 3 read; null not found. */
 messageAck?(id:string):Promise<number|null>;
 /** Opens the chat in WhatsApp Web without writing in it: media can be sent only to an open chat. chatId: where to send (it may be a private «@lid» id). */
 openChat?(to:string):Promise<{state:'exists'|'opened'|'missing'|'unsupported';chatId:string|null;via:string}>;
}
// Only this adapter depends on OpenWAUnlocked's lifecycle and method names.
export class OpenWaAdapter {
 private readonly pending=new Map<string,()=>Promise<void>>();
 protected async loadProvider(){
  const coreName='@eulab/openwaunlocked-core',clientName='@eulab/openwaunlocked-client',driverName='@eulab/openwaunlocked-driver-puppeteer',qrName='qrcode';
  return Promise.all([import(coreName),import(clientName),import(driverName),import(qrName)]);
 }
 /** link: number to pair with an 8-character code typed on the phone, instead of the QR. */
 async create(sessionId:string,onQR:(qr:string)=>Promise<void>,link?:{phone:string;onLinkCode:(code:string)=>Promise<void>}):Promise<WaClient>{
  const [wa,clientModule,driverModule,qrModule]=await this.loadProvider();
  const profile=path.join(this.profile(sessionId),'openwaunlocked');await mkdir(profile,{recursive:true,mode:0o700});
  const core=await wa.createClient({sessionId,driver:await this.persistentDriver(driverModule.PuppeteerDriver,sessionId),sessionDataPath:profile,
   sessionDataEncryptionKey:Buffer.from(required('DATA_ENCRYPTION_KEY'),'hex').toString('base64'),headless:true,executablePath:process.env.CHROMIUM_PATH,
   browserArgs:['--no-sandbox','--disable-dev-shm-usage'],allowDangerousBrowserArgs:true,
   qrTimeoutMs:180000,authTimeoutMs:180000,navigationTimeoutMs:60000,
   ...(link?{linkCode:link.phone.replace(/\D/g,'')}:{}),
   logConsole:false,logConsoleErrors:false,
   deleteSessionDataOnLogout:true,killClientOnLogout:false});
  const raw=new clientModule.Client({client:core,transport:core.getTransport()});
  this.pending.set(sessionId,()=>raw.stop('eulab-cancel'));
  const qrListener=(event:any)=>{
   const value=event.details?.qr;if(typeof value!=='string')return;
   void (async()=>{const qr=qrModule.default||qrModule;await onQR(await qr.toDataURL(value,{width:320,errorCorrectionLevel:'M'}));})().catch(()=>console.error('Persistenza QR fallita',sessionId));
  };
  core.events.on('launch.auth.qr.generated',qrListener);
  const codeListener=(event:any)=>{
   const value=event.details?.linkCode;if(!link||typeof value!=='string'||!/^[A-Z0-9-]{8,9}$/i.test(value))return;
   void link.onLinkCode(value.toUpperCase()).catch(()=>console.error('Persistenza codice di collegamento fallita',sessionId));
  };
  core.events.on('launch.auth.linkCode.generated',codeListener);
  try{await raw.start();}
  catch(error){await raw.stop('eulab-start-failed').catch(()=>undefined);throw error;}
  finally{core.events.off('launch.auth.qr.generated',qrListener);core.events.off('launch.auth.linkCode.generated',codeListener);this.pending.delete(sessionId);}
  // One provider subscription, shared by the archive and by send verification.
  const tracker=new SendTracker(),messageListeners=new Set<(m:any)=>void>(),ackListeners=new Set<(a:any)=>void>();
  await raw.onAnyMessage((m:any)=>{tracker.message(m);for(const fn of messageListeners)fn(m);});
  await raw.onAck((a:any)=>{tracker.ack(a);for(const fn of ackListeners)fn(a);});
  const client:WaClient={
   sendInteractive:(to,content)=>raw.sendInteractive(to,content),
   onInteractiveResponse:async fn=>raw.onInteractiveResponse(fn),
   onIncomingCall:async fn=>raw.onIncomingCall(fn),onCallState:async fn=>raw.onCallState(fn),
   operation:async command=>{
    switch(command.kind){
     case 'contact.refresh':{
      const [contact,avatar]=await Promise.all([raw.getContact(command.chatId),raw.getProfilePic(command.chatId).catch(()=>null)]);
      const bounded=(value:unknown,max=200)=>typeof value==='string'?value.slice(0,max):null;
      const profile:ConversationContact={name:bounded(contact?.name||contact?.formattedName),pushName:bounded(contact?.pushname),description:bounded(contact?.status,1000),avatar:typeof avatar==='string'&&avatar.length<=2000000&&(/^(https:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(avatar))?avatar:null,isBusiness:contact?.isBusiness===true,isGroup:command.chatId.endsWith('@g.us'),updatedAt:new Date().toISOString()};
      return profile;
     }
     case 'call.inspect':return {capabilities:await raw.getCallCapabilities(),active:await raw.getActiveCall()};
     case 'call.start':return raw.startCall(command.to);
     case 'call.accept':return raw.acceptCall(command.call);
     case 'call.reject':return raw.rejectCall(command.call);
     case 'call.end':return raw.endCall(command.call);
     case 'call.mute':return raw.muteCall(command.call,command.muted);
    }
   },
   getHostNumber:()=>raw.getHostNumber(),getAllChats:()=>raw.evaluate(readChatIds,undefined),
   getAllMessagesInChat:(id,includeMe,notifications)=>raw.getAllMessages(id,includeMe,notifications),
   onAnyMessage:async fn=>{messageListeners.add(fn);},onStateChanged:async fn=>raw.onStateChanged(fn),onAck:async fn=>{ackListeners.add(fn);},
   sendText:(to,text)=>raw.sendText(to,text),sendFile:(to,data,name,caption)=>raw.sendFile(to,data,name,{caption}),
   sendPoll:(to,question,options)=>raw.sendPoll(to,question,options),decryptMedia:async message=>decryptWhatsAppMedia(await mediaSource(message,id=>raw.getMessageById(id))),
   checkNumber:async to=>{const r=await raw.checkNumberStatus(to);return r?.status===404?404:r?.numberExists===true||r?.status===200?200:null;},
   messageAck:async id=>{const m=await raw.getMessageById(id);return m&&typeof m.ack==='number'?m.ack:null;},
   openChat:to=>raw.evaluate(openChatInPage,to),
   // Logout uses the public evaluate API. Failure remains unconfirmed in audit.
   logout:async()=>await raw.evaluate(()=>{const api=(globalThis as any).WAPI;if(typeof api?.logout!=='function')throw new Error('LOGOUT_NOT_SUPPORTED');return api.logout();},undefined)===true,
   kill:()=>raw.stop('eulab-stop')
  };
  this.trackers.set(client,tracker);
  return client;
 }
 private readonly trackers=new WeakMap<WaClient,SendTracker>();
 /** How long the phone has to show the outgoing message, and WhatsApp to accept it (ack 1). */
 static verify={afterResultMs:30_000,afterErrorMs:20_000,ackMs:60_000};
 async cancelPending(id?:string){if(id){await this.pending.get(id)?.();return;}await Promise.allSettled([...this.pending.values()].map(stop=>stop()));}
 profile(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('ID sessione non valido');return path.join(required('OPENWA_PROFILE_DIR'),id);}
 async removeAuthentication(id:string){await rm(this.profile(id),{recursive:true,force:true});}
 /**
  * Chrome keeps WhatsApp Web's login (IndexedDB) in its profile. OpenWAUnlocked launches a
  * throwaway profile inside the container and its own checkpoint is never written, so every
  * runner restart or new image asked for a new QR. The profile lives on the /profiles volume
  * instead: it survives restarts and image changes, and removeAuthentication still wipes it.
  * Chrome's single-instance locks left by a killed container would block the next launch.
  */
 chromeProfile(id:string){return path.join(this.profile(id),'chrome');}
 protected async persistentDriver(Base:new()=>any,sessionId:string){
  const dir=this.chromeProfile(sessionId);await mkdir(dir,{recursive:true,mode:0o700});
  await Promise.all(['SingletonLock','SingletonSocket','SingletonCookie'].map(name=>rm(path.join(dir,name),{force:true})));
  return new (class extends Base{launch(options?:any){return super.launch({...options,userDataDir:options?.userDataDir??dir});}})();
 }
 /** One send at a time per WhatsApp number: media confirmations are matched by file size, so parallel sends of the same photo steal each other's confirmation. */
 private sending=new WeakMap<WaClient,Promise<unknown>>();
 static sendTimeoutMs=150_000;
 send(client:WaClient,p:any):Promise<string>{
  const previous=this.sending.get(client)??Promise.resolve();
  const run=previous.catch(()=>undefined).then(()=>{
   let timer:NodeJS.Timeout|undefined;
   // A confirmation that never comes must not hold the line for the next messages.
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('PROVIDER_TIMEOUT')),OpenWaAdapter.sendTimeoutMs);});
   return Promise.race([this.deliver(client,p),timeout]).finally(()=>clearTimeout(timer));
  });
  this.sending.set(client,run.catch(()=>undefined));
  return run;
 }
 private async sendNow(client:WaClient,p:any):Promise<string>{
  let result:unknown;
  switch(p.kind){case 'text':result=await client.sendText(p.to,p.text);break;
   case 'image':case 'document':case 'audio':case 'video':result=await client.sendFile(p.to,p.data,p.filename,p.caption||'');break;
   case 'poll':result=await client.sendPoll(p.to,p.question,p.options);break;
   case 'interactive':result=await client.sendInteractive(p.to,p.content);break;default:throw new Error('UNSUPPORTED_MESSAGE');}
  // false: WhatsApp refused before sending (chat not found). Never sent, safe to report as failed.
  if(result===false)throw new ProviderRejected('PROVIDER_REJECTED');
  if(typeof result!=='string'||!result||result.startsWith('ERROR'))throw new Error('PROVIDER_RESULT_UNCONFIRMED');return result;
 }
 /**
  * Sent only when the phone shows the outgoing message and WhatsApp acknowledges it.
  * No message on the phone: NotSent (retry is safe). Message without acknowledgement: Unconfirmed.
  */
 private async deliver(client:WaClient,p:any):Promise<string>{
  const tracker=this.trackers.get(client);
  if(!tracker||p.kind==='interactive')return this.sendNow(client,p);
  if(String(p.to).endsWith('@c.us')&&client.checkNumber){
   const status=await this.numberStatus(client,String(p.to));
   if(status===404)throw new NotOnWhatsApp('NOT_ON_WHATSAPP');
  }
  // «Start a chat with sendText … before trying to send media»: open the chat first, no extra message.
  if(mediaTypes[p.kind]&&client.openChat){
   const opened=await client.openChat(String(p.to)).catch((error:unknown)=>({state:'missing' as const,chatId:null,via:'error:'+String((error as any)?.message??error).slice(0,120)}));
   if(opened.state!=='exists')console.warn(JSON.stringify({component:'outbox',level:'info',message:'media_chat_opened',result:opened.state,via:opened.via,lid:!!opened.chatId?.endsWith('@lid')}));
   // The chat may live under its private «@lid» id: the media goes there.
   if(opened.chatId&&opened.chatId!==p.to)p={...p,to:opened.chatId};
  }
  const watch=tracker.watch(p),limits=OpenWaAdapter.verify;
  try{
   let id:string|undefined,failure:unknown;
   try{id=await this.sendNow(client,p);}
   catch(error){if(error instanceof ProviderRejected)throw error;failure=error;}
   const seen=await watch.message(id,failure?limits.afterErrorMs:limits.afterResultMs);
   const messageId=seen?.id??id;
   if(!messageId)throw new NotSent(providerReason(failure)==='PROVIDER_RESULT_UNCONFIRMED'?'NOT_ON_PHONE':providerReason(failure));
   const ack=await watch.ack(messageId,limits.ackMs);
   if(ack>=1)return messageId;
   if(ack<0)throw new NotSent('WHATSAPP_ACK_ERROR');
   throw new Unconfirmed(seen?'WHATSAPP_NO_ACK':'NOT_ON_PHONE_NO_ACK',messageId);
  }finally{watch.close();}
 }
 private readonly numbers=new Map<string,{status:number;at:number}>();
 /** A lookup error never blocks a send: only an explicit 404 does. Results are kept for a day. */
 private async numberStatus(client:WaClient,to:string){
  const known=this.numbers.get(to);if(known&&Date.now()-known.at<86_400_000)return known.status;
  const status=await client.checkNumber!(to).catch(()=>null);
  if(status){this.numbers.set(to,{status,at:Date.now()});if(this.numbers.size>20_000)this.numbers.delete(this.numbers.keys().next().value!);}
  return status;
 }
 /** Acknowledgement read again later, for a message on the phone that WhatsApp had not confirmed yet. */
 async ackOf(client:WaClient,id:string){return client.messageAck?client.messageAck(id).catch(()=>null):null;}
}
