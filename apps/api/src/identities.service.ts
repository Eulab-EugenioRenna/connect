import {Injectable,ConflictException,ForbiddenException,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {Database,audit} from './database.js';
import {required} from './config.js';
export interface ManagedIdentity {subject:string;username:string;email:string;display_name:string;enabled:boolean;user_type:'admin'|'client'}
@Injectable()
export class IdentitiesService {
 private token?:{value:string;expires:number};
 constructor(private readonly db:Database){}
 async request(path:string,method='GET',body?:unknown):Promise<{body:any;location:string|null}>{
  const issuer=required('OIDC_INTERNAL_ISSUER');const secret=process.env.OIDC_IDENTITY_ADMIN_SECRET;
  if(!secret)throw new ServiceUnavailableException('Configura il servizio identità con scripts/setup-admin.mjs');
  if(!this.token||this.token.expires<Date.now()){
   const r=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:'connect-identity-admin',client_secret:secret}),signal:AbortSignal.timeout(5000)});
   if(!r.ok)throw new ServiceUnavailableException('Servizio identità SSO non disponibile');const t=await r.json();this.token={value:t.access_token,expires:Date.now()+(t.expires_in-30)*1000};
  }
  const url=issuer.replace('/realms/','/admin/realms/')+path;
  const r=await fetch(url,{method,headers:{Authorization:`Bearer ${this.token.value}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  if(r.status===409)throw new ConflictException('Username o email già presente: collega esplicitamente l’identità esistente');
  if(r.status===404)throw new NotFoundException('Identità SSO non trovata');
  if(!r.ok)throw new ServiceUnavailableException(`Operazione identità SSO non riuscita (${r.status})`);
  const text=await r.text();return {body:text?JSON.parse(text):null,location:r.headers.get('location')};
 }
 private async roles(subject:string){return (await this.request(`/users/${encodeURIComponent(subject)}/role-mappings/realm/composite`)).body as {id:string;name:string}[];}
 private async representation(user:any):Promise<ManagedIdentity>{
  const roles=await this.roles(user.id);return {subject:user.id,username:user.username,email:user.email||'',display_name:[user.firstName,user.lastName].filter(Boolean).join(' ')||user.username,enabled:user.enabled,user_type:roles.some(r=>r.name==='eulab-admin')?'admin':'client'};
 }
 async list(){
  const users=(await this.request('/users?max=1000&briefRepresentation=false')).body as any[];
  const result:ManagedIdentity[]=[];for(const user of users){if(!user.serviceAccountClientId&&!user.username.startsWith('service-account-'))result.push(await this.representation(user));}return result;
 }
 async create(b:{username:string;email:string;displayName:string;userType:'admin'|'client';password:string;temporaryPassword:boolean},actor:string){
  await this.db.transaction(tx=>audit(tx,actor,'identity.sso.create.requested',b.username,{username:b.username,userType:b.userType}));
  const response=await this.request('/users','POST',{username:b.username,email:b.email||undefined,firstName:b.displayName.split(' ')[0],lastName:b.displayName.split(' ').slice(1).join(' '),enabled:true,credentials:[{type:'password',value:b.password,temporary:b.temporaryPassword}]});
  const subject=response.location?.split('/').pop();if(!subject)throw new ServiceUnavailableException('Identità creata: identificativo non restituito da SSO');
  await this.applyType(subject,b.userType);
  await this.db.transaction(async tx=>{await tx.query('INSERT INTO identities VALUES($1,$2,true) ON CONFLICT(subject) DO UPDATE SET display_name=$2,enabled=true',[subject,b.displayName]);await audit(tx,actor,'identity.sso.create',subject,{username:b.username,userType:b.userType});});
  return this.representation((await this.request(`/users/${subject}`)).body);
 }
 private async applyType(subject:string,type:'admin'|'client'){
  const path=`/users/${encodeURIComponent(subject)}/role-mappings/realm`;
  if(type==='admin'){const role=(await this.request('/roles/eulab-admin')).body;await this.request(path,'POST',[role]);}
  else{const roles=(await this.request(path)).body.filter((r:any)=>['eulab-admin','eulab-technician'].includes(r.name));if(roles.length)await this.request(path,'DELETE',roles);}
 }
 async remove(subject:string,actor:string){
  if(subject===actor)throw new ForbiddenException('Non puoi eliminare il tuo accesso amministratore corrente');
  const user=(await this.request(`/users/${encodeURIComponent(subject)}`)).body;
  if(user.serviceAccountClientId||user.username.startsWith('service-account-'))throw new ForbiddenException('Account di servizio protetto');
  await this.db.transaction(tx=>audit(tx,actor,'identity.sso.delete.requested',subject));
  await this.request(`/users/${encodeURIComponent(subject)}/logout`,'POST');
  await this.request(`/users/${encodeURIComponent(subject)}`,'DELETE');
  await this.db.transaction(async tx=>{for(const table of ['notifications','assignments','local_links','memberships','identities'])await tx.query(`DELETE FROM ${table} WHERE subject=$1`,[subject]);await audit(tx,actor,'identity.sso.delete',subject);});
  return {removed:true};
 }
 async update(subject:string,b:{displayName:string;email:string;enabled:boolean;userType:'admin'|'client'},actor:string){
  if(subject===actor&&(!b.enabled||b.userType!=='admin'))throw new ForbiddenException('Non puoi revocare il tuo accesso amministratore corrente');
  return this.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(901275)');
   if(!(await this.roles(actor)).some(r=>r.name==='eulab-admin'))throw new ForbiddenException('Accesso amministratore revocato');
   const user=(await this.request(`/users/${encodeURIComponent(subject)}`)).body;
   if(user.serviceAccountClientId||user.username.startsWith('service-account-'))throw new ForbiddenException('Gli account di servizio non sono utenti configurabili');
   await audit(tx,actor,'identity.sso.update.requested',subject,{...b});
   await this.request(`/users/${encodeURIComponent(subject)}`,'PUT',{...user,firstName:b.displayName.split(' ')[0],lastName:b.displayName.split(' ').slice(1).join(' '),email:b.email||undefined,enabled:b.enabled});
   const previousType=(await this.roles(subject)).some(r=>r.name==='eulab-admin')?'admin':'client';
   await this.applyType(subject,b.userType);
   if(!b.enabled||previousType!==b.userType)await this.request(`/users/${encodeURIComponent(subject)}/logout`,'POST');
   await tx.query('INSERT INTO identities VALUES($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET display_name=$2,enabled=$3',[subject,b.displayName,b.enabled]);
   await audit(tx,actor,'identity.sso.update',subject,{...b});return {subject,...b};
  });
 }
}
