import type {Database} from '../../api/src/database.js';
import type {Authorization} from '../../api/src/authorization.js';
import type {WaClient} from './openwa.js';
import {introspect} from '../../api/src/oidc.js';
import {unseal} from '../../api/src/security.js';
import {operationPermission,providerCommandSchema} from '../../api/src/whatsapp-operations.js';
/** Claim once before calling the provider. Ambiguous completion is never retried. */
export async function runProviderOperation(db:Database,policy:Authorization,id:string,runner:string,owned:(id:string)=>Promise<WaClient|undefined>,emit:(session:any,kind:string,payload:unknown)=>Promise<void>){
 const [op]=await db.query('SELECT o.*,s.state AS session_state,s.closed_at,s.delete_requested,s.archive_id,i.enabled FROM wa_operations o JOIN wa_sessions s ON s.id=o.session_id JOIN installations i ON i.id=o.installation_id WHERE o.id=$1 AND s.runner_id=$2',[id,runner]);
 if(!op||op.state!=='queued')return;
 const client=await owned(op.session_id);if(!client)throw new Error('SESSION_NOT_READY');
 const current=await introspect(unseal(op.authorization_cipher));
 const principal={subject:op.actor,admin:current.realm_access?.roles?.includes('eulab-admin')===true,technician:false,server:true,installationId:op.installation_id};
 const allowed=current.active&&current.sub===op.actor&&op.enabled&&op.session_state==='connected'&&!op.closed_at&&!op.delete_requested&&(principal.admin||(await policy.check(principal,op.installation_id,operationPermission(op.command.kind))).allowed&&(op.command.kind!=='call.start'||(await policy.check(principal,op.installation_id,'whatsapp.send')).allowed));
 if(!allowed){await db.query("UPDATE wa_operations SET state='cancelled',error='authorization_revoked' WHERE id=$1 AND state='queued'",[id]);return;}
 const command=providerCommandSchema.parse(op.command);
 if('call' in command&&command.call.sessionId!==op.session_id)throw new Error('CALL_SESSION_MISMATCH');
 if((await owned(op.session_id))!==client)throw new Error('SESSION_OWNER_LOST');
 const [claimed]=await db.query("UPDATE wa_operations SET state='running' WHERE id=$1 AND state='queued' RETURNING id",[id]);if(!claimed)return;
 try{
  const result=await client.operation(command);
  if((await owned(op.session_id))!==client)throw new Error('SESSION_OWNER_LOST');
  await db.transaction(async tx=>{
   if(command.kind==='contact.refresh')await tx.query('INSERT INTO wa_contacts(archive_id,chat_id,profile) VALUES($1,$2,$3) ON CONFLICT(archive_id,chat_id) DO UPDATE SET profile=$3,updated_at=now()',[op.archive_id,command.chatId,JSON.stringify(result)]);
   await tx.query("UPDATE wa_operations SET state='completed',result=$2 WHERE id=$1",[id,JSON.stringify(result)]);
  });
  await emit({id:op.session_id,installation_id:op.installation_id},'provider.operation.completed',{id,kind:command.kind});
 }catch{await db.query("UPDATE wa_operations SET state='uncertain',error='Esito provider non confermato; nessuna ripetizione automatica' WHERE id=$1 AND state='running'",[id]);}
}
