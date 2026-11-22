export type {InteractiveAction,InteractiveContent,InteractiveResponse,ProviderCommand,ProviderOperation,ConversationContact,CallIdentity,CallSnapshot,CallCapabilities,CallActionResult} from './interactive.js';
export type {IVRInput,IVRPrompt,IVRChannel,VoiceIVRSession} from './bot.js';
export type {WhatsAppRealtimeEvent,WhatsAppSnapshot,WhatsAppRealtimeStatus,WhatsAppSubscribeOptions,WhatsAppSubscription} from './realtime.js';
export type {WhatsAppBotDefinition,WhatsAppBotNode,WhatsAppBotState,WhatsAppBotTurn,WhatsAppBot} from './bot.js';
export {defineFunctions,functionsResponse,functionCatalogPath} from './functions.js';
export type {AppFunction,FunctionMatrix,AccessResult,ConnectUser,TeamFunction,TeamRole,TeamUser,TeamOverview,TeamRoleInput,TeamUserAssignment,TeamRevocation,TeamRestore} from './functions.js';
import type {AccessResult,ConnectUser,TeamFunction,TeamOverview,TeamRole,TeamRoleInput,TeamUser,TeamUserAssignment,TeamRevocation,TeamRestore} from './functions.js';
import {whatsappClient} from './whatsapp.js';
export type {WhatsAppSession,WhatsAppArchive,Conversation,WhatsAppMessage,WhatsAppPayload} from './whatsapp.js';
export interface BrowserConfig {apiUrl:string;installationId?:string;issuer:string;clientId:string;redirectUri:string;functionFallbackUrl?:string}
export interface LoginOptions {returnTo?:string;prompt?:'login'|'none';action?:'CONFIGURE_TOTP'|'VERIFY_EMAIL'|'UPDATE_PASSWORD';maxAge?:number}
export type LoginResult={status:'authenticated';access:AccessResult|null;returnTo:string;actionStatus:string|null}|{status:'anonymous'}|{status:'error';code:string;message:string};
export class ConnectLoginError extends Error {constructor(readonly code:string,message:string){super(message);this.name='ConnectLoginError';}}
export interface AccountSecurity {totp:boolean;preferredMethod:'auto'|'totp'|'email';emailVerified:boolean;requiredActions:string[];authenticators:{id:string;name:string;createdAt:number}[];trustedDevices:{id:string;name:string;createdAt:number;expiresAt:number}[]}
export interface Notification {id:string;title:string;body:string;created_at:string;read_at:string|null}
export class ConnectBrowser {
 private readonly streams=new Set<()=>void>();
 private accessState:AccessResult|null=null;
 private token:string|null=null;
 private refreshToken:string|null=null;
 private idToken:string|null=null;
 private expiresAt=0;
 private refreshing?:Promise<void>;
 private initializing?:Promise<boolean>;
 private restoring?:Promise<boolean>;
 private sessionVersion=0;
 private get storageKey(){return `connect.session:${this.config.issuer}:${this.config.clientId}`;}
 private clear(){for(const close of this.streams)close();this.streams.clear();this.sessionVersion++;this.refreshing=undefined;this.accessState=null;this.token=null;this.refreshToken=null;this.idToken=null;this.expiresAt=0;sessionStorage.removeItem(this.storageKey);}
 private accept(result:any){if(typeof result?.access_token!=='string'||!result.access_token){this.clear();throw new ConnectLoginError('invalid_token_response','Risposta SSO non valida');}this.sessionVersion++;this.token=result.access_token;this.refreshToken=result.refresh_token||this.refreshToken;this.idToken=result.id_token||this.idToken;this.expiresAt=Date.now()+(result.expires_in||300)*1000;sessionStorage.setItem(this.storageKey,JSON.stringify({refreshToken:this.refreshToken,idToken:this.idToken}));}
 async refresh(){
  if(this.refreshing)return this.refreshing;
  if(!this.refreshToken)throw new ConnectLoginError('session_expired','Sessione SSO scaduta. Accedi di nuovo.');
  const refreshToken=this.refreshToken,version=this.sessionVersion;
  const operation=(async()=>{
   const response=await fetch(`${this.config.issuer}/protocol/openid-connect/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:this.config.clientId,refresh_token:refreshToken}),signal:AbortSignal.timeout(10000)});
   if(version!==this.sessionVersion)throw new ConnectLoginError('session_changed','Sessione modificata durante il rinnovo');
   if(!response.ok){
    if(response.status===400||response.status===401){this.clear();throw new ConnectLoginError('session_expired','Sessione SSO scaduta o revocata. Accedi di nuovo.');}
    throw new ConnectLoginError('refresh_unavailable','Rinnovo SSO temporaneamente non disponibile');
   }
   let result:any;try{result=await response.json();}catch{if(version===this.sessionVersion)this.clear();throw new ConnectLoginError('invalid_token_response','Risposta SSO non valida');}
   if(version!==this.sessionVersion)throw new ConnectLoginError('session_changed','Sessione modificata durante il rinnovo');
   this.accept(result);
  })().finally(()=>{if(this.refreshing===operation)this.refreshing=undefined;});
  this.refreshing=operation;return operation;
 }
 async checkSession():Promise<boolean>{
  if(!this.refreshToken&&!this.token){
   const saved=sessionStorage.getItem(this.storageKey);if(!saved)return false;
   try{const value=JSON.parse(saved);if(typeof value.refreshToken!=='string'||!value.refreshToken)throw new Error();this.refreshToken=value.refreshToken;this.idToken=typeof value.idToken==='string'?value.idToken:null;}catch{this.clear();return false;}
  }
  try{
   // The refresh grant validates the server-side SSO session on every explicit check.
   if(this.refreshToken)await this.refresh();else await this.request('/v1/context');
   return true;
  }catch(error){if(error instanceof ConnectLoginError&&error.code==='session_expired')return false;if(!this.token&&!this.refreshToken)return false;throw error;}
 }
 async init(options:{loginRequired?:boolean}={}){
  if(this.initializing)return this.initializing;
  const operation=(async()=>{const authenticated=await this.callback();if(!authenticated){if(options.loginRequired)await this.login();return false;}if(this.config.installationId)return (await this.permissions()).canLogin;return true;})().finally(()=>{if(this.initializing===operation)this.initializing=undefined;});
  this.initializing=operation;return operation;
 }
 get access(){return this.accessState;}
 can(functionKey:string){return !!this.accessState?.canLogin&&this.accessState.functions.some(f=>f.key===functionKey);}
 async permissions(){const result=await this.request<AccessResult>('/v1/access');this.accessState=result;return result;}
 users(){return this.request<ConnectUser[]>('/v1/users');}
 teamOverview(){return this.request<TeamOverview>('/v1/team');}
 teamUsers(){return this.request<TeamUser[]>('/v1/team/users');}
 teamRoles(){return this.request<TeamRole[]>('/v1/team/roles');}
 teamFunctions(){return this.request<TeamFunction[]>('/v1/team/functions');}
 createTeamRole(role:TeamRoleInput){return this.request<TeamRole>('/v1/team/roles','POST',role);}
 updateTeamRole(id:string,role:TeamRoleInput){return this.request<TeamRole>('/v1/team/roles/'+encodeURIComponent(id),'PUT',role);}
 deleteTeamRole(id:string){return this.request<{removed:boolean}>('/v1/team/roles/'+encodeURIComponent(id),'DELETE');}
 setTeamUserRoles(subject:string,roleIds:string[]){return this.request<TeamUserAssignment>('/v1/team/users/'+encodeURIComponent(subject)+'/roles','PUT',{roleIds});}
 revokeTeamUser(subject:string){return this.request<TeamRevocation>('/v1/team/users/'+encodeURIComponent(subject),'DELETE');}
 restoreTeamUser(subject:string){return this.request<TeamRestore>('/v1/team/users/'+encodeURIComponent(subject)+'/restore','POST');}
 watchAccess(onChange:(access:AccessResult|null)=>void,intervalMs=30000){const refresh=async()=>{try{if(!await this.checkSession()){this.accessState=null;onChange(null);return;}onChange(await this.permissions());}catch{this.accessState=null;onChange(null);}};const timer=setInterval(()=>void refresh(),Math.max(intervalMs,5000));return()=>clearInterval(timer);}
 watchSession(onChange:(valid:boolean|null)=>void,intervalMs=30000){const check=async()=>{try{onChange(await this.checkSession());}catch{onChange(null);}};const timer=setInterval(()=>void check(),Math.max(intervalMs,5000));return()=>clearInterval(timer);}
 get authenticated(){return !!this.token;}

 constructor(readonly config:BrowserConfig){}
 private destination(value=this.config.redirectUri){const target=new URL(value,location.href),callback=new URL(this.config.redirectUri);if(target.origin!==callback.origin||target.username||target.password)throw new ConnectLoginError('invalid_return_to','Pagina di ritorno esterna all’app');return target.href;}
 async loginResult():Promise<LoginResult>{try{if(!await this.callback())return {status:'anonymous'};if(this.config.installationId){const access=await this.permissions();if(!access.canLogin)return {status:'error',code:access.reason,message:'Accesso all’applicazione non consentito: '+access.reason};}return {status:'authenticated',access:this.accessState,returnTo:location.href,actionStatus:this.actionStatus};}catch(e){return {status:'error',code:e instanceof ConnectLoginError?e.code:'login_failed',message:(e as Error).message};}}
 private actionStatus:string|null=null;
 async login(options:LoginOptions={}){
  const returnTo=this.destination(options.returnTo);
  if(options.maxAge!==undefined&&(!Number.isInteger(options.maxAge)||options.maxAge<0))throw new ConnectLoginError('invalid_max_age','Durata autenticazione non valida');
  const verifier=Array.from(crypto.getRandomValues(new Uint8Array(48)),x=>x.toString(16).padStart(2,'0')).join('');
  const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const state=crypto.randomUUID();sessionStorage.setItem(this.storageKey+':pkce',JSON.stringify({verifier,state,createdAt:Date.now(),returnTo,redirectUri:this.config.redirectUri}));
  const url=new URL(`${this.config.issuer}/protocol/openid-connect/auth`);
  Object.entries({client_id:this.config.clientId,redirect_uri:this.config.redirectUri,response_type:'code',scope:'openid profile email',state,code_challenge:challenge,code_challenge_method:'S256'}).forEach(([k,v])=>url.searchParams.set(k,v));
  if(options.prompt)url.searchParams.set('prompt',options.prompt);
  if(options.action)url.searchParams.set('kc_action',options.action);
  if(options.maxAge!==undefined)url.searchParams.set('max_age',String(options.maxAge));
  location.assign(url);
 }
 async callback():Promise<boolean>{
  if(this.restoring)return this.restoring;
  const operation=this.handleCallback().finally(()=>{if(this.restoring===operation)this.restoring=undefined;});this.restoring=operation;return operation;
 }
 private async handleCallback():Promise<boolean>{
  const url=new URL(location.href),code=url.searchParams.get('code'),error=url.searchParams.get('error');
  if(!code&&!error)return this.checkSession();
  const stored=sessionStorage.getItem(this.storageKey+':pkce');sessionStorage.removeItem(this.storageKey+':pkce');
  // Remove authorization parameters even when the callback is rejected.
  history.replaceState({},'',this.config.redirectUri);
  let callbackVersion:number|undefined;
  try{
   if(!stored)throw new ConnectLoginError('missing_request','Richiesta SSO assente o già utilizzata');
   let pending:any;try{pending=JSON.parse(stored);}catch{throw new ConnectLoginError('invalid_request','Richiesta SSO non valida');}
   if(url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==pending.state)throw new ConnectLoginError('invalid_state','Stato SSO non valido');
   if(!Number.isFinite(pending.createdAt)||Date.now()-pending.createdAt>600000||pending.createdAt>Date.now()+30000||pending.redirectUri!==this.config.redirectUri)throw new ConnectLoginError('expired_request','Richiesta SSO scaduta');
   if(url.searchParams.has('iss')&&url.searchParams.get('iss')!==this.config.issuer)throw new ConnectLoginError('invalid_issuer','Provider SSO non valido');
   const returnTo=this.destination(pending.returnTo);
   if(error)throw new ConnectLoginError(error,['access_denied','login_required','interaction_required'].includes(error)?'Accesso SSO annullato o da ripetere.':'Accesso SSO non riuscito.');
   if(!code||url.searchParams.getAll('code').length!==1)throw new ConnectLoginError('invalid_code','Codice SSO non valido');
   this.clear();const version=this.sessionVersion;callbackVersion=version;
   const response=await fetch(`${this.config.issuer}/protocol/openid-connect/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:this.config.clientId,redirect_uri:this.config.redirectUri,code,code_verifier:pending.verifier}),signal:AbortSignal.timeout(10000)});
   if(version!==this.sessionVersion)throw new ConnectLoginError('session_changed','Sessione modificata durante il login');
   if(!response.ok)throw new ConnectLoginError('token_exchange_failed','Scambio SSO fallito');
   const result=await response.json();if(typeof result.access_token!=='string'||!result.access_token)throw new ConnectLoginError('invalid_token_response','Risposta SSO non valida');
   if(version!==this.sessionVersion)throw new ConnectLoginError('session_changed','Sessione modificata durante il login');
   this.accept(result);this.actionStatus=url.searchParams.get('kc_action_status');history.replaceState({},'',returnTo);return true;
  }catch(e){if(callbackVersion===undefined||callbackVersion===this.sessionVersion)this.clear();throw e;}
 }
 configureMfa(returnTo=location.href){return this.login({action:'CONFIGURE_TOTP',returnTo});}
 verifyEmail(returnTo=location.href){return this.login({action:'VERIFY_EMAIL',returnTo});}
 accountSecurity(){return this.request<AccountSecurity>('/v1/security/me');}
 setMfaPreference(preferredMethod:AccountSecurity['preferredMethod']){return this.request<AccountSecurity>('/v1/security/me/preferences','PUT',{preferredMethod});}
 userSecurity(subject:string){return this.request<AccountSecurity>('/v1/security/users/'+encodeURIComponent(subject));}
 setUserMfaPreference(subject:string,preferredMethod:AccountSecurity['preferredMethod']){return this.request<AccountSecurity>('/v1/security/users/'+encodeURIComponent(subject)+'/preferences','PUT',{preferredMethod});}
 revokeUserCredential(subject:string,id:string){return this.request<{revoked:boolean;sessionsLoggedOut:boolean;trustedDevicesRevoked:boolean}>('/v1/security/users/'+encodeURIComponent(subject)+'/credentials/'+encodeURIComponent(id),'DELETE');}
 async revokeTrustedDevice(id:string){const result=await this.request<{revoked:boolean;sessionsLoggedOut:boolean}>('/v1/security/devices/'+encodeURIComponent(id),'DELETE');if(result.sessionsLoggedOut)this.clear();return result;}
 notifications(options:{unread?:boolean;before?:string;beforeId?:string;limit?:number}={}){const q=new URLSearchParams();for(const [key,value] of Object.entries(options))if(value!==undefined)q.set(key,String(value));return this.request<{items:Notification[];unreadCount:number;next:{before:string;beforeId:string}|null}>('/v1/notifications?'+q);}
 markNotification(id:string,read=true){return this.request('/v1/notifications/'+encodeURIComponent(id)+'/read','PUT',{read});}
 markAllNotificationsRead(){return this.request('/v1/notifications/read-all','POST');}
 setAccessToken(token:string){this.clear();this.token=token;this.expiresAt=Infinity;this.refreshToken=null;}
 logout(){const hint=this.idToken;this.clear();const url=new URL(`${this.config.issuer}/protocol/openid-connect/logout`);if(hint)url.searchParams.set('id_token_hint',hint);url.searchParams.set('client_id',this.config.clientId);url.searchParams.set('post_logout_redirect_uri',this.config.redirectUri);location.assign(url);}
 async request<T=any>(path:string,method='GET',body?:unknown,extra:Record<string,string>={}):Promise<T>{
  if(this.refreshing)await this.refreshing;
  if(this.token&&Date.now()>=this.expiresAt-30000)await this.refresh();
  if(!this.token)throw new Error('Accedi con EULab SSO');
  const version=this.sessionVersion,token=this.token;
  const response=await fetch(`${this.config.apiUrl}${path}`,{method,referrerPolicy:'origin',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(this.config.installationId?{'X-Installation-Id':this.config.installationId}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  // Proxies answer with HTML pages (502/503/504): never show raw parser errors to people.
  const text=await response.text();let data:any=null;let parsed=true;
  if(text){try{data=JSON.parse(text);}catch{parsed=false;}}
  if(response.status===401&&version===this.sessionVersion&&token===this.token)this.clear();
  if(!response.ok){
   const message=parsed&&data&&typeof data.message==='string'?data.message:parsed&&data?.message?JSON.stringify(data.message):httpMessage(response.status);
   throw Object.assign(new Error(message),{status:response.status});
  }
  if(!parsed)throw Object.assign(new Error('Risposta non valida dal server EULab Connect. Riprova tra poco.'),{status:response.status});
  return data;
 }
 functionUrl(feature:string,path?:string){
  if(!/^[a-z][a-z0-9_.:-]{0,79}$/.test(feature))throw new Error('Chiave funzione non valida');
  const url=path?new URL(path,location.origin):new URL(`${(this.config.functionFallbackUrl||location.origin+'/eulab/connect/functions').replace(/\/$/,'')}/${encodeURIComponent(feature)}`);
  if(url.origin!==location.origin)throw new Error('URL funzione esterno al dominio autorizzato');return url.href;
 }
 sessions(){return this.request<{sessions:{id:string;subject:string;username:string;ipAddress:string;startedAt:number;lastAccess:number;clients:string[];current:boolean}[];truncated:boolean}>('/v1/sessions');}
 async logoutSession(id:string){const result=await this.request<{loggedOut:boolean;current:boolean}>(`/v1/sessions/${encodeURIComponent(id)}/logout`,'POST');if(result.current)this.clear();return result;}
 async logoutAllSessions(){const result=await this.request('/v1/sessions/logout-all','POST');this.clear();return result;}
 context(){return this.request('/v1/context');}
 authorize(installationId:string,permission:string){return this.request<{allowed:boolean;reason:string}>('/v1/authorize','POST',{installationId,permission});}
 whatsapp(installationId=this.config.installationId){if(!installationId)throw new Error('InstallationId richiesto');return whatsappClient(this.request.bind(this),installationId,{apiUrl:this.config.apiUrl,register:close=>{this.streams.add(close);return()=>{this.streams.delete(close);};}});}
}

/** Plain-language message when the server did not send a JSON error. */
function httpMessage(status:number):string{
 if(status===401)return 'Sessione scaduta. Accedi di nuovo.';
 if(status===403)return 'Non hai i permessi per questa sezione.';
 if(status===404)return 'Elemento non trovato.';
 if(status===429)return 'Troppe richieste ravvicinate. Attendi qualche secondo.';
 if(status>=500)return 'EULab Connect non è raggiungibile in questo momento. Riprova tra poco.';
 return 'Richiesta non riuscita ('+status+').';
}
