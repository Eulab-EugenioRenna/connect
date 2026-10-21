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
