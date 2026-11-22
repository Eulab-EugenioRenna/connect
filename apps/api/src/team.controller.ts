import {IdentitiesService} from './identities.service.js';
import {Body,ConflictException,Controller,Delete,Get,Param,Post,Put,Req,ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {ApiInput} from './openapi.js';
import {parse,name,key,uuid} from './validation.js';
import {TeamPolicy} from './team-policy.js';
import type {TeamContext as Context,TeamDelegation as Delegation} from './team-policy.js';

const roleSchema=z.object({name:z.string().trim().min(1).max(200),permissions:z.array(key).max(1000)}).strict();
const assignmentSchema=z.object({roleIds:z.array(uuid).max(50)}).strict();

type Role={id:string;name:string;permissions:string[]};

@Controller('v1/team') @ApiTags('Squadra dell’installazione') @ApiBearerAuth()
export class TeamController {
 constructor(private readonly db:Database,private readonly team:TeamPolicy,private readonly identities:IdentitiesService){}
 private async users(c:Context){
  return await this.db.query(`SELECT u.subject,u.display_name AS "displayName",lk.local_user_id AS "localUserId",u.enabled AS "identityEnabled",COALESCE(m.enabled,false) AS "membershipEnabled",
    EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=u.subject) AS "accessRevoked",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name) ORDER BY r.name) FROM assignments a JOIN roles r ON r.id=a.role_id WHERE a.subject=u.subject AND a.customer_id=i.customer_id AND a.app_id=i.app_id),'[]'::jsonb) AS roles
   FROM local_links lk JOIN installations i ON i.id=lk.installation_id JOIN identities u ON u.subject=lk.subject
   LEFT JOIN memberships m ON m.subject=u.subject AND m.customer_id=i.customer_id
   WHERE lk.installation_id=$1 ORDER BY u.display_name,u.subject`,[c.installationId]);
 }
 private async roles(c:Context){
  return await this.db.query(`SELECT r.id,r.name,COALESCE((SELECT jsonb_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permissions rp WHERE rp.role_id=r.id AND rp.app_id=r.app_id),'[]'::jsonb) AS permissions
   FROM roles r WHERE r.customer_id=$1 AND r.app_id=$2 ORDER BY r.name,r.id`,[c.customerId,c.appId]) as Role[];
 }
 private functions(d:Delegation){return d.licensed.map(f=>({...f,delegable:d.allowed.has(f.key)}));}
 @Get() async overview(@Req() req:RequestContext){
  const c=await this.team.context(req),d=await this.team.guard(c);
  const [users,roles]=await Promise.all([this.users(c),this.roles(c)]);
  return {installationId:c.installationId,customerId:c.customerId,appId:c.appId,canManage:d.allowed.has('team.manage'),functions:this.functions(d),delegation:d.delegated,roles,users};
 }
 @Get('users') async usersList(@Req() req:RequestContext){const c=await this.team.context(req);await this.team.guard(c);return this.users(c);}
 @Get('roles') async rolesList(@Req() req:RequestContext){const c=await this.team.context(req);await this.team.guard(c);return this.roles(c);}
 @Get('functions') async functionsList(@Req() req:RequestContext){const c=await this.team.context(req);const d=await this.team.guard(c);return this.functions(d);}
 @Post('roles') @ApiInput(roleSchema) async createRole(@Body() body:unknown,@Req() req:RequestContext){
  const c=await this.team.context(req),d=await this.team.guard(c,true),b=parse(roleSchema,body),permissions=this.team.validatePermissions(d,b.permissions),id=randomUUID();
  return this.db.transaction(async tx=>{
   await tx.query('INSERT INTO roles VALUES($1,$2,$3,$4)',[id,c.customerId,c.appId,b.name]);
   for(const permission of permissions)await tx.query('INSERT INTO role_permissions VALUES($1,$2,$3)',[id,c.appId,permission]);
   await audit(tx,c.subject,'team.role.create',id,{name:b.name,permissions});
   return {id,name:b.name,permissions};
  });
 }
 @Put('roles/:id') @ApiInput(roleSchema) async updateRole(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  parse(uuid,id);const c=await this.team.context(req),d=await this.team.guard(c,true),b=parse(roleSchema,body);
  await this.team.role(c,id);
  // Un ruolo che contiene già funzioni fuori dalla delega del chiamante non è modificabile.
  this.team.assertWithin(d,await this.team.rolePermissions(c,id),'Il ruolo contiene funzioni fuori dalla propria delega');
  const permissions=this.team.validatePermissions(d,b.permissions);
  return this.db.transaction(async tx=>{
   await tx.query('UPDATE roles SET name=$2 WHERE id=$1',[id,b.name]);
   await tx.query('DELETE FROM role_permissions WHERE role_id=$1',[id]);
   for(const permission of permissions)await tx.query('INSERT INTO role_permissions VALUES($1,$2,$3)',[id,c.appId,permission]);
   await audit(tx,c.subject,'team.role.update',id,{name:b.name,permissions});
   return {id,name:b.name,permissions};
  });
 }
 @Delete('roles/:id') async deleteRole(@Param('id') id:string,@Req() req:RequestContext){
  parse(uuid,id);const c=await this.team.context(req),d=await this.team.guard(c,true);
  await this.team.role(c,id);this.team.assertWithin(d,await this.team.rolePermissions(c,id),'Il ruolo contiene funzioni fuori dalla propria delega');
  return this.db.transaction(async tx=>{
   await tx.query('DELETE FROM assignments WHERE role_id=$1',[id]);
   await tx.query('DELETE FROM roles WHERE id=$1',[id]);
   await audit(tx,c.subject,'team.role.delete',id);
   return {removed:true};
  });
 }
 @Post('users/:subject/password-reset') async passwordReset(@Param('subject') subject:string,@Req() req:RequestContext){
  parse(name,subject);const c=await this.team.context(req),d=await this.team.guard(c,true);
  if(!d.allowed.has('team.password.reset'))throw new ForbiddenException('Recupero password non abilitato');
  if(subject===c.subject)throw new ForbiddenException('Usa la sicurezza del tuo profilo personale');
  await this.team.target(c,subject);
  this.team.assertWithin(d,await this.team.userPermissions(c,subject),'Account fuori dalla propria delega');
  const [profile]=await this.db.query('SELECT role FROM app_local_users WHERE installation_id=$1 AND subject=$2 AND enabled=true',[c.installationId,subject]);
  if(!profile||!['collaborator','reception','manager'].includes(profile.role))throw new ForbiddenException('Account non amministrabile da questa applicazione');
  const revoked=await this.db.query('SELECT 1 FROM app_access_revocations WHERE subject=$1 AND customer_id=$2 AND app_id=$3',[subject,c.customerId,c.appId]);
  if(revoked.length)throw new ConflictException('Accesso revocato: verifica il profilo prima del recupero');
  const user=await this.identities.user(subject),roles=await this.identities.roles(subject);
  if(!user?.enabled||!user.email||user.serviceAccountClientId||roles.some(r=>['eulab-admin','eulab-technician'].includes(r.name)))throw new ForbiddenException('Identità non disponibile per il recupero delegato');
  await this.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['password-reset:'+subject]);
   if((await tx.query("SELECT 1 FROM audit WHERE action='team.password_reset.requested' AND target=$1 AND created_at>now()-interval '60 seconds'",[subject])).rows.length)throw new ConflictException('Richiesta recente: verifica la ricezione prima di ripetere');
   await audit(tx,c.subject,'team.password_reset.requested',subject,{installationId:c.installationId});
  });
  try{await this.identities.request('/users/'+encodeURIComponent(subject)+'/execute-actions-email?lifespan=900','PUT',['UPDATE_PASSWORD']);}
  catch{throw new ServiceUnavailableException({code:'password_reset_outcome_uncertain',message:'Esito del recupero da verificare con il destinatario. Nessun invio viene ripetuto automaticamente'});}
  await this.db.transaction(tx=>audit(tx,c.subject,'team.password_reset.accepted',subject,{installationId:c.installationId}));
  return {requested:true};
 }
 @Put('users/:subject/roles') @ApiInput(assignmentSchema) async setRoles(@Param('subject') subject:string,@Body() body:unknown,@Req() req:RequestContext){
  parse(name,subject);const c=await this.team.context(req),d=await this.team.guard(c,true),b=parse(assignmentSchema,body);
  const target=await this.team.target(c,subject);
  // Non si possono sostituire i ruoli di un utente con funzioni più ampie della propria delega.
  this.team.assertWithin(d,await this.team.userPermissions(c,subject),'L’utente possiede funzioni fuori dalla propria delega');
  if(new Set(b.roleIds).size!==b.roleIds.length)throw new ConflictException('Ruoli duplicati');
  for(const roleId of b.roleIds){
   await this.team.role(c,roleId);
   this.team.assertWithin(d,await this.team.rolePermissions(c,roleId),'Il ruolo contiene funzioni fuori dalla propria delega');
  }
  return this.db.transaction(async tx=>{
   await tx.query('DELETE FROM assignments WHERE subject=$1 AND customer_id=$2 AND app_id=$3',[subject,c.customerId,c.appId]);
   for(const roleId of b.roleIds)await tx.query('INSERT INTO assignments VALUES($1,$2,$3,$4)',[subject,c.customerId,c.appId,roleId]);
   // Un'assegnazione esplicita riattiva l'accesso revocato in precedenza alla stessa applicazione.
   if(b.roleIds.length)await tx.query('DELETE FROM app_access_revocations WHERE customer_id=$1 AND app_id=$2 AND subject=$3',[c.customerId,c.appId,subject]);
   await audit(tx,c.subject,'team.user.roles',subject,{localUserId:target.localUserId,roleIds:b.roleIds});
   return {subject,localUserId:target.localUserId,roleIds:b.roleIds,accessRestored:b.roleIds.length>0};
  });
 }
 @Delete('users/:subject') async revoke(@Param('subject') subject:string,@Req() req:RequestContext){
  parse(name,subject);const c=await this.team.context(req),d=await this.team.guard(c,true);
  const target=await this.team.target(c,subject);
  // Non si possono revocare utenti con funzioni più ampie della propria delega.
  this.team.assertWithin(d,await this.team.userPermissions(c,subject),'L’utente possiede funzioni fuori dalla propria delega');
  return this.db.transaction(async tx=>{
   await tx.query('DELETE FROM assignments WHERE subject=$1 AND customer_id=$2 AND app_id=$3',[subject,c.customerId,c.appId]);
   await tx.query(`INSERT INTO app_access_revocations(customer_id,app_id,subject,revoked_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(customer_id,app_id,subject) DO UPDATE SET revoked_at=now(),revoked_by=$4`,[c.customerId,c.appId,subject,c.subject]);
   await audit(tx,c.subject,'team.user.revoke',subject,{localUserId:target.localUserId,appId:c.appId,identityPreserved:true,membershipPreserved:true});
   return {revoked:true,subject,localUserId:target.localUserId,identityPreserved:true,membershipPreserved:true,otherApplicationsPreserved:true};
  });
 }
 @Post('users/:subject/restore') async restore(@Param('subject') subject:string,@Req() req:RequestContext){
  parse(name,subject);const c=await this.team.context(req),d=await this.team.guard(c,true);
  const target=await this.team.target(c,subject);
  this.team.assertWithin(d,await this.team.userPermissions(c,subject),'L’utente possiede funzioni fuori dalla propria delega');
  if(!(await this.db.query('SELECT 1 FROM assignments WHERE subject=$1 AND customer_id=$2 AND app_id=$3 LIMIT 1',[subject,c.customerId,c.appId])).length)throw new ConflictException('Assegna prima almeno un ruolo dell’applicazione');
  return this.db.transaction(async tx=>{
   await tx.query('DELETE FROM app_access_revocations WHERE customer_id=$1 AND app_id=$2 AND subject=$3',[c.customerId,c.appId,subject]);
   await audit(tx,c.subject,'team.user.restore',subject,{localUserId:target.localUserId,appId:c.appId});
   return {restored:true,subject,localUserId:target.localUserId};
  });
 }
}
