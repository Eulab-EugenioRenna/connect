import {Body,Controller,Get,Post,Put,Param,Query,Req,ForbiddenException,NotFoundException,ConflictException} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {Admin,RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {ApiInput} from './openapi.js';
import {parse,uuid,name} from './validation.js';
const syncSchema=z.object({generation:uuid,start:z.boolean().default(false),complete:z.boolean().default(false),users:z.array(z.object({id:z.string().regex(/^[1-9][0-9]{0,14}$/),username:z.string().min(1).max(200),displayName:z.string().max(250),email:z.string().max(250),roles:z.array(z.string().min(1).max(100)).max(50).refine(roles=>!roles.includes('eulab_technician'),'Account tecnico escluso')}).strict()).max(100)}).strict();
@Controller('v1') @ApiTags('Utenti WordPress') @ApiBearerAuth()
export class WordPressController {
 constructor(private readonly db:Database){}
 private async site(id:string){parse(uuid,id);const [i]=await this.db.query("SELECT id FROM installations WHERE id=$1 AND integration='wordpress' AND enabled=true",[id]);if(!i)throw new NotFoundException('Installazione WordPress non disponibile');}
 private async plugin(req:RequestContext){if(!req.principal.server||!req.principal.installationId)throw new ForbiddenException('Credenziali del plugin richieste');await this.site(req.principal.installationId);return req.principal.installationId;}
 @Get('wordpress/sync-status') async status(@Req() req:RequestContext){const id=await this.plugin(req);const [directory]=await this.db.query('SELECT synced_at,requested_at FROM wordpress_directories WHERE installation_id=$1',[id]);return {requested:!directory?.synced_at||!!directory.requested_at&&new Date(directory.requested_at)>new Date(directory.synced_at)};}
 @Post('wordpress/users/sync') @ApiInput(syncSchema) async sync(@Body() body:unknown,@Req() req:RequestContext){
  const id=await this.plugin(req),b=parse(syncSchema,body);
  if(new Set(b.users.map(u=>u.id)).size!==b.users.length)throw new ConflictException('Utenti duplicati nel lotto');
  return this.db.transaction(async tx=>{
   await tx.query('SELECT id FROM installations WHERE id=$1 FOR UPDATE',[id]);
   if(b.start)await tx.query('INSERT INTO wordpress_directories(installation_id,pending_generation) VALUES($1,$2) ON CONFLICT(installation_id) DO UPDATE SET pending_generation=$2',[id,b.generation]);
   const directory=(await tx.query('SELECT * FROM wordpress_directories WHERE installation_id=$1 FOR UPDATE',[id])).rows[0];
   if(directory?.pending_generation!==b.generation)throw new ConflictException('Sincronizzazione scaduta: ricomincia dall’inizio');
   for(const u of b.users)await tx.query(`INSERT INTO wordpress_users VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(installation_id,generation,local_user_id) DO UPDATE SET username=$4,display_name=$5,email=$6,roles=$7`,[id,b.generation,u.id,u.username,u.displayName,u.email,JSON.stringify(u.roles)]);
   if(b.complete){
    await tx.query('UPDATE wordpress_directories SET active_generation=$2,pending_generation=null,synced_at=now() WHERE installation_id=$1',[id,b.generation]);
    await tx.query('DELETE FROM wordpress_users WHERE installation_id=$1 AND generation<>$2',[id,b.generation]);
    await audit(tx,'installation:'+id,'wordpress.users.synced',id);
   }
   return {saved:true,complete:b.complete};
  });
 }
 @Get('installations/:id/wordpress/users') @Admin() async users(@Param('id') id:string,@Query() query:unknown){
  await this.site(id);const q=parse(z.object({search:z.string().max(100).default(''),role:z.string().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict(),query);
  const [directory]=await this.db.query('SELECT synced_at,pending_generation,requested_at,active_generation FROM wordpress_directories WHERE installation_id=$1',[id]);
  const args=[id,directory?.active_generation||null,q.search,q.role];
  const where=`installation_id=$1 AND generation=$2 AND ($3='' OR position(lower($3) in lower(username||' '||display_name||' '||email))>0) AND ($4='' OR roles ? $4)`;
  const [items,count,roleRows]=await Promise.all([
   this.db.query(`SELECT local_user_id AS id,username,display_name,email,roles FROM wordpress_users WHERE ${where} ORDER BY lower(display_name),local_user_id LIMIT 20 OFFSET $5`,[...args,(q.page-1)*20]),
   this.db.query(`SELECT count(*)::int AS total FROM wordpress_users WHERE ${where}`,args),
   this.db.query('SELECT DISTINCT jsonb_array_elements_text(roles) AS role FROM wordpress_users WHERE installation_id=$1 AND generation=$2 ORDER BY role',args.slice(0,2))
  ]);
  const links=await this.db.query('SELECT l.local_user_id,l.subject,u.display_name FROM local_links l JOIN identities u ON u.subject=l.subject WHERE l.installation_id=$1',[id]);
  return {items:items.map(u=>({...u,link:links.find(l=>l.local_user_id===u.id)||null})),total:count[0].total,page:q.page,pageSize:20,roles:roleRows.map(r=>r.role),syncedAt:directory?.synced_at||null,syncing:!!directory?.pending_generation,syncRequested:!!directory?.requested_at&&(!directory?.synced_at||new Date(directory.requested_at)>new Date(directory.synced_at))};
 }
 @Put('installations/:id/wordpress/users/:localId/sso-link') @Admin() async linkSso(@Param('id') id:string,@Param('localId') localId:string,@Body() body:unknown,@Req() req:RequestContext){
  await this.site(id);const b=parse(z.object({subject:name,enableMembership:z.boolean().default(false)}).strict(),body);parse(z.string().regex(/^[1-9][0-9]{0,14}$/),localId);
  return this.db.transaction(async tx=>{
   const site=(await tx.query('SELECT * FROM installations WHERE id=$1 FOR UPDATE',[id])).rows[0];
   const user=(await tx.query('SELECT u.local_user_id FROM wordpress_users u JOIN wordpress_directories d ON d.installation_id=u.installation_id AND d.active_generation=u.generation WHERE u.installation_id=$1 AND u.local_user_id=$2',[id,localId])).rows[0];if(!user)throw new NotFoundException('Utente WordPress non disponibile');
   if(!(await tx.query('SELECT subject FROM identities WHERE subject=$1 AND enabled=true',[b.subject])).rows.length)throw new NotFoundException('Identità SSO non disponibile');
   const links=(await tx.query('SELECT subject,local_user_id FROM local_links WHERE installation_id=$1 AND (subject=$2 OR local_user_id=$3)',[id,b.subject,localId])).rows;
   if(links.some(l=>l.subject!==b.subject||l.local_user_id!==localId))throw new ConflictException('Esiste già un altro collegamento: scollegalo prima da Identità e accessi');
   if(b.enableMembership)await tx.query('INSERT INTO memberships VALUES($1,$2,true) ON CONFLICT(subject,customer_id) DO UPDATE SET enabled=true',[b.subject,site.customer_id]);
   if(!(await tx.query('SELECT subject FROM memberships WHERE subject=$1 AND customer_id=$2 AND enabled=true',[b.subject,site.customer_id])).rows.length)throw new ConflictException('Abilita prima l’appartenenza al cliente');
   await tx.query('INSERT INTO local_links VALUES($1,$2,$3) ON CONFLICT(installation_id,local_user_id) DO UPDATE SET subject=$3',[id,localId,b.subject]);await audit(tx,req.principal.subject!,'wordpress.sso.link',id,{...b,localUserId:localId});return {saved:true,subject:b.subject,localUserId:localId};
  });
 }
 @Post('installations/:id/wordpress/sync') @Admin() async requestSync(@Param('id') id:string,@Req() req:RequestContext){
  await this.site(id);return this.db.transaction(async tx=>{await tx.query('INSERT INTO wordpress_directories(installation_id,requested_at) VALUES($1,now()) ON CONFLICT(installation_id) DO UPDATE SET requested_at=now()',[id]);await audit(tx,req.principal.subject!,'wordpress.users.sync.requested',id);return {requested:true};});
 }
}
