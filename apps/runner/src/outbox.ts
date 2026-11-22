import {randomUUID} from 'node:crypto';
import type {Database} from '../../api/src/database.js';
import {IdentitiesService} from '../../api/src/identities.service.js';
import {Authorization} from '../../api/src/authorization.js';
import {AutomationService} from '../../api/src/automation.service.js';
import {WhatsAppBotService} from '../../api/src/whatsapp-bot.service.js';
import {introspect} from '../../api/src/oidc.js';
import {unseal} from '../../api/src/security.js';

/** A queue item carries only the persisted outbox ID. Provider failures are never retried. */
export async function runOutbox(db:Database,id:string,runner:string,getEffect: (sessionId:string)=>Promise<((payload:any)=>Promise<string>)|undefined>,automations=new AutomationService(db,new IdentitiesService(db))){
 const [initial]=await db.query('SELECT o.*,s.runner_id FROM outbox o JOIN wa_sessions s ON s.id=o.session_id WHERE o.id=$1',[id]);
 if(!initial||initial.state!=='queued'||initial.runner_id!==runner)return;
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
  await db.transaction(async tx=>{
   const result=await tx.query("UPDATE outbox SET state='sent',provider_id=$2 WHERE id=$1 AND state='sending' RETURNING id",[id,providerId]);if(!result.rowCount)return;
   const session=(await tx.query('SELECT archive_id,number FROM wa_sessions WHERE id=$1',[claimed.session_id])).rows[0];
   const eventId=randomUUID(),occurredAt=new Date().toISOString();
   const payload={outboxId:id,providerId,sessionId:claimed.session_id,archiveId:session.archive_id,direction:'out',fromMe:true,senderId:session.number?session.number+'@c.us':null,recipientId:claimed.payload.to,occurredAt,source:'connect_outbox',delegationId:claimed.delegation_id||null};
   await tx.query("INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,'message.sent',$4)",[eventId,claimed.installation_id,claimed.session_id,JSON.stringify(payload)]);
   await tx.query('INSERT INTO deliveries(id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM webhook_endpoints WHERE installation_id=$2 AND enabled=true',[eventId,claimed.installation_id]);
  });
  return {outbox:claimed,providerId};
 }catch{
  await db.query("UPDATE outbox SET state='uncertain',error='Esito provider non confermato; nessun reinvio automatico' WHERE id=$1 AND state='sending'",[id]);
 }
}
/** Reclaiming a process never reclaims an effect: both pre/post-effect crashes stay uncertain. */
export async function recoverInterruptedOutbox(db:Database,runner:string){
 await db.query("UPDATE outbox SET state='uncertain',error='Runner interrotto durante invio; verifica manuale necessaria' WHERE state='sending' AND session_id IN (SELECT id FROM wa_sessions WHERE runner_id=$1)",[runner]);
}
