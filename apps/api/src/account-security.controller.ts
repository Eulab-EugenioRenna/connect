import {Body,Controller,Delete,ForbiddenException,Get,NotFoundException,Param,Post,Put,Req,ServiceUnavailableException} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {Admin,RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {IdentitiesService} from './identities.service.js';
import {MailService,smtpConfig} from './mail.service.js';
import {parse} from './validation.js';
import {ApiInput} from './openapi.js';
const preferenceSchema=z.object({preferredMethod:z.enum(['auto','totp','email'])}).strict();
const rememberSchema=z.object({enabled:z.boolean(),idleSeconds:z.number().int().min(300).max(2592000),maxSeconds:z.number().int().min(300).max(7776000)}).strict().refine(v=>v.idleSeconds<=v.maxSeconds,'Inattività oltre durata massima');
@Controller('v1/security') @ApiTags('Sicurezza account') @ApiBearerAuth()
export class AccountSecurityController {
 constructor(private readonly identities:IdentitiesService,private readonly db:Database,private readonly mail:MailService){}
 private subject(req:RequestContext){if(!req.principal.subject)throw new ForbiddenException('Identità personale richiesta');return req.principal.subject;}
 private async account(subject:string){
  const path='/users/'+encodeURIComponent(subject),user=(await this.identities.request(path)).body;
  if(user.serviceAccountClientId||user.username?.startsWith('service-account-'))throw new ForbiddenException('Account di servizio protetto');
  const credentials=(await this.identities.request(path+'/credentials')).body;
  return {path,user,credentials};
 }
 private async security(subject:string){
  const {user,credentials}=await this.account(subject);
  const preferred=user.attributes?.['eulab.mfa.preferredMethod']?.[0];
  return {totp:credentials.some((c:any)=>c.type==='otp'),preferredMethod:['totp','email'].includes(preferred)?preferred:'auto',emailVerified:!!user.emailVerified,requiredActions:user.requiredActions||[],authenticators:credentials.filter((c:any)=>c.type==='otp').map((c:any)=>({id:c.id,name:c.userLabel||'App Authenticator',createdAt:c.createdDate})),trustedDevices:credentials.filter((c:any)=>c.type==='eulab-trusted-device').map((c:any)=>{let data:any={};try{data=JSON.parse(c.credentialData||'{}')||{};}catch{}return {id:c.id,name:c.userLabel||'Dispositivo attendibile',createdAt:c.createdDate,expiresAt:data.expiresAt};})};
 }
 @Get('me') me(@Req() req:RequestContext){return this.security(this.subject(req));}
 @Put('me/preferences') @ApiInput(preferenceSchema) preferences(@Req() req:RequestContext,@Body() body:unknown){return this.savePreferences(this.subject(req),this.subject(req),body);}
 @Admin() @Get('users/:subject') userSecurity(@Param('subject') subject:string){return this.security(subject);}
 @Admin() @Put('users/:subject/preferences') @ApiInput(preferenceSchema) userPreferences(@Req() req:RequestContext,@Param('subject') subject:string,@Body() body:unknown){return this.savePreferences(subject,this.subject(req),body);}
 private async savePreferences(subject:string,actor:string,body:unknown){
  const b=parse(preferenceSchema,body),{path,user}=await this.account(subject);
  await this.db.transaction(tx=>audit(tx,actor,'security.preferences.update.requested',subject,b));
  await this.identities.request(path,'PUT',{...user,attributes:{...user.attributes,'eulab.mfa.preferredMethod':[b.preferredMethod]}});
  const state=await this.security(subject);
  if(state.preferredMethod!==b.preferredMethod)throw new ServiceUnavailableException('Configura il profilo MFA con npm run security:profile prima di salvare la preferenza');
  await this.db.transaction(tx=>audit(tx,actor,'security.preferences.update',subject,b));return state;
 }
 @Admin() @Delete('users/:subject/credentials/:id') async removeCredential(@Req() req:RequestContext,@Param('subject') subject:string,@Param('id') id:string){
  const {path,credentials}=await this.account(subject),credential=credentials.find((c:any)=>c.id===id&&['otp','eulab-trusted-device'].includes(c.type));
  if(!credential)throw new NotFoundException('App o dispositivo non trovato');
  const actor=this.subject(req);
  await this.db.transaction(tx=>audit(tx,actor,'security.credential.revoke.requested',subject,{credentialId:id,type:credential.type}));
  await this.identities.request(path+'/credentials/'+encodeURIComponent(id),'DELETE');
  // Removing an authenticator also invalidates every trusted browser for this identity.
  let trustedDevicesRevoked=true;
  if(credential.type==='otp')for(const c of credentials.filter((c:any)=>c.type==='eulab-trusted-device'))try{await this.identities.request(path+'/credentials/'+encodeURIComponent(c.id),'DELETE');}catch{trustedDevicesRevoked=false;}
  let sessionsLoggedOut=true;try{await this.identities.request(path+'/logout','POST');}catch{sessionsLoggedOut=false;}
  await this.db.transaction(tx=>audit(tx,actor,'security.credential.revoke',subject,{credentialId:id,type:credential.type,sessionsLoggedOut,trustedDevicesRevoked}));
  return {revoked:true,sessionsLoggedOut,trustedDevicesRevoked};
 }
 @Delete('devices/:id') async revoke(@Req() req:RequestContext,@Param('id') id:string){
  parse(z.string().min(1).max(200),id);const subject=this.subject(req),path='/users/'+encodeURIComponent(subject),credentials=(await this.identities.request(path+'/credentials')).body;
  if(!credentials.some((c:any)=>c.id===id&&c.type==='eulab-trusted-device'))throw new NotFoundException('Dispositivo non trovato');
  await this.db.transaction(tx=>audit(tx,subject,'security.device.revoke.requested',id));
  await this.identities.request(path+'/credentials/'+encodeURIComponent(id),'DELETE');
  let sessionsLoggedOut=true;try{await this.identities.request(path+'/logout','POST');}catch{sessionsLoggedOut=false;}
  await this.db.transaction(tx=>audit(tx,subject,'security.device.revoke',id,{sessionsLoggedOut}));return {revoked:true,sessionsLoggedOut};
 }
 @Admin() @Get('settings') async settings(){const realm=(await this.identities.request('')).body;return {rememberMe:!!realm.rememberMe,idleSeconds:realm.ssoSessionIdleTimeoutRememberMe||realm.ssoSessionIdleTimeout,maxSeconds:realm.ssoSessionMaxLifespanRememberMe||realm.ssoSessionMaxLifespan,smtp:this.mail.status(),smtpSynced:!!realm.smtpServer?.host,browserFlow:realm.browserFlow};}
 @Admin() @Put('remember-me') @ApiInput(rememberSchema) async remember(@Req() req:RequestContext,@Body() body:unknown){const b=parse(rememberSchema,body);await this.identities.request('','PUT',{rememberMe:b.enabled,ssoSessionIdleTimeoutRememberMe:b.idleSeconds,ssoSessionMaxLifespanRememberMe:b.maxSeconds});await this.db.transaction(tx=>audit(tx,this.subject(req),'security.remember-me.update','eulab',b));return this.settings();}
 @Admin() @Post('smtp/sync') async smtp(@Req() req:RequestContext){const c=smtpConfig();await this.identities.request('','PUT',{emailTheme:'eulab',smtpServer:{host:c.host,port:String(c.port),from:c.from,fromDisplayName:'EULab Connect',auth:String(!!c.user),user:c.user,password:c.password,ssl:String(c.security==='tls'),starttls:String(c.security==='starttls')}});await this.db.transaction(tx=>audit(tx,this.subject(req),'security.smtp.sync','eulab'));return {synced:true};}
}
