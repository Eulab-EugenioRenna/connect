import {introspect} from './oidc.js';
import {ApiInput} from './openapi.js';
import {connectorAuthorizeSchema,connectorRedeemSchema,connectorTicketSchema,connectorTechnicalRedeemSchema,connectorAccessAsSchema} from './schemas.js';
import { Body, Controller, Get, Post, Req, GoneException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Admin, Public, RequestContext } from './auth.js';
import {CatalogService} from './catalog.service.js';
import { Database, audit } from './database.js';
import { Authorization } from './authorization.js';
import { parse, uuid, name, origin, catalogSchema } from './validation.js';
import { hash, secret, seal, unseal } from './security.js';
@Controller('v1') @ApiTags('Connettori e autorizzazioni') @ApiBearerAuth()
export class ConnectorsController {
 constructor(private readonly db:Database,private readonly policy:Authorization,private readonly catalogs:CatalogService) {}
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
     }else if(b.localUserId)throw new ForbiddenException('Selezione utente disponibile solo per WordPress');
     await db.query("INSERT INTO technical_tickets(hash,installation_id,subject,authorization_cipher,expires_at,consumed_at,local_user_id) VALUES($1,$2,$3,$4,now()+interval '60 seconds',null,$5)",[hash(ticket),b.installationId,req.principal.subject,seal(req.principal.accessToken!),selected?.local_user_id||null]);
     await audit(db,req.principal.subject!,'technical.ticket.issue',b.installationId,selected?{localUserId:selected.local_user_id,localUsername:selected.username}:{});
     return {ticket,domain:i.domain,technicalUrl:`${i.domain}${i.base_path}${i.integration==='wordpress'?'/?eulab_technical=1':'/eulab/connect/technical'}`,expiresIn:60,localUserId:selected?.local_user_id};
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
     await audit(db,t.subject,'technical.login',p.installationId!,{localUserId:t.local_user_id});
     return {subject:t.subject,scope:i.integration==='wordpress'?'eulab-wordpress-user':'eulab-technical',installationId:p.installationId,localUserId:t.local_user_id,accessToken:unseal(t.authorization_cipher)};
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
