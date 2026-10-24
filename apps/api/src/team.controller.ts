import {Body,ConflictException,Controller,Delete,ForbiddenException,Get,NotFoundException,Param,Post,Put,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {Authorization} from './authorization.js';
import {ApiInput} from './openapi.js';
import {parse,name,key,uuid} from './validation.js';

const roleSchema=z.object({name:z.string().trim().min(1).max(200),permissions:z.array(key).max(1000)}).strict();
const assignmentSchema=z.object({roleIds:z.array(uuid).max(50)}).strict();

type Role={id:string;name:string;permissions:string[]};
type FunctionRef={key:string;name:string};
type Context={installationId:string;customerId:string;appId:string;subject:string;principal:RequestContext['principal']};
type Delegation={licensed:FunctionRef[];delegated:FunctionRef[];allowed:Set<string>};

@Controller('v1/team') @ApiTags('Squadra dell’installazione') @ApiBearerAuth()
export class TeamController {
 constructor(private readonly db:Database,private readonly policy:Authorization){}
 // Cliente e applicazione derivano sempre dall’installazione autenticata, mai dal corpo della richiesta.
 private async context(req:RequestContext):Promise<Context>{
  const p=req.principal;
  if(!p.installationId)throw new ForbiddenException('Installazione richiesta');
  if(!p.subject)throw new ForbiddenException('Identità personale richiesta');
  const [i]=await this.db.query('SELECT id,customer_id,app_id FROM installations WHERE id=$1 AND enabled=true',[p.installationId]);
  if(!i)throw new ForbiddenException('Installazione non attiva');
  const access=await this.policy.access(p,p.installationId);
  if(!access.canLogin)throw new ForbiddenException('Accesso all’applicazione non consentito: '+access.reason);
  return {installationId:i.id,customerId:i.customer_id,appId:i.app_id,subject:p.subject,principal:p};
 }
 private async licensed(c:Context){
  return await this.db.query(`SELECT p.key,p.name FROM permissions p
   JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key AND f.active=true
   JOIN entitlements e ON e.customer_id=$1 AND e.app_id=p.app_id AND e.feature_key=p.feature_key AND e.purchased=true AND e.enabled=true
   WHERE p.app_id=$2 AND p.active=true ORDER BY p.name,p.key`,[c.customerId,c.appId]) as FunctionRef[];
 }
 private async delegation(c:Context){
  return await this.db.query(`SELECT DISTINCT p.key,p.name FROM permissions p
   JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key AND f.active=true
   JOIN entitlements e ON e.customer_id=$1 AND e.app_id=p.app_id AND e.feature_key=p.feature_key AND e.purchased=true AND e.enabled=true
   JOIN assignments a ON a.subject=$3 AND a.customer_id=$1 AND a.app_id=p.app_id
   JOIN roles r ON r.id=a.role_id AND r.customer_id=a.customer_id AND r.app_id=a.app_id
   JOIN role_permissions rp ON rp.role_id=r.id AND rp.app_id=p.app_id AND rp.permission_key=p.key
   WHERE p.app_id=$2 AND p.active=true ORDER BY p.name,p.key`,[c.customerId,c.appId,c.subject]) as FunctionRef[];
 }
 // Se l’app dichiara team.manage, solo chi lo possiede può leggere la squadra.
 // Le modifiche richiedono sempre team.manage: senza la funzione dichiarata l’app resta in sola lettura.
 private async guard(c:Context,write=false):Promise<Delegation>{
  const [licensed,delegated,declared]=await Promise.all([
   this.licensed(c),
   this.delegation(c),
   this.db.query("SELECT 1 FROM permissions p JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key WHERE p.app_id=$1 AND p.key='team.manage' AND p.active=true AND f.active=true LIMIT 1",[c.appId])
  ]);
  const allowed=new Set(delegated.map(f=>f.key));
  const canManage=write?allowed.has('team.manage'):declared.length?allowed.has('team.manage'):allowed.size>0;
  if(!canManage)throw new ForbiddenException(write?'Le modifiche alla squadra richiedono la funzione team.manage':'Amministrazione della squadra non delegata');
  return {licensed,delegated,allowed};
 }
 private validatePermissions(d:Delegation,permissions:string[]){
  if(new Set(permissions).size!==permissions.length)throw new ConflictException('Funzioni duplicate');
  const licensed=new Set(d.licensed.map(f=>f.key));
  for(const permission of permissions){
   if(['eulab-admin','eulab-technician'].includes(permission))throw new ForbiddenException('Permesso amministrativo EULab riservato');
   if(!licensed.has(permission))throw new ForbiddenException('Funzione non attiva o non inclusa nella licenza: '+permission);
   if(!d.allowed.has(permission))throw new ForbiddenException('Funzione fuori dalla propria delega: '+permission);
  }
  return permissions;
 }
 private async role(c:Context,id:string){
  const [role]=await this.db.query('SELECT id FROM roles WHERE id=$1 AND customer_id=$2 AND app_id=$3',[id,c.customerId,c.appId]);
  if(!role)throw new NotFoundException('Ruolo non disponibile');
  return role;
 }
 // Include anche funzioni non più attive o non licenziate: un ruolo con funzioni fuori
 // dalla delega non deve essere modificabile, eliminabile o assegnabile per approssimazione.
 private async rolePermissions(c:Context,id:string){
  return (await this.db.query('SELECT DISTINCT rp.permission_key AS key FROM role_permissions rp WHERE rp.role_id=$1 AND rp.app_id=$2',[id,c.appId])).map((r:any)=>r.key) as string[];
 }
 private async userPermissions(c:Context,subject:string){
  return (await this.db.query(`SELECT DISTINCT p.key FROM assignments a
   JOIN roles r ON r.id=a.role_id AND r.customer_id=a.customer_id AND r.app_id=a.app_id
   JOIN role_permissions rp ON rp.role_id=r.id AND rp.app_id=r.app_id
   JOIN permissions p ON p.app_id=rp.app_id AND p.key=rp.permission_key AND p.active=true
   JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key AND f.active=true
   JOIN entitlements e ON e.customer_id=$1 AND e.app_id=p.app_id AND e.feature_key=p.feature_key AND e.purchased=true AND e.enabled=true
   WHERE a.subject=$2 AND a.customer_id=$1 AND a.app_id=$3`,[c.customerId,subject,c.appId])).map((r:any)=>r.key) as string[];
 }
 private assertWithin(d:Delegation,permissions:string[],message:string){
  const outside=permissions.filter(p=>!d.allowed.has(p));
  if(outside.length)throw new ForbiddenException(message+': '+outside.join(', '));
 }
 private async target(c:Context,subject:string){
  const [link]=await this.db.query(`SELECT lk.subject,lk.local_user_id AS "localUserId",u.display_name AS "displayName",u.enabled AS "identityEnabled",COALESCE(m.enabled,false) AS "membershipEnabled"
   FROM local_links lk JOIN installations i ON i.id=lk.installation_id JOIN identities u ON u.subject=lk.subject
   LEFT JOIN memberships m ON m.subject=u.subject AND m.customer_id=i.customer_id
   WHERE lk.installation_id=$1 AND lk.subject=$2`,[c.installationId,subject]);
  if(!link)throw new NotFoundException('Utente non collegato all’installazione');
  if(!link.identityEnabled)throw new ConflictException('Identità globale disabilitata');
  if(!link.membershipEnabled)throw new ConflictException('Appartenenza al cliente disabilitata');
  return link;
 }
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
  const c=await this.context(req),d=await this.guard(c);
  const [users,roles]=await Promise.all([this.users(c),this.roles(c)]);
  return {installationId:c.installationId,customerId:c.customerId,appId:c.appId,canManage:d.allowed.has('team.manage'),functions:this.functions(d),delegation:d.delegated,roles,users};
 }
 @Get('users') async usersList(@Req() req:RequestContext){const c=await this.context(req);await this.guard(c);return this.users(c);}
 @Get('roles') async rolesList(@Req() req:RequestContext){const c=await this.context(req);await this.guard(c);return this.roles(c);}
 @Get('functions') async functionsList(@Req() req:RequestContext){const c=await this.context(req);const d=await this.guard(c);return this.functions(d);}
 @Post('roles') @ApiInput(roleSchema) async createRole(@Body() body:unknown,@Req() req:RequestContext){
  const c=await this.context(req),d=await this.guard(c,true),b=parse(roleSchema,body),permissions=this.validatePermissions(d,b.permissions),id=randomUUID();
  return this.db.transaction(async tx=>{
   await tx.query('INSERT INTO roles VALUES($1,$2,$3,$4)',[id,c.customerId,c.appId,b.name]);
   for(const permission of permissions)await tx.query('INSERT INTO role_permissions VALUES($1,$2,$3)',[id,c.appId,permission]);
   await audit(tx,c.subject,'team.role.create',id,{name:b.name,permissions});
   return {id,name:b.name,permissions};
  });
 }
 @Put('roles/:id') @ApiInput(roleSchema) async updateRole(@Param('id') id:string,@Body() body:unknown,@Req() req:RequestContext){
  parse(uuid,id);const c=await this.context(req),d=await this.guard(c,true),b=parse(roleSchema,body);
  await this.role(c,id);
  // Un ruolo che contiene già funzioni fuori dalla delega del chiamante non è modificabile.
  this.assertWithin(d,await this.rolePermissions(c,id),'Il ruolo contiene funzioni fuori dalla propria delega');
  const permissions=this.validatePermissions(d,b.permissions);
  return this.db.transaction(async tx=>{
   await tx.query('UPDATE roles SET name=$2 WHERE id=$1',[id,b.name]);
   await tx.query('DELETE FROM role_permissions WHERE role_id=$1',[id]);
   for(const permission of permissions)await tx.query('INSERT INTO role_permissions VALUES($1,$2,$3)',[id,c.appId,permission]);
   await audit(tx,c.subject,'team.role.update',id,{name:b.name,permissions});
   return {id,name:b.name,permissions};
  });
 }
 @Delete('roles/:id') async deleteRole(@Param('id') id:string,@Req() req:RequestContext){
  parse(uuid,id);const c=await this.context(req),d=await this.guard(c,true);
  await this.role(c,id);this.assertWithin(d,await this.rolePermissions(c,id),'Il ruolo contiene funzioni fuori dalla propria delega');
  return this.db.transaction(async tx=>{
   await tx.query('DELETE FROM assignments WHERE role_id=$1',[id]);
   await tx.query('DELETE FROM roles WHERE id=$1',[id]);
   await audit(tx,c.subject,'team.role.delete',id);
   return {removed:true};
  });
 }
 @Put('users/:subject/roles') @ApiInput(assignmentSchema) async setRoles(@Param('subject') subject:string,@Body() body:unknown,@Req() req:RequestContext){
  parse(name,subject);const c=await this.context(req),d=await this.guard(c,true),b=parse(assignmentSchema,body);
  const target=await this.target(c,subject);
  // Non si possono sostituire i ruoli di un utente con funzioni più ampie della propria delega.
  this.assertWithin(d,await this.userPermissions(c,subject),'L’utente possiede funzioni fuori dalla propria delega');
  if(new Set(b.roleIds).size!==b.roleIds.length)throw new ConflictException('Ruoli duplicati');
  for(const roleId of b.roleIds){
   await this.role(c,roleId);
   this.assertWithin(d,await this.rolePermissions(c,roleId),'Il ruolo contiene funzioni fuori dalla propria delega');
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
  parse(name,subject);const c=await this.context(req),d=await this.guard(c,true);
  const target=await this.target(c,subject);
  // Non si possono revocare utenti con funzioni più ampie della propria delega.
  this.assertWithin(d,await this.userPermissions(c,subject),'L’utente possiede funzioni fuori dalla propria delega');
  return this.db.transaction(async tx=>{
   await tx.query('DELETE FROM assignments WHERE subject=$1 AND customer_id=$2 AND app_id=$3',[subject,c.customerId,c.appId]);
   await tx.query(`INSERT INTO app_access_revocations(customer_id,app_id,subject,revoked_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(customer_id,app_id,subject) DO UPDATE SET revoked_at=now(),revoked_by=$4`,[c.customerId,c.appId,subject,c.subject]);
   await audit(tx,c.subject,'team.user.revoke',subject,{localUserId:target.localUserId,appId:c.appId,identityPreserved:true,membershipPreserved:true});
   return {revoked:true,subject,localUserId:target.localUserId,identityPreserved:true,membershipPreserved:true,otherApplicationsPreserved:true};
  });
 }
 @Post('users/:subject/restore') async restore(@Param('subject') subject:string,@Req() req:RequestContext){
  parse(name,subject);const c=await this.context(req),d=await this.guard(c,true);
  const target=await this.target(c,subject);
  this.assertWithin(d,await this.userPermissions(c,subject),'L’utente possiede funzioni fuori dalla propria delega');
  if(!(await this.db.query('SELECT 1 FROM assignments WHERE subject=$1 AND customer_id=$2 AND app_id=$3 LIMIT 1',[subject,c.customerId,c.appId])).length)throw new ConflictException('Assegna prima almeno un ruolo dell’applicazione');
  return this.db.transaction(async tx=>{
   await tx.query('DELETE FROM app_access_revocations WHERE customer_id=$1 AND app_id=$2 AND subject=$3',[c.customerId,c.appId,subject]);
   await audit(tx,c.subject,'team.user.restore',subject,{localUserId:target.localUserId,appId:c.appId});
   return {restored:true,subject,localUserId:target.localUserId};
  });
 }
}
