import {purgeWhatsApp} from './whatsapp-purge.js';
import {ApiInput} from './openapi.js';
import {whatsappWebhookSchema} from './schemas.js';
import { Body, Controller, Get, Param, Post, Put, Delete, Req, ForbiddenException, Headers, Query, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Database, audit } from './database.js';
import { WhatsAppService } from './whatsapp.service.js';
import { RequestContext } from './auth.js';
import { Authorization } from './authorization.js';
import { parse, uuid, messageSchema } from './validation.js';
import { seal,secret } from './security.js';
/** Optional: the number to link with a code typed on the phone instead of scanning a QR. International form, e.g. +39 333 1234567. */
const connectSchema=z.object({phone:z.string().trim().regex(/^\+?[\d\s().-]{8,24}$/).refine(v=>{const d=v.replace(/\D/g,'');return d.length>=8&&d.length<=15&&!d.startsWith('0');},'Numero in formato internazionale').optional()}).strict();
@Controller('v1/installations/:installationId/whatsapp') @ApiTags('WhatsApp') @ApiBearerAuth()
export class WhatsAppController {
 constructor(private readonly wa:WhatsAppService,private readonly db:Database,private readonly policy:Authorization) {}
 private async access(req:RequestContext,id:string,permission:string){parse(uuid,id);await this.policy.require(req.principal,id,permission);}
 @Get('sessions') async sessions(@Param('installationId') i:string,@Req() req:RequestContext) {
   await this.access(req,i,'whatsapp.read');return this.db.query(`SELECT s.id,s.number,s.archive_id,s.state,s.runner_id,s.sync_status,s.sync_count,s.sync_limit,s.created_at,s.closed_at,s.delete_requested,COALESCE(r.heartbeat_at>now()-interval '20 seconds',false) AS runner_online FROM wa_sessions s LEFT JOIN runners r ON r.id=s.runner_id WHERE s.installation_id=$1 ORDER BY s.created_at DESC`,[i]);
 }
 @Post('sessions') @ApiInput(connectSchema) async connect(@Param('installationId') i:string,@Req() req:RequestContext,@Body() body:unknown){
   await this.access(req,i,'whatsapp.manage');
   const input=parse(connectSchema,body??{});
   return this.wa.start(i,req.principal,input.phone?input.phone.replace(/\D/g,''):null);
 }
 @Post('sessions/:id/reconnect') async reconnect(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext) {
   await this.access(req,i,'whatsapp.manage');parse(uuid,id);await this.wa.session(i,id);
   return this.db.transaction(async db=>{const result=await db.query("UPDATE wa_sessions SET state='queued',qr=null,link_code=null WHERE id=$1 AND state='failed' AND closed_at IS NULL RETURNING id",[id]);if(!result.rowCount)throw new ForbiddenException('Riconnessione disponibile solo per sessioni interrotte');await audit(db,req.principal.subject!,'whatsapp.reconnect',id);return {id,state:'queued'};});
 }
 @Get('sessions/:id/qr') async qr(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext) {
   await this.access(req,i,'whatsapp.manage');parse(uuid,id);const s=await this.wa.session(i,id);return {state:s.state,method:s.link_phone?'phone':'qr',qr:s.state==='pairing'&&!s.link_phone?s.qr:null,linkCode:s.state==='pairing'?s.link_code??null:null};
 }
 @Post('sessions/:id/disconnect') async disconnect(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext){await this.access(req,i,'whatsapp.manage');parse(uuid,id);return this.wa.disconnect(i,id,req.principal);}
 @Get('archives') async archives(@Param('installationId') i:string,@Req() req:RequestContext) {await this.access(req,i,'whatsapp.read');return this.db.query('SELECT * FROM wa_archives WHERE installation_id=$1 ORDER BY created_at DESC',[i]);}
 @Delete('archives/:id') async deleteArchive(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext){
   await this.access(req,i,'whatsapp.manage');parse(uuid,id);
   return this.db.transaction(async tx=>{
     await tx.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[i]);
     if(!(await tx.query('SELECT id FROM wa_archives WHERE id=$1 AND installation_id=$2 FOR UPDATE',[id,i])).rows.length)throw new NotFoundException();
     await tx.query("UPDATE wa_sessions SET delete_requested=true,state=CASE WHEN closed_at IS NULL THEN 'disconnecting' ELSE state END,qr=null WHERE archive_id=$1",[id]);
     const removed=await purgeWhatsApp(tx,i,id);await audit(tx,req.principal.subject!,'whatsapp.archive.delete'+(removed?'':'.requested'),id,{installationId:i});return {removed,state:removed?'deleted':'disconnecting'};
   });
 }
 @Delete('sessions/:id') async deleteSession(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext){
   await this.access(req,i,'whatsapp.manage');parse(uuid,id);const session=await this.wa.session(i,id);
   if(session.archive_id)return this.deleteArchive(i,session.archive_id,req);
   return this.db.transaction(async tx=>{await tx.query("UPDATE wa_sessions SET delete_requested=true,state=CASE WHEN closed_at IS NULL THEN 'disconnecting' ELSE state END,qr=null WHERE id=$1",[id]);const removed=await purgeWhatsApp(tx,i,null,id);await audit(tx,req.principal.subject!,'whatsapp.session.delete.requested',id);return {removed,state:removed?'deleted':'disconnecting'};});
 }
 @Get('archives/:id/messages') async messages(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext,@Query('before') before?:string,@Query('chat') chat?:string) {
   await this.access(req,i,'whatsapp.read');parse(uuid,id);if(before)parse(uuid,before);if(chat)parse(z.string().max(100),chat);
   return this.db.query(`SELECT m.id,m.session_id,m.archive_id,m.provider_id,m.chat_id,m.direction,m.kind,m.body-'media' AS body,m.occurred_at FROM messages m JOIN wa_archives a ON a.id=m.archive_id
     WHERE a.installation_id=$1 AND a.id=$2 AND ($3::uuid IS NULL OR (m.occurred_at,m.id)<(SELECT occurred_at,id FROM messages WHERE id=$3 AND archive_id=$2))
     AND ($4::text IS NULL OR m.chat_id=$4) ORDER BY m.occurred_at DESC,m.id DESC LIMIT 50`,[i,id,before||null,chat||null]);
 }
 @Get('archives/:id/conversations') async conversations(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext){
   await this.access(req,i,'whatsapp.read');parse(uuid,id);return this.db.query(`SELECT DISTINCT ON(m.chat_id) m.chat_id,count(*) OVER(PARTITION BY m.chat_id)::int AS messages,m.occurred_at AS last_message_at,m.body->>'text' AS preview,m.kind,m.direction,c.profile AS contact FROM messages m JOIN wa_archives a ON a.id=m.archive_id LEFT JOIN wa_contacts c ON c.archive_id=m.archive_id AND c.chat_id=m.chat_id WHERE a.installation_id=$1 AND a.id=$2 ORDER BY m.chat_id,m.occurred_at DESC,m.id DESC`,[i,id]).then(rows=>rows.sort((a,b)=>new Date(b.last_message_at).getTime()-new Date(a.last_message_at).getTime()));
 }
 @Get('archives/:id/messages/:messageId/media') async media(@Param('installationId') i:string,@Param('id') id:string,@Param('messageId') messageId:string,@Req() req:RequestContext){
   await this.access(req,i,'whatsapp.read');parse(uuid,id);parse(uuid,messageId);
   const [m]=await this.db.query("SELECT m.id,m.kind,m.body->>'media' AS data FROM messages m JOIN wa_archives a ON a.id=m.archive_id WHERE a.installation_id=$1 AND a.id=$2 AND m.id=$3",[i,id,messageId]);
   if(!m)throw new NotFoundException('Messaggio non trovato');
   if(m.data)return {data:m.data,state:'available'};
   if(!['image','document','audio','video','ptt','sticker'].includes(m.kind))throw new NotFoundException('Il messaggio non contiene allegati');
   const [session]=await this.db.query("SELECT s.id,s.runner_id FROM wa_sessions s JOIN runners r ON r.id=s.runner_id WHERE s.installation_id=$1 AND s.archive_id=$2 AND s.state='connected' AND s.closed_at IS NULL AND NOT s.delete_requested AND r.heartbeat_at>now()-interval '20 seconds'",[i,id]);
   if(!session)throw new NotFoundException('Ricollega questo numero per recuperare l’allegato');
   await this.wa.queue(session.runner_id).add('recover-media',{id:messageId,archiveId:id,installationId:i,sessionId:session.id},{jobId:`media-${messageId}`,removeOnComplete:true,removeOnFail:true});
   return {data:null,state:'queued'};
 }
 @Post('sessions/:id/messages/test') @ApiInput(messageSchema) async testMessage(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext,@Body() body:unknown){
   await this.access(req,i,'whatsapp.send');parse(uuid,id);const payload=parse(messageSchema,body);const session=await this.wa.session(i,id);
   return {valid:true,kind:payload.kind,to:payload.to,connected:session.state==='connected'&&!session.closed_at&&!session.delete_requested,sent:false};
 }
 @Post('sessions/:id/messages') @ApiInput(messageSchema) async send(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext,@Body() body:unknown,@Headers('idempotency-key') idem:string) {
   await this.access(req,i,'whatsapp.send');parse(uuid,id);const payload=parse(messageSchema,body);parse(z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),idem);
   return this.wa.enqueue(i,id,payload,idem,req.principal);
 }
 @Get('outbox') async outbox(@Param('installationId') i:string,@Req() req:RequestContext){await this.access(req,i,'whatsapp.read');return this.db.query('SELECT id,session_id,state,provider_id,error,created_at FROM outbox WHERE installation_id=$1 ORDER BY created_at DESC LIMIT 200',[i]);}
 @Post('webhooks') @ApiInput(whatsappWebhookSchema) async webhook(@Param('installationId') i:string,@Body() body:unknown,@Req() req:RequestContext) {
   await this.access(req,i,'whatsapp.manage');const b=parse(whatsappWebhookSchema,body);
   const url=new URL(b.url);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new ForbiddenException('Webhook HTTPS sulla porta 443 richiesto');
   const credential=secret(),id=randomUUID();return this.db.transaction(async db=>{await db.query('INSERT INTO webhook_endpoints(id,installation_id,url,secret_cipher) VALUES($1,$2,$3,$4)',[id,i,b.url,seal(credential)]);await audit(db,req.principal.subject!,'webhook.create',id,{url:b.url});return {id,secret:credential};});
 }
 @Get('webhooks') async webhooks(@Param('installationId') i:string,@Req() req:RequestContext){await this.access(req,i,'whatsapp.manage');return this.db.query('SELECT id,url,enabled FROM webhook_endpoints WHERE installation_id=$1',[i]);}
 @Put('webhooks/:id') @ApiInput(z.object({enabled:z.boolean()})) async updateWebhook(@Param('installationId') i:string,@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
   await this.access(req,i,'whatsapp.manage');parse(uuid,id);const b=parse(z.object({enabled:z.boolean()}).strict(),body);return this.db.transaction(async db=>{const result=await db.query('UPDATE webhook_endpoints SET enabled=$3 WHERE id=$1 AND installation_id=$2 RETURNING id',[id,i,b.enabled]);if(!result.rowCount)throw new NotFoundException();if(!b.enabled)await db.query("UPDATE deliveries SET state='cancelled' WHERE endpoint_id=$1 AND state IN ('queued','retrying')",[id]);await audit(db,req.principal.subject!,'webhook.update',id,b);return {id,...b};});
 }
 @Get('deliveries') async deliveries(@Param('installationId') i:string,@Req() req:RequestContext) {await this.access(req,i,'whatsapp.read');return this.db.query('SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_id WHERE e.installation_id=$1 ORDER BY e.created_at DESC LIMIT 200',[i]);}
}
