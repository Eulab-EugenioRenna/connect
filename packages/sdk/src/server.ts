import {automationClient} from './automations.js';
export type {AutomationChannel,AutomationDelegationInput,AutomationDelegation,AutomationGrant,AutomationScope,AutomationVerification,DelegatedMessageInput,DelegatedMessageStatus,DelegatedMessageWithdrawal,WebhookRegistration,ConnectWebhookEvent,WhatsAppMessageEventPayload} from './automations.js';
export type {InteractiveAction,InteractiveContent,InteractiveResponse,ProviderCommand,ProviderOperation,ConversationContact,CallIdentity,CallSnapshot,CallCapabilities,CallActionResult} from './interactive.js';
export type {IVRInput,IVRPrompt,IVRChannel,VoiceIVRSession} from './bot.js';
export type {WhatsAppRealtimeEvent,WhatsAppSnapshot,WhatsAppRealtimeStatus,WhatsAppSubscribeOptions,WhatsAppSubscription} from './realtime.js';
export type {WhatsAppBotDefinition,WhatsAppBotNode,WhatsAppBotState,WhatsAppBotTurn,WhatsAppBot} from './bot.js';
export {defineFunctions,functionsResponse,functionCatalogPath} from './functions.js';
export type {AppFunction,FunctionMatrix,AccessResult,ConnectUser,TeamFunction,TeamRole,TeamUser,TeamOverview,TeamRoleInput,TeamUserAssignment,TeamRevocation,TeamRestore} from './functions.js';
import type {AccessResult,ConnectUser,TeamFunction,TeamOverview,TeamRole,TeamRoleInput,TeamUser,TeamUserAssignment,TeamRevocation,TeamRestore} from './functions.js';
import {functionCatalogPath} from './functions.js';
import {whatsappClient} from './whatsapp.js';
export type {WhatsAppSession,WhatsAppArchive,Conversation,WhatsAppMessage,WhatsAppPayload} from './whatsapp.js';
import { createHmac,timingSafeEqual } from 'node:crypto';
export interface LocalUserProfile {localUserId:string;username:string;email:string;displayName:string;
 // Password verificata localmente poco prima della chiamata. Serve solo a inizializzare una nuova identità:
 // Connect la inoltra al provider nella richiesta di creazione e non la conserva.
 initialPassword?:string; initialPasswordTemporary?:boolean}
export interface MirroredUser {installationId:string;customerId:string;localUserId:string;subject:string;username?:string;created:boolean;status:'created'|'already_linked'|'recovered';ssoSetupRequired:boolean|null}
export interface ApplicationTeamUserInput {
 localUser:{localUserId:string;username?:string;email:string;firstName:string;lastName:string;role:'manager'|'reception'|'collaborator';permissions:string[]};
 roleIds:string[];initialPassword?:string;initialPasswordTemporary?:boolean;
}
export interface ApplicationMirrorInput extends LocalUserProfile {
 application:{sourceId:string;localTenantId:string;firstName:string;lastName:string;role:'manager'|'reception'|'collaborator';permissions:string[];roleIds:string[]};
}
export interface ApplicationTeamUserResult extends MirroredUser {appId:string;sourceId:string;localTenantId:string;roleIds:string[];applicationAccess:boolean}
/** Business failures preserve a valid application session; uncertain outcomes require an explicit read/retry. */
export class ConnectApiError extends Error {
 readonly code:string;
 constructor(readonly status:number,result:{code?:string;message?:unknown}){
  super(`Connect ${status}: ${JSON.stringify(result)}`);this.name='ConnectApiError';this.code=typeof result.code==='string'?result.code:status===401?'authentication_required':status===403?'forbidden':status===400?'invalid_input':status===409?'conflict':'service_unavailable';
 }
}
export type OnboardingRequestState='pending'|'approved'|'migrating'|'completed'|'rejected'|'expired'|'failed';
export type OnboardingNextAction='wait'|'sign_in'|'choose_connect_password'|'resubmit'|'contact_admin'|'closed';
export interface OnboardingRequestStatus {requestId:string;state:OnboardingRequestState;nextAction?:OnboardingNextAction}
export interface OnboardingPasswordRecovery {requestId:string;localTenantId:string;localUserId:string;email:string;consentVersion:string;newPassword:string}

export interface AuthorizedConnectContext {
 tenant:{id:string;name:string;slug:string};
 binding:{customerId:string;installationId:string;secret:string};
 user:{id:string;subject:string;email:string;firstName:string;lastName:string;role:'owner'|'manager'|'reception'|'collaborator';permissions:string[]};
}
export interface ApprovedApplicationConfiguration {sourceId:string;appId:string;issuer:string;clientId:string;redirectUri:string;clientSecret?:string}
export interface DeploymentMetadata {name:string;environment:'development'|'staging'|'production';origins:string[];catalogUrl?:string;oidcCallbacks?:string[]}
export type AppOnboardingLoginContext={status:'configuration_required';appId:string;context:AuthorizedConnectContext}|{status:'connect';context:AuthorizedConnectContext}|{status:'not_found';request?:OnboardingRequestStatus};
export interface AppOnboardingMigrationRequest {
 kind:'migration';
 consentVersion:string;
 localTenant:{id:string;name:string;slug:string};
 localUser:{id:string;email:string;firstName:string;lastName:string;role:'owner'|'manager'|'reception'|'collaborator';permissions:string[]};
 /** Password verificata localmente: transito cifrato a TTL, mai restituita o registrata in chiaro. */
 initialPassword:string;
}
export interface AppOnboardingActivationRequest {
 kind:'activation';
 companyName:string;
 applicant:{email:string;firstName:string;lastName:string};
 initialPassword:string;
}
export type AppOnboardingRequest=AppOnboardingMigrationRequest|AppOnboardingActivationRequest;
/** Errore del contratto sorgente: lo stato HTTP resta disponibile al chiamante. */
export class ConnectOnboardingError extends Error {
 constructor(readonly status:number,message:string){super(message);this.name='ConnectOnboardingError';}
}
/**
 * Client backend della sorgente/deployment per l'onboarding assistito.
 * Non va usato nel browser: il segreto bootstrap resta sul server della sorgente.
 * `submit` non sostituisce mai una credenziale già acquisita con la stessa chiave.
 */
export class ConnectOnboardingSource {
 constructor(private readonly config:{apiUrl:string;sourceId:string;appId:string;secret:string;presenterId?:string;deployment?:DeploymentMetadata}){}
 private async post<T>(path:string,body:Record<string,unknown>,idempotencyKey?:string):Promise<T>{
  const url=new URL('/v1/app-onboarding/'+path,this.config.apiUrl);
  const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.config.secret,'X-Connect-Source':this.config.sourceId,...(this.config.presenterId?{'X-Connect-Presenter':this.config.presenterId}:{}),
    ...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},
   body:JSON.stringify({schemaVersion:1,appId:this.config.appId,sourceId:this.config.sourceId,...(this.config.deployment?{deployment:this.config.deployment}:{}),...body})});
  const text=await response.text();
  let result:any=null;try{result=text?JSON.parse(text):null;}catch{result=null;}
  if(!response.ok)throw new ConnectOnboardingError(response.status,`Connect onboarding ${response.status}`);
  if(!result||typeof result!=='object')throw new ConnectOnboardingError(response.status,'Risposta onboarding non valida');
  return result as T;
 }
 private status(value:OnboardingRequestStatus):OnboardingRequestStatus{
  if(!value||typeof value.requestId!=='string'||!['pending','approved','migrating','completed','rejected','expired','failed'].includes(value.state))throw new ConnectOnboardingError(502,'Risposta onboarding non valida');
  const known=['wait','sign_in','choose_connect_password','resubmit','contact_admin','closed'];
  return {requestId:value.requestId,state:value.state,...(value.nextAction?{nextAction:known.includes(value.nextAction)?value.nextAction:'contact_admin' as const}:{})};
 }
 configuration(){return this.post<{status:'pending'|'configuration_required';plannedAppId?:string}|{status:'ready';configuration:ApprovedApplicationConfiguration}>('configuration',{});}
 async recoverPassword(input:OnboardingPasswordRecovery,idempotencyKey:string){return this.status(await this.post<OnboardingRequestStatus>('password-recovery',input as unknown as Record<string,unknown>,idempotencyKey));}
 async loginContext(email:string):Promise<AppOnboardingLoginContext>{
  const value=await this.post<AppOnboardingLoginContext>('login-context',{email});
  if(value.status==='not_found')return {status:'not_found',...(value.request?{request:this.status(value.request)}:{})};
  if(value.status==='connect'||value.status==='configuration_required'){
   const c=value.context,strings=(v:unknown[])=>v.every(x=>typeof x==='string'&&x.length>0);
   if(c?.tenant&&c?.binding&&c?.user&&strings([c.tenant.id,c.tenant.name,c.tenant.slug,c.binding.customerId,c.binding.installationId,c.binding.secret,c.user.id,c.user.subject,c.user.email])&&typeof c.user.firstName==='string'&&typeof c.user.lastName==='string'&&['owner','manager','reception','collaborator'].includes(c.user.role)&&Array.isArray(c.user.permissions)&&c.user.permissions.every(p=>typeof p==='string'))return value;
  }
  throw new ConnectOnboardingError(502,'Risposta onboarding non valida');
 }
 async submit(request:AppOnboardingRequest,idempotencyKey:string){
  if(!idempotencyKey||idempotencyKey.length<8||idempotencyKey.length>200)throw new Error('Idempotency-Key non valida');
  return this.status(await this.post<OnboardingRequestStatus>('requests',request as unknown as Record<string,unknown>,idempotencyKey));
 }
}
export class ConnectServer {
 constructor(private readonly config:{apiUrl:string;installationId:string;secret:string;domain?:string;functionFallbackUrl?:string;catalogUrl?:string;basePath?:string;requestTimeoutMs?:number}){}
 async request<T=any>(path:string,method='GET',body?:unknown,accessToken?:string,extra:Record<string,string>={}):Promise<T>{
  const response=await fetch(`${this.config.apiUrl}${path}`,{method,...(this.config.requestTimeoutMs?{signal:AbortSignal.timeout(this.config.requestTimeoutMs),redirect:'error' as const}:{}),headers:{'Content-Type':'application/json','X-Installation-Id':this.config.installationId,'X-Installation-Secret':this.config.secret,...(accessToken?{Authorization:`Bearer ${accessToken}`} : {}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new ConnectApiError(response.status,result);return result;
 }
 functionUrl(feature:string,path?:string){
  if(!/^[a-z][a-z0-9_.:-]{0,79}$/.test(feature)||!this.config.domain)throw new Error('Dominio o funzione non valido');
  const url=path?new URL(path,this.config.domain):new URL(`${(this.config.functionFallbackUrl||this.config.domain+'/eulab/connect/functions').replace(/\/$/,'')}/${encodeURIComponent(feature)}`);
  if(url.origin!==this.config.domain)throw new Error('URL funzione esterno al dominio autorizzato');return url.href;
 }
 authorize(accessToken:string,permission:string){return this.request<{allowed:boolean;reason:string}>('/v1/authorize','POST',{installationId:this.config.installationId,permission},accessToken);}
 whatsapp(accessToken:string|(()=>Promise<string>)){return whatsappClient(async(path,method,body,extra)=>this.request(path,method,body,typeof accessToken==='function'?await accessToken():accessToken,extra),this.config.installationId,{apiUrl:this.config.apiUrl});}
 /** Backend only. Supply a personal token for creation/recovery; workers use the stored delegation credential. */
 automations(accessToken?:string|(()=>Promise<string>)){return automationClient(async(path,method,body,extra)=>this.request(path,method,body,typeof accessToken==='function'?await accessToken():accessToken,extra),this.config.installationId);}
 registerFunctions(url?:string){const source=url||this.config.catalogUrl||(this.config.domain?this.config.domain+(this.config.basePath||'')+functionCatalogPath:undefined);if(!source)throw new Error('URL funzioni o dominio richiesto');return this.request('/v1/catalog-source','POST',{url:source});}
 /**
  * Crea o recupera l'identità centrale collegata all'utente locale.
  *
  * `initialPassword` deve provenire da una verifica locale appena conclusa e viene usata
  * soltanto per inizializzare una nuova identità nel provider. Non viene conservata da
  * Connect, non compare nelle risposte e non viene applicata a identità già esistenti.
  * Le chiamate esistenti senza il campo mantengono il comportamento precedente.
  */
 requestTeamPasswordReset(accessToken:string,subject:string){return this.request<{requested:true}>('/v1/team/users/'+encodeURIComponent(subject)+'/password-reset','POST',{},accessToken);}
 mirrorUser(user:LocalUserProfile){return this.request<MirroredUser>('/v1/users/mirror','POST',user);}
 async mirrorApplicationUser(accessToken:string,user:ApplicationMirrorInput){
  try{return await this.request<ApplicationTeamUserResult>('/v1/users/mirror','POST',user,accessToken);}
  catch(error){if(error instanceof ConnectApiError)throw error;throw new ConnectApiError(0,{code:'mirror_outcome_uncertain',message:'Esito incerto: verifica e riprendi esplicitamente sullo stesso ID locale'});}
 }
 teamOverview(accessToken:string){return this.request<TeamOverview>('/v1/team','GET',undefined,accessToken);}
 teamUsers(accessToken:string){return this.request<TeamUser[]>('/v1/team/users','GET',undefined,accessToken);}
 teamRoles(accessToken:string){return this.request<TeamRole[]>('/v1/team/roles','GET',undefined,accessToken);}
 teamFunctions(accessToken:string){return this.request<TeamFunction[]>('/v1/team/functions','GET',undefined,accessToken);}
 createTeamRole(accessToken:string,role:TeamRoleInput){return this.request<TeamRole>('/v1/team/roles','POST',role,accessToken);}
 updateTeamRole(accessToken:string,id:string,role:TeamRoleInput){return this.request<TeamRole>('/v1/team/roles/'+encodeURIComponent(id),'PUT',role,accessToken);}
 deleteTeamRole(accessToken:string,id:string){return this.request<{removed:boolean}>('/v1/team/roles/'+encodeURIComponent(id),'DELETE',undefined,accessToken);}
 setTeamUserRoles(accessToken:string,subject:string,roleIds:string[]){return this.request<TeamUserAssignment>('/v1/team/users/'+encodeURIComponent(subject)+'/roles','PUT',{roleIds},accessToken);}
 revokeTeamUser(accessToken:string,subject:string){return this.request<TeamRevocation>('/v1/team/users/'+encodeURIComponent(subject),'DELETE',undefined,accessToken);}
 restoreTeamUser(accessToken:string,subject:string){return this.request<TeamRestore>('/v1/team/users/'+encodeURIComponent(subject)+'/restore','POST',undefined,accessToken);}
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
