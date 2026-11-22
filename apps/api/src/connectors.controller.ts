import {introspect} from './oidc.js';
import {ApiInput} from './openapi.js';
import {connectorAuthorizeSchema,connectorRedeemSchema,connectorTicketSchema,connectorTechnicalRedeemSchema,connectorAccessAsSchema} from './schemas.js';
import { Body, Controller, Get, Post, Param, Query, Req, GoneException, ForbiddenException, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Admin, Public, RequestContext } from './auth.js';
import {CatalogService} from './catalog.service.js';
import { Database, audit } from './database.js';
import { Authorization } from './authorization.js';
import { parse, uuid, name, origin, catalogSchema } from './validation.js';
import { hash, secret, seal, unseal } from './security.js';
/**
 * Utente locale selezionabile dall'admin EULab per un'installazione non WordPress.
 * Deve esistere un collegamento esplicito, l'identità e l'appartenenza al cliente
 * devono essere attive e l'accesso all'app non deve essere revocato.
 */
const accessUserSql=`SELECT lk.local_user_id,lk.subject,u.display_name
 FROM local_links lk
 JOIN installations i ON i.id=lk.installation_id
 JOIN identities u ON u.subject=lk.subject
 JOIN memberships m ON m.subject=u.subject AND m.customer_id=i.customer_id AND m.enabled=true
 WHERE lk.installation_id=$1 AND lk.local_user_id=$2 AND u.enabled=true
  AND NOT EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=u.subject)`;
@Controller('v1') @ApiTags('Connettori e autorizzazioni') @ApiBearerAuth()
export class ConnectorsController {
 constructor(private readonly db:Database,private readonly policy:Authorization,private readonly catalogs:CatalogService) {}
 @Get('installations/:id/access-users') @Admin() async accessUsers(@Param('id') id:string,@Query() query:unknown){
  parse(uuid,id);
  const q=parse(z.object({search:z.string().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict(),query);
  const [installation]=await this.db.query<any>(`SELECT i.id,i.domain,i.base_path,i.integration,i.customer_id,i.app_id,c.name AS customer_name,a.name AS app_name FROM installations i JOIN customers c ON c.id=i.customer_id JOIN applications a ON a.id=i.app_id WHERE i.id=$1`,[id]);
  if(!installation)throw new NotFoundException('Installazione non trovata');
  if(installation.integration==='wordpress')throw new BadRequestException('Per WordPress usa l’elenco utenti del sito');
  const args=[id,q.search];
  const where=`lk.installation_id=$1 AND ($2='' OR position(lower($2) in lower(lk.local_user_id||' '||u.display_name||' '||coalesce(alu.email,'')))>0)`;
  const from=`FROM local_links lk
   JOIN installations i ON i.id=lk.installation_id
   JOIN identities u ON u.subject=lk.subject
   JOIN memberships m ON m.subject=u.subject AND m.customer_id=i.customer_id AND m.enabled=true
   LEFT JOIN LATERAL (SELECT alu.email FROM app_local_users alu WHERE alu.installation_id=lk.installation_id AND alu.local_user_id=lk.local_user_id ORDER BY alu.updated_at DESC LIMIT 1) alu ON true
   WHERE ${where}
    AND u.enabled=true
    AND NOT EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=u.subject)`;
  const [items,count]=await Promise.all([
   this.db.query(`SELECT lk.local_user_id AS "localUserId",lk.subject,u.display_name AS "displayName",alu.email,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name) ORDER BY r.name) FROM assignments a JOIN roles r ON r.id=a.role_id WHERE a.subject=lk.subject AND a.customer_id=i.customer_id AND a.app_id=i.app_id),'[]'::jsonb) AS roles
    ${from} ORDER BY lower(u.display_name),lk.local_user_id LIMIT 20 OFFSET $3`,[...args,(q.page-1)*20]),
   this.db.query(`SELECT count(*)::int AS total ${from}`,args)
  ]);
  return {installation:{id:installation.id,domain:installation.domain,basePath:installation.base_path,integration:installation.integration,customerId:installation.customer_id,customerName:installation.customer_name,appId:installation.app_id,appName:installation.app_name},items,total:count[0].total,page:q.page,pageSize:20};
 }
 @Post('catalogs') @ApiInput(catalogSchema) async publishCatalog(@Body() body:unknown,@Req() req:RequestContext) {
  throw new GoneException('L’app deve esporre le funzioni con GET e registrare il loro URL in /v1/catalog-source');
 }
 @Get('catalogs') async catalog(@Req() req:RequestContext){
  if(!req.principal.installationId)throw new ForbiddenException('Installazione richiesta');
  return this.db.query('SELECT c.version,c.document FROM catalogs c JOIN installations i ON i.app_id=c.app_id JOIN applications a ON a.id=c.app_id WHERE i.id=$1 AND c.version=a.catalog_version',[req.principal.installationId]);
 }
 @Get('context') async context(@Req() req:RequestContext) {
   const p=req.principal;
   if(!p.installationId)return {subject:p.subject,admin:p.admin,technician:p.technician};
   const [i]=await this.db.query('SELECT id,customer_id,app_id,domain,description,integration,base_path,fallback_url FROM installations WHERE id=$1',[p.installationId]);
   return {...i,admin:p.admin,technician:p.technician,...await this.policy.access(p,p.installationId)};
 }
 @Post('authorize') @ApiInput(connectorAuthorizeSchema) async authorize(@Body() body:unknown,@Req() req:RequestContext) {
   const b=parse(connectorAuthorizeSchema,body);return this.policy.check(req.principal,b.installationId,b.permission);
 }
 @Post('pairing/redeem') @Public() @ApiInput(connectorRedeemSchema) async redeem(@Body() body:unknown) {
   const b=parse(connectorRedeemSchema,body),credential=secret();
   return this.db.transaction(async db=>{
     const code=(await db.query('SELECT c.* FROM pairing_codes c JOIN installations i ON i.id=c.installation_id WHERE c.hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() AND i.domain=$2 AND i.enabled=true FOR UPDATE OF c',[hash(b.code),b.domain])).rows[0];
     if(!code)throw new UnauthorizedException('Codice scaduto, usato o dominio non autorizzato');
     await db.query('UPDATE pairing_codes SET consumed_at=now() WHERE hash=$1',[hash(b.code)]);
     await db.query('UPDATE installations SET secret_hash=$2,secret_cipher=$3 WHERE id=$1',[code.installation_id,hash(credential),seal(credential)]);
     await audit(db,'pairing','pairing.redeem',code.installation_id,{domain:b.domain});const installation=(await db.query('SELECT app_id FROM installations WHERE id=$1',[code.installation_id])).rows[0];return {installationId:code.installation_id,appId:installation.app_id,secret:credential};
   });
 }
 @Post('technical/tickets') @ApiInput(connectorTicketSchema) async ticket(@Body() body:unknown,@Req() req:RequestContext) {
   if(!req.principal.technician)throw new ForbiddenException();
   const b=parse(connectorTicketSchema,body),ticket=secret();
   return this.db.transaction(async db=>{
     const i=(await db.query('SELECT domain,base_path,integration FROM installations WHERE id=$1 AND enabled=true AND NOT EXISTS(SELECT 1 FROM wordpress_guardians g WHERE g.installation_id=installations.id AND g.enabled=false) FOR UPDATE',[b.installationId])).rows[0];if(!i)throw new ForbiddenException();
     let selected:any;
     if(i.integration==='wordpress'){
       if(!req.principal.admin||!b.localUserId)throw new ForbiddenException('Seleziona un utente WordPress dall’elenco admin');
       selected=(await db.query('SELECT u.local_user_id,u.username FROM wordpress_users u JOIN wordpress_directories d ON d.installation_id=u.installation_id AND d.active_generation=u.generation WHERE u.installation_id=$1 AND u.local_user_id=$2',[b.installationId,b.localUserId])).rows[0];
       if(!selected)throw new ForbiddenException('Utente non presente nell’elenco del sito: aggiorna la sincronizzazione');
     }else if(b.localUserId){if(!req.principal.admin)throw new ForbiddenException('Seleziona il profilo locale come Admin EULab');selected=(await db.query(accessUserSql,[b.installationId,b.localUserId])).rows[0];if(!selected)throw new ForbiddenException('Profilo non collegato all’installazione o accesso revocato');}
     await db.query("INSERT INTO technical_tickets(hash,installation_id,subject,authorization_cipher,expires_at,consumed_at,local_user_id) VALUES($1,$2,$3,$4,now()+interval '60 seconds',null,$5)",[hash(ticket),b.installationId,req.principal.subject,seal(req.principal.accessToken!),selected?.local_user_id||null]);
     await audit(db,req.principal.subject!,'technical.ticket.issue',b.installationId,selected?{localUserId:selected.local_user_id,localUsername:selected.username||selected.display_name}:{});
     return {ticket,domain:i.domain,technicalUrl:`${i.domain}${i.base_path}${i.integration==='wordpress'?'/?eulab_technical=1':`/eulab/connect/technical?installation=${encodeURIComponent(b.installationId)}`}`,expiresIn:60,localUserId:selected?.local_user_id||null};
   });
 }
 @Post('technical/redeem') @ApiInput(connectorTechnicalRedeemSchema) async technicalRedeem(@Body() body:unknown,@Req() req:RequestContext) {
   const p=req.principal;if(!p.server||!p.installationId)throw new ForbiddenException();
   const b=parse(connectorTechnicalRedeemSchema,body);
   return this.db.transaction(async db=>{
     const t=(await db.query('UPDATE technical_tickets SET consumed_at=now() WHERE hash=$1 AND installation_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING subject,authorization_cipher,local_user_id',[hash(b.ticket),p.installationId])).rows[0];if(!t)throw new UnauthorizedException('Ticket non valido');
     const current=await introspect(unseal(t.authorization_cipher));
     const i=(await db.query('SELECT integration FROM installations WHERE id=$1 AND enabled=true',[p.installationId])).rows[0];
     if(!i||!current.active||current.sub!==t.subject||!current.realm_access?.roles?.some(r=>i.integration==='wordpress'?r==='eulab-admin':['eulab-admin','eulab-technician'].includes(r)))throw new UnauthorizedException('Accesso revocato');
     if(i.integration==='wordpress'&&!t.local_user_id)throw new UnauthorizedException('Ticket WordPress privo di utente selezionato');
     if(i.integration!=='wordpress'&&t.local_user_id&&!current.realm_access?.roles?.includes('eulab-admin'))throw new UnauthorizedException('Solo un Admin EULab può accedere come profilo locale');
     const selected=i.integration!=='wordpress'&&t.local_user_id?(await db.query(accessUserSql,[p.installationId,t.local_user_id])).rows[0]:null;
     if(i.integration!=='wordpress'&&t.local_user_id&&!selected)throw new UnauthorizedException('Profilo non più autorizzato');
     await audit(db,t.subject,'technical.login',p.installationId!,{localUserId:t.local_user_id});
     return {subject:t.subject,scope:i.integration==='wordpress'?'eulab-wordpress-user':t.local_user_id?'eulab-access-as':'eulab-technical',installationId:p.installationId,localUserId:t.local_user_id,localSubject:selected?.subject||null,accessToken:unseal(t.authorization_cipher)};
   });
 }
 @Post('technical/access-as') @Admin() @ApiInput(connectorAccessAsSchema) async accessAs(@Body() body:unknown,@Req() req:RequestContext) {
   const p=req.principal;if(!p.server||!p.installationId)throw new ForbiddenException('Richiesta server WordPress necessaria');
   const b=parse(connectorAccessAsSchema,body);
   return this.db.transaction(async db=>{
     const i=(await db.query("SELECT id FROM installations WHERE id=$1 AND enabled=true AND integration='wordpress'",[p.installationId])).rows[0];
     if(!i)throw new ForbiddenException('Installazione WordPress non disponibile');
     const selected=(await db.query('SELECT u.local_user_id FROM wordpress_users u JOIN wordpress_directories d ON d.installation_id=u.installation_id AND d.active_generation=u.generation WHERE u.installation_id=$1 AND u.local_user_id=$2 AND u.username=$3',[p.installationId,b.localUserId,b.localUsername])).rows[0];if(!selected)throw new ForbiddenException('Utente estraneo all’elenco del sito: sincronizza gli utenti');
     await audit(db,p.subject!,'technical.access_as',p.installationId!,{localUserId:b.localUserId,localUsername:b.localUsername});
     return {subject:p.subject,installationId:p.installationId,localUserId:b.localUserId,scope:'eulab-access-as'};
   });
 }
}
