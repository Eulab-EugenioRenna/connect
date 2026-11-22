import {Injectable,ForbiddenException,ConflictException,NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Database,audit} from './database.js';
import {Authorization} from './authorization.js';
import type {Principal} from './auth.js';
import {requestHash} from './automation-contract.js';
import {secret,seal,unseal} from './security.js';
@Injectable()
export class WebhookRegistrationService {
 constructor(private readonly db:Database){}
 private async access(i:string,p:Principal,tx?:PoolClient){
  const store=tx?{query:async(sql:string,params:unknown[]=[]) => (await tx.query(sql,params)).rows} as Database:this.db;
  const result=await new Authorization(store).check({...p,admin:false},i,'whatsapp.manage');if(!result.allowed)throw new ForbiddenException(result.reason);
 }
 private result(row:any){return {id:row.id,url:row.url,enabled:row.enabled,secret:unseal(row.secret_cipher)};}
 async create(i:string,p:Principal,input:{url:string},key:string){
  const url=new URL(input.url);
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new ForbiddenException('Webhook HTTPS sulla porta 443 richiesto');
  const digest=requestHash({url:url.href});
  return this.db.transaction(async tx=>{
   await tx.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[i]);
   await this.access(i,p,tx);
   const old=(await tx.query('SELECT * FROM webhook_endpoints WHERE installation_id=$1 AND actor=$2 AND idempotency_key=$3',[i,p.subject,key])).rows[0];
   if(old){if(old.request_hash!==digest)throw new ConflictException('idempotency_conflict');return this.result(old);}
   const credential=secret(),id=randomUUID();
   await tx.query('INSERT INTO webhook_endpoints(id,installation_id,url,secret_cipher,actor,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,i,url.href,seal(credential),p.subject,key,digest]);
   await audit(tx,p.subject!,'webhook.create',id,{installationId:i});return {id,url:url.href,enabled:true,secret:credential};
  });
 }
 async recover(i:string,p:Principal,key:string){
  await this.access(i,p);const [old]=await this.db.query('SELECT * FROM webhook_endpoints WHERE installation_id=$1 AND actor=$2 AND idempotency_key=$3',[i,p.subject,key]);
  if(!old)throw new NotFoundException();return this.result(old);
 }
}
