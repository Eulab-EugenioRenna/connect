import {Injectable,NotFoundException,ConflictException,BadRequestException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {Database,audit} from './database.js';
import {Authorization} from './authorization.js';
import type {Principal} from './auth.js';
import {botTurn,botPayload} from './whatsapp-bot.js';
import {hash} from './security.js';
import type {WhatsAppBotDefinition,WhatsAppBotState} from '../../../packages/sdk/src/bot.js';
@Injectable()
export class WhatsAppBotService {
 constructor(private readonly db:Database,private readonly policy:Authorization){}
 async archive(installationId:string,archiveId:string){
  const [archive]=await this.db.query('SELECT id FROM wa_archives WHERE id=$1 AND installation_id=$2',[archiveId,installationId]);if(!archive)throw new NotFoundException('Archivio non trovato');
 }
 async get(installationId:string,archiveId:string){
  await this.archive(installationId,archiveId);
  const [bot]=await this.db.query('SELECT definition,revision,enabled FROM wa_bots WHERE archive_id=$1',[archiveId]);
  const [session]=await this.db.query("SELECT id FROM wa_sessions WHERE archive_id=$1 AND installation_id=$2 AND state='connected' AND closed_at IS NULL AND NOT delete_requested",[archiveId,installationId]);
  return {archiveId,definition:bot?.definition||null,revision:bot?.revision||0,enabled:bot?.enabled||false,connected:!!session};
 }
 async configure(installationId:string,archiveId:string,definition:WhatsAppBotDefinition,expectedRevision:number,p:Principal){
  await this.archive(installationId,archiveId);
  await this.db.transaction(async tx=>{
   // Serialize initial creation as well as subsequent edits for this archive.
   await tx.query('SELECT id FROM wa_archives WHERE id=$1 AND installation_id=$2 FOR UPDATE',[archiveId,installationId]);
   const old=(await tx.query('SELECT revision FROM wa_bots WHERE archive_id=$1 FOR UPDATE',[archiveId])).rows[0];
   if((old?.revision||0)!==expectedRevision)throw new ConflictException('Il bot è stato modificato: ricarica la configurazione');
   await tx.query(`INSERT INTO wa_bots(archive_id,definition,actor,technical_admin) VALUES($1,$2,$3,$4) ON CONFLICT(archive_id) DO UPDATE SET definition=$2,revision=wa_bots.revision+1,enabled=false,actor=$3,technical_admin=$4,updated_at=now()`,[archiveId,JSON.stringify(definition),p.subject,p.admin]);
   await this.clear(tx,archiveId);
   await audit(tx,p.subject!,'whatsapp.bot.configure',archiveId,{installationId,nodes:definition.nodes.length,revision:expectedRevision+1});
  });return this.get(installationId,archiveId);
 }
 async enable(installationId:string,archiveId:string,enabled:boolean,revision:number,p:Principal){
  await this.archive(installationId,archiveId);
  await this.db.transaction(async tx=>{
   const old=(await tx.query('SELECT revision FROM wa_bots WHERE archive_id=$1 FOR UPDATE',[archiveId])).rows[0];
   if(!old)throw new NotFoundException('Configura prima il bot');if(old.revision!==revision)throw new ConflictException('Revisione del bot cambiata');
   if(enabled){const active=await tx.query("SELECT s.id FROM wa_sessions s JOIN installations i ON i.id=s.installation_id WHERE s.installation_id=$1 AND s.archive_id=$2 AND s.state='connected' AND s.closed_at IS NULL AND NOT s.delete_requested AND i.enabled",[installationId,archiveId]);if(!active.rows.length)throw new ConflictException('Collega prima il numero tramite QR');}
   await tx.query('UPDATE wa_bots SET enabled=$2,actor=$3,technical_admin=$4,updated_at=now() WHERE archive_id=$1',[archiveId,enabled,p.subject,p.admin]);
   await this.clear(tx,archiveId);await audit(tx,p.subject!,'whatsapp.bot.'+(enabled?'enable':'disable'),archiveId,{installationId,revision,delegatedAutomation:enabled});
  });return this.get(installationId,archiveId);
 }
 async startVoice(installationId:string,archiveId:string,callId:string,key:string,p:Principal){
  await this.archive(installationId,archiveId);
  return this.db.transaction(async tx=>{
   await tx.query('SELECT id FROM wa_archives WHERE id=$1 FOR UPDATE',[archiveId]);
   const old=(await tx.query('SELECT * FROM wa_voice_ivr WHERE archive_id=$1 AND (idempotency_key=$2 OR call_id=$3)',[archiveId,key,callId])).rows[0];
   if(old){if(old.idempotency_key!==key||old.call_id!==callId||old.actor!==p.subject)throw new ConflictException('Chiave o chiamata già usata');return old.initial_response;}
   const bot=(await tx.query('SELECT definition,revision FROM wa_bots WHERE archive_id=$1',[archiveId])).rows[0];
   if(!bot)throw new NotFoundException('Configura prima il percorso IVR');
   const id=randomUUID(),expiresAt=new Date(Date.now()+bot.definition.sessionTimeoutMinutes*60000).toISOString();
   const result=botTurn(bot.definition,{type:'start'},null,'voice'),response={id,callId,revision:bot.revision,turn:0,result,expiresAt};
   await tx.query('INSERT INTO wa_voice_ivr(id,archive_id,actor,call_id,idempotency_key,definition,revision,result,initial_response,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,archiveId,p.subject,callId,key,JSON.stringify(bot.definition),bot.revision,JSON.stringify(result),JSON.stringify(response),expiresAt]);
   await audit(tx,p.subject!,'whatsapp.ivr.voice.start',id,{installationId,archiveId,callId,revision:bot.revision});return response;
  });
 }
 async getVoice(installationId:string,archiveId:string,id:string,p:Principal){
  await this.archive(installationId,archiveId);
  const [row]=await this.db.query('SELECT id,call_id,revision,turn,result,expires_at FROM wa_voice_ivr WHERE id=$1 AND archive_id=$2 AND actor=$3',[id,archiveId,p.subject]);
  if(!row)throw new NotFoundException('Sessione IVR non trovata');
  return {id:row.id,callId:row.call_id,revision:row.revision,turn:row.turn,result:row.result,expiresAt:new Date(row.expires_at).toISOString()};
 }
 async advanceVoice(installationId:string,archiveId:string,id:string,input:import('../../../packages/sdk/src/bot.js').IVRInput,expectedTurn:number,key:string,p:Principal){
  await this.archive(installationId,archiveId);
  return this.db.transaction(async tx=>{
   const row=(await tx.query('SELECT * FROM wa_voice_ivr WHERE id=$1 AND archive_id=$2 AND actor=$3 FOR UPDATE',[id,archiveId,p.subject])).rows[0];
   if(!row)throw new NotFoundException('Sessione IVR non trovata');
   const digest=hash(JSON.stringify({input,expectedTurn})),old=(await tx.query('SELECT * FROM wa_voice_turns WHERE session_id=$1 AND idempotency_key=$2',[id,key])).rows[0];
   if(old){if(old.request_hash!==digest)throw new ConflictException('Chiave usata con un altro turno');return old.response;}
   if(row.turn!==expectedTurn)throw new ConflictException('Turno IVR cambiato');
   if(row.result.completed||new Date(row.expires_at).getTime()<=Date.now())throw new BadRequestException('Sessione IVR conclusa o scaduta');
   const result=botTurn(row.definition,input,row.result.state,'voice'),expiresAt=new Date(Date.now()+row.definition.sessionTimeoutMinutes*60000).toISOString();
   const response={id,callId:row.call_id,revision:row.revision,turn:row.turn+1,result,expiresAt};
   await tx.query('UPDATE wa_voice_ivr SET turn=$2,result=$3,expires_at=$4 WHERE id=$1',[id,response.turn,JSON.stringify(result),expiresAt]);
   await tx.query('INSERT INTO wa_voice_turns(session_id,idempotency_key,request_hash,response) VALUES($1,$2,$3,$4)',[id,key,digest,JSON.stringify(response)]);
   await audit(tx,p.subject!,'whatsapp.ivr.voice.turn',id,{installationId,turn:response.turn,completed:result.completed});return response;
  });
 }
 private async clear(tx:PoolClient,archiveId:string){
  await tx.query('DELETE FROM wa_bot_conversations WHERE archive_id=$1',[archiveId]);
  await tx.query("UPDATE outbox SET state='cancelled',error='bot_configuration_changed' WHERE bot_archive_id=$1 AND state='queued'",[archiveId]);
 }
 async authorized(bot:{actor:string;technical_admin:boolean},installationId:string,tx?:PoolClient){
  const store=tx?{query:async(sql:string,params:unknown[]) => (await tx.query(sql,params)).rows}:this.db;
  const policy=tx?new Authorization(store as Database):this.policy;
  const [installation]=await store.query('SELECT enabled FROM installations WHERE id=$1',[installationId]);if(!installation?.enabled)return false;
  // Enabling is an explicit durable delegation, independent of an expiring UI token.
  if(bot.technical_admin)return true;
  const principal={subject:bot.actor,admin:false,technician:false,server:true,installationId};
  return (await policy.check(principal,installationId,'whatsapp.manage')).allowed&&(await policy.check(principal,installationId,'whatsapp.send')).allowed;
 }
 async receive(tx:PoolClient,session:{id:string;installation_id:string;archive_id:string},message:{id:string;provider_id:string;chat_id:string;text:string;occurred_at:Date}){
  if(!/@(c\.us|lid)$/.test(message.chat_id)||Date.now()-message.occurred_at.getTime()>120_000||message.occurred_at.getTime()>Date.now()+30_000)return;
  const bot=(await tx.query('SELECT * FROM wa_bots WHERE archive_id=$1 AND enabled=true FOR UPDATE',[session.archive_id])).rows[0];if(!bot||!await this.authorized(bot,session.installation_id,tx))return;
  const active=await tx.query("SELECT id FROM wa_sessions WHERE id=$1 AND archive_id=$2 AND state='connected' AND closed_at IS NULL AND NOT delete_requested",[session.id,session.archive_id]);if(!active.rows.length)return;
  if((await tx.query('SELECT id FROM outbox WHERE installation_id=$1 AND idempotency_key=$2',[session.installation_id,`bot-${message.id}`])).rows.length)return;
  const previous=(await tx.query('SELECT * FROM wa_bot_conversations WHERE archive_id=$1 AND chat_id=$2',[session.archive_id,message.chat_id])).rows[0];
  const definition=bot.definition as WhatsAppBotDefinition;
  const state:WhatsAppBotState|null=previous&&previous.revision===bot.revision&&Date.now()-new Date(previous.updated_at).getTime()<definition.sessionTimeoutMinutes*60_000?previous.state:null;
  let input=message.text;
  if(input.startsWith('ivr:')){const prefix=`ivr:v${bot.revision}:`;if(!input.startsWith(prefix))return;input='ivr:'+input.slice(prefix.length);}
  const result=botTurn(definition,input,state);
  if(!result.reply)return;
  if(result.state)await tx.query(`INSERT INTO wa_bot_conversations(archive_id,chat_id,revision,state) VALUES($1,$2,$3,$4) ON CONFLICT(archive_id,chat_id) DO UPDATE SET revision=$3,state=$4,updated_at=now()`,[session.archive_id,message.chat_id,bot.revision,JSON.stringify(result.state)]);
  else await tx.query('DELETE FROM wa_bot_conversations WHERE archive_id=$1 AND chat_id=$2',[session.archive_id,message.chat_id]);
  const payload=botPayload(message.chat_id,result,bot.revision),outboxId=randomUUID();
  await tx.query(`INSERT INTO outbox(id,installation_id,session_id,idempotency_key,request_hash,payload,actor,authorization_cipher,bot_archive_id,bot_revision) VALUES($1,$2,$3,$4,$5,$6,$7,'',$8,$9) ON CONFLICT(installation_id,idempotency_key) DO NOTHING`,[outboxId,session.installation_id,session.id,`bot-${message.id}`,hash(JSON.stringify(payload)),JSON.stringify(payload),bot.actor,session.archive_id,bot.revision]);
  const eventId=randomUUID(),kind=result.completed?'bot.completed':'bot.step';
  await tx.query('INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,$4,$5)',[eventId,session.installation_id,session.id,kind,JSON.stringify({archiveId:session.archive_id,revision:bot.revision,chatId:message.chat_id,messageId:message.id,outboxId,nodeId:result.state?.nodeId||null,answers:result.answers,outcome:result.outcome||null})]);
  await tx.query('INSERT INTO deliveries(id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM webhook_endpoints WHERE installation_id=$2 AND enabled=true',[eventId,session.installation_id]);
 }
}
