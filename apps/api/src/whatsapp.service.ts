import { Injectable, OnModuleDestroy, ConflictException, NotFoundException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Database, audit } from './database.js';
import { redisOptions } from './config.js';
import { Principal } from './auth.js';
import { hash,seal } from './security.js';
@Injectable()
export class WhatsAppService implements OnModuleDestroy {
 private readonly queues=new Map<string,Queue>();
 constructor(private readonly db:Database) {}
 queue(runner:string) {let q=this.queues.get(runner);if(!q){q=new Queue(`wa-${runner}`,{connection:redisOptions()});this.queues.set(runner,q);}return q;}
 async start(installationId:string,p:Principal) {
   return this.db.transaction(async db=>{
     await db.query('SELECT pg_advisory_xact_lock(901272)');
     await db.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[installationId]);
     const active=(await db.query('SELECT id FROM wa_sessions WHERE installation_id=$1 AND closed_at IS NULL',[installationId])).rows[0];if(active)throw new ConflictException('Connessione già presente');
     // Lock the selected runner to serialize capacity reservations from all API replicas.
     const runner=(await db.query(`SELECT r.id FROM runners r WHERE heartbeat_at>now()-interval '20 seconds'
       AND (SELECT count(*) FROM wa_sessions s WHERE s.runner_id=r.id AND s.closed_at IS NULL)<r.capacity ORDER BY r.id LIMIT 1 FOR UPDATE OF r`)).rows[0];
     if(!runner)throw new ServiceUnavailableException('Nessun runner disponibile');
     const id=randomUUID();await db.query("INSERT INTO wa_sessions(id,installation_id,runner_id,state) VALUES($1,$2,$3,'queued')",[id,installationId,runner.id]);
     await audit(db,p.subject!,'whatsapp.connect',id,{installationId});return {id,state:'queued'};
   });
 }
 async session(installationId:string,sessionId:string) {
   const [s]=await this.db.query('SELECT * FROM wa_sessions WHERE installation_id=$1 AND id=$2',[installationId,sessionId]);if(!s)throw new NotFoundException();return s;
 }
 async disconnect(installationId:string,id:string,p:Principal) {
   await this.session(installationId,id);
   return this.db.transaction(async db=>{const result=await db.query("UPDATE wa_sessions SET state='disconnecting',qr=null WHERE id=$1 AND closed_at IS NULL RETURNING id",[id]);if(!result.rowCount)throw new ConflictException('Sessione già chiusa');await audit(db,p.subject!,'whatsapp.disconnect.request',id);return {id,state:'disconnecting'};});
 }
 async enqueue(installationId:string,sessionId:string,payload:unknown,idempotencyKey:string,p:Principal) {
   const [installation]=await this.db.query('SELECT enabled FROM installations WHERE id=$1',[installationId]);if(!installation?.enabled)throw new ConflictException('Installazione revocata');
   const s=await this.session(installationId,sessionId);if(s.delete_requested||s.state!=='connected')throw new ConflictException('Sessione non connessa');
   const digest=hash(JSON.stringify(payload)),id=randomUUID();
   return this.db.transaction(async db=>{
     const inserted=await db.query('INSERT INTO outbox(id,installation_id,session_id,idempotency_key,request_hash,payload,actor,authorization_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(installation_id,idempotency_key) DO NOTHING RETURNING id',[id,installationId,sessionId,idempotencyKey,digest,JSON.stringify(payload),p.subject,seal(p.accessToken!)]);
     if(!inserted.rowCount){const old=(await db.query('SELECT id,state,request_hash,session_id FROM outbox WHERE installation_id=$1 AND idempotency_key=$2',[installationId,idempotencyKey])).rows[0];if(old.request_hash!==digest||old.session_id!==sessionId)throw new ConflictException('Chiave di idempotenza già usata con altra richiesta');return {id:old.id,state:old.state};}
     await audit(db,p.subject!,'whatsapp.send.queued',id,{sessionId,kind:(payload as any).kind,technicalAdmin:p.admin});return {id,state:'queued'};
   });
 }
 async onModuleDestroy(){await Promise.all([...this.queues.values()].map(q=>q.close()));}
}
