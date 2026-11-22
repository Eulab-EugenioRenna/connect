import {Body,Controller,Post,Req,ForbiddenException,ConflictException,ServiceUnavailableException,BadRequestException,HttpException} from '@nestjs/common';
import {ApiInput} from './openapi.js';
import {z} from 'zod';
import {createHmac} from 'node:crypto';
import {RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {IdentitiesService} from './identities.service.js';
import {parse,name,key,uuid} from './validation.js';
import {required} from './config.js';
import {TeamPolicy} from './team-policy.js';
import {localId,sourceId} from './onboarding.schemas.js';

export const mirrorUserSchema=z.object({
 localUserId:name,
 username:z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/).refine(v=>!v.startsWith('service-account-'),'Username riservato'),
 email:z.string().email().max(250),
 displayName:name,
 // Solo il backend dell’installazione può usarla, esclusivamente per inizializzare una nuova identità.
 initialPassword:z.string().min(1).max(512).optional(),
 initialPasswordTemporary:z.boolean().optional(),
 application:z.object({sourceId,localTenantId:localId,firstName:z.string().trim().min(1).max(80),lastName:z.string().trim().min(1).max(80),
  role:z.enum(['manager','reception','collaborator']),permissions:z.array(key).max(500),roleIds:z.array(uuid).min(1).max(50)}).strict().optional()
}).strict();

@Controller('v1/users')
export class UserMirrorsController {
 constructor(private readonly db:Database,private readonly identities:IdentitiesService,private readonly team:TeamPolicy){}
 @Post('mirror') @ApiInput(mirrorUserSchema) async mirror(@Body() body:unknown,@Req() req:RequestContext){
  const p=req.principal;
  if(!p.server||!p.installationId)throw new ForbiddenException('La copia dell’utente deve essere richiesta dal backend dell’app');
  const b=parse(mirrorUserSchema,body),installationId=p.installationId;
  if(b.application)return this.applicationMirror(b,req);
  return this.db.transaction(async tx=>{
   const site=(await tx.query('SELECT * FROM installations WHERE id=$1 AND enabled=true FOR UPDATE',[installationId])).rows[0];if(!site)throw new ForbiddenException('Installazione non attiva');
   const existing=(await tx.query('SELECT subject FROM local_links WHERE installation_id=$1 AND local_user_id=$2',[installationId,b.localUserId])).rows[0];
   // An explicit existing association is authoritative, including manual links and revocations.
   if(existing)return {installationId,customerId:site.customer_id,localUserId:b.localUserId,subject:existing.subject,created:false,status:'already_linked',ssoSetupRequired:null};
   if(site.integration==='wordpress'&&!(await tx.query('SELECT u.local_user_id FROM wordpress_users u JOIN wordpress_directories d ON d.installation_id=u.installation_id AND d.active_generation=u.generation WHERE u.installation_id=$1 AND u.local_user_id=$2',[installationId,b.localUserId])).rows.length)throw new ConflictException('Seleziona un utente WordPress esistente dall’elenco sincronizzato');
   // The password and its verification never enter Connect tables, audit details, responses or errors.
   await audit(tx,'installation:'+installationId,'identity.mirror.requested',b.localUserId,{username:b.username,passwordInitialized:b.initialPassword!==undefined});
   const {user,created}=await this.mirrorIdentity(b,installationId);
   // Never reset credentials, names, permissions or an existing administrator revocation.
   await tx.query('INSERT INTO identities VALUES($1,$2,true) ON CONFLICT(subject) DO NOTHING',[user.id,[user.firstName,user.lastName].filter(Boolean).join(' ')||user.username]);
   await tx.query('INSERT INTO memberships VALUES($1,$2,true) ON CONFLICT(subject,customer_id) DO NOTHING',[user.id,site.customer_id]);
   await tx.query('INSERT INTO local_links VALUES($1,$2,$3)',[installationId,b.localUserId,user.id]);
   const credentials=(await this.identities.request('/users/'+encodeURIComponent(user.id)+'/credentials')).body as {type:string}[];
   const passwordConfigured=credentials.some(c=>c.type==='password');
   await audit(tx,'installation:'+installationId,'identity.mirror.linked',user.id,{localUserId:b.localUserId,created});
   return {installationId,customerId:site.customer_id,localUserId:b.localUserId,subject:user.id,username:user.username,created,status:created?'created':'recovered',ssoSetupRequired:passwordConfigured?false:!(created&&b.initialPassword!==undefined)};
  });
 }
 private conflict(code:string,message:string):never {throw new ConflictException({code,message});}
 private async applicationMirror(b:z.infer<typeof mirrorUserSchema>,req:RequestContext){
  const a=b.application!,installationId=req.principal.installationId!;
  if(!req.principal.subject||req.principal.admin||req.principal.technician)throw new ForbiddenException({code:'team_operator_required',message:'Richiesta identità personale con delega aziendale'});
  const fingerprint=(appId:string)=>createHmac('sha256',required('DATA_ENCRYPTION_KEY')).update(JSON.stringify([
   installationId,appId,a.sourceId,a.localTenantId,b.localUserId,b.username.toLowerCase(),b.email.toLowerCase(),b.displayName,
   a.firstName,a.lastName,a.role,[...a.permissions].sort(),[...a.roleIds].sort()
  ])).digest('hex');
  return this.db.transaction(async tx=>{
   // Serializes mirrors for this installation, including the legacy WordPress branch.
   const site=(await tx.query('SELECT * FROM installations WHERE id=$1 AND enabled=true FOR UPDATE',[installationId])).rows[0];
   if(!site||site.integration==='wordpress')throw new ForbiddenException({code:'application_installation_required',message:'Installazione applicativa non attiva'});
   const policy=this.team.within(tx),c=await policy.context(req),d=await policy.guard(c,true);
   const [source]=(await tx.query('SELECT * FROM connect_sources WHERE id=$1 FOR SHARE',[a.sourceId])).rows;
   const bindings=(await tx.query('SELECT * FROM source_installation_bindings WHERE source_id=$1 AND installation_id=$2 FOR SHARE',[a.sourceId,installationId])).rows;
   const tenants=(await tx.query('SELECT * FROM source_tenant_bindings WHERE source_id=$1 AND local_tenant_id=$2 FOR SHARE',[a.sourceId,a.localTenantId])).rows;
   if(!source?.enabled||!source.integration_approved||(source.approved_app_id||source.app_id)!==c.appId||bindings.length!==1||!bindings[0].enabled||bindings[0].app_id!==c.appId||tenants.length!==1||tenants[0].customer_id!==c.customerId||tenants[0].app_id!==c.appId)throw new ForbiddenException({code:'application_binding_invalid',message:'Sorgente, installazione o azienda locale non autorizzate'});
   const operators=(await tx.query('SELECT * FROM app_local_users WHERE source_id=$1 AND installation_id=$2 AND subject=$3 FOR SHARE',[a.sourceId,installationId,c.subject])).rows;
   if(operators.length!==1||!operators[0].enabled||operators[0].local_tenant_id!==a.localTenantId||operators[0].app_id!==c.appId)throw new ForbiddenException({code:'operator_binding_invalid',message:'Operatore non collegato alla sorgente e azienda richieste'});
   if(new Set(a.roleIds).size!==a.roleIds.length)this.conflict('mirror_roles_invalid','Ruoli duplicati');
   const granted=new Set<string>();
   for(const id of a.roleIds){
    await tx.query('SELECT id FROM roles WHERE id=$1 FOR SHARE',[id]);
    await policy.role(c,id);
    const permissions=policy.validatePermissions(d,await policy.rolePermissions(c,id));
    for(const permission of permissions)granted.add(permission);
   }
   if(!granted.size)this.conflict('mirror_roles_invalid','I ruoli scelti non concedono funzioni attive');
   policy.validatePermissions(d,a.permissions);
   if(a.permissions.some(p=>!granted.has(p)))throw new ForbiddenException({code:'local_permissions_outside_roles',message:'Permessi locali fuori dai ruoli scelti'});
   const receipt=fingerprint(c.appId);
   const links=(await tx.query('SELECT * FROM local_links WHERE installation_id=$1 AND local_user_id=$2',[installationId,b.localUserId])).rows;
   const mappings=(await tx.query('SELECT * FROM app_local_users WHERE installation_id=$1 AND local_user_id=$2 FOR UPDATE',[installationId,b.localUserId])).rows;
   if(links.length||mappings.length){
    if(links.length!==1||mappings.length!==1)this.conflict('mirror_mapping_conflict','Collegamento incompleto o ambiguo: revisione amministrativa richiesta');
    const m=mappings[0];
    if(m.source_id!==a.sourceId||m.local_tenant_id!==a.localTenantId||m.app_id!==c.appId||m.subject!==links[0].subject||m.mirror_fingerprint!==receipt)this.conflict('mirror_profile_conflict','Profilo o ruoli richiesti diversi dalla creazione originale');
    if(!m.enabled)this.conflict('mirror_mapping_disabled','Mapping applicativo sospeso');
    if(m.email_normalized!==b.email.toLowerCase()||m.first_name!==a.firstName||m.last_name!==a.lastName||m.role!==a.role||JSON.stringify([...m.permissions].sort())!==JSON.stringify([...a.permissions].sort()))this.conflict('mirror_review_required','Profilo modificato dopo la creazione: revisione esplicita richiesta');
    await policy.target(c,m.subject);
    policy.assertWithin(d,await policy.userPermissions(c,m.subject),'Il destinatario possiede funzioni fuori delega');
    const assigned=(await tx.query('SELECT role_id FROM assignments WHERE subject=$1 AND customer_id=$2 AND app_id=$3 ORDER BY role_id',[m.subject,c.customerId,c.appId])).rows.map(r=>r.role_id);
    if(JSON.stringify(assigned)!==JSON.stringify([...a.roleIds].sort()))this.conflict('mirror_review_required','Assegnazioni modificate: la creazione non può riscriverle');
    if((await tx.query('SELECT 1 FROM app_access_revocations WHERE subject=$1 AND customer_id=$2 AND app_id=$3',[m.subject,c.customerId,c.appId])).rows.length)this.conflict('mirror_access_revoked','Accesso revocato: nessuna riattivazione dal mirror');
    const user=await this.identities.user(m.subject);await this.assertProviderIdentity(user);this.assertApplicationProfile(user,b);
    return {installationId,customerId:c.customerId,appId:c.appId,sourceId:a.sourceId,localTenantId:a.localTenantId,localUserId:b.localUserId,subject:m.subject,roleIds:assigned,created:false,status:'already_linked',applicationAccess:true,ssoSetupRequired:await this.setupRequired(user)};
   }
   await audit(tx,c.subject,'identity.mirror.requested',b.localUserId,{sourceId:a.sourceId,installationId,passwordInitialized:b.initialPassword!==undefined});
   const {user,created}=await this.mirrorIdentity(b,installationId,receipt);
   policy.assertWithin(d,await policy.userPermissions(c,user.id),'Il destinatario possiede funzioni fuori delega');
   const occupied=(await tx.query('SELECT 1 FROM local_links WHERE installation_id=$1 AND subject=$2 UNION ALL SELECT 1 FROM app_local_users WHERE installation_id=$1 AND subject=$2',[installationId,user.id])).rows;
   if(occupied.length)this.conflict('mirror_mapping_conflict','Identità già collegata ad altro profilo locale');
   if((await tx.query('SELECT 1 FROM app_access_revocations WHERE subject=$1 AND customer_id=$2 AND app_id=$3',[user.id,c.customerId,c.appId])).rows.length)this.conflict('mirror_access_revoked','Accesso applicativo revocato');
   await tx.query('INSERT INTO identities(subject,display_name,enabled) VALUES($1,$2,true) ON CONFLICT(subject) DO NOTHING',[user.id,b.displayName]);
   await tx.query('INSERT INTO memberships(subject,customer_id,enabled) VALUES($1,$2,true) ON CONFLICT(subject,customer_id) DO NOTHING',[user.id,c.customerId]);
   const identity=(await tx.query('SELECT enabled FROM identities WHERE subject=$1 FOR SHARE',[user.id])).rows[0];
   const membership=(await tx.query('SELECT enabled FROM memberships WHERE subject=$1 AND customer_id=$2 FOR SHARE',[user.id,c.customerId])).rows[0];
   if(!identity?.enabled||!membership?.enabled)this.conflict('mirror_identity_suspended','Identità o appartenenza sospesa: nessuna riattivazione');
   // Revalidate delegation after the external provider call, before any grants.
   const current=await policy.guard(await policy.context(req),true);
   for(const id of a.roleIds)policy.validatePermissions(current,await policy.rolePermissions(c,id));
   await tx.query('INSERT INTO local_links(installation_id,local_user_id,subject) VALUES($1,$2,$3)',[installationId,b.localUserId,user.id]);
   await tx.query(`INSERT INTO app_local_users(source_id,installation_id,app_id,local_tenant_id,local_user_id,subject,email,email_normalized,first_name,last_name,role,permissions,mirror_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[a.sourceId,installationId,c.appId,a.localTenantId,b.localUserId,user.id,b.email,b.email.toLowerCase(),a.firstName,a.lastName,a.role,JSON.stringify(a.permissions),receipt]);
   for(const roleId of a.roleIds)await tx.query('INSERT INTO assignments(subject,customer_id,app_id,role_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[user.id,c.customerId,c.appId,roleId]);
   const setup=await this.setupRequired(user);
   await audit(tx,c.subject,'identity.mirror.application.linked',user.id,{installationId,sourceId:a.sourceId,localTenantId:a.localTenantId,localUserId:b.localUserId,roleIds:a.roleIds,created});
   return {installationId,customerId:c.customerId,appId:c.appId,sourceId:a.sourceId,localTenantId:a.localTenantId,localUserId:b.localUserId,subject:user.id,username:user.username,roleIds:a.roleIds,created,status:created?'created':'recovered',applicationAccess:true,ssoSetupRequired:setup};
  }).catch(error=>{
   if(error instanceof HttpException)throw error;
   throw new ServiceUnavailableException({code:'mirror_outcome_uncertain',message:'Esito incerto: verifica e riprendi esplicitamente sullo stesso ID locale'});
  });
 }
 private assertApplicationProfile(user:any,b:z.infer<typeof mirrorUserSchema>){
  if(b.application&&(String(user.username).toLowerCase()!==b.username.toLowerCase()||String(user.email).toLowerCase()!==b.email.toLowerCase()||user.firstName!==b.application.firstName||user.lastName!==b.application.lastName))this.conflict('mirror_profile_conflict','Profilo provider diverso: revisione esplicita richiesta');
 }
 private async assertProviderIdentity(user:any){
  if(!user?.id||!user.enabled)this.conflict('mirror_identity_disabled','Identità provider assente o disabilitata');
  const roles=await this.identities.roles(user.id);
  if(user.serviceAccountClientId||String(user.username).startsWith('service-account-')||roles.some(r=>['eulab-admin','eulab-technician'].includes(r.name)))this.conflict('mirror_identity_protected','Identità amministrativa o di servizio non collegabile');
 }
 private async setupRequired(user:any){
  const credentials=(await this.identities.request('/users/'+encodeURIComponent(user.id)+'/credentials')).body as {type:string}[];
  return !credentials.some(c=>c.type==='password')||!!user.requiredActions?.length;
 }
 private async mirrorIdentity(b:z.infer<typeof mirrorUserSchema>,installationId:string,fingerprint?:string){
  const proof=(username:string)=>createHmac('sha256',required('DATA_ENCRYPTION_KEY')).update(JSON.stringify([installationId,b.localUserId,username.toLowerCase()])).digest('hex');
  const found=(await this.identities.request('/users?'+new URLSearchParams({username:b.username,exact:'true',max:'2',briefRepresentation:'false'}))).body as any[];
  const matches=found.filter(u=>u.username.toLowerCase()===b.username.toLowerCase());
  if(matches.length>1)this.conflict('mirror_identity_conflict','Identità provider ambigua');
  let user=matches[0],created=false;
  if(user&&(user.attributes?.eulab_mirror_proof?.[0]!==proof(user.username)||(fingerprint&&user.attributes?.eulab_app_mirror_profile?.[0]!==fingerprint)))this.conflict('mirror_identity_conflict','Identità esistente senza prova corrispondente: nessuna unione per email');
  if(!user){
   if(fingerprint){
    const profile=(await this.identities.request('/users/profile')).body;
    const configured=['eulab_mirror_proof','eulab_app_mirror_profile'].every(name=>profile?.attributes?.some((a:any)=>a.name===name&&a.multivalued&&a.permissions?.view?.length===1&&a.permissions.view[0]==='admin'&&a.permissions?.edit?.length===1&&a.permissions.edit[0]==='admin'));
    if(!configured)throw new ServiceUnavailableException({code:'mirror_provider_configuration_required',message:'Configura gli attributi riservati del provider tramite il bootstrap Connect prima di creare account applicativi'});
   }
   if(fingerprint&&await this.identities.findUserByEmail(b.email))this.conflict('mirror_identity_conflict','Email già associata a un’identità senza prova corrispondente');
   const payload:any={username:b.username,email:b.email,firstName:b.application?.firstName||b.displayName.split(' ')[0],lastName:b.application?.lastName||b.displayName.split(' ').slice(1).join(' '),enabled:true,emailVerified:false,
    attributes:{eulab_mirror_proof:[proof(b.username)],...(fingerprint?{eulab_app_mirror_profile:[fingerprint]}:{})},requiredActions:b.initialPassword===undefined||b.initialPasswordTemporary?['UPDATE_PASSWORD']:[]};
   if(b.initialPassword!==undefined)payload.credentials=[{type:'password',value:b.initialPassword,temporary:b.initialPasswordTemporary===true}];
   let r;
   try{r=await this.identities.request('/users','POST',payload,'La password non rispetta la policy del provider identità');}
   catch(error){
    if(error instanceof BadRequestException)throw new BadRequestException({code:'mirror_password_rejected',message:'La password non rispetta la policy del provider identità'});
    if(error instanceof ServiceUnavailableException)throw new ServiceUnavailableException({code:'mirror_outcome_uncertain',message:'Esito provider incerto: verifica e riprendi esplicitamente sullo stesso ID locale'});
    throw error;
   }
   const subject=r.location?.split('/').pop();if(!subject)throw new ServiceUnavailableException({code:'mirror_outcome_uncertain',message:'Esito provider incerto: verifica e riprendi esplicitamente sullo stesso ID locale'});
   user=await this.identities.user(subject);created=true;
  }
  await this.assertProviderIdentity(user);
  this.assertApplicationProfile(user,b);
  if(fingerprint&&(user.attributes?.eulab_mirror_proof?.[0]!==proof(user.username)||user.attributes?.eulab_app_mirror_profile?.[0]!==fingerprint))throw new ServiceUnavailableException({code:'mirror_provider_proof_missing',message:'Il provider non conserva la prova di creazione: revisione amministrativa richiesta'});
  return {user,created};
 }
}
