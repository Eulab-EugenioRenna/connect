import {randomUUID} from 'node:crypto';
import type {Database} from '../../api/src/database.js';
import {IdentitiesService} from '../../api/src/identities.service.js';
import {Authorization} from '../../api/src/authorization.js';
import {AutomationService} from '../../api/src/automation.service.js';
import {WhatsAppBotService} from '../../api/src/whatsapp-bot.service.js';
import {introspect} from '../../api/src/oidc.js';
import {unseal} from '../../api/src/security.js';
import {ProviderRejected,NotSent,NotOnWhatsApp,Unconfirmed,providerReason} from './openwa.js';

/** A message verified as not sent is tried again, a few times, spaced out. */
export const outboxRetry={attempts:6,delaySeconds:[20,60,120,300,600]};
const pause=(attempt:number)=>outboxRetry.delaySeconds[Math.min(attempt,outboxRetry.delaySeconds.length)-1];

/** A queue item carries only the persisted outbox ID. Only a send verified as not sent is retried. */
export async function runOutbox(db:Database,id:string,runner:string,getEffect: (sessionId:string)=>Promise<((payload:any)=>Promise<string>)|undefined>,automations=new AutomationService(db,new IdentitiesService(db))){
 const [initial]=await db.query('SELECT o.*,s.runner_id FROM outbox o JOIN wa_sessions s ON s.id=o.session_id WHERE o.id=$1',[id]);
 if(!initial||initial.state!=='queued'||initial.runner_id!==runner)return;
 if(initial.not_before&&new Date(initial.not_before).getTime()>Date.now())return;
 const send=await getEffect(initial.session_id);if(!send)throw new Error('SESSION_NOT_READY');
 const policy=new Authorization(db),bots=new WhatsAppBotService(db,policy);
 const claimed=await db.transaction(async tx=>{
  // Lock delegation before outbox, same order as revoke/enqueue, to avoid a revoke/claim deadlock.
  if(initial.delegation_id)await tx.query('SELECT id FROM automation_delegations WHERE id=$1 FOR UPDATE',[initial.delegation_id]);
  const o=(await tx.query('SELECT o.*,s.state AS session_state,s.closed_at,s.delete_requested,i.enabled AS installation_enabled FROM outbox o JOIN wa_sessions s ON s.id=o.session_id JOIN installations i ON i.id=o.installation_id WHERE o.id=$1 FOR UPDATE OF o',[id])).rows[0];
  if(!o||o.state!=='queued')return;
  let allowed=false;
  if(o.delegation_id){allowed=await automations.authorizedOutbox(o,tx);}
  else if(o.bot_archive_id){
   const bot=(await tx.query('SELECT actor,technical_admin,revision,enabled FROM wa_bots WHERE archive_id=$1',[o.bot_archive_id])).rows[0];
   allowed=!!bot&&bot.enabled&&bot.revision===o.bot_revision&&await bots.authorized(bot,o.installation_id,tx);
  }else{
   const current=await introspect(unseal(o.authorization_cipher)),technical=current.realm_access?.roles?.includes('eulab-admin')===true;
   const txPolicy=new Authorization({query:async(sql:string,params:unknown[]=[]) => (await tx.query(sql,params)).rows} as Database);
   allowed=o.installation_enabled&&current.active&&current.sub===o.actor&&(technical||(await txPolicy.check({subject:o.actor,admin:false,technician:false,server:true,installationId:o.installation_id},o.installation_id,'whatsapp.send')).allowed);
  }
  if(!allowed||o.session_state!=='connected'||o.closed_at||o.delete_requested){await tx.query("UPDATE outbox SET state='cancelled',error='authorization_revoked' WHERE id=$1 AND state='queued'",[id]);return;}
  const updated=await tx.query("UPDATE outbox SET state='sending' WHERE id=$1 AND state='queued' AND (bot_archive_id IS NULL OR EXISTS(SELECT 1 FROM wa_bots b WHERE b.archive_id=outbox.bot_archive_id AND b.enabled AND b.revision=outbox.bot_revision)) RETURNING id",[id]);
  if(updated.rowCount)return o;
 });
 if(!claimed)return;
 try{
  // Lease and durable authorization are checked again immediately before the provider boundary.
  const effect=await getEffect(claimed.session_id);if(!effect)throw new Error('SESSION_OWNER_LOST');
  if(claimed.delegation_id){
   const allowed=await db.transaction(tx=>automations.authorizedOutbox(claimed,tx));
   if(!allowed){await db.query("UPDATE outbox SET state='cancelled',error='authorization_revoked' WHERE id=$1 AND state='sending'",[id]);return;}
  }
  const providerId=await effect(claimed.payload);
  // Provider success and its signed event are one commit. A lost commit response stays sent or uncertain.
  await markSent(db,claimed,providerId,'sending');
  return {outbox:claimed,providerId};
 }catch(error){
  // Only a cleaned reason is kept: provider messages can carry numbers or credentials.
  const reason=providerReason(error);
  if(error instanceof ProviderRejected||(error as {outcome?:unknown})?.outcome==='not_sent'){
   await db.query("UPDATE outbox SET state='failed',error='provider_rejected' WHERE id=$1 AND state='sending'",[id]);
   console.warn(JSON.stringify({component:'outbox',level:'warn',message:'outbox_rejected',outboxId:id,reason}));return;
  }
  if(error instanceof NotOnWhatsApp){
   await db.query("UPDATE outbox SET state='failed',error='not_on_whatsapp' WHERE id=$1 AND state='sending'",[id]);
   console.warn(JSON.stringify({component:'outbox',level:'warn',message:'outbox_not_on_whatsapp',outboxId:id}));return;
  }
  if(error instanceof NotSent){
   // Verified on the phone: nothing left. Another attempt cannot produce a duplicate.
   const attempt=(claimed.attempts??0)+1;
   await notSent(db,id,'sending',attempt,reason);return;
  }
  // The message may be on its way: never resent automatically. With its ID it is checked again later.
  await db.query("UPDATE outbox SET state='uncertain',provider_id=COALESCE($3,provider_id),error=$2 WHERE id=$1 AND state='sending'",[id,`Esito provider non confermato; nessun reinvio automatico (${reason})`,error instanceof Unconfirmed?error.messageId??null:null]);
  console.warn(JSON.stringify({component:'outbox',level:'warn',message:'outbox_uncertain',outboxId:id,reason}));
 }
}
async function notSent(db:Database,id:string,from:string,attempt:number,reason:string){
 if(attempt<outboxRetry.attempts){
  const seconds=pause(attempt);
  await db.query("UPDATE outbox SET state='queued',attempts=$3,not_before=now()+make_interval(secs=>$4),error=$5 WHERE id=$1 AND state=$2",[id,from,attempt,seconds,`retrying: tentativo ${attempt} di ${outboxRetry.attempts} non partito (${reason}), nuovo tentativo tra ${seconds} secondi`]);
  console.warn(JSON.stringify({component:'outbox',level:'warn',message:'outbox_retry',outboxId:id,attempt,reason}));return;
 }
 await db.query("UPDATE outbox SET state='failed',attempts=$3,error=$4 WHERE id=$1 AND state=$2",[id,from,attempt,`not_sent: non partito dopo ${attempt} tentativi (${reason})`]);
 console.warn(JSON.stringify({component:'outbox',level:'warn',message:'outbox_not_sent',outboxId:id,attempt,reason}));
}
async function markSent(db:Database,o:any,providerId:string,from:string){
 await db.transaction(async tx=>{
  const result=await tx.query("UPDATE outbox SET state='sent',provider_id=$2,error=NULL WHERE id=$1 AND state=$3 RETURNING id",[o.id,providerId,from]);if(!result.rowCount)return;
  const session=(await tx.query('SELECT archive_id,number FROM wa_sessions WHERE id=$1',[o.session_id])).rows[0];
  const eventId=randomUUID(),occurredAt=new Date().toISOString();
  const payload={outboxId:o.id,providerId,sessionId:o.session_id,archiveId:session.archive_id,direction:'out',fromMe:true,senderId:session.number?session.number+'@c.us':null,recipientId:o.payload.to,occurredAt,source:'connect_outbox',delegationId:o.delegation_id||null};
  await tx.query("INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,'message.sent',$4)",[eventId,o.installation_id,o.session_id,JSON.stringify(payload)]);
  await tx.query('INSERT INTO deliveries(id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM webhook_endpoints WHERE installation_id=$2 AND enabled=true',[eventId,o.installation_id]);
 });
}
/**
 * Messages on the phone that WhatsApp had not acknowledged yet: their ack is read again by ID.
 * Acknowledged: sent. Error on the message: verified not sent, tried again. Still waiting: left as it is.
 */
export async function reconcileOutbox(db:Database,runner:string,ackOf:(sessionId:string,providerId:string)=>Promise<number|null>){
 const rows=await db.query("SELECT o.* FROM outbox o JOIN wa_sessions s ON s.id=o.session_id WHERE s.runner_id=$1 AND o.state='uncertain' AND o.provider_id IS NOT NULL AND o.created_at>now()-interval '24 hours' ORDER BY o.created_at LIMIT 50",[runner]);
 for(const o of rows){
  const ack=await ackOf(o.session_id,o.provider_id);
  if(ack!==null&&ack>=1){await markSent(db,o,o.provider_id,'uncertain');console.warn(JSON.stringify({component:'outbox',level:'info',message:'outbox_confirmed_later',outboxId:o.id,ack}));}
  else if(ack!==null&&ack<0)await notSent(db,o.id,'uncertain',(o.attempts??0)+1,'WHATSAPP_ACK_ERROR');
 }
}
/** Reclaiming a process never reclaims an effect: both pre/post-effect crashes stay uncertain. */
export async function recoverInterruptedOutbox(db:Database,runner:string){
 await db.query("UPDATE outbox SET state='uncertain',error='Runner interrotto durante invio; verifica manuale necessaria' WHERE state='sending' AND session_id IN (SELECT id FROM wa_sessions WHERE runner_id=$1)",[runner]);
}
