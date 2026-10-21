export type {InteractiveAction,InteractiveContent,InteractiveResponse,ProviderCommand,ProviderOperation,ConversationContact,CallIdentity,CallSnapshot,CallCapabilities,CallActionResult} from './interactive.js';
export type {IVRInput,IVRPrompt,IVRChannel,VoiceIVRSession} from './bot.js';
export type {WhatsAppRealtimeEvent,WhatsAppSnapshot,WhatsAppRealtimeStatus,WhatsAppSubscribeOptions,WhatsAppSubscription} from './realtime.js';
export type {WhatsAppBotDefinition,WhatsAppBotNode,WhatsAppBotState,WhatsAppBotTurn,WhatsAppBot} from './bot.js';
export {defineFunctions,functionsResponse,functionCatalogPath} from './functions.js';
export type {AppFunction,FunctionMatrix,AccessResult,ConnectUser} from './functions.js';
import type {AccessResult,ConnectUser} from './functions.js';
import {functionCatalogPath} from './functions.js';
import {whatsappClient} from './whatsapp.js';
export type {WhatsAppSession,WhatsAppArchive,Conversation,WhatsAppMessage,WhatsAppPayload} from './whatsapp.js';
import { createHmac,timingSafeEqual } from 'node:crypto';
export interface LocalUserProfile {localUserId:string;username:string;email:string;displayName:string}
export interface MirroredUser {installationId:string;customerId:string;localUserId:string;subject:string;username?:string;created:boolean;status:'created'|'already_linked'|'recovered';ssoSetupRequired:boolean|null}
export class ConnectServer {
 constructor(private readonly config:{apiUrl:string;installationId:string;secret:string;domain?:string;functionFallbackUrl?:string;catalogUrl?:string;basePath?:string}){}
 async request<T=any>(path:string,method='GET',body?:unknown,accessToken?:string,extra:Record<string,string>={}):Promise<T>{
  const response=await fetch(`${this.config.apiUrl}${path}`,{method,headers:{'Content-Type':'application/json','X-Installation-Id':this.config.installationId,'X-Installation-Secret':this.config.secret,...(accessToken?{Authorization:`Bearer ${accessToken}`} : {}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(`Connect ${response.status}: ${JSON.stringify(result)}`);return result;
 }
 functionUrl(feature:string,path?:string){
  if(!/^[a-z][a-z0-9_.:-]{0,79}$/.test(feature)||!this.config.domain)throw new Error('Dominio o funzione non valido');
  const url=path?new URL(path,this.config.domain):new URL(`${(this.config.functionFallbackUrl||this.config.domain+'/eulab/connect/functions').replace(/\/$/,'')}/${encodeURIComponent(feature)}`);
  if(url.origin!==this.config.domain)throw new Error('URL funzione esterno al dominio autorizzato');return url.href;
 }
 authorize(accessToken:string,permission:string){return this.request<{allowed:boolean;reason:string}>('/v1/authorize','POST',{installationId:this.config.installationId,permission},accessToken);}
 whatsapp(accessToken:string|(()=>Promise<string>)){return whatsappClient(async(path,method,body,extra)=>this.request(path,method,body,typeof accessToken==='function'?await accessToken():accessToken,extra),this.config.installationId,{apiUrl:this.config.apiUrl});}
 registerFunctions(url?:string){const source=url||this.config.catalogUrl||(this.config.domain?this.config.domain+(this.config.basePath||'')+functionCatalogPath:undefined);if(!source)throw new Error('URL funzioni o dominio richiesto');return this.request('/v1/catalog-source','POST',{url:source});}
 mirrorUser(user:LocalUserProfile){return this.request<MirroredUser>('/v1/users/mirror','POST',user);}
 permissions(accessToken:string){return this.request<AccessResult>('/v1/access','GET',undefined,accessToken);}
 notifications(accessToken:string,options:{unread?:boolean;before?:string;beforeId?:string;limit?:number}={}){const query=new URLSearchParams();for(const [key,value] of Object.entries(options))if(value!==undefined)query.set(key,String(value));return this.request('/v1/notifications?'+query,'GET',undefined,accessToken);}
 markNotification(accessToken:string,id:string,read=true){return this.request('/v1/notifications/'+encodeURIComponent(id)+'/read','PUT',{read},accessToken);}
 markAllNotificationsRead(accessToken:string){return this.request('/v1/notifications/read-all','POST',undefined,accessToken);}
 accountSecurity(accessToken:string){return this.request('/v1/security/me','GET',undefined,accessToken);}
 revokeTrustedDevice(accessToken:string,id:string){return this.request('/v1/security/devices/'+encodeURIComponent(id),'DELETE',undefined,accessToken);}
 sessions(accessToken:string){return this.request('/v1/sessions','GET',undefined,accessToken);}
 logoutSession(accessToken:string,id:string){return this.request(`/v1/sessions/${encodeURIComponent(id)}/logout`,'POST',undefined,accessToken);}
 logoutAllSessions(accessToken:string){return this.request('/v1/sessions/logout-all','POST',undefined,accessToken);}
 users(accessToken:string){return this.request<ConnectUser[]>('/v1/users','GET',undefined,accessToken);}
 async requireFunction(accessToken:string,functionKey:string){const result=await this.authorize(accessToken,functionKey);if(!result.allowed)throw new Error('Funzione non consentita: '+result.reason);}

 redeemTechnicalTicket(ticket:string){return this.request('/v1/technical/redeem','POST',{ticket});}
 static async pair(apiUrl:string,code:string,domain:string){const r=await fetch(`${apiUrl}/v1/pairing/redeem`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,domain})});if(!r.ok)throw new Error('Associazione fallita');return r.json();}
}
export function verifyWebhook(secret:string,rawBody:string,timestamp:string,received:string,now=Date.now()){
 if(!/^\d+$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300||!/^[a-f0-9]{64}$/.test(received))return false;
 const expected=createHmac('sha256',secret).update(`${timestamp}.${rawBody}`).digest();return timingSafeEqual(expected,Buffer.from(received,'hex'));
}
// Persist event IDs in the consumer database before applying side effects; signatures alone do not deduplicate events.
