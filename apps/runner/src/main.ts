import {AutomationService} from '../../api/src/automation.service.js';
import {IdentitiesService} from '../../api/src/identities.service.js';
import {recordMessage} from './message-record.js';
import {runOutbox,recoverInterruptedOutbox,reconcileOutbox} from './outbox.js';
import {syncHistory} from './history-sync.js';
import {providerReason} from './openwa.js';
import {runProviderOperation} from './provider-operation.js';
import 'reflect-metadata';
import {WhatsAppBotService} from '../../api/src/whatsapp-bot.service.js';
import {recoverMedia} from './recover-media.js';
import {purgeWhatsApp} from '../../api/src/whatsapp-purge.js';
import {randomUUID} from 'node:crypto';
import {Redis} from 'ioredis';
import {Queue,Worker} from 'bullmq';
import {Database,audit} from '../../api/src/database.js';
import {Authorization} from '../../api/src/authorization.js';
import {required,redisOptions} from '../../api/src/config.js';
import {OpenWaAdapter,WaClient} from './openwa.js';
import {deliver,webhookEnvelope} from './webhooks.js';
const db=new Database(),policy=new Authorization(db),redis=new Redis(required('REDIS_URL'));
const bots=new WhatsAppBotService(db,policy),automations=new AutomationService(db,new IdentitiesService(db));
const runner=required('RUNNER_ID');if(!/^[a-zA-Z0-9_-]{1,40}$/.test(runner))throw new Error('RUNNER_ID non valido');
const capacity=Number(process.env.RUNNER_CAPACITY||2);if(!Number.isInteger(capacity)||capacity<1||capacity>50)throw new Error('Capacità runner non valida');
const adapter=new OpenWaAdapter(),clients=new Map<string,WaClient>(),leases=new Map<string,string>(),starting=new Set<string>();
const queue=new Queue(`wa-${runner}`,{connection:redisOptions()}),hooks=new Queue('webhooks',{connection:redisOptions()});
let stopping=false,ticking=false;
const runnerToken=randomUUID();
if(await redis.set(`runner-owner:${runner}`,runnerToken,'EX',20,'NX')!=='OK')throw new Error('RUNNER_ID già attivo');
async function event(session:any,kind:string,payload:unknown){
 await db.transaction(async tx=>{const id=randomUUID();await tx.query('INSERT INTO events VALUES($1,$2,$3,$4,$5,now())',[id,session.installation_id,session.id,kind,JSON.stringify(payload)]);await tx.query("INSERT INTO deliveries(id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM webhook_endpoints WHERE installation_id=$2 AND enabled=true",[id,session.installation_id]);});
}
async function record(session:any,m:any,emit:boolean){
 if(!m.id||!session.archive_id)return;
 if(['buttons_response','list_response','native_flow_response','interactive'].includes(m.type))return;
 let media:string|undefined;
 if(m.mimetype&&clients.has(session.id)){try{media=await clients.get(session.id)!.decryptMedia(m);if(media.length>14_000_000)media=undefined;}catch(error){
   // WhatsApp may no longer make media available: the reason is logged (no numbers, IDs or links).
   console.warn(JSON.stringify({component:'media',level:'warn',message:'media_unavailable',kind:String(m.type||''),live:emit,reason:providerReason(error)}));
 }}
 await recordMessage(db,bots,session,m,emit,media);
}
async function start(id:string){
 if(clients.has(id)||starting.has(id)||stopping)return;starting.add(id);
 const token=randomUUID();let client:WaClient|undefined;
 try{
   if(await redis.set(`owner:${id}`,token,'EX',20,'NX')!=='OK')return;
   leases.set(id,token);
   const [s]=await db.query('SELECT * FROM wa_sessions WHERE id=$1 AND runner_id=$2 AND closed_at IS NULL',[id,runner]);if(!s||s.state==='disconnecting')return;
   await db.query("UPDATE wa_sessions SET state='pairing',qr=null,link_code=null WHERE id=$1",[id]);
   client=await adapter.create(id,async qr=>{await db.query("UPDATE wa_sessions SET qr=$2 WHERE id=$1 AND state='pairing'",[id,qr]);},
    s.link_phone?{phone:s.link_phone,onLinkCode:async code=>{await db.query("UPDATE wa_sessions SET link_code=$2 WHERE id=$1 AND state='pairing'",[id,code]);}}:undefined);
   if(stopping||!leases.has(id))throw new Error('OWNER_LOST');
   const number=(await client.getHostNumber()).replace(/\D/g,'');if(!number)throw new Error('NUMBER_MISSING');
   const session=await db.transaction(async tx=>{
     const locked=(await tx.query('SELECT * FROM wa_sessions WHERE id=$1 FOR UPDATE',[id])).rows[0];if(locked.state==='disconnecting')throw new Error('DISCONNECT_REQUESTED');
     const archive=(await tx.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3) ON CONFLICT(installation_id,number) DO UPDATE SET number=$3 RETURNING id',[randomUUID(),s.installation_id,number])).rows[0];
     return (await tx.query("UPDATE wa_sessions SET number=$2,archive_id=$3,state='connected',qr=null,link_code=null,sync_status='running',sync_count=0 WHERE id=$1 RETURNING *",[id,number,archive.id])).rows[0];
   });
   clients.set(id,client);session.bot_ready_at=Date.now();
   await client.onAnyMessage(m=>{void record(session,m,true).catch(()=>console.error('Persistenza messaggio fallita',id));});
   await client.onInteractiveResponse(response=>{
    if(!['reply','list'].includes(response.type)||!response.id||!response.messageId)return;
    void record(session,{id:response.messageId,chatId:response.chatId,from:response.senderId,fromMe:false,type:'interactive_response',body:response.label||response.id,selectedButtonId:response.id,t:response.timestamp?(response.timestamp>1e12?response.timestamp/1000:response.timestamp):undefined},true).catch(()=>console.error('Risposta interattiva non persistita',id));
   });
   for(const [listener,kind]of [[client.onIncomingCall.bind(client),'call.incoming'],[client.onCallState.bind(client),'call.state']] as const)await listener(call=>{void event(session,kind,call).catch(()=>console.error('Evento chiamata non persistito',id));});
   await client.onAck(ack=>{void event(session,'message.ack',ack).catch(()=>console.error('Persistenza ack fallita',id));});
   await client.onStateChanged(state=>{void (async()=>{
     await event(session,'connection.state',{state});
     if(['UNPAIRED','UNPAIRED_IDLE','DISCONNECTED','TIMEOUT'].includes(state)){
       const updated=await db.query("UPDATE wa_sessions SET state='failed',qr=null WHERE id=$1 AND state='connected' RETURNING id",[id]);
       if(updated.length){const existing=clients.get(id);clients.delete(id);if(existing)await existing.kill();await release(id);}
     }
   })().catch(()=>console.error('Aggiornamento stato fallito',id));});
   await event(session,'connection.connected',{number,archiveId:session.archive_id});
   // First link of this number on this licence: full history. Same number again: only what is new.
   const synced=await syncHistory(db,session,client,m=>record(session,m,false),()=>clients.has(id)&&!stopping);
   console.log(JSON.stringify({component:'history',level:'info',message:'history_sync',sessionId:id,mode:synced.mode,count:synced.count,complete:synced.complete}));
 }catch(error:any){
   console.error('Connessione fallita',id,error.code||error.message);
   if(client){if(error.code==='23505')await client.logout(false).catch(()=>undefined);await client.kill().catch(()=>undefined);}
   clients.delete(id);await db.query("UPDATE wa_sessions SET state=CASE WHEN state='disconnecting' THEN state ELSE 'failed' END,qr=null WHERE id=$1",[id]);
 }finally{starting.delete(id);if(!clients.has(id))await release(id);}
}
async function release(id:string){const token=leases.get(id);if(token)await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,`owner:${id}`,token);leases.delete(id);}
async function disconnect(s:any){
 if(starting.has(s.id)){await adapter.cancelPending(s.id);return;}
 const client=clients.get(s.id);let remoteLogoutConfirmed=false;
 if(client){try{remoteLogoutConfirmed=await client.logout(false);}catch{ /* Local authentication is still removed below. */ }
   await client.kill();clients.delete(s.id);
 }
 await adapter.removeAuthentication(s.id);
 await db.transaction(async tx=>{await tx.query("UPDATE wa_sessions SET state='disconnected',closed_at=now(),qr=null WHERE id=$1",[s.id]);await tx.query("UPDATE outbox SET state='cancelled',error='explicit_disconnect' WHERE session_id=$1 AND state='queued'",[s.id]);await audit(tx,'runner:'+runner,'whatsapp.disconnected',s.id,{authenticationRemoved:true,remoteLogoutConfirmed,archivePreserved:true});});
 await release(s.id);await event(s,'connection.disconnected',{authenticationRemoved:true,remoteLogoutConfirmed,archivePreserved:true});
}
const worker=new Worker(`wa-${runner}`,async job=>{
 if(job.name==='provider-operation'){await runProviderOperation(db,policy,job.data.id,runner,async id=>{const owner=leases.get(id);return owner&&await redis.get(`owner:${id}`)===owner?clients.get(id):undefined;},event);return;}
 if(job.name==='connect'){await start(job.data.id);return;}
 if(job.name==='recover-media'){
   const {id,sessionId,archiveId,installationId}=job.data;
   const owner=leases.get(sessionId),client=clients.get(sessionId);
   if(!client||!owner||await redis.get(`owner:${sessionId}`)!==owner)throw new Error('SESSION_NOT_READY');
   const [m]=await db.query(`SELECT m.provider_id,m.chat_id FROM messages m JOIN wa_archives a ON a.id=m.archive_id JOIN wa_sessions s ON s.archive_id=a.id WHERE m.id=$1 AND a.id=$2 AND a.installation_id=$3 AND s.id=$4 AND s.runner_id=$5 AND s.state='connected' AND s.closed_at IS NULL AND NOT s.delete_requested AND m.body->>'media' IS NULL`,[id,archiveId,installationId,sessionId,runner]);
   if(!m)return;
   const data=await recoverMedia(client,m);
   if(leases.get(sessionId)!==owner||await redis.get(`owner:${sessionId}`)!==owner)throw new Error('SESSION_OWNER_LOST');
   await db.query(`UPDATE messages SET body=body || $4::jsonb WHERE id=$1 AND archive_id=$2 AND EXISTS(SELECT 1 FROM wa_sessions WHERE id=$3 AND archive_id=$2 AND state='connected' AND NOT delete_requested)`,[id,archiveId,sessionId,JSON.stringify({media:data,mediaAvailable:true})]);return;
 }
 const result=await runOutbox(db,job.data.id,runner,async sessionId=>{
  const owner=leases.get(sessionId),client=clients.get(sessionId);
  return owner&&client&&await redis.get(`owner:${sessionId}`)===owner?payload=>adapter.send(client,payload):undefined;
 },automations);
 if(result?.outbox.payload.kind==='interactive'){
  const [session]=await db.query('SELECT * FROM wa_sessions WHERE id=$1',[result.outbox.session_id]);
  await record(session,{id:result.providerId,chatId:result.outbox.payload.to,fromMe:true,type:'interactive_message',body:result.outbox.payload.content.body,interactiveContent:result.outbox.payload.content},false);
 }
},{connection:redisOptions(),concurrency:capacity+2});
const hookWorker=new Worker('webhooks',async job=>{
 const [d]=await db.query('SELECT d.*,e.kind,e.payload,e.created_at,e.installation_id,e.session_id,w.url,w.secret_cipher,w.enabled FROM deliveries d JOIN events e ON e.id=d.event_id JOIN webhook_endpoints w ON w.id=d.endpoint_id WHERE d.id=$1',[job.data.id]);
 if(!d||['delivered','cancelled'].includes(d.state)||d.attempts>=8||!d.enabled)return;
 let status=0,error:string|null=null;try{status=await deliver(d.url,d.secret_cipher,webhookEnvelope({...d,id:d.event_id}),d.event_id);if(status<200||status>=300)error=`HTTP_${status}`;}catch(e:any){error=e.message;}
 await db.query("UPDATE deliveries SET attempts=attempts+1,last_status=$2,last_error=$3,state=$4,next_attempt_at=now()+interval '30 seconds' WHERE id=$1",[d.id,status,error,error?(d.attempts+1>=8?'failed':'retrying'):'delivered']);
 if(error)throw new Error(error);
},{connection:redisOptions(),concurrency:4});
let reconcileTicks=0;
async function tick(){if(ticking||stopping)return;ticking=true;try{
 await db.query('INSERT INTO runners(id,capacity) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),capacity=$2',[runner,capacity]);
 for(const s of await db.query('SELECT * FROM wa_sessions WHERE runner_id=$1 AND closed_at IS NULL',[runner])){
   if(s.state==='disconnecting'){await disconnect(s).catch(()=>console.error('Disconnessione da riprovare',s.id));continue;}
   if(['queued','pairing','connected'].includes(s.state)&&!clients.has(s.id)&&!starting.has(s.id))await queue.add('connect',{id:s.id},{jobId:`connect-${s.id}`,removeOnComplete:true,removeOnFail:true});
 }
 // Durable requests survive a restart between closing the connection and deleting the history.
 for(const s of await db.query('SELECT * FROM wa_sessions WHERE runner_id=$1 AND closed_at IS NOT NULL AND delete_requested=true',[runner])){
   if(starting.has(s.id)||clients.has(s.id))continue;
   await db.transaction(async tx=>{await tx.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[s.installation_id]);if(await purgeWhatsApp(tx,s.installation_id,s.archive_id,s.id))await audit(tx,'runner:'+runner,'whatsapp.history.deleted',s.archive_id||s.id);});
 }
 for(const o of await db.query("SELECT o.id FROM outbox o JOIN wa_sessions s ON s.id=o.session_id WHERE s.runner_id=$1 AND o.state='queued' AND (o.not_before IS NULL OR o.not_before<=now())",[runner]))await queue.add('send',{id:o.id},{jobId:o.id,attempts:20,backoff:{type:'exponential',delay:2000},removeOnComplete:true,removeOnFail:100});
 // About once a minute: messages waiting for WhatsApp's acknowledgement are checked again.
 if(++reconcileTicks%12===0)await reconcileOutbox(db,runner,async(sessionId,providerId)=>{const owner=leases.get(sessionId),client=clients.get(sessionId);return owner&&client&&await redis.get(`owner:${sessionId}`)===owner?adapter.ackOf(client,providerId):null;}).catch(()=>console.error('Verifica esiti non disponibile'));
 for(const op of await db.query("SELECT o.id FROM wa_operations o JOIN wa_sessions s ON s.id=o.session_id WHERE s.runner_id=$1 AND o.state='queued'",[runner]))await queue.add('provider-operation',{id:op.id},{jobId:`operation-${op.id}`,attempts:10,backoff:{type:'exponential',delay:2000},removeOnComplete:true,removeOnFail:100});
 for(const d of await db.query("SELECT id FROM deliveries WHERE state IN ('queued','retrying') AND attempts<8 AND next_attempt_at<=now()"))await hooks.add('deliver',{id:d.id},{jobId:d.id,attempts:8,backoff:{type:'exponential',delay:2000},removeOnComplete:100,removeOnFail:200});
 }finally{ticking=false;}}
const renew=setInterval(async()=>{
 try{const runnerOk=await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],20) else return 0 end",1,`runner-owner:${runner}`,runnerToken);if(!runnerOk)throw new Error('RUNNER_OWNER_LOST');for(const [id,token]of leases){const ok=await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],20) else return 0 end",1,`owner:${id}`,token);if(!ok)throw new Error('OWNERSHIP_LOST');}}
 catch{stopping=true;await adapter.cancelPending();await Promise.allSettled([...clients.values()].map(c=>c.kill()));process.exit(1);}
},5000);
await recoverInterruptedOutbox(db,runner);
await db.query("UPDATE wa_operations SET state='uncertain',error='Runner interrotto durante operazione; nessuna ripetizione automatica' WHERE state='running' AND session_id IN (SELECT id FROM wa_sessions WHERE runner_id=$1)",[runner]);
await tick();const timer=setInterval(()=>{void tick().catch(()=>console.error('Dispatcher non disponibile'));},5000);
async function shutdown(){stopping=true;clearInterval(timer);clearInterval(renew);await adapter.cancelPending();await Promise.allSettled([...clients.values()].map(c=>c.kill()));for(const id of [...leases.keys()])await release(id);await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,`runner-owner:${runner}`,runnerToken);await worker.close();await hookWorker.close();await queue.close();await hooks.close();await redis.quit();await db.onModuleDestroy();process.exit(0);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
