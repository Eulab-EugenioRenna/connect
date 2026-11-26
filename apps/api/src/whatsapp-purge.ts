import type {PoolClient} from 'pg';
// Run only after every session in this archive has been closed by its owning runner.
export async function purgeWhatsApp(tx:PoolClient,installationId:string,archiveId:string|null,sessionId?:string){
 const ids=(await tx.query('SELECT id,closed_at FROM wa_sessions WHERE installation_id=$1 AND (($2::uuid IS NOT NULL AND archive_id=$2) OR ($2::uuid IS NULL AND id=$3)) FOR UPDATE',[installationId,archiveId,sessionId||null])).rows;
 if(ids.some(s=>!s.closed_at))return false;
 const keys=ids.map(s=>s.id);
 await tx.query('DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE session_id=ANY($1::uuid[]))',[keys]);
 for(const table of ['events','outbox','messages'])await tx.query(`DELETE FROM ${table} WHERE session_id=ANY($1::uuid[])`,[keys]);
 await tx.query('DELETE FROM wa_sessions WHERE id=ANY($1::uuid[])',[keys]);
 if(archiveId)await tx.query('DELETE FROM wa_archives WHERE id=$1 AND installation_id=$2',[archiveId,installationId]);
 return true;
}

/**
 * Deleting a licence: every WhatsApp connection of it is asked to disconnect and,
 * once closed by its runner, removed with its archives (messages, outbox, events).
 * false: a number is still connected; the request stays and the runner completes it.
 */
export async function purgeInstallationWhatsApp(tx:PoolClient,installationId:string){
 await tx.query("UPDATE wa_sessions SET delete_requested=true,state=CASE WHEN closed_at IS NULL THEN 'disconnecting' ELSE state END,qr=null WHERE installation_id=$1",[installationId]);
 for(const a of (await tx.query('SELECT id FROM wa_archives WHERE installation_id=$1',[installationId])).rows)await purgeWhatsApp(tx,installationId,a.id);
 for(const s of (await tx.query('SELECT id FROM wa_sessions WHERE installation_id=$1 AND archive_id IS NULL',[installationId])).rows)await purgeWhatsApp(tx,installationId,null,s.id);
 const left=(await tx.query('SELECT (SELECT count(*) FROM wa_sessions WHERE installation_id=$1)+(SELECT count(*) FROM wa_archives WHERE installation_id=$1) AS n',[installationId])).rows[0];
 return Number(left?.n??0)===0;
}
