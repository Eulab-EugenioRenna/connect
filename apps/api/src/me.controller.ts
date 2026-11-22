import {Controller,ForbiddenException,Get,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiTags} from '@nestjs/swagger';
import {RequestContext} from './auth.js';
import {Database} from './database.js';
import {IdentitiesService} from './identities.service.js';

/** Why an application is not usable yet; `ready` and `first_access` can be opened. */
export type PortalAppState='ready'|'first_access';

export interface PortalApplication {installationId:string;appId:string;appName:string;description:string;customerId:string;customerName:string;url:string;state:PortalAppState}

/**
 * Personal portal: who I am and which applications I can open. Same rules as
 * the access decision of an installation (identity, membership, revocation,
 * active licence), evaluated for every installation of the person's companies.
 */
@Controller('v1/me') @ApiTags('Profilo personale') @ApiBearerAuth()
export class MeController {
 constructor(private readonly db:Database,private readonly identities:IdentitiesService){}

 @Get() async me(@Req() req:RequestContext){
  const p=req.principal;
  if(!p.subject||p.server||p.installationId)throw new ForbiddenException('Identità personale richiesta');
  const [identity]=await this.db.query('SELECT display_name,enabled FROM identities WHERE subject=$1',[p.subject]);
  let account:any={};
  // Name and email come from the identity provider; the portal still works if it is slow.
  try{account=(await this.identities.request('/users/'+encodeURIComponent(p.subject))).body||{};}catch{account={};}
  return {
   subject:p.subject,
   admin:p.admin,
   displayName:identity?.display_name||[account.firstName,account.lastName].filter(Boolean).join(' ')||account.username||'',
   firstName:account.firstName||'',lastName:account.lastName||'',email:account.email||'',emailVerified:!!account.emailVerified,
   enabled:identity?.enabled!==false,
   applications:identity?.enabled===false?[]:await this.applications(p.subject),
  };
 }

 private async applications(subject:string):Promise<PortalApplication[]>{
  const rows=await this.db.query(`SELECT i.id,i.app_id,a.name AS app_name,a.description,i.customer_id,c.name AS customer_name,i.domain,i.base_path,
    (lk.local_user_id IS NOT NULL) AS linked
   FROM memberships m
   JOIN installations i ON i.customer_id=m.customer_id AND i.enabled=true
   JOIN applications a ON a.id=i.app_id
   JOIN customers c ON c.id=i.customer_id
   JOIN licenses l ON l.customer_id=i.customer_id AND l.app_id=i.app_id AND l.state='active' AND (l.expires_at IS NULL OR l.expires_at>now())
   LEFT JOIN local_links lk ON lk.installation_id=i.id AND lk.subject=m.subject
   WHERE m.subject=$1 AND m.enabled=true
     AND NOT EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=m.subject)
     AND (lk.local_user_id IS NOT NULL OR EXISTS(SELECT 1 FROM assignments x WHERE x.subject=m.subject AND x.customer_id=i.customer_id AND x.app_id=i.app_id))
   ORDER BY a.name,c.name,i.domain`,[subject]);
  return rows.map((r:any)=>({installationId:r.id,appId:r.app_id,appName:r.app_name,description:r.description||'',customerId:r.customer_id,customerName:r.customer_name,
   url:entryUrl(r.domain,r.base_path),state:r.linked?'ready':'first_access'}));
 }
}

/** Installation domains are stored with their scheme; only http(s) links are offered. */
export function entryUrl(domain:string,basePath:string){
 try{
  const url=new URL(/^https?:\/\//.test(domain)?domain:'https://'+domain);
  if(!['http:','https:'].includes(url.protocol))return '';
  url.pathname=(basePath||'/').startsWith('/')?(basePath||'/'):'/'+basePath;url.search='';url.hash='';
  return url.href;
 }catch{return '';}
}
