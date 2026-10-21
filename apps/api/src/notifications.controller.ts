import {Body,ConflictException,Controller,ForbiddenException,Get,NotFoundException,Param,Post,Put,Query,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiHeader,ApiTags} from '@nestjs/swagger';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Admin,RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {IdentitiesService} from './identities.service.js';
import {MailService} from './mail.service.js';
import {hash} from './security.js';
import {parse,uuid} from './validation.js';
import {ApiInput} from './openapi.js';
const createSchema=z.object({subject:z.string().min(1).max(200),title:z.string().trim().min(1).max(200),body:z.string().trim().min(1).max(8000),email:z.boolean().default(false)}).strict();
const readSchema=z.object({read:z.boolean()}).strict();
const listSchema=z.object({unread:z.enum(['true','false']).optional(),before:z.string().datetime({offset:true}).optional(),beforeId:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).strict().refine(v=>!!v.before===!!v.beforeId,'Cursore incompleto');
@Controller('v1/notifications') @ApiTags('Notifiche') @ApiBearerAuth()
export class NotificationsController {
 constructor(private readonly db:Database,private readonly identities:IdentitiesService,private readonly mail:MailService){}
 private subject(req:RequestContext){if(!req.principal.subject)throw new ForbiddenException('Identità personale richiesta');return req.principal.subject;}
 @Get() async list(@Req() req:RequestContext,@Query() query:unknown){
  const subject=this.subject(req),q=parse(listSchema,query);
  const items=await this.db.query(`SELECT id,title,body,created_at,read_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM notifications WHERE subject=$1 AND ($2::boolean IS NULL OR (read_at IS NULL)=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,[subject,q.unread===undefined?null:q.unread==='true',q.before||null,q.beforeId||null,q.limit+1]);
  const [count]=await this.db.query('SELECT count(*)::int AS count FROM notifications WHERE subject=$1 AND read_at IS NULL',[subject]);
  const hasMore=items.length>q.limit;items.splice(q.limit);const last=items.at(-1);
  return {items:items.map(({cursor_time,...item})=>item),unreadCount:count.count,next:hasMore?{before:last.cursor_time,beforeId:last.id}:null};
 }
 @Put(':id/read') @ApiInput(readSchema) async read(@Req() req:RequestContext,@Param('id') id:string,@Body() body:unknown){
  parse(uuid,id);const b=parse(readSchema,body),subject=this.subject(req);
  const [item]=await this.db.query('UPDATE notifications SET read_at=CASE WHEN $3 THEN COALESCE(read_at,now()) ELSE NULL END WHERE id=$1 AND subject=$2 RETURNING id,read_at',[id,subject,b.read]);
  if(!item)throw new NotFoundException('Notifica non trovata');return item;
 }
 @Post('read-all') async readAll(@Req() req:RequestContext){const rows=await this.db.query('UPDATE notifications SET read_at=now() WHERE subject=$1 AND read_at IS NULL RETURNING id',[this.subject(req)]);return {updated:rows.length};}
 @Admin() @Post() @ApiHeader({name:'Idempotency-Key',required:true,description:'Chiave stabile per una sola notifica e un solo tentativo email'}) @ApiInput(createSchema) async create(@Req() req:RequestContext,@Body() body:unknown){
  const b=parse(createSchema,body),actor=this.subject(req),key=parse(z.string().min(8).max(200),req.headers['idempotency-key']),digest=hash(JSON.stringify(b));
  const [existing]=await this.db.query('SELECT id,email_state,request_hash FROM notifications WHERE actor=$1 AND idempotency_key=$2',[actor,key]);
  if(existing){if(existing.request_hash!==digest)throw new ConflictException('Chiave idempotenza già usata con contenuto diverso');return {id:existing.id,emailState:existing.email_state,replayed:true};}
  // Resolve the canonical recipient before reserving an email attempt. No caller-provided email address.
  const user=(await this.identities.request('/users/'+encodeURIComponent(b.subject))).body;
  if(b.email&&(!user.emailVerified||!z.string().email().safeParse(user.email).success))throw new ConflictException('Email destinatario assente o non verificata');
  if(b.email)smtpConfigCheck(this.mail);
  const id=randomUUID();
  const row=await this.db.transaction(async tx=>{
   const inserted=await tx.query(`INSERT INTO notifications(id,subject,title,body,actor,idempotency_key,request_hash,email_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(actor,idempotency_key) DO NOTHING RETURNING id,email_state`,[id,b.subject,b.title,b.body,actor,key,digest,b.email?'sending':'not_requested']);
   if(!inserted.rows.length){const existing=(await tx.query('SELECT id,email_state,request_hash FROM notifications WHERE actor=$1 AND idempotency_key=$2',[actor,key])).rows[0];if(existing.request_hash!==digest)throw new ConflictException('Chiave idempotenza già usata con contenuto diverso');return {...existing,created:false};}
   await audit(tx,actor,'notification.create',id,{subject:b.subject,email:b.email});return {...inserted.rows[0],created:true};
  });
  if(!row.created||!b.email)return {id:row.id,emailState:row.email_state,replayed:!row.created};
  let state='uncertain';
  try{const result=await this.mail.send(user.email,b.title,b.body);state=result.accepted.length?'accepted':'failed';}
  catch(e){const error=e as {code?:string;command?:string};if(['EAUTH','EENVELOPE','EDNS'].includes(error.code||'')||error.command==='CONN')state='failed';}
  await this.db.query('UPDATE notifications SET email_state=$2 WHERE id=$1',[id,state]);
  return {id,emailState:state,replayed:false};
 }
}
function smtpConfigCheck(mail:MailService){if(!mail.status().configured)throw new ConflictException('Configura SMTP prima di richiedere l’invio email');}
