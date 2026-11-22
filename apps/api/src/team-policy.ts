import {Inject,Injectable,ForbiddenException,ConflictException,NotFoundException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {Database} from './database.js';
import {Authorization} from './authorization.js';
import {RequestContext} from './auth.js';
type FunctionRef={key:string;name:string};
export type TeamContext={installationId:string;customerId:string;appId:string;subject:string;principal:RequestContext['principal']};
export type TeamDelegation={licensed:FunctionRef[];delegated:FunctionRef[];allowed:Set<string>};

@Injectable()
export class TeamPolicy {
 constructor(@Inject(Database) private readonly db:Pick<Database,'query'>,private readonly policy:Authorization){}
 within(tx:PoolClient){
  const db:Pick<Database,'query'>={query:async(sql,params=[])=> (await tx.query(sql,params)).rows};
  return new TeamPolicy(db,new Authorization(db));
 }
 // Cliente e applicazione derivano sempre dall’installazione autenticata, mai dal corpo della richiesta.
 async context(req:RequestContext):Promise<TeamContext>{
  const p=req.principal;
  if(!p.installationId)throw new ForbiddenException('Installazione richiesta');
  if(!p.subject)throw new ForbiddenException('Identità personale richiesta');
  const [i]=await this.db.query('SELECT id,customer_id,app_id FROM installations WHERE id=$1 AND enabled=true',[p.installationId]);
  if(!i)throw new ForbiddenException('Installazione non attiva');
  const access=await this.policy.access(p,p.installationId);
  if(!access.canLogin)throw new ForbiddenException('Accesso all’applicazione non consentito: '+access.reason);
  return {installationId:i.id,customerId:i.customer_id,appId:i.app_id,subject:p.subject,principal:p};
 }
 async licensed(c:TeamContext){
  return await this.db.query(`SELECT p.key,p.name FROM permissions p
   JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key AND f.active=true
   JOIN entitlements e ON e.customer_id=$1 AND e.app_id=p.app_id AND e.feature_key=p.feature_key AND e.purchased=true AND e.enabled=true
   WHERE p.app_id=$2 AND p.active=true ORDER BY p.name,p.key`,[c.customerId,c.appId]) as FunctionRef[];
 }
 async delegation(c:TeamContext){
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
 async guard(c:TeamContext,write=false):Promise<TeamDelegation>{
  // This policy also runs on a single transactional PostgreSQL connection.
  const licensed=await this.licensed(c),delegated=await this.delegation(c);
  const declared=await this.db.query("SELECT 1 FROM permissions p JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key WHERE p.app_id=$1 AND p.key='team.manage' AND p.active=true AND f.active=true LIMIT 1",[c.appId]);
  const allowed=new Set(delegated.map(f=>f.key));
  const canManage=write?allowed.has('team.manage'):declared.length?allowed.has('team.manage'):allowed.size>0;
  if(!canManage)throw new ForbiddenException(write?'Le modifiche alla squadra richiedono la funzione team.manage':'Amministrazione della squadra non delegata');
  return {licensed,delegated,allowed};
 }
 validatePermissions(d:TeamDelegation,permissions:string[]){
  if(new Set(permissions).size!==permissions.length)throw new ConflictException('Funzioni duplicate');
  const licensed=new Set(d.licensed.map(f=>f.key));
  for(const permission of permissions){
   if(['eulab-admin','eulab-technician'].includes(permission))throw new ForbiddenException('Permesso amministrativo EULab riservato');
   if(!licensed.has(permission))throw new ForbiddenException('Funzione non attiva o non inclusa nella licenza: '+permission);
   if(!d.allowed.has(permission))throw new ForbiddenException('Funzione fuori dalla propria delega: '+permission);
  }
  return permissions;
 }
 async role(c:TeamContext,id:string){
  const [role]=await this.db.query('SELECT id FROM roles WHERE id=$1 AND customer_id=$2 AND app_id=$3',[id,c.customerId,c.appId]);
  if(!role)throw new NotFoundException('Ruolo non disponibile');
  return role;
 }
 // Include anche funzioni non più attive o non licenziate: un ruolo con funzioni fuori
 // dalla delega non deve essere modificabile, eliminabile o assegnabile per approssimazione.
 async rolePermissions(c:TeamContext,id:string){
  return (await this.db.query('SELECT DISTINCT rp.permission_key AS key FROM role_permissions rp WHERE rp.role_id=$1 AND rp.app_id=$2',[id,c.appId])).map((r:any)=>r.key) as string[];
 }
 async userPermissions(c:TeamContext,subject:string){
  return (await this.db.query(`SELECT DISTINCT rp.permission_key AS key FROM assignments a
   JOIN roles r ON r.id=a.role_id AND r.customer_id=a.customer_id AND r.app_id=a.app_id
   JOIN role_permissions rp ON rp.role_id=r.id AND rp.app_id=r.app_id
   WHERE a.subject=$2 AND a.customer_id=$1 AND a.app_id=$3`,[c.customerId,subject,c.appId])).map((r:any)=>r.key) as string[];
 }
 assertWithin(d:TeamDelegation,permissions:string[],message:string){
  const outside=permissions.filter(p=>!d.allowed.has(p));
  if(outside.length)throw new ForbiddenException(message+': '+outside.join(', '));
 }
 async target(c:TeamContext,subject:string){
  const [link]=await this.db.query(`SELECT lk.subject,lk.local_user_id AS "localUserId",u.display_name AS "displayName",u.enabled AS "identityEnabled",COALESCE(m.enabled,false) AS "membershipEnabled"
   FROM local_links lk JOIN installations i ON i.id=lk.installation_id JOIN identities u ON u.subject=lk.subject
   LEFT JOIN memberships m ON m.subject=u.subject AND m.customer_id=i.customer_id
   WHERE lk.installation_id=$1 AND lk.subject=$2`,[c.installationId,subject]);
  if(!link)throw new NotFoundException('Utente non collegato all’installazione');
  if(!link.identityEnabled)throw new ConflictException('Identità globale disabilitata');
  if(!link.membershipEnabled)throw new ConflictException('Appartenenza al cliente disabilitata');
  return link;
 }
}
