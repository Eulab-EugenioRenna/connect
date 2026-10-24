import {Body,Controller,Post,Req,ForbiddenException,ConflictException,ServiceUnavailableException} from '@nestjs/common';
import {ApiInput} from './openapi.js';
import {z} from 'zod';
import {createHmac} from 'node:crypto';
import {RequestContext} from './auth.js';
import {Database,audit} from './database.js';
import {IdentitiesService} from './identities.service.js';
import {parse,name} from './validation.js';
import {required} from './config.js';

export const mirrorUserSchema=z.object({
 localUserId:name,
 username:z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/).refine(v=>!v.startsWith('service-account-'),'Username riservato'),
 email:z.string().email().max(250),
 displayName:name,
 // Solo il backend dell’installazione può usarla, esclusivamente per inizializzare una nuova identità.
 initialPassword:z.string().min(1).max(512).optional()
}).strict();

@Controller('v1/users')
export class UserMirrorsController {
 constructor(private readonly db:Database,private readonly identities:IdentitiesService){}
 @Post('mirror') @ApiInput(mirrorUserSchema) async mirror(@Body() body:unknown,@Req() req:RequestContext){
  const p=req.principal;
  if(!p.server||!p.installationId)throw new ForbiddenException('La copia dell’utente deve essere richiesta dal backend dell’app');
  const b=parse(mirrorUserSchema,body),installationId=p.installationId;
  const proof=(username:string)=>createHmac('sha256',required('DATA_ENCRYPTION_KEY')).update(JSON.stringify([installationId,b.localUserId,username.toLowerCase()])).digest('hex');
  return this.db.transaction(async tx=>{
   const site=(await tx.query('SELECT * FROM installations WHERE id=$1 AND enabled=true FOR UPDATE',[installationId])).rows[0];if(!site)throw new ForbiddenException('Installazione non attiva');
   const existing=(await tx.query('SELECT subject FROM local_links WHERE installation_id=$1 AND local_user_id=$2',[installationId,b.localUserId])).rows[0];
   // An explicit existing association is authoritative, including manual links and revocations.
   if(existing)return {installationId,customerId:site.customer_id,localUserId:b.localUserId,subject:existing.subject,created:false,status:'already_linked',ssoSetupRequired:null};
   if(site.integration==='wordpress'&&!(await tx.query('SELECT u.local_user_id FROM wordpress_users u JOIN wordpress_directories d ON d.installation_id=u.installation_id AND d.active_generation=u.generation WHERE u.installation_id=$1 AND u.local_user_id=$2',[installationId,b.localUserId])).rows.length)throw new ConflictException('Seleziona un utente WordPress esistente dall’elenco sincronizzato');
   // The password and its verification never enter Connect tables, audit details, responses or errors.
   await audit(tx,'installation:'+installationId,'identity.mirror.requested',b.localUserId,{username:b.username,passwordInitialized:b.initialPassword!==undefined});
   const found=(await this.identities.request('/users?'+new URLSearchParams({username:b.username,exact:'true',max:'2'}))).body as any[];
   let user=found.find(u=>u.username.toLowerCase()===b.username.toLowerCase()),created=false;
   if(user&&user.attributes?.eulab_mirror_proof?.[0]!==proof(user.username))throw new ConflictException('Username SSO già presente: collega esplicitamente l’identità dall’admin Connect. Nessuna unione automatica per email.');
   if(!user){
    const first=b.displayName.split(' ')[0],last=b.displayName.split(' ').slice(1).join(' ');
    const payload:any={username:b.username,email:b.email,firstName:first,lastName:last,enabled:true,emailVerified:false,attributes:{eulab_mirror_proof:[proof(b.username)]}};
    if(b.initialPassword===undefined){
     // Historical behaviour: the user activates the identity through Connect.
     payload.requiredActions=['UPDATE_PASSWORD'];
    }else{
     // The provider validates its own password policy and stores the credential.
     payload.credentials=[{type:'password',value:b.initialPassword,temporary:false}];
     payload.requiredActions=[];
    }
    const r=await this.identities.request('/users','POST',payload,b.initialPassword===undefined?undefined:'La password non rispetta la policy del provider identità');
    const subject=r.location?.split('/').pop();if(!subject)throw new ServiceUnavailableException('Identità creata: ripeti la richiesta per completare il collegamento');
    user=(await this.identities.request('/users/'+encodeURIComponent(subject))).body;created=true;
   }
   const roles=(await this.identities.request('/users/'+encodeURIComponent(user.id)+'/role-mappings/realm/composite')).body as {name:string}[];
   if(roles.some(r=>['eulab-admin','eulab-technician'].includes(r.name)))throw new ConflictException('Identità amministrativa protetta: collegamento riservato all’admin Connect');
   if(!user.enabled)throw new ConflictException('Identità SSO disabilitata dall’amministratore');
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
}
