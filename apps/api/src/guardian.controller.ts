import {Controller,Get,Post,Put,Param,Body,Req,UnauthorizedException,NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {Admin,Public,RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {parse,uuid} from './validation.js';
import {hash,secret} from './security.js';
const report=z.object({status:z.enum(['active','missing','paused','error','repaired']),error:z.string().max(500).default('')}).strict();
@Controller('v1/wordpress-guardians')
export class GuardianController {
 constructor(private readonly db:Database){}
 @Admin() @Get(':id') async get(@Param('id') id:string){parse(uuid,id);return (await this.db.query('SELECT installation_id,enabled,heartbeat_at,status,last_error,repairs,updated_at FROM wordpress_guardians WHERE installation_id=$1',[id]))[0]||null;}
 @Admin() @Post(':id') async enroll(@Param('id') id:string,@Req() req:RequestContext){parse(uuid,id);const credential=secret();return this.db.transaction(async tx=>{if(!(await tx.query("SELECT id FROM installations WHERE id=$1 AND integration='wordpress'",[id])).rows.length)throw new NotFoundException();await tx.query('INSERT INTO wordpress_guardians(installation_id,secret_hash) VALUES($1,$2) ON CONFLICT(installation_id) DO UPDATE SET secret_hash=$2,updated_at=now()',[id,hash(credential)]);await audit(tx,req.principal.subject!,'wordpress.guardian.enroll',id);return {installationId:id,secret:credential};});}
 @Admin() @Put(':id') async toggle(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){parse(uuid,id);const b=parse(z.object({enabled:z.boolean()}).strict(),body);return this.db.transaction(async tx=>{if(!(await tx.query('UPDATE wordpress_guardians SET enabled=$2,updated_at=now() WHERE installation_id=$1 RETURNING installation_id',[id,b.enabled])).rowCount)throw new NotFoundException();await audit(tx,req.principal.subject!,b.enabled?'wordpress.guardian.resume':'wordpress.guardian.stop',id);return {enabled:b.enabled};});}
 @Public() @Post(':id/check') async check(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){parse(uuid,id);const b=parse(report,body),credential=req.headers['x-guardian-secret'];if(!credential||credential.length>200)throw new UnauthorizedException();return this.db.transaction(async tx=>{const g=(await tx.query('SELECT g.*,i.enabled AS installation_enabled FROM wordpress_guardians g JOIN installations i ON i.id=g.installation_id WHERE g.installation_id=$1 AND g.secret_hash=$2 FOR UPDATE OF g',[id,hash(credential)])).rows[0];if(!g)throw new UnauthorizedException();await tx.query('UPDATE wordpress_guardians SET heartbeat_at=now(),status=$2,last_error=$3,repairs=repairs+$4 WHERE installation_id=$1',[id,b.status,b.error,b.status==='repaired'?1:0]);if(g.status!==b.status)await audit(tx,'guardian:'+id,'wordpress.guardian.status',id,b);return {enabled:g.enabled&&g.installation_enabled,checkAfterSeconds:30};});}
}
