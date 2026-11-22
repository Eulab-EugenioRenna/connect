import {Injectable,ForbiddenException,NotFoundException,ConflictException,BadRequestException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Database,audit} from './database.js';
import {IdentitiesService} from './identities.service.js';
import {Authorization} from './authorization.js';
import type {Principal} from './auth.js';
import {equalSecret,hash,seal,unseal,secret} from './security.js';
import {requestHash,type DelegationInput} from './automation-contract.js';
import type {AutomationDelegation,AutomationVerification,DelegatedMessageStatus,DelegatedMessageWithdrawal} from '../../../packages/sdk/src/automations.js';

export function delegationView(d:any):AutomationDelegation{
 return {id:d.id,installationId:d.installation_id,appId:d.app_id,actor:d.actor,purpose:d.purpose,channel:d.channel,functions:d.functions,archiveId:d.archive_id,revision:d.revision,expiresAt:new Date(d.expires_at).toISOString(),revokedAt:d.revoked_at?new Date(d.revoked_at).toISOString():null,createdAt:new Date(d.created_at).toISOString()};
}
export function outboxView(o:any):DelegatedMessageStatus{
 return {id:o.id,sessionId:o.session_id,state:o.state,providerId:o.provider_id||null,error:o.error||null,createdAt:new Date(o.created_at).toISOString()};
}
function withdrawalView(o:any):DelegatedMessageWithdrawal{
 const message=outboxView(o);
 switch(message.state){
  case 'cancelled':return {outcome:message.error==='command_withdrawn'?'withdrawn':'already_terminal',message:{...message,state:'cancelled'}};
  case 'failed':return {outcome:'already_terminal',message:{...message,state:'failed'}};
  case 'sending':case 'sent':case 'uncertain':return {outcome:'effect_started',message:{...message,state:message.state}};
  default:throw new Error('WITHDRAWAL_NOT_TERMINAL');
 }
}
@Injectable()
export class AutomationService {
 constructor(private readonly db:Database,private readonly identities:IdentitiesService){}
 private policy(tx?:PoolClient){return new Authorization(tx?{query:async(sql:string,params:unknown[]=[]) => (await tx.query(sql,params)).rows} as Database:this.db);}
 async current(d:any,tx?:PoolClient):Promise<AutomationVerification>{
  if(d.revoked_at)return {allowed:false,reason:'delegation_revoked'};
  if(new Date(d.expires_at).getTime()<=Date.now())return {allowed:false,reason:'delegation_expired'};
  try{const user=await this.identities.user(d.actor);if(user?.id!==d.actor||user.enabled!==true||!!user.serviceAccountClientId||String(user.username||'').startsWith('service-account-'))return {allowed:false,reason:'identity_provider_disabled'};}
  catch(error){if(error instanceof NotFoundException)return {allowed:false,reason:'identity_provider_missing'};throw error;}
  if(new Date(d.expires_at).getTime()<=Date.now())return {allowed:false,reason:'delegation_expired'};
  const rows=tx?(await tx.query('SELECT app_id FROM installations WHERE id=$1',[d.installation_id])).rows:await this.db.query('SELECT app_id FROM installations WHERE id=$1',[d.installation_id]);
  if(rows[0]?.app_id!==d.app_id)return {allowed:false,reason:'delegation_scope_mismatch'};
  const policy=this.policy(tx),p={subject:d.actor,admin:false,technician:false,server:true,installationId:d.installation_id};
  // Never carry an admin bypass, role snapshot or UI token into a durable delegation.
  for(const permission of d.functions){const result=await policy.check(p,d.installation_id,permission);if(!result.allowed)return result;}
  return {allowed:true,reason:'granted'};
 }
 private async requireCurrent(d:any,tx?:PoolClient){const result=await this.current(d,tx);if(!result.allowed)throw new ForbiddenException(result.reason);}
 async create(i:string,p:Principal,input:DelegationInput,key:string){
  return this.db.transaction(async tx=>{
   const installation=(await tx.query('SELECT app_id FROM installations WHERE id=$1 FOR UPDATE',[i])).rows[0];if(!installation)throw new NotFoundException();
   const digest=requestHash({...input,expiresAt:new Date(input.expiresAt).toISOString()});
   const old=(await tx.query('SELECT * FROM automation_delegations WHERE installation_id=$1 AND actor=$2 AND idempotency_key=$3',[i,p.subject,key])).rows[0];
   if(old){if(old.request_hash!==digest)throw new ConflictException('idempotency_conflict');await this.requireCurrent(old,tx);return {delegation:delegationView(old),credential:unseal(old.credential_cipher)};}
   const expires=new Date(input.expiresAt).getTime();
   if(expires<=Date.now()||expires>Date.now()+366*86400000)throw new BadRequestException('Scadenza richiesta entro 366 giorni');
   if(input.archiveId&&!(await tx.query('SELECT id FROM wa_archives WHERE id=$1 AND installation_id=$2',[input.archiveId,i])).rows.length)throw new NotFoundException('Archivio non trovato');
   const d={id:randomUUID(),installation_id:i,app_id:installation.app_id,actor:p.subject,...{purpose:input.purpose,channel:input.channel,functions:input.functions,archive_id:input.archiveId||null,revision:1,expires_at:input.expiresAt,revoked_at:null,created_at:new Date()}};
   await this.requireCurrent(d,tx);const credential=secret();
   const inserted=await tx.query('INSERT INTO automation_delegations(id,installation_id,app_id,actor,purpose,channel,functions,archive_id,expires_at,idempotency_key,request_hash,credential_hash,credential_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',[d.id,i,d.app_id,p.subject,d.purpose,d.channel,JSON.stringify(d.functions),d.archive_id,input.expiresAt,key,digest,hash(credential),seal(credential)]);
   await audit(tx,p.subject!,'automation.delegation.create',d.id,{installationId:i,channel:d.channel,revision:1});return {delegation:delegationView(inserted.rows[0]),credential};
  });
 }
 async recover(i:string,actor:string,key:string){
  const [d]=await this.db.query('SELECT * FROM automation_delegations WHERE installation_id=$1 AND actor=$2 AND idempotency_key=$3',[i,actor,key]);
  if(!d)throw new NotFoundException();await this.requireCurrent(d);return {delegation:delegationView(d),credential:unseal(d.credential_cipher)};
 }
 async owned(i:string,id:string,p:Principal,credential?:string,tx?:PoolClient){
  const rows=tx?(await tx.query('SELECT * FROM automation_delegations WHERE id=$1 AND installation_id=$2 FOR UPDATE',[id,i])).rows:await this.db.query('SELECT * FROM automation_delegations WHERE id=$1 AND installation_id=$2',[id,i]);
  const d=rows[0];if(!d||!(credential?equalSecret(credential,d.credential_hash):p.subject===d.actor))throw new NotFoundException('Delega non trovata');return d;
 }
 async get(i:string,id:string,p:Principal,credential?:string){return delegationView(await this.owned(i,id,p,credential));}
 async verify(i:string,id:string,p:Principal,credential:string|undefined,scope:{purpose:string;channel:string;functions:string[]}){
  const d=await this.owned(i,id,p,credential);
  if(d.purpose!==scope.purpose||d.channel!==scope.channel||scope.functions.some(f=>!d.functions.includes(f)))return {allowed:false,reason:'delegation_scope_mismatch'};
  return this.current(d);
 }
 async revoke(i:string,id:string,p:Principal,credential?:string){
  return this.db.transaction(async tx=>{
   const d=await this.owned(i,id,p,credential,tx);
   if(!d.revoked_at){d.revoked_at=new Date();d.revision++;await tx.query('UPDATE automation_delegations SET revoked_at=$2,revision=$3 WHERE id=$1',[id,d.revoked_at,d.revision]);await tx.query("UPDATE outbox SET state='cancelled',error='delegation_revoked' WHERE delegation_id=$1 AND state='queued'",[id]);await audit(tx,d.actor,'automation.delegation.revoke',id,{installationId:i,revision:d.revision});}
   return delegationView(d);
  });
 }
 async send(i:string,id:string,p:Principal,credential:string,input:{sessionId:string;purpose:string;payload:unknown},key:string){
  return this.db.transaction(async tx=>{
   const d=await this.owned(i,id,p,credential,tx),digest=requestHash({delegationId:id,...input});
   // Read the original receipt even after disconnect/revocation/expiry. No new effect.
   const old=(await tx.query('SELECT * FROM outbox WHERE installation_id=$1 AND idempotency_key=$2',[i,key])).rows[0];
   if(old){if(old.delegation_id!==id||old.actor!==d.actor||old.request_hash!==digest)throw new ConflictException('idempotency_conflict');return outboxView(old);}
   if(d.channel!=='whatsapp'||d.purpose!==input.purpose)throw new ForbiddenException('delegation_scope_mismatch');
   await this.requireCurrent(d,tx);
   const s=(await tx.query("SELECT id FROM wa_sessions WHERE id=$1 AND installation_id=$2 AND archive_id=$3 AND state='connected' AND closed_at IS NULL AND NOT delete_requested",[input.sessionId,i,d.archive_id])).rows[0];
   if(!s)throw new ConflictException('session_scope_mismatch');
   const outboxId=randomUUID();
   const inserted=await tx.query("INSERT INTO outbox(id,installation_id,session_id,idempotency_key,request_hash,payload,actor,authorization_cipher,delegation_id,delegation_revision,delegation_purpose) VALUES($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10) ON CONFLICT(installation_id,idempotency_key) DO NOTHING RETURNING *",[outboxId,i,input.sessionId,key,digest,JSON.stringify(input.payload),d.actor,id,d.revision,d.purpose]);
   if(!inserted.rows.length){const old=(await tx.query('SELECT * FROM outbox WHERE installation_id=$1 AND idempotency_key=$2',[i,key])).rows[0];if(old.delegation_id!==id||old.request_hash!==digest)throw new ConflictException('idempotency_conflict');return outboxView(old);}
   await audit(tx,d.actor,'automation.message.queued',outboxId,{delegationId:id,installationId:i,sessionId:input.sessionId});return outboxView(inserted.rows[0]);
  });
 }
 /** Withdraw the same command, or reserve its cancelled receipt before a delayed send can commit. */
 async withdraw(i:string,id:string,p:Principal,credential:string,input:{sessionId:string;purpose:string;payload:unknown},key:string):Promise<DelegatedMessageWithdrawal>{
  return this.db.transaction(async tx=>{
   // Same lock order as send/revoke/runner. This also fences a send with no outbox row yet.
   const d=await this.owned(i,id,p,credential,tx),digest=requestHash({delegationId:id,...input});
   let o=(await tx.query('SELECT * FROM outbox WHERE installation_id=$1 AND idempotency_key=$2 FOR UPDATE',[i,key])).rows[0];
   if(!o){
    // Ownership cleanup is permitted after expiry/revocation; it never authorizes a new effect.
    if(d.channel!=='whatsapp'||d.purpose!==input.purpose)throw new ConflictException('delegation_scope_mismatch');
    const session=(await tx.query('SELECT id FROM wa_sessions WHERE id=$1 AND installation_id=$2 AND archive_id=$3',[input.sessionId,i,d.archive_id])).rows[0];
    if(!session)throw new ConflictException('session_scope_mismatch');
    const inserted=await tx.query("INSERT INTO outbox(id,installation_id,session_id,idempotency_key,request_hash,payload,actor,authorization_cipher,delegation_id,delegation_revision,delegation_purpose,state,error) VALUES($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,'cancelled','command_withdrawn') ON CONFLICT(installation_id,idempotency_key) DO NOTHING RETURNING *",[randomUUID(),i,input.sessionId,key,digest,JSON.stringify(input.payload),d.actor,id,d.revision,d.purpose]);
    if(inserted.rows.length){
     o=inserted.rows[0];await audit(tx,d.actor,'automation.message.withdraw',o.id,{installationId:i,delegationId:id,sessionId:input.sessionId});return withdrawalView(o);
    }
    // Another delegation/manual command may own the installation-wide key. Never adopt it.
    o=(await tx.query('SELECT * FROM outbox WHERE installation_id=$1 AND idempotency_key=$2 FOR UPDATE',[i,key])).rows[0];
   }
   if(o.delegation_id!==id||o.actor!==d.actor||o.delegation_purpose!==input.purpose||o.session_id!==input.sessionId||o.request_hash!==digest)throw new ConflictException('idempotency_conflict');
   if(o.state==='queued'){
    o=(await tx.query("UPDATE outbox SET state='cancelled',error='command_withdrawn' WHERE id=$1 AND state='queued' RETURNING *",[o.id])).rows[0];
    await audit(tx,d.actor,'automation.message.withdraw',o.id,{installationId:i,delegationId:id,sessionId:input.sessionId});
   }
   return withdrawalView(o);
  });
 }
 async message(i:string,id:string,p:Principal,credential:string,key:string){
  await this.owned(i,id,p,credential);
  const [o]=await this.db.query('SELECT * FROM outbox WHERE installation_id=$1 AND delegation_id=$2 AND idempotency_key=$3',[i,id,key]);if(!o)throw new NotFoundException();return outboxView(o);
 }
 /** Runner only: derive actor/scope from persisted outbox, never from a job. */
 async authorizedOutbox(o:any,tx:PoolClient){
  const d=(await tx.query('SELECT * FROM automation_delegations WHERE id=$1 FOR UPDATE',[o.delegation_id])).rows[0];
  if(!d||d.installation_id!==o.installation_id||d.actor!==o.actor||d.channel!=='whatsapp'||d.purpose!==o.delegation_purpose||d.revision!==o.delegation_revision)return false;
  if(!(await this.current(d,tx)).allowed)return false;
  const s=(await tx.query('SELECT installation_id,archive_id,state,closed_at,delete_requested FROM wa_sessions WHERE id=$1',[o.session_id])).rows[0];
  return !!s&&s.installation_id===d.installation_id&&s.archive_id===d.archive_id&&s.state==='connected'&&!s.closed_at&&!s.delete_requested;
 }
}
