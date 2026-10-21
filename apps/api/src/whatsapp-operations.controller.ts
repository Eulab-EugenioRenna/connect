import {Body,Controller,Get,Headers,Param,Post,Req,NotFoundException,ConflictException} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Database,audit} from './database.js';
import {Authorization} from './authorization.js';
import {RequestContext} from './auth.js';
import {WhatsAppService} from './whatsapp.service.js';
import {parse,uuid} from './validation.js';
import {hash,seal} from './security.js';
import {providerCommandSchema,operationPermission} from './whatsapp-operations.js';
import {ApiInput} from './openapi.js';
@Controller('v1/installations/:installationId/whatsapp') @ApiTags('WhatsApp provider') @ApiBearerAuth()
export class WhatsAppOperationsController {
 constructor(private readonly db:Database,private readonly policy:Authorization,private readonly wa:WhatsAppService){}
 @Post('sessions/:id/operations') @ApiInput(providerCommandSchema)
 async submit(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext,@Body() body:unknown,@Headers('idempotency-key') key:string){
  parse(uuid,i);parse(uuid,id);parse(z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),key);const command=parse(providerCommandSchema,body);
  await this.policy.require(req.principal,i,operationPermission(command.kind));
  if(command.kind==='call.start')await this.policy.require(req.principal,i,'whatsapp.send');
  const session=await this.wa.session(i,id);if(session.state!=='connected'||session.closed_at||session.delete_requested)throw new ConflictException('Sessione non connessa');
  if('call' in command&&command.call.sessionId!==id)throw new ConflictException('La chiamata appartiene a un’altra sessione');
  return this.db.transaction(async tx=>{
   const digest=hash(JSON.stringify(command)),opId=randomUUID();
   const inserted=await tx.query('INSERT INTO wa_operations(id,installation_id,session_id,idempotency_key,request_hash,actor,authorization_cipher,command) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(installation_id,idempotency_key) DO NOTHING RETURNING id',[opId,i,id,key,digest,req.principal.subject,seal(req.principal.accessToken!),JSON.stringify(command)]);
   const row=(await tx.query('SELECT id,session_id,actor,request_hash,state,command,result,error,created_at FROM wa_operations WHERE installation_id=$1 AND idempotency_key=$2',[i,key])).rows[0];
   if(row.request_hash!==digest||row.session_id!==id||row.actor!==req.principal.subject)throw new ConflictException('Chiave già usata con un’altra operazione');
   if(inserted.rowCount)await audit(tx,req.principal.subject!,'whatsapp.operation.queued',opId,{installationId:i,kind:command.kind});
   const {request_hash,actor,session_id,...result}=row;return result;
  });
 }
 @Get('operations') async list(@Param('installationId') i:string,@Req() req:RequestContext){parse(uuid,i);await this.policy.require(req.principal,i,'whatsapp.read');return this.db.query('SELECT id,state,command,result,error,created_at FROM wa_operations WHERE installation_id=$1 ORDER BY created_at DESC LIMIT 50',[i]);}
 @Get('operations/:id') async get(@Param('installationId') i:string,@Param('id') id:string,@Req() req:RequestContext){parse(uuid,i);parse(uuid,id);await this.policy.require(req.principal,i,'whatsapp.read');const [row]=await this.db.query('SELECT id,state,command,result,error,created_at FROM wa_operations WHERE installation_id=$1 AND id=$2',[i,id]);if(!row)throw new NotFoundException();return row;}
}
