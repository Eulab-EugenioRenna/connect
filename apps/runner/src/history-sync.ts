import type {Database} from '../../api/src/database.js';

/**
 * History of a number on a licence: one archive per (installation, number), messages
 * unique per archive. The first link of a number reads every chat (full sync); any
 * later link of the same number (also after another number was used in between)
 * only adds what is newer than the archive already holds (update).
 */
export interface HistoryClient {
 getAllChats():Promise<Array<{id:string;t?:number|null}>>;
 getAllMessagesInChat(id:string,includeMe:boolean,notifications:boolean):Promise<any[]>;
}
/** Overlap kept when updating, so messages arriving around the last sync are not missed. */
export const UPDATE_OVERLAP_SECONDS=3600;

export async function syncHistory(db:Database,session:{id:string;archive_id:string},client:HistoryClient,
 record:(m:any)=>Promise<void>,running:()=>boolean):Promise<{mode:'full'|'update';count:number;complete:boolean}>{
 const [archive]=await db.query('SELECT a.history_synced_at,(SELECT max(occurred_at) FROM messages m WHERE m.archive_id=a.id) AS last_at FROM wa_archives a WHERE a.id=$1',[session.archive_id]);
 const update=!!archive?.history_synced_at&&!!archive?.last_at;
 const cutoff=update?Math.floor(new Date(archive.last_at).getTime()/1000)-UPDATE_OVERLAP_SECONDS:0;
 const mode=update?'update':'full';
 await db.query("UPDATE wa_sessions SET sync_mode=$2,sync_status='running',sync_count=0 WHERE id=$1",[session.id,mode]);
 let count=0;
 try{
  for(const chat of await client.getAllChats()){
   if(!running())return {mode,count,complete:false};
   // Update: a chat with nothing newer than the archive is skipped without reading it.
   if(update&&typeof chat.t==='number'&&chat.t>0&&chat.t<cutoff)continue;
   for(const m of await client.getAllMessagesInChat(String(chat.id),true,false)){
    if(update&&typeof m?.t==='number'&&m.t>0&&m.t<cutoff)continue;
    await record(m);count++;
   }
   await db.query('UPDATE wa_sessions SET sync_count=$2 WHERE id=$1',[session.id,count]);
  }
 }catch{
  await db.query("UPDATE wa_sessions SET sync_status='partial',sync_count=$2 WHERE id=$1",[session.id,count]);
  return {mode,count,complete:false};
 }
 await db.query("UPDATE wa_sessions SET sync_status='available_history_synced',sync_count=$2 WHERE id=$1",[session.id,count]);
 await db.query('UPDATE wa_archives SET history_synced_at=now() WHERE id=$1',[session.archive_id]);
 return {mode,count,complete:true};
}
