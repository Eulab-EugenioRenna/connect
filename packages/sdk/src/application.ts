import {createHash,randomBytes,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';
import {ConnectOnboardingSource,ConnectOnboardingError,ConnectServer} from './server.js';
import type {AuthorizedConnectContext,OnboardingRequestStatus,AppOnboardingActivationRequest,OnboardingNextAction,DeploymentMetadata,ApprovedApplicationConfiguration} from './server.js';
import type {AccessResult,FunctionMatrix} from './functions.js';
import type {ConnectApplicationStore,ConnectStoreTransaction} from './application-store.js';
export * from './application-store.js';
export const connectConsentVersion='2026-10-21-mandatory-v1';
export type ConnectApplicationErrorCode='invalid_configuration'|'invalid_credentials'|'invalid_context'|'invalid_flow'|'invalid_consent'|'invalid_password'|'access_denied'|'session_expired'|'provider_unavailable'|'provision_conflict';
export type ConnectCallbackStage='flow'|'token_exchange'|'id_token'|'context'|'authorization'|'handoff';
export class ConnectApplicationError extends Error {
 callbackStage?:ConnectCallbackStage;
 authorizationDetail?:'http_401'|'http_403'|'http_other'|'transport'|'login_denied'|'app_mismatch'|'installation_mismatch'|'subject_mismatch'|'local_user_mismatch';
 constructor(readonly code:ConnectApplicationErrorCode){super(code);this.name='ConnectApplicationError';}
}
export interface BrowserContext {/** Must be checked against the actual Origin by the HTTP adapter. */origin:string;cookies:Record<string,string|undefined>}
export interface CookieDirective {name:string;value:string;httpOnly:true;secure:boolean;sameSite:'lax';path:'/';maxAge:number}
export interface LegacyAccount {localTenant:{id:string;name:string;slug:string};localUser:Omit<AuthorizedConnectContext['user'],'subject'>}
export interface LocalProfile {localUserId:string;localTenantId:string}
export interface ConnectAccountAdapter {
 verifyLegacy(input:{email:string;password:string}):Promise<LegacyAccount|null>;
 /** Must be idempotent on operationId and reject conflicting existing IDs/subjects. Never join by email. */
 provision(context:AuthorizedConnectContext,operation:{operationId:string;transaction:ConnectStoreTransaction}):Promise<LocalProfile>;
 restrict(profile:LocalProfile,functionKey:string,resource:unknown):Promise<boolean>;
}
export interface ConnectApplicationConfig {
 apiUrl:string;sourceId:string;appId:string;sourceSecret?:string;
 presenter?:{id:string;secret:string;deployment:DeploymentMetadata};
 issuer?:string;clientId?:string;clientSecret?:string;redirectUri?:string;appOrigin:string;
 /** Server-only origin for provider HTTP calls; canonical issuer/token validation and browser redirects stay unchanged. */
 oidcTransportOrigin?:string;
 encryptionKey:string;store:ConnectApplicationStore;accounts:ConnectAccountAdapter;catalog:FunctionMatrix;
 /** Explicit opt-in restricted to loopback HTTP. */allowLoopbackHttp?:boolean;
 sessionTtlSeconds?:number;
}
export type SignInResult={status:'administrative_required';reason:'source_conflict'}|{status:'configuration_required';appId:string}|{status:'redirect';url:string;cookies:CookieDirective[]}|{status:'migration_required';challenge:string;consentVersion:string;request?:OnboardingRequestStatus;cookies:CookieDirective[]}|{status:'pending';request:OnboardingRequestStatus;nextAction:OnboardingNextAction};
export interface ConnectDiagnosticReport {checks:{code:'configuration'|'discovery'|'source'|'authorization';status:'ok'|'failed'|'not_checked'}[]}
export interface ApplicationSession {sessionId:string;profile:LocalProfile;subject:string;expiresAt:number}
interface Tokens {access_token:string;refresh_token:string;id_token?:string;expires_in:number;expiresAt:number}
interface Flow {context:AuthorizedConnectContext;email:string;verifier:string;nonce:string;browserHash:string}
interface Session {context:AuthorizedConnectContext;email:string;tokens:Tokens;profile:LocalProfile;expiresAt:number;refreshedAt:number;generation:string}
const opaque=()=>randomBytes(32).toString('base64url');
const digest=(v:string)=>createHash('sha256').update(v).digest('base64url');
const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
function fail(code:ConnectApplicationErrorCode):never {throw new ConnectApplicationError(code);}

/** Server-only application facade. No provider token appears in a public result. */
export class ConnectApplication {
 /** Read-only entry point usable even when construction would reject invalid configuration. */
 static async diagnose(config:ConnectApplicationConfig,email?:string):Promise<ConnectDiagnosticReport>{
  try{return await new ConnectApplication(config).diagnose(email);}catch{return {checks:[{code:'configuration',status:'failed'},{code:'discovery',status:'not_checked'},{code:'source',status:'not_checked'},{code:'authorization',status:'not_checked'}]};}
 }
 readonly source:ConnectOnboardingSource;
 get catalog():FunctionMatrix{return {...this.config.catalog,appId:this.settings?.appId||this.plannedAppId||this.config.appId};}
 private readonly key:Buffer;
 private jwks?:ReturnType<typeof createRemoteJWKSet>;
 private settings?:ApprovedApplicationConfiguration;
 private plannedAppId?:string;
 private readonly prefix:string;
 private readonly ttl!:number;
 constructor(private readonly config:ConnectApplicationConfig){
  try{
   for(const value of [config.apiUrl,config.appOrigin,...(config.oidcTransportOrigin?[config.oidcTransportOrigin]:[]),...(config.issuer?[config.issuer]:[]),...(config.redirectUri?[config.redirectUri]:[])]){
    const u=new URL(value);if(u.username||u.password||u.hash||!(u.protocol==='https:'||(config.allowLoopbackHttp&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))fail('invalid_configuration');
   }
   if((config.redirectUri&&new URL(config.redirectUri).origin!==config.appOrigin)||!(config.sourceSecret||config.presenter?.secret)||((config.issuer||config.clientId||config.redirectUri)&&!(config.issuer&&config.clientId&&config.redirectUri))||!config.sourceId||config.catalog.appId!==config.appId||!/^([a-f0-9]{64})$/i.test(config.encryptionKey))fail('invalid_configuration');
   if(config.oidcTransportOrigin){const transport=new URL(config.oidcTransportOrigin);if(transport.pathname!=='/'||transport.search)fail('invalid_configuration');}
   this.ttl=config.sessionTtlSeconds??28800;if(this.ttl<60||this.ttl>604800)fail('invalid_configuration');
  }catch{fail('invalid_configuration');}
  this.key=Buffer.from(config.encryptionKey,'hex');this.prefix=(new URL(config.appOrigin).protocol==='https:'?'__Host-':'')+'connect_'+digest(config.sourceId+':'+config.appId).slice(0,12);
  this.source=new ConnectOnboardingSource({apiUrl:config.apiUrl,sourceId:config.sourceId,appId:config.appId,secret:config.presenter?.secret||config.sourceSecret!,presenterId:config.presenter?.id,deployment:config.presenter?.deployment});
  if(config.issuer&&config.clientId&&config.redirectUri)this.settings={sourceId:config.sourceId,appId:config.appId,issuer:config.issuer,clientId:config.clientId,redirectUri:config.redirectUri,clientSecret:config.clientSecret};
 }
 private validateConfiguration(c:ApprovedApplicationConfiguration){
  try{
   if(c.sourceId!==this.config.sourceId||!c.clientId||!/^[a-z][a-z0-9_.:-]{0,79}$/.test(c.appId)||new URL(c.redirectUri).origin!==this.config.appOrigin)fail('invalid_configuration');
   for(const value of [c.issuer,c.redirectUri]){const u=new URL(value);if(u.username||u.password||u.hash||!(u.protocol==='https:'||(this.config.allowLoopbackHttp&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))fail('invalid_configuration');}
  }catch{fail('invalid_configuration');}
 }
 private async loadSettings(){
  if(!this.settings){const stored=await this.transaction('configuration',tx=>this.read<ApprovedApplicationConfiguration>(tx,'configuration'));if(stored){this.validateConfiguration(stored);this.settings=stored;}}
  return this.settings;
 }
 private async oidc(){const settings=await this.loadSettings();if(!settings)fail('invalid_configuration');return settings;}
 readonly configuration={sync:async()=>{
  const result=await this.onboarding(()=>this.source.configuration());
  if(result.status!=='ready'){
   this.plannedAppId=undefined;
   if(result.plannedAppId){if(!/^[a-z][a-z0-9_.:-]{0,79}$/.test(result.plannedAppId))fail('invalid_configuration');this.plannedAppId=result.plannedAppId;}
   return {status:result.status,...(result.plannedAppId?{plannedAppId:result.plannedAppId}:{})};
  }
  this.validateConfiguration(result.configuration);
  await this.transaction('configuration',tx=>this.put(tx,'configuration',result.configuration,365*86400));
  this.settings=result.configuration;this.jwks=undefined;return {status:'ready' as const,appId:result.configuration.appId};
 }};
 private async transaction<T>(key:string,fn:(tx:ConnectStoreTransaction)=>Promise<T>):Promise<T>{try{return await this.config.store.transaction(key,fn);}catch(e){if(e instanceof ConnectApplicationError)throw e;return fail('provider_unavailable');}}
 private cookie(name:string,value:string,maxAge:number):CookieDirective{return {name:this.prefix+'_'+name,value,httpOnly:true,secure:new URL(this.config.appOrigin).protocol==='https:',sameSite:'lax',path:'/',maxAge};}
 private browser(ctx:BrowserContext){if(ctx.origin!==this.config.appOrigin)fail('invalid_context');}
 private seal(id:string,value:unknown){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(this.config.sourceId+':'+this.config.appId+':'+id));const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url');}
 private open<T>(id:string,value:string):T{try{const bytes=Buffer.from(value,'base64url'),dec=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));dec.setAAD(Buffer.from(this.config.sourceId+':'+this.config.appId+':'+id));dec.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([dec.update(bytes.subarray(28)),dec.final()]).toString());}catch{return fail('invalid_flow');}}
 private async put(tx:ConnectStoreTransaction,id:string,value:unknown,ttlSeconds:number){await tx.put(id,this.seal(id,value),Date.now()+ttlSeconds*1000);}
 private async read<T>(tx:ConnectStoreTransaction,id:string){const cipher=await tx.get(id);return cipher?this.open<T>(id,cipher):null;}
 private async take<T>(id:string){return this.transaction(id,async tx=>{const value=await this.read<T>(tx,id);await tx.remove(id);return value;});}
 private client(context:AuthorizedConnectContext){return new ConnectServer({apiUrl:this.config.apiUrl,installationId:context.binding.installationId,secret:context.binding.secret,requestTimeoutMs:10000});}
 private async onboarding<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(e){if(e instanceof ConnectOnboardingError)fail(e.status===409?'invalid_context':e.status>=500||e.status===0?'provider_unavailable':'access_denied');return fail('provider_unavailable');}}
 private async current(email:string,expected:AuthorizedConnectContext){
  const found=await this.onboarding(()=>this.source.loginContext(email));
  if(found.status!=='connect'&&found.status!=='configuration_required')return fail('access_denied');
  const a=found.context,b=expected;
  if(a.user.subject!==b.user.subject||a.user.id!==b.user.id||a.tenant.id!==b.tenant.id||a.binding.installationId!==b.binding.installationId||a.binding.customerId!==b.binding.customerId)fail('invalid_context');
  return a;
 }
 private async verifyAccess(context:AuthorizedConnectContext,token:string):Promise<AccessResult>{
  let a:AccessResult;
  try{a=await this.client(context).permissions(token);}catch(cause){
   const error=new ConnectApplicationError('access_denied');
   const status=cause instanceof Error?cause.message.match(/^Connect (\d{3}):/)?.[1]:undefined;
   error.authorizationDetail=status==='401'?'http_401':status==='403'?'http_403':status?'http_other':'transport';throw error;
  }
  const detail=a.canLogin!==true?'login_denied':a.appId!==(this.settings?.appId||this.config.appId)?'app_mismatch':a.installationId!==context.binding.installationId?'installation_mismatch':a.subject!==context.user.subject?'subject_mismatch':a.localUserId!==context.user.id?'local_user_mismatch':undefined;
  if(detail){const error=new ConnectApplicationError('access_denied');error.authorizationDetail=detail;throw error;}return a;
 }
 private providerUrl(issuer:string,path:string):string {
  const canonical=new URL(issuer+path);
  return this.config.oidcTransportOrigin?new URL(canonical.pathname+canonical.search,this.config.oidcTransportOrigin).href:canonical.href;
 }
 private async grant(params:Record<string,string>):Promise<Tokens>{
  try{
   const sso=await this.oidc();
   const r=await fetch(this.providerUrl(sso.issuer,'/protocol/openid-connect/token'),{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,client_id:sso.clientId,...(sso.clientSecret?{client_secret:sso.clientSecret}:{})}),signal:AbortSignal.timeout(10000)});
   if(!r.ok)fail(r.status>=500?'provider_unavailable':'access_denied');
   const t=await r.json() as Tokens;if(typeof t.access_token!=='string'||!t.access_token||typeof t.refresh_token!=='string'||!t.refresh_token||!Number.isFinite(t.expires_in)||t.expires_in<=0)fail('access_denied');
   return {...t,expiresAt:Date.now()+t.expires_in*1000};
  }catch(e){if(e instanceof ConnectApplicationError)throw e;return fail('provider_unavailable');}
 }
 private next(request:OnboardingRequestStatus):OnboardingNextAction{return request.nextAction??(['pending','approved','migrating'].includes(request.state)?'wait':request.state==='completed'?'sign_in':'contact_admin');}
 private async begin(context:AuthorizedConnectContext,email:string):Promise<SignInResult>{
  const sso=await this.oidc();
  const state=opaque(),browser=opaque(),nonce=opaque(),verifier=opaque();
  await this.transaction('flow:'+digest(state),tx=>this.put(tx,'flow:'+digest(state),{context,email,verifier,nonce,browserHash:digest(browser)},600));
  const u=new URL(sso.issuer+'/protocol/openid-connect/auth');
  for(const [k,v] of Object.entries({client_id:sso.clientId,redirect_uri:sso.redirectUri,response_type:'code',scope:'openid profile email',state,nonce,code_challenge:digest(verifier),code_challenge_method:'S256',login_hint:email}))u.searchParams.set(k,v);
  return {status:'redirect',url:u.href,cookies:[this.cookie('flow',browser,600)]};
 }
 readonly auth={
  signIn:async(input:{email:string;password?:string},ctx:BrowserContext):Promise<SignInResult>=>{
   this.browser(ctx);let found;try{found=await this.onboarding(()=>this.source.loginContext(input.email));}catch(e){if(e instanceof ConnectApplicationError&&e.code==='invalid_context')return {status:'administrative_required',reason:'source_conflict'};throw e;}
   if(found.status==='connect'||found.status==='configuration_required'){
    if(!await this.loadSettings())return {status:'configuration_required',appId:found.status==='configuration_required'?found.appId:this.config.appId};
    return this.begin(found.context,input.email);
   }
   const next=found.request?this.next(found.request):undefined;
   if(found.request&&next!=='resubmit'&&next!=='choose_connect_password')return {status:'pending',request:found.request,nextAction:next!};
   if(!input.password)fail('invalid_credentials');
   const legacy=await this.config.accounts.verifyLegacy({email:input.email,password:input.password});if(!legacy)fail('invalid_credentials');
   const challenge=opaque();await this.transaction('challenge:'+digest(challenge),tx=>this.put(tx,'challenge:'+digest(challenge),{legacy,email:input.email,request:found.request,browserHash:digest(challenge)},120));
   return {status:'migration_required',challenge,consentVersion:connectConsentVersion,cookies:[this.cookie('challenge',challenge,120)],...(found.request?{request:found.request}:{})};
  },
  callback:async(input:{state:string;code?:string;error?:string;iss?:string},ctx:BrowserContext)=>{
   let stage:ConnectCallbackStage='flow';
   try{
   this.browser(ctx);const sso=await this.oidc();const id='flow:'+digest(input.state),flow=await this.take<Flow>(id);
   if(!flow||!same(flow.browserHash,digest(ctx.cookies[this.prefix+'_flow']??''))||input.error||!input.code||(input.iss&&input.iss!==sso.issuer))return fail('invalid_flow');
   stage='token_exchange';
   const tokens=await this.grant({grant_type:'authorization_code',code:input.code,redirect_uri:sso.redirectUri,code_verifier:flow.verifier});
   stage='id_token';
   try{
    if(!tokens.id_token)fail('access_denied');
    const {payload}=await jwtVerify(tokens.id_token,this.jwks??=createRemoteJWKSet(new URL(this.providerUrl(sso.issuer,'/protocol/openid-connect/certs')),{timeoutDuration:10000}),{issuer:sso.issuer,audience:sso.clientId,algorithms:['RS256','ES256'],requiredClaims:['sub','iat','exp','nonce']});
    if(payload.sub!==flow.context.user.subject||payload.nonce!==flow.nonce||(payload.azp&&payload.azp!==sso.clientId))fail('invalid_context');
   }catch{return fail('access_denied');}
   stage='context';
   const context=await this.current(flow.email,flow.context);
   stage='authorization';await this.verifyAccess(context,tokens.access_token);
   stage='handoff';
   const handoff=opaque(),browser=opaque();
   await this.transaction('handoff:'+digest(handoff),tx=>this.put(tx,'handoff:'+digest(handoff),{context,email:flow.email,tokens,browserHash:digest(browser)},60));
   return {status:'handoff' as const,handoff,cookies:[this.cookie('flow','',0),this.cookie('handoff',browser,60)]};
   }catch(error){if(error instanceof ConnectApplicationError)error.callbackStage=stage;throw error;}
  },
  exchange:async(handoff:string,ctx:BrowserContext)=>{
   this.browser(ctx);const id='handoff:'+digest(handoff);
   return this.transaction(id,async tx=>{
    const flow=await this.read<Flow&{tokens:Tokens}>(tx,id);
    if(!flow||!same(flow.browserHash,digest(ctx.cookies[this.prefix+'_handoff']??'')))return fail('invalid_flow');
    const context=await this.current(flow.email,flow.context);await this.verifyAccess(context,flow.tokens.access_token);
    const profile=await this.config.accounts.provision(context,{operationId:id,transaction:tx});
    if(profile.localUserId!==context.user.id||profile.localTenantId!==context.tenant.id)fail('provision_conflict');
    const sessionId=opaque(),expiry=Date.now()+this.ttl*1000;
    await this.put(tx,'session:'+digest(sessionId),{context,email:flow.email,tokens:flow.tokens,profile,expiresAt:expiry,refreshedAt:0,generation:opaque()},this.ttl);
    await tx.remove(id);
    return {status:'authenticated' as const,session:{sessionId,profile,subject:context.user.subject,expiresAt:expiry},cookies:[this.cookie('handoff','',0),this.cookie('session',sessionId,this.ttl)]};
   });
  },
  resolve:async(sessionId:string)=>this.resolve(sessionId,false),
  refresh:async(sessionId:string)=>this.resolve(sessionId,true),
  fromCookies:(ctx:BrowserContext)=>{this.browser(ctx);return ctx.cookies[this.prefix+'_session']??'';},
  logout:async(sessionId:string,ctx:BrowserContext)=>{
   this.browser(ctx);const id='session:'+digest(sessionId);
   const session=await this.take<Session>(id);let providerRevoked:boolean|null=null;
   if(session){try{const sso=await this.oidc();const r=await fetch(this.providerUrl(sso.issuer,'/protocol/openid-connect/logout'),{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:sso.clientId,refresh_token:session.tokens.refresh_token,...(sso.clientSecret?{client_secret:sso.clientSecret}:{})}),signal:AbortSignal.timeout(10000)});providerRevoked=r.ok;}catch{providerRevoked=false;}}
   return {revoked:true,providerRevoked,cookies:[this.cookie('session','',0)]};
  }
 };
 private async resolve(sessionId:string,force:boolean):Promise<ApplicationSession>{
  const result=await this.withSession(sessionId,force,async s=>({sessionId,profile:s.profile,subject:s.context.user.subject,expiresAt:s.expiresAt}));return result;
 }
 private async withSession<T>(sessionId:string,force:boolean,fn:(s:Session)=>Promise<T>):Promise<T>{
  const id='session:'+digest(sessionId);
  const result=await this.transaction(id,async tx=>{
   const s=await this.read<Session>(tx,id);if(!s||s.expiresAt<=Date.now())return {error:'session_expired' as const};
   try{
    const intentId='refresh:'+digest(sessionId+':'+s.generation);
    const interrupted=await tx.get(intentId);if(interrupted)fail('session_expired');
    s.context=await this.current(s.email,s.context);
    // A shared persisted timestamp also deduplicates callers queued on another process.
    if(s.tokens.expiresAt<=Date.now()+30000||(force&&s.refreshedAt<Date.now()-5000)){
     // Commit a tombstone BEFORE a rotating grant: on an ambiguous response/crash the old token is never replayed.
     // The intent survives a crash/rollback and is checked on every session use.
     await this.put(tx,intentId,{pending:true},this.ttl);await tx.checkpoint();
     s.tokens=await this.grant({grant_type:'refresh_token',refresh_token:s.tokens.refresh_token});s.refreshedAt=Date.now();s.generation=opaque();
     // The new generation supersedes the durable intent only on commit.
    }
    await this.verifyAccess(s.context,s.tokens.access_token);
    const value=await fn(s);await tx.put(id,this.seal(id,s),s.expiresAt);return {value};
   }catch(e){await tx.remove(id);return {error:e instanceof ConnectApplicationError?e.code:'access_denied' as const};}
  });
  if('error' in result)return fail(result.error!);
  // Old intents expire with their session; no unsafe cleanup race between processes.
  return result.value;
 }
 readonly migration={
  submit:async(input:{challenge:string;legacyPassword:string;consentVersion:string;idempotencyKey:string;newConnectPassword?:string},ctx:BrowserContext)=>{
   this.browser(ctx);if(input.consentVersion!==connectConsentVersion)fail('invalid_consent');
   const proof=await this.take<{legacy:LegacyAccount;email:string;request?:OnboardingRequestStatus;browserHash:string}>('challenge:'+digest(input.challenge));if(!proof||!same(proof.browserHash,digest(ctx.cookies[this.prefix+'_challenge']??'')))fail('invalid_flow');
   const verified=await this.config.accounts.verifyLegacy({email:proof.email,password:input.legacyPassword});
   if(!verified||JSON.stringify(verified)!==JSON.stringify(proof.legacy))fail('invalid_credentials');
   if(proof.request&&this.next(proof.request)==='choose_connect_password'){
    if(!input.newConnectPassword||same(input.newConnectPassword,input.legacyPassword))fail('invalid_password');
    return this.onboarding(()=>this.source.recoverPassword({requestId:proof.request!.requestId,email:proof.email,localTenantId:verified.localTenant.id,localUserId:verified.localUser.id,consentVersion:input.consentVersion,newPassword:input.newConnectPassword!},input.idempotencyKey));
   }
   return this.onboarding(()=>this.source.submit({kind:'migration',consentVersion:input.consentVersion,...verified,initialPassword:input.legacyPassword},input.idempotencyKey));
  }
 };
 readonly activation={submit:async(input:AppOnboardingActivationRequest&{consentVersion:string;idempotencyKey:string},ctx:BrowserContext)=>{
  this.browser(ctx);if(input.consentVersion!==connectConsentVersion)fail('invalid_consent');const {idempotencyKey,consentVersion,...request}=input;return this.onboarding(()=>this.source.submit(request,idempotencyKey));
 }};
 readonly access={authorize:async(sessionId:string,functionKey:string,resource:unknown=null)=>this.withSession(sessionId,false,async s=>{
  if(!this.catalog.functions.some(f=>f.key===functionKey))return {allowed:false,reason:'unknown_function'};
  const central=await this.client(s.context).authorize(s.tokens.access_token,functionKey);
  return central.allowed?{allowed:await this.config.accounts.restrict(s.profile,functionKey,resource),reason:'local_policy'}:central;
 })};
 /** All existing Connect services share this authenticated server session. No callback is retried. */
 async services<T>(sessionId:string,operation:(client:ConnectServer,accessToken:string)=>Promise<T>):Promise<T>{return this.withSession(sessionId,false,s=>operation(this.client(s.context),s.tokens.access_token));}
 async diagnose(email?:string):Promise<ConnectDiagnosticReport>{
  const checks:{code:'configuration'|'discovery'|'source'|'authorization';status:'ok'|'failed'|'not_checked'}[]=[{code:'configuration',status:'ok'}];
  const sso=await this.loadSettings();
  if(!sso)checks.push({code:'discovery',status:'not_checked'});
  else try{const r=await fetch(this.providerUrl(sso.issuer,'/.well-known/openid-configuration'),{redirect:'error',signal:AbortSignal.timeout(10000)});const d=await r.json() as {issuer?:string};checks.push({code:'discovery',status:r.ok&&d.issuer===sso.issuer?'ok':'failed'});}catch{checks.push({code:'discovery',status:'failed'});}
  try{const context=await this.source.loginContext(email??'connect-diagnostic@example.invalid');checks.push({code:'source',status:'ok'},{code:'authorization',status:'not_checked'});}catch(e){checks.push({code:'source',status:e instanceof ConnectOnboardingError&&e.status===403?'ok':'failed'},{code:'authorization',status:'not_checked'});}
  return {checks};
 }
}
