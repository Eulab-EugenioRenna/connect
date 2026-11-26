import {purgeInstallationWhatsApp} from './whatsapp-purge.js';
import {SessionsService} from './sessions.service.js';
import {Optional} from '@nestjs/common';
import {defaultCatalogUrl} from './function-matrix.js';
import {ApiInput} from './openapi.js';
import {adminCustomerSchema,adminAppSchema,adminInstallationSchema,adminConnectApplicationSchema,adminUpdateInstallationSchema,adminLicenseSchema,adminIdentitySchema,adminMembershipSchema,adminRoleSchema,adminLinkSchema} from './schemas.js';
import { Body, Controller, Get, Param, Post, Put, Delete, Query, Req, GoneException, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Admin, RequestContext } from './auth.js';
import { Database, audit } from './database.js';
import { parse, uuid, key, name, origin, catalogSchema } from './validation.js';
import {CatalogService} from './catalog.service.js';
import { hash, secret, seal } from './security.js';
@Controller('v1') @ApiTags('Amministrazione') @ApiBearerAuth() @Admin()
export class AdminController {
 constructor(private readonly db: Database,private readonly catalogs:CatalogService,@Optional() private readonly sessions?:SessionsService) {}
 @Get('overview') async overview() {
   const tables = ['customers','applications','installations','licenses','entitlements','identities','memberships','roles','role_permissions','assignments','local_links','features','permissions'];
   const values = await Promise.all(tables.map(t=>this.db.query(`SELECT ${t==='installations'?'id,customer_id,app_id,domain,description,integration,base_path,fallback_url,enabled,created_at':'*'} FROM ${t}`)));
   const [recentAudit,errorCounts]=await Promise.all([
     this.db.query('SELECT id,actor,action,target,created_at FROM audit ORDER BY id DESC LIMIT 100'),
     this.db.query(`SELECT 'Sincronizzazione app' AS source,count(*)::int AS count FROM applications WHERE catalog_sync_error IS NOT NULL AND catalog_sync_error<>''
       UNION ALL SELECT 'Protezione WordPress',count(*)::int FROM wordpress_guardians WHERE enabled AND status IN ('error','missing')
       UNION ALL SELECT 'Connessioni WhatsApp',count(*)::int FROM wa_sessions WHERE state='failed' AND closed_at IS NULL
       UNION ALL SELECT 'Invii WhatsApp',count(*)::int FROM outbox WHERE state IN ('failed','uncertain')
       UNION ALL SELECT 'Consegne webhook',count(*)::int FROM deliveries WHERE state='failed'`)
   ]);
   return {...Object.fromEntries(tables.map((t,i)=>[t,values[i]])),recent_audit:recentAudit,error_counts:errorCounts};
 }
 @Get('customers') customers(){return this.db.query('SELECT * FROM customers ORDER BY created_at');}
 @Get('applications') applications(){return this.db.query('SELECT * FROM applications ORDER BY name');}
 @Get('installations') installations(){return this.db.query('SELECT id,customer_id,app_id,domain,description,integration,base_path,fallback_url,enabled,created_at FROM installations ORDER BY created_at');}
 @Get('licenses') licenses(){return this.db.query('SELECT * FROM licenses');}
 @Get('identities') identities(){return this.db.query('SELECT * FROM identities');}
 @Get('roles') roles(){return this.db.query('SELECT * FROM roles');}
 @Get('applications/:id/catalogs') catalogsList(@Param('id') id:string){return this.db.query('SELECT version,document FROM catalogs WHERE app_id=$1 ORDER BY version DESC',[id]);}
 @Get('operations') async operations(){
   const [runners,connections]=await Promise.all([
     this.db.query('SELECT r.*,count(s.id)::int AS sessions FROM runners r LEFT JOIN wa_sessions s ON s.runner_id=r.id AND s.closed_at IS NULL GROUP BY r.id'),
     this.db.query(`SELECT s.id,s.installation_id,s.number,s.state,s.runner_id,s.delete_requested,i.domain,i.base_path,c.name AS customer_name,a.name AS app_name,COALESCE(r.heartbeat_at>now()-interval '20 seconds',false) AS runner_online FROM wa_sessions s JOIN installations i ON i.id=s.installation_id JOIN customers c ON c.id=i.customer_id JOIN applications a ON a.id=i.app_id LEFT JOIN runners r ON r.id=s.runner_id WHERE s.closed_at IS NULL ORDER BY i.domain,s.created_at DESC`)
   ]);return {runners,connections,targetConcurrentSessions:{min:50,max:500,verified:false}};
 }
 @Get('audit') audit(@Query() query:unknown={}) {
   const q=parse(z.object({from:z.string().datetime().optional(),to:z.string().datetime().optional(),actor:z.string().max(200).optional(),action:z.string().max(200).optional(),target:z.string().max(300).optional(),before:z.string().regex(/^[1-9][0-9]*$/).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).strict(),query);
   const from=q.from||new Date(Date.now()-3600000).toISOString();if(q.to&&new Date(from)>new Date(q.to))throw new BadRequestException('Intervallo non valido');
   return this.db.query(`SELECT * FROM audit WHERE created_at >= $1 AND ($2::timestamptz IS NULL OR created_at <= $2) AND ($3::text IS NULL OR actor ILIKE '%'||$3||'%') AND ($4::text IS NULL OR action ILIKE '%'||$4||'%') AND ($5::text IS NULL OR target ILIKE '%'||$5||'%') AND ($6::bigint IS NULL OR id<$6) ORDER BY id DESC LIMIT $7`,[from,q.to||null,q.actor||null,q.action||null,q.target||null,q.before||null,q.limit]);
 }
 @Put('customers/:id') @ApiInput(adminCustomerSchema) async updateCustomer(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
   parse(uuid,id);const b=parse(adminCustomerSchema,body);return this.db.transaction(async tx=>{if(!(await tx.query('UPDATE customers SET name=$2,reference=$3 WHERE id=$1 RETURNING id',[id,b.name,b.reference])).rowCount)throw new NotFoundException();await audit(tx,req.principal.subject!,'customer.update',id,b);return {id,...b};});
 }
 @Delete('customers/:id') async deleteCustomer(@Param('id') id:string,@Req() req:RequestContext){
   parse(uuid,id);return this.db.transaction(async tx=>{if(!(await tx.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new NotFoundException();for(const table of ['installations','licenses','roles','memberships'])if((await tx.query(`SELECT 1 FROM ${table} WHERE customer_id=$1 LIMIT 1`,[id])).rows.length)throw new ConflictException('Cliente ancora collegato a installazioni, licenze, ruoli o appartenenze. Rimuovi prima i collegamenti.');await tx.query('DELETE FROM app_access_revocations WHERE customer_id=$1',[id]);await tx.query('DELETE FROM customers WHERE id=$1',[id]);await audit(tx,req.principal.subject!,'customer.delete',id);return {removed:true};});
 }
 @Put('applications/:id') @ApiInput(adminAppSchema.omit({id:true})) async updateApp(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
   parse(key,id);const b=parse(adminAppSchema.omit({id:true}),body);return this.db.transaction(async tx=>{if(!(await tx.query('UPDATE applications SET name=$2,description=$3 WHERE id=$1 RETURNING id',[id,b.name,b.description])).rowCount)throw new NotFoundException();await audit(tx,req.principal.subject!,'application.update',id,b);return {id,...b};});
 }
 @Delete('applications/:id') async deleteApp(@Param('id') id:string,@Req() req:RequestContext){
   parse(key,id);return this.db.transaction(async tx=>{if(!(await tx.query('SELECT id FROM applications WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new NotFoundException();for(const table of ['installations','licenses','roles'])if((await tx.query(`SELECT 1 FROM ${table} WHERE app_id=$1 LIMIT 1`,[id])).rows.length)throw new ConflictException('Applicazione ancora collegata a installazioni, licenze o ruoli. Rimuovi prima i collegamenti.');for(const table of ['permissions','features','catalogs','app_access_revocations','applications'])await tx.query(`DELETE FROM ${table} WHERE ${table==='applications'?'id':'app_id'}=$1`,[id]);await audit(tx,req.principal.subject!,'application.delete',id);return {removed:true};});
 }
 @Delete('installations/:id') async deleteInstallation(@Param('id') id:string,@Req() req:RequestContext){
   parse(uuid,id);return this.db.transaction(async tx=>{if(!(await tx.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new NotFoundException();// WhatsApp history goes only with its licence: connected numbers are disconnected first by their runner.
if(!(await purgeInstallationWhatsApp(tx,id))){await audit(tx,req.principal.subject!,'installation.delete.requested',id);return {removed:false,state:'disconnecting',message:'Scollegamento dei numeri WhatsApp in corso: riprova tra qualche secondo per completare l’eliminazione.'};}for(const table of ['local_links','pairing_codes','technical_tickets','webhook_endpoints'])await tx.query(`DELETE FROM ${table} WHERE installation_id=$1`,[id]);await tx.query('DELETE FROM installations WHERE id=$1',[id]);await audit(tx,req.principal.subject!,'installation.delete',id);return {removed:true};});
 }
 @Delete('licenses/:customerId/:appId') async deleteLicense(@Param('customerId') customerId:string,@Param('appId') appId:string,@Req() req:RequestContext){
   parse(uuid,customerId);parse(key,appId);return this.db.transaction(async tx=>{await tx.query('DELETE FROM entitlements WHERE customer_id=$1 AND app_id=$2',[customerId,appId]);if(!(await tx.query('DELETE FROM licenses WHERE customer_id=$1 AND app_id=$2 RETURNING customer_id',[customerId,appId])).rowCount)throw new NotFoundException();await audit(tx,req.principal.subject!,'license.delete',customerId+'/'+appId);return {removed:true};});
 }
 @Delete('roles/:id') async deleteRole(@Param('id') id:string,@Req() req:RequestContext){
   parse(uuid,id);return this.db.transaction(async tx=>{await tx.query('DELETE FROM assignments WHERE role_id=$1',[id]);if(!(await tx.query('DELETE FROM roles WHERE id=$1 RETURNING id',[id])).rowCount)throw new NotFoundException();await audit(tx,req.principal.subject!,'role.delete',id);return {removed:true};});
 }
 @Delete('memberships/:subject/:customerId') async deleteMembership(@Param('subject') subject:string,@Param('customerId') customerId:string,@Req() req:RequestContext){
   parse(name,subject);parse(uuid,customerId);return this.db.transaction(async tx=>{await tx.query('DELETE FROM assignments WHERE subject=$1 AND customer_id=$2',[subject,customerId]);await tx.query('DELETE FROM memberships WHERE subject=$1 AND customer_id=$2',[subject,customerId]);await audit(tx,req.principal.subject!,'membership.delete',subject,{customerId});return {removed:true};});
 }
 @Post('customers') @ApiInput(adminCustomerSchema) async customer(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminCustomerSchema,body),id=randomUUID();
   return this.db.transaction(async db=>{ await db.query('INSERT INTO customers(id,name,reference) VALUES($1,$2,$3)',[id,b.name,b.reference]); await audit(db,req.principal.subject!,'customer.create',id,b); return {id,...b}; });
 }
 @Post('applications') @ApiInput(adminAppSchema) async app(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminAppSchema,body);
   return this.db.transaction(async db=>{await db.query('INSERT INTO applications(id,name,description) VALUES($1,$2,$3)',[b.id,b.name,b.description]);await audit(db,req.principal.subject!,'application.create',b.id,b);return b;});
 }
 @Post('applications/:id/catalogs') @ApiInput(catalogSchema) async catalog(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext) {
   throw new GoneException('Le funzioni sono definite dall’app: configura il loro URL e sincronizza con GET');
 }
 @Post('installations') @ApiInput(adminInstallationSchema) async installation(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminInstallationSchema,body),id=randomUUID(),credential=secret();
   const fallback=b.fallbackUrl||`${b.domain}${b.basePath}/eulab/connect/functions`;if(new URL(fallback).origin!==b.domain||new URL(fallback).username||new URL(fallback).password||new URL(fallback).search||new URL(fallback).hash)throw new BadRequestException('Il fallback deve appartenere al dominio autorizzato');
   return this.db.transaction(async db=>{ await db.query('INSERT INTO installations(id,customer_id,app_id,domain,secret_hash,description,integration,base_path,fallback_url,secret_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,b.customerId,b.appId,b.domain,hash(credential),b.description,b.integration,b.basePath,fallback,seal(credential)]); await db.query('UPDATE applications SET catalog_url=$2 WHERE id=$1 AND catalog_url IS NULL',[b.appId,defaultCatalogUrl(b)]);await audit(db,req.principal.subject!,'installation.create',id,b);return {id,...b,fallbackUrl:fallback,secret:credential}; });
 }
 @Post('application-connections') @ApiInput(adminConnectApplicationSchema) async connectApplication(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminConnectApplicationSchema,body);
   const appId=b.id||`app-${randomUUID().slice(0,8)}`;
   const id=randomUUID(),credential=secret(),fallback=b.fallbackUrl||`${b.domain}${b.basePath}/eulab/connect/functions`;
   const url=new URL(fallback);if(url.origin!==b.domain||url.username||url.password||url.search||url.hash)throw new BadRequestException('Fallback esterno al dominio autorizzato');
   return this.db.transaction(async db=>{
     await db.query('INSERT INTO applications(id,name,description,catalog_url) VALUES($1,$2,$3,$4)',[appId,b.name,b.description,defaultCatalogUrl(b)]);
     await db.query('INSERT INTO installations(id,customer_id,app_id,domain,secret_hash,description,integration,base_path,fallback_url,secret_cipher) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,b.customerId,appId,b.domain,hash(credential),b.description,b.integration,b.basePath,fallback,seal(credential)]);
     await audit(db,req.principal.subject!,'application.connect',id,{...b,fallbackUrl:fallback});
     return {appId,installationId:id,domain:b.domain,integration:b.integration,fallbackUrl:fallback,secret:credential};
   });
 }
 @Put('installations/:id') @ApiInput(adminUpdateInstallationSchema) async updateInstallation(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext) {
   parse(uuid,id);const b=parse(adminUpdateInstallationSchema,body),credential=b.rotateSecret?secret():null;
   if(b.domain||b.fallbackUrl||b.basePath!==undefined){const [old]=await this.db.query('SELECT domain,base_path,fallback_url FROM installations WHERE id=$1',[id]);if(!old)throw new NotFoundException();const domain=b.domain||old.domain,basePath=b.basePath??old.base_path;const fallback=b.fallbackUrl||((b.domain||b.basePath!==undefined)?`${domain}${basePath}/eulab/connect/functions`:old.fallback_url);if(new URL(fallback).origin!==domain||new URL(fallback).username||new URL(fallback).password||new URL(fallback).search||new URL(fallback).hash)throw new BadRequestException('Fallback esterno al dominio autorizzato');b.fallbackUrl=fallback;}
   return this.db.transaction(async db=>{const previous=(await db.query('SELECT domain,base_path,integration,app_id FROM installations WHERE id=$1 FOR UPDATE',[id])).rows[0];const result=await db.query('UPDATE installations SET enabled=$2,secret_hash=COALESCE($3,secret_hash),domain=COALESCE($4,domain),description=COALESCE($5,description),integration=COALESCE($6,integration),base_path=COALESCE($7,base_path),fallback_url=COALESCE($8,fallback_url),secret_cipher=COALESCE($9,secret_cipher) WHERE id=$1 RETURNING id',[id,b.enabled,credential?hash(credential):null,b.domain??null,b.description??null,b.integration??null,b.basePath??null,b.fallbackUrl??null,credential?seal(credential):null]);if(!result.rowCount)throw new NotFoundException();if(previous&&((b.domain!==undefined&&b.domain!==previous.domain)||(b.basePath!==undefined&&b.basePath!==previous.base_path)||(b.integration!==undefined&&b.integration!==previous.integration))){await db.query('UPDATE applications SET catalog_url=$3,catalog_source_version=null,catalog_source_hash=null,catalog_checked_at=null,catalog_sync_error=null WHERE id=$1 AND catalog_url=$2',[previous.app_id,defaultCatalogUrl(previous),defaultCatalogUrl({domain:b.domain??previous.domain,base_path:b.basePath??previous.base_path,integration:b.integration??previous.integration})]);await db.query('DELETE FROM wordpress_users WHERE installation_id=$1',[id]);await db.query('DELETE FROM wordpress_directories WHERE installation_id=$1',[id]);await db.query('DELETE FROM technical_tickets WHERE installation_id=$1',[id]);}await audit(db,req.principal.subject!,'installation.update',id,b);return {id,enabled:b.enabled,...(credential?{secret:credential}:{})};});
 }
 @Put('licenses') @ApiInput(adminLicenseSchema) async license(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminLicenseSchema,body);
   const result=await this.db.transaction(async db=>{
     await db.query('INSERT INTO licenses VALUES($1,$2,$3,$4) ON CONFLICT(customer_id,app_id) DO UPDATE SET state=$3,expires_at=$4',[b.customerId,b.appId,b.state,b.expiresAt]);
     await db.query('UPDATE entitlements SET purchased=false,enabled=false WHERE customer_id=$1 AND app_id=$2',[b.customerId,b.appId]);
     for(const f of b.features) {if(f.enabled&&!f.purchased)throw new BadRequestException('Acquisto necessario');await db.query('INSERT INTO entitlements VALUES($1,$2,$3,$4,$5) ON CONFLICT(customer_id,app_id,feature_key) DO UPDATE SET purchased=$4,enabled=$5',[b.customerId,b.appId,f.key,f.purchased,f.enabled]);}
     await audit(db,req.principal.subject!,'license.update',`${b.customerId}/${b.appId}`,b);return {saved:true};
   });
   if(b.revokeSessions){if(!this.sessions)throw new Error('Servizio sessioni assente');return {...result,sessions:await this.sessions.logoutForPlan(b.customerId,b.appId,req.principal.subject!)};}return result;
 }
 @Put('identities') @ApiInput(adminIdentitySchema) async identity(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminIdentitySchema,body);
   return this.db.transaction(async db=>{await db.query('INSERT INTO identities VALUES($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET display_name=$2,enabled=$3',[b.subject,b.displayName,b.enabled]);await audit(db,req.principal.subject!,'identity.update',b.subject,b);return {saved:true};});
 }
 @Put('memberships') @ApiInput(adminMembershipSchema) async membership(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminMembershipSchema,body);
   return this.db.transaction(async db=>{
     await db.query('INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT(subject,customer_id) DO UPDATE SET enabled=$3',[b.subject,b.customerId,b.enabled]);
     await db.query('DELETE FROM assignments WHERE subject=$1 AND customer_id=$2',[b.subject,b.customerId]);
     for(const role of b.roleIds){const r=(await db.query('SELECT * FROM roles WHERE id=$1 AND customer_id=$2',[role,b.customerId])).rows[0];if(!r)throw new BadRequestException('Ruolo estraneo al cliente');await db.query('INSERT INTO assignments VALUES($1,$2,$3,$4)',[b.subject,b.customerId,r.app_id,role]);}
     await audit(db,req.principal.subject!,'membership.update',b.subject,b);return {saved:true};
   });
 }
 @Put('roles') @ApiInput(adminRoleSchema) async role(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminRoleSchema,body),id=b.id||randomUUID();
   return this.db.transaction(async db=>{
     const existing=(await db.query('SELECT * FROM roles WHERE id=$1 FOR UPDATE',[id])).rows[0];
     if(existing&&(existing.customer_id!==b.customerId||existing.app_id!==b.appId))throw new BadRequestException('Ambito ruolo immutabile');
     await db.query('INSERT INTO roles VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$4',[id,b.customerId,b.appId,b.name]);
     await db.query('DELETE FROM role_permissions WHERE role_id=$1',[id]);
     for(const p of b.permissions)await db.query('INSERT INTO role_permissions VALUES($1,$2,$3)',[id,b.appId,p]);
     await audit(db,req.principal.subject!,'role.update',id,b);return {id};
   });
 }
 @Put('identity-links') @ApiInput(adminLinkSchema) async link(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(adminLinkSchema,body);
   return this.db.transaction(async db=>{await db.query('INSERT INTO local_links VALUES($1,$2,$3) ON CONFLICT(installation_id,local_user_id) DO UPDATE SET subject=$3',[b.installationId,b.localUserId,b.subject]);await audit(db,req.principal.subject!,'identity.link',b.installationId,b);return {saved:true};});
 }
 @Delete('identity-links/:installationId/:localUserId') async unlink(@Param('installationId') installationId:string,@Param('localUserId') localUserId:string,@Req() req:RequestContext){
   parse(uuid,installationId);parse(name,localUserId);return this.db.transaction(async db=>{await db.query('DELETE FROM local_links WHERE installation_id=$1 AND local_user_id=$2',[installationId,localUserId]);await audit(db,req.principal.subject!,'identity.unlink',installationId,{localUserId});return {removed:true};});
 }
 @Post('installations/:id/pairing-code') async pairing(@Param('id') id:string,@Req() req:RequestContext) {
   parse(uuid,id);const code=secret();return this.db.transaction(async db=>{await db.query("INSERT INTO pairing_codes VALUES($1,$2,now()+interval '10 minutes',null)",[hash(code),id]);await audit(db,req.principal.subject!,'pairing.issue',id);return {code,expiresIn:600};});
 }
}
