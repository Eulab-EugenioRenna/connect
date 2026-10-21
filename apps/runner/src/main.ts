import {interactiveContentSchema} from '../../api/src/whatsapp-interactive.js';
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
import {introspect} from '../../api/src/oidc.js';
import {unseal} from '../../api/src/security.js';
import {deliver} from './webhooks.js';
const db=new Database(),policy=new Authorization(db),redis=new Redis(required('REDIS_URL'));
const bots=new WhatsAppBotService(db,policy);
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
 if(m.mimetype&&clients.has(session.id)){try{media=await clients.get(session.id)!.decryptMedia(m);if(media.length>14_000_000)media=undefined;}catch{ /* WhatsApp may no longer make media available. */ }}
 const interactive=interactiveContentSchema.safeParse(m.interactiveContent);
 const chatId=String(m.chatId||(m.fromMe?m.to:m.from));
 const body={interactive:interactive.success?interactive.data:null,text:typeof m.body==='string'?m.body:typeof m.caption==='string'?m.caption:'',senderName:typeof m.sender?.pushname==='string'?m.sender.pushname.slice(0,200):null,quotedText:typeof m.quotedMsg?.body==='string'?m.quotedMsg.body.slice(0,2000):null,mimetype:m.mimetype||null,filename:m.filename||null,media:media||null,mediaAvailable:!!media,selectedButtonId:m.selectedButtonId||null,poll:m.pollData||null};
 await db.transaction(async tx=>{
   const result=await tx.query('INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(archive_id,provider_id) DO NOTHING RETURNING id',[randomUUID(),session.id,session.archive_id,String(m.id),chatId,m.fromMe?'out':'in',m.type||'text',JSON.stringify(body),m.t?new Date(m.t*1000):new Date()]);
   if(!result.rowCount&&interactive.success)await tx.query("UPDATE messages SET body=body || $3::jsonb WHERE archive_id=$1 AND provider_id=$2",[session.archive_id,String(m.id),JSON.stringify({interactive:interactive.success?interactive.data:null})]);
   if(!result.rowCount&&media)await tx.query("UPDATE messages SET body=body || $3::jsonb WHERE archive_id=$1 AND provider_id=$2 AND body->>'media' IS NULL",[session.archive_id,String(m.id),JSON.stringify({media,mediaAvailable:true})]);
   if(emit&&result.rowCount){
     const id=randomUUID(),payload={providerId:m.id,chatId,kind:m.type,body};
     await tx.query('INSERT INTO events VALUES($1,$2,$3,$4,$5,now())',[id,session.installation_id,session.id,'message.received',JSON.stringify(payload)]);
     await tx.query("INSERT INTO deliveries(id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM webhook_endpoints WHERE installation_id=$2 AND enabled=true",[id,session.installation_id]);
   }
   if(emit&&(result.rowCount||m.type==='interactive_response')&&!m.fromMe&&['chat','text','interactive_response'].includes(m.type||'text')&&typeof m.body==='string'&&m.body.trim()&&m.body.length<=2000&&m.t&&m.t*1000>=session.bot_ready_at-1000){
    const messageId=result.rows[0]?.id||(await tx.query('SELECT id FROM messages WHERE archive_id=$1 AND provider_id=$2',[session.archive_id,String(m.id)])).rows[0]?.id;
    if(messageId){
     if(m.type==='interactive_response'&&!result.rowCount)await tx.query('UPDATE messages SET body=body || $2::jsonb WHERE id=$1',[messageId,JSON.stringify({selectedButtonId:m.selectedButtonId,text:m.body})]);
     await bots.receive(tx,session,{id:messageId,provider_id:String(m.id),chat_id:chatId,text:m.selectedButtonId||m.body,occurred_at:new Date(m.t*1000)});
    }
   }
 });
}
async function start(id:string){
 if(clients.has(id)||starting.has(id)||stopping)return;starting.add(id);
 const token=randomUUID();let client:WaClient|undefined;
 try{
   if(await redis.set(`owner:${id}`,token,'EX',20,'NX')!=='OK')return;
   leases.set(id,token);
   const [s]=await db.query('SELECT * FROM wa_sessions WHERE id=$1 AND runner_id=$2 AND closed_at IS NULL',[id,runner]);if(!s||s.state==='disconnecting')return;
   await db.query("UPDATE wa_sessions SET state='pairing',qr=null WHERE id=$1",[id]);
   client=await adapter.create(id,async qr=>{await db.query("UPDATE wa_sessions SET qr=$2 WHERE id=$1 AND state='pairing'",[id,qr]);});
   if(stopping||!leases.has(id))throw new Error('OWNER_LOST');
   const number=(await client.getHostNumber()).replace(/\D/g,'');if(!number)throw new Error('NUMBER_MISSING');
   const session=await db.transaction(async tx=>{
     const locked=(await tx.query('SELECT * FROM wa_sessions WHERE id=$1 FOR UPDATE',[id])).rows[0];if(locked.state==='disconnecting')throw new Error('DISCONNECT_REQUESTED');
     const archive=(await tx.query('INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,$3) ON CONFLICT(installation_id,number) DO UPDATE SET number=$3 RETURNING id',[randomUUID(),s.installation_id,number])).rows[0];
     return (await tx.query("UPDATE wa_sessions SET number=$2,archive_id=$3,state='connected',qr=null,sync_status='running',sync_count=0 WHERE id=$1 RETURNING *",[id,number,archive.id])).rows[0];
   });
   clients.set(id,client);session.bot_ready_at=Date.now();
   await client.onAnyMessage(m=>{void record(session,m,true).catch(()=>console.error('Persistenza messaggio fallita',id));});
   await client.onInteractiveResponse(response=>{
    if(!['reply','list'].includes(response.type)||!response.id||!response.messageId)return;
    void record(session,{id:response.messageId,chatId:response.chatId,from:response.senderId,fromMe:false,type:'interactive_response',body:response.label||response.id,selectedButtonId:response.id,t:response.timestamp?(response.timestamp>1e12?response.timestamp/1000:response.timestamp):Date.now()/1000},true).catch(()=>console.error('Risposta interattiva non persistita',id));
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
   let count=0;
   try {for(const chat of await client.getAllChats()) {
     if(!clients.has(id)||stopping)break;
     for(const m of await client.getAllMessagesInChat(String(chat.id),true,false)){await record(session,m,false);count++;}
     await db.query('UPDATE wa_sessions SET sync_count=$2 WHERE id=$1',[id,count]);
   }
   await db.query("UPDATE wa_sessions SET sync_status='available_history_synced',sync_count=$2 WHERE id=$1",[id,count]);
   }catch{await db.query("UPDATE wa_sessions SET sync_status='partial',sync_count=$2 WHERE id=$1",[id,count]);}
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
 const [o]=await db.query('SELECT o.*,s.runner_id,s.state AS session_state,i.enabled AS installation_enabled FROM outbox o JOIN wa_sessions s ON s.id=o.session_id JOIN installations i ON i.id=o.installation_id WHERE o.id=$1',[job.data.id]);
 if(!o||o.state!=='queued')return;
 const owner=leases.get(o.session_id);if(!owner||await redis.get(`owner:${o.session_id}`)!==owner)throw new Error('SESSION_OWNER_MISSING');
 const client=clients.get(o.session_id);if(!client)throw new Error('SESSION_NOT_READY');
 let allowed=false;
 if(o.bot_archive_id){
  const [bot]=await db.query('SELECT actor,technical_admin,revision,enabled FROM wa_bots WHERE archive_id=$1',[o.bot_archive_id]);
  allowed=!!bot&&bot.enabled&&bot.revision===o.bot_revision&&await bots.authorized(bot,o.installation_id);
 }else{
  const current=await introspect(unseal(o.authorization_cipher));
  const technical=current.realm_access?.roles?.includes('eulab-admin')===true;
  allowed=o.installation_enabled&&current.active&&current.sub===o.actor&&(technical||(await policy.check({subject:o.actor,admin:false,technician:false,server:true,installationId:o.installation_id},o.installation_id,'whatsapp.send')).allowed);
 }
 if(!allowed||o.session_state!=='connected'){await db.query("UPDATE outbox SET state='cancelled',error='authorization_revoked' WHERE id=$1 AND state='queued'",[o.id]);return;}
 const [claimed]=await db.query("UPDATE outbox SET state='sending' WHERE id=$1 AND state='queued' AND (bot_archive_id IS NULL OR EXISTS(SELECT 1 FROM wa_bots b WHERE b.archive_id=outbox.bot_archive_id AND b.enabled AND b.revision=outbox.bot_revision)) RETURNING id",[o.id]);if(!claimed)return;
 try {const providerId=await adapter.send(client,o.payload);await db.query("UPDATE outbox SET state='sent',provider_id=$2 WHERE id=$1",[o.id,providerId]);if(o.payload.kind==='interactive'){const [session]=await db.query('SELECT * FROM wa_sessions WHERE id=$1',[o.session_id]);await record(session,{id:providerId,chatId:o.payload.to,fromMe:true,type:'interactive_message',body:o.payload.content.body,interactiveContent:o.payload.content,t:Date.now()/1000},false);}
 await event({id:o.session_id,installation_id:o.installation_id},'message.sent',{outboxId:o.id,providerId});}
 catch {await db.query("UPDATE outbox SET state='uncertain',error='Esito provider non confermato; nessun reinvio automatico' WHERE id=$1 AND state='sending'",[o.id]);}
},{connection:redisOptions(),concurrency:capacity+2});
const hookWorker=new Worker('webhooks',async job=>{
 const [d]=await db.query('SELECT d.*,e.kind,e.payload,e.created_at,e.installation_id,w.url,w.secret_cipher,w.enabled FROM deliveries d JOIN events e ON e.id=d.event_id JOIN webhook_endpoints w ON w.id=d.endpoint_id WHERE d.id=$1',[job.data.id]);
 if(!d||['delivered','cancelled'].includes(d.state)||d.attempts>=8||!d.enabled)return;
 let status=0,error:string|null=null;try{status=await deliver(d.url,d.secret_cipher,{id:d.event_id,kind:d.kind,createdAt:d.created_at,installationId:d.installation_id,payload:d.payload},d.event_id);if(status<200||status>=300)error=`HTTP_${status}`;}catch(e:any){error=e.message;}
 await db.query("UPDATE deliveries SET attempts=attempts+1,last_status=$2,last_error=$3,state=$4,next_attempt_at=now()+interval '30 seconds' WHERE id=$1",[d.id,status,error,error?(d.attempts+1>=8?'failed':'retrying'):'delivered']);
 if(error)throw new Error(error);
},{connection:redisOptions(),concurrency:4});
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
 for(const o of await db.query("SELECT o.id FROM outbox o JOIN wa_sessions s ON s.id=o.session_id WHERE s.runner_id=$1 AND o.state='queued'",[runner]))await queue.add('send',{id:o.id},{jobId:o.id,attempts:20,backoff:{type:'exponential',delay:2000},removeOnComplete:true,removeOnFail:100});
 for(const op of await db.query("SELECT o.id FROM wa_operations o JOIN wa_sessions s ON s.id=o.session_id WHERE s.runner_id=$1 AND o.state='queued'",[runner]))await queue.add('provider-operation',{id:op.id},{jobId:`operation-${op.id}`,attempts:10,backoff:{type:'exponential',delay:2000},removeOnComplete:true,removeOnFail:100});
 for(const d of await db.query("SELECT id FROM deliveries WHERE state IN ('queued','retrying') AND attempts<8 AND next_attempt_at<=now()"))await hooks.add('deliver',{id:d.id},{jobId:d.id,attempts:8,backoff:{type:'exponential',delay:2000},removeOnComplete:100,removeOnFail:200});
 }finally{ticking=false;}}
const renew=setInterval(async()=>{
 try{const runnerOk=await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],20) else return 0 end",1,`runner-owner:${runner}`,runnerToken);if(!runnerOk)throw new Error('RUNNER_OWNER_LOST');for(const [id,token]of leases){const ok=await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('expire',KEYS[1],20) else return 0 end",1,`owner:${id}`,token);if(!ok)throw new Error('OWNERSHIP_LOST');}}
 catch{stopping=true;await adapter.cancelPending();await Promise.allSettled([...clients.values()].map(c=>c.kill()));process.exit(1);}
},5000);
await db.query("UPDATE outbox SET state='uncertain',error='Runner interrotto durante invio; verifica manuale necessaria' WHERE state='sending' AND session_id IN (SELECT id FROM wa_sessions WHERE runner_id=$1)",[runner]);
await db.query("UPDATE wa_operations SET state='uncertain',error='Runner interrotto durante operazione; nessuna ripetizione automatica' WHERE state='running' AND session_id IN (SELECT id FROM wa_sessions WHERE runner_id=$1)",[runner]);
await tick();const timer=setInterval(()=>{void tick().catch(()=>console.error('Dispatcher non disponibile'));},5000);
async function shutdown(){stopping=true;clearInterval(timer);clearInterval(renew);await adapter.cancelPending();await Promise.allSettled([...clients.values()].map(c=>c.kill()));for(const id of [...leases.keys()])await release(id);await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",1,`runner-owner:${runner}`,runnerToken);await worker.close();await hookWorker.close();await queue.close();await hooks.close();await redis.quit();await db.onModuleDestroy();process.exit(0);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
