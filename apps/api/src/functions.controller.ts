import {Controller,Get,Post,Put,Param,Body,Req,ForbiddenException} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {Admin,RequestContext} from './auth.js';
import {Database} from './database.js';
import {CatalogSourceService} from './catalog-source.service.js';
import {Authorization} from './authorization.js';
import {parse,key} from './validation.js';
import {ApiInput} from './openapi.js';
const sourceSchema=z.object({url:z.string().url().max(2000)}).strict();
@Controller('v1') @ApiTags('Funzioni dell’app') @ApiBearerAuth()
export class FunctionsController {
 constructor(private readonly db:Database,private readonly sources:CatalogSourceService,private readonly policy:Authorization){}
 @Post('catalog-source') @ApiInput(sourceSchema) async register(@Body() body:unknown,@Req() req:RequestContext){const p=req.principal;if(!p.server||!p.installationId)throw new ForbiddenException('Registrazione server dell’app richiesta');const b=parse(sourceSchema,body);const [i]=await this.db.query('SELECT app_id FROM installations WHERE id=$1',[p.installationId]);await this.sources.configure(i.app_id,b.url,'installation:'+p.installationId,p.installationId);return this.sources.sync(i.app_id,'installation:'+p.installationId);}
 @Put('applications/:id/catalog-source') @Admin() @ApiInput(sourceSchema) async source(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){parse(key,id);const b=parse(sourceSchema,body);await this.sources.configure(id,b.url,req.principal.subject!);return this.sources.sync(id,req.principal.subject!);}
 @Get('applications/:id/functions') @Admin() async functions(@Param('id') id:string){parse(key,id);const [app]=await this.db.query('SELECT catalog_url,catalog_source_version,catalog_version,catalog_checked_at,catalog_synced_at,catalog_sync_error FROM applications WHERE id=$1',[id]);if(!app)throw new ForbiddenException('Applicazione non disponibile');return {...app,functions:await this.db.query('SELECT key,name FROM permissions WHERE app_id=$1 AND active=true ORDER BY name,key',[id])};}
 @Post('applications/:id/catalog-sync') @Admin() async sync(@Param('id') id:string,@Req() req:RequestContext){parse(key,id);return this.sources.sync(id,req.principal.subject!);}
 @Get('access') access(@Req() req:RequestContext){if(!req.principal.installationId)throw new ForbiddenException('Installazione richiesta');return this.policy.access(req.principal,req.principal.installationId);}
 @Get('users') async users(@Req() req:RequestContext){const p=req.principal;if(!p.installationId)throw new ForbiddenException('Installazione richiesta');await this.policy.require(p,p.installationId,'users.read');return this.db.query(`SELECT u.subject,u.display_name AS "displayName",lk.local_user_id AS "localUserId",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name) ORDER BY r.name) FROM assignments a JOIN roles r ON r.id=a.role_id WHERE a.subject=u.subject AND a.customer_id=i.customer_id AND a.app_id=i.app_id),'[]'::jsonb) AS roles FROM local_links lk JOIN installations i ON i.id=lk.installation_id JOIN identities u ON u.subject=lk.subject JOIN memberships m ON m.subject=u.subject AND m.customer_id=i.customer_id WHERE i.id=$1 AND u.enabled=true AND m.enabled=true AND NOT EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=u.subject) ORDER BY u.display_name,u.subject`,[p.installationId]);}
}
