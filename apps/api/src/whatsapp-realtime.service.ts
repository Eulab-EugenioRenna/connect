import {Injectable,ForbiddenException,OnModuleDestroy} from '@nestjs/common';
import type {Server} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {z} from 'zod';
import {Database} from './database.js';
import {Authorization} from './authorization.js';
import type {Principal} from './auth.js';
import {hash,secret,seal,unseal} from './security.js';
import {introspect} from './oidc.js';
const authentication=z.object({type:z.literal('authenticate'),ticket:z.string().regex(/^[\w-]{43}$/)}).strict();
const eventKinds=['message.received','message.sent','message.ack','bot.step','bot.completed','connection.connected','connection.disconnected','connection.state'];
export const realtimePath='/v1/whatsapp/events';
// Large attachments stay behind the existing authenticated media endpoint.
export function realtimePayload(value:any):any {
 if(Array.isArray(value))return value.map(realtimePayload);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['media','authorization_cipher','accessToken','secret'].includes(key)).map(([key,v])=>[key,realtimePayload(v)]));
 return value;
}
@Injectable()
export class WhatsAppRealtimeService implements OnModuleDestroy {
 private wss?:WebSocketServer;
 private detach?:()=>void;
 private cleanup?:ReturnType<typeof setInterval>;
 constructor(private readonly db:Database,private readonly policy:Authorization){}
 async ticket(installationId:string,principal:Principal,origin?:string){
  if(!principal.subject||!principal.accessToken)throw new ForbiddenException('Sessione utente richiesta');
  await this.policy.require(principal,installationId,'whatsapp.read');
  const ticket=secret(),expiresAt=new Date(Date.now()+30_000).toISOString();
  await this.db.transaction(async tx=>{
   await tx.query('DELETE FROM wa_stream_tickets WHERE expires_at<=now()');
   await tx.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[installationId]);
   const count=(await tx.query('SELECT count(*)::int AS total FROM wa_stream_tickets WHERE installation_id=$1 AND actor=$2',[installationId,principal.subject])).rows[0].total;
   if(count>=10)throw new ForbiddenException('Troppe richieste di connessione realtime');
   await tx.query('INSERT INTO wa_stream_tickets(ticket_hash,installation_id,actor,principal_cipher,origin,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[hash(ticket),installationId,principal.subject,seal(JSON.stringify(principal)),origin||null,expiresAt]);
  });return {ticket,path:realtimePath,expiresAt};
 }
 async consume(ticket:string,origin?:string){
  const rows=await this.db.query('DELETE FROM wa_stream_tickets WHERE ticket_hash=$1 AND expires_at>now() RETURNING installation_id,principal_cipher,origin',[hash(ticket)]);
  const value=rows[0];if(!value||value.origin&&value.origin!==origin)throw new Error('AUTHENTICATION_FAILED');
  const principal=JSON.parse(unseal(value.principal_cipher)) as Principal;
  return {installationId:value.installation_id as string,principal};
 }
 async access(installationId:string,principal:Principal){
  const current=await introspect(principal.accessToken!);
  if(!current.active||current.sub!==principal.subject)throw new Error('AUTHENTICATION_EXPIRED');
  const [installation]=await this.db.query('SELECT i.enabled,g.enabled AS guardian_enabled FROM installations i LEFT JOIN wordpress_guardians g ON g.installation_id=i.id WHERE i.id=$1',[installationId]);
  if(!installation?.enabled||installation.guardian_enabled===false)throw new Error('ACCESS_REVOKED');
  const active={...principal,admin:current.realm_access?.roles?.includes('eulab-admin')===true};
  if(!(await this.policy.check(active,installationId,'whatsapp.read')).allowed)throw new Error('ACCESS_REVOKED');
  return {manage:(await this.policy.check(active,installationId,'whatsapp.manage')).allowed};
 }
 async snapshot(installationId:string,manage:boolean){
  const sessions=await this.db.query(`SELECT s.id,s.created_at,s.number,s.state,s.archive_id,s.runner_id,s.closed_at,s.delete_requested,s.sync_count,s.sync_status,s.sync_limit,COALESCE(r.heartbeat_at>now()-interval '20 seconds',false) AS runner_online,CASE WHEN $2 AND s.state='pairing' THEN s.qr ELSE NULL END AS qr FROM wa_sessions s LEFT JOIN runners r ON r.id=s.runner_id WHERE s.installation_id=$1 ORDER BY s.created_at DESC`,[installationId,manage]);
  const outbox=await this.db.query('SELECT id,session_id,state,provider_id,error,created_at FROM outbox WHERE installation_id=$1 ORDER BY created_at DESC LIMIT 200',[installationId]);
  const bots=await this.db.query('SELECT b.archive_id,b.revision,b.enabled FROM wa_bots b JOIN wa_archives a ON a.id=b.archive_id WHERE a.installation_id=$1',[installationId]);
  return {sessions,outbox,bots};
 }
 async events(installationId:string,since:Date,seen:string[]){
  const rows=await this.db.query(`SELECT id,session_id,kind,payload,created_at FROM events WHERE installation_id=$1 AND created_at>=$2 AND NOT (id=ANY($3::uuid[])) AND kind=ANY($4::text[]) ORDER BY created_at,id LIMIT 200`,[installationId,since,seen,eventKinds]);
  return rows.map(event=>({...event,payload:realtimePayload(event.payload)}));
 }
 attach(server:Server){
  if(this.wss)return;
  const wss=this.wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  const upgrade:Parameters<Server['on']>[1]=(request:any,socket:any,head:any)=>{
   if(request.url!==realtimePath||wss.clients.size>=256){socket.destroy();return;}
   wss.handleUpgrade(request,socket,head,ws=>this.connection(ws,request.headers.origin));
  };
  server.on('upgrade',upgrade);this.detach=()=>server.off('upgrade',upgrade);
  this.cleanup=setInterval(()=>{void this.db.query('DELETE FROM wa_stream_tickets WHERE expires_at<=now()').catch(()=>{});},30000);this.cleanup.unref();
 }
 private connection(ws:WebSocket,origin?:string){
  let authenticated=false,busy=false,frames=0,alive=true,lastSnapshot='',manage=false;
  let installationId='',principal:Principal|undefined;
  const since=new Date(Date.now()-60_000),seen=new Map<string,number>();
  const authTimer=setTimeout(()=>ws.close(4001,'Authentication timeout'),5000);
  const send=(frame:unknown)=>{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>1_000_000){ws.close(4008,'Slow consumer');return;}ws.send(JSON.stringify(frame));};
  const tick=async()=>{
   if(!authenticated||busy||ws.readyState!==WebSocket.OPEN)return;busy=true;
   try{
    // Revalidate before every batch, including QR frames; revoked readers receive no new data.
    const access=await this.access(installationId,principal!);manage=access.manage;
    if(ws.readyState!==WebSocket.OPEN)return;
    const snapshot=await this.snapshot(installationId,manage),json=JSON.stringify(snapshot);
    if(json!==lastSnapshot){send({type:'snapshot',...snapshot});lastSnapshot=json;}
    const cutoff=new Date(Math.max(since.getTime(),Date.now()-60_000));
    for(const [id,time] of seen)if(time<cutoff.getTime())seen.delete(id);
    for(const event of await this.events(installationId,cutoff,[...seen.keys()])){if(seen.size>=5000){ws.close(4008,'Event backlog exceeded');return;}send({type:'event',event});seen.set(event.id,new Date(event.created_at).getTime());}
   }catch(e){ws.close((e as Error).message==='ACCESS_REVOKED'?4003:(e as Error).message==='AUTHENTICATION_EXPIRED'?4001:1011,'Authorization or service unavailable');}
   finally{busy=false;}
  };
  ws.on('error',()=>{});ws.on('pong',()=>{alive=true;});
  ws.on('message',async(data,isBinary)=>{
   if(++frames>30||isBinary){ws.close(4008,'Invalid or excessive frames');return;}
   if(authenticated){ws.close(4008,'Read only stream');return;}
   if(busy){ws.close(4001,'Authentication already pending');return;}
   busy=true;
   try{
    const message=authentication.parse(JSON.parse(data.toString())),context=await this.consume(message.ticket,origin);
    installationId=context.installationId;principal=context.principal;await this.access(installationId,principal);
    if(ws.readyState!==WebSocket.OPEN)return;
    authenticated=true;clearTimeout(authTimer);send({type:'ready',installationId});
   }catch{ws.close(4001,'Authentication failed');}finally{busy=false;}
   if(authenticated)await tick();
  });
  const timer=setInterval(()=>void tick(),1000);
  const heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;frames=0;if(ws.readyState===WebSocket.OPEN)ws.ping();},15000);
  ws.once('close',()=>{clearTimeout(authTimer);clearInterval(timer);clearInterval(heartbeat);});
 }
 onModuleDestroy(){clearInterval(this.cleanup);this.detach?.();for(const ws of this.wss?.clients||[])ws.terminate();this.wss?.close();}
}
