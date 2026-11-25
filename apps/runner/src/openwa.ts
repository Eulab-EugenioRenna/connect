import type {InteractiveContent,InteractiveResponse,ProviderCommand,ConversationContact} from '../../../packages/sdk/src/interactive.js';
import {mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {required} from '../../api/src/config.js';
import {readChatIds} from './openwa-history.js';
/** The provider said no before sending anything: the message did not leave. */
export class ProviderRejected extends Error {}
export interface WaClient {
 sendInteractive(to:string,content:InteractiveContent):Promise<string>;
 onInteractiveResponse(fn:(response:InteractiveResponse)=>void):Promise<unknown>;
 onCallState(fn:(call:any)=>void):Promise<unknown>;
 onIncomingCall(fn:(call:any)=>void):Promise<unknown>;
 operation(command:ProviderCommand):Promise<unknown>;

 getHostNumber():Promise<string>;getAllChats():Promise<any[]>;getAllMessagesInChat(id:string,includeMe:boolean,notifications:boolean):Promise<any[]>;
 onAnyMessage(fn:(m:any)=>void):Promise<unknown>;onStateChanged(fn:(state:string)=>void):Promise<unknown>;onAck(fn:(ack:any)=>void):Promise<unknown>;
 sendText(to:string,text:string):Promise<string>;sendFile(to:string,data:string,name:string,caption:string):Promise<string|boolean>;
 sendPoll(to:string,question:string,options:string[]):Promise<string|boolean>;
 decryptMedia(message:any):Promise<string>;logout(preserve?:boolean):Promise<boolean>;kill():Promise<unknown>;
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
  const core=await wa.createClient({sessionId,driver:new driverModule.PuppeteerDriver(),sessionDataPath:profile,
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
  return {
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
   onAnyMessage:async fn=>raw.onAnyMessage(fn),onStateChanged:async fn=>raw.onStateChanged(fn),onAck:async fn=>raw.onAck(fn),
   sendText:(to,text)=>raw.sendText(to,text),sendFile:(to,data,name,caption)=>raw.sendFile(to,data,name,{caption}),
   sendPoll:(to,question,options)=>raw.sendPoll(to,question,options),decryptMedia:message=>raw.decryptMedia(message),
   // Logout uses the public evaluate API. Failure remains unconfirmed in audit.
   logout:async()=>await raw.evaluate(()=>{const api=(globalThis as any).WAPI;if(typeof api?.logout!=='function')throw new Error('LOGOUT_NOT_SUPPORTED');return api.logout();},undefined)===true,
   kill:()=>raw.stop('eulab-stop')
  };
 }
 async cancelPending(id?:string){if(id){await this.pending.get(id)?.();return;}await Promise.allSettled([...this.pending.values()].map(stop=>stop()));}
 profile(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('ID sessione non valido');return path.join(required('OPENWA_PROFILE_DIR'),id);}
 async removeAuthentication(id:string){await rm(this.profile(id),{recursive:true,force:true});}
 /** One send at a time per WhatsApp number: media confirmations are matched by file size, so parallel sends of the same photo steal each other's confirmation. */
 private sending=new WeakMap<WaClient,Promise<unknown>>();
 static sendTimeoutMs=90_000;
 send(client:WaClient,p:any):Promise<string>{
  const previous=this.sending.get(client)??Promise.resolve();
  const run=previous.catch(()=>undefined).then(()=>{
   let timer:NodeJS.Timeout|undefined;
   // A confirmation that never comes must not hold the line for the next messages.
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('PROVIDER_TIMEOUT')),OpenWaAdapter.sendTimeoutMs);});
   return Promise.race([this.sendNow(client,p),timeout]).finally(()=>clearTimeout(timer));
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
}
