import {
  BadRequestException,ConflictException,ForbiddenException,HttpException,Injectable,NotFoundException,
  OnApplicationBootstrap,OnModuleDestroy,ServiceUnavailableException,UnauthorizedException
} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {authenticatePresenter,issuePresenter} from './onboarding-bootstrap.js';
import {Database,audit} from './database.js';
import {IdentitiesService,ProviderPasswordRejected} from './identities.service.js';
import {CatalogSourceService} from './catalog-source.service.js';
import {CatalogReader} from './catalog-reader.js';
import {functionMatrixSchema} from './function-matrix.js';
import {hash,secret,seal,equalSecret,sealMigrationValue,unsealMigrationValue,unseal} from './security.js';
import {
  ONBOARDING_CONSENT_VERSION,OnboardingState,onboardingPlanSchema
} from './onboarding.schemas.js';
import type {z} from 'zod';
import type {connectSourceSchema} from './onboarding.schemas.js';

type SourceRow={id:string;app_id:string;name:string;environment:string;origins:string[];catalog_url:string|null;oidc_callbacks:string[];deployment_identity:string;enabled:boolean;presenter_id?:string|null;integration_approved?:boolean;approved_app_id?:string|null;verified_app_id?:string|null;verified_origins?:string[]};
type PracticeRow={id:string;source_id:string;app_id:string;kind:'migration'|'activation';local_tenant_id:string|null;tenant_name:string;tenant_slug:string;state:OnboardingState;plan:any;target_customer_id:string|null;target_installation_id:string|null;checkpoint:any;safe_error:string;created_at:Date;updated_at:Date;completed_at:Date|null};
type RequestRow={id:string;practice_id:string;source_id:string;app_id:string;kind:'migration'|'activation';state:OnboardingState;idempotency_key:string;request_hash:string;consent_version:string;local_tenant_id:string|null;local_user_id:string|null;email:string;email_normalized:string;first_name:string;last_name:string;role:string;permissions:string[];company_name:string;identity_subject:string|null;password_cipher:string|null;password_expires_at:Date|null;password_deleted_at:Date|null;password_consumed_at:Date|null;checkpoint:any;safe_error:string;action_required:string;created_at:Date;updated_at:Date;approved_at:Date|null;completed_at:Date|null};

// Shared projection for discovery, submit/replay and recovery: personal state alone is insufficient.
type RequestStatusRow=Pick<RequestRow,'id'|'kind'|'state'|'action_required'|'identity_subject'|'local_tenant_id'|'local_user_id'>&{
 practice_state:OnboardingState;planned_identity:boolean;local_linked:boolean;
};
const requestStatusProjection=`r.id,r.kind,r.state,r.practice_id,r.created_at,r.action_required,r.identity_subject,r.local_tenant_id,r.local_user_id,
 p.state AS practice_state,COALESCE(p.plan->'identities'->>r.id::text,'')<>'' AS planned_identity,
 EXISTS(SELECT 1 FROM app_local_users linked WHERE linked.source_id=r.source_id AND linked.app_id=r.app_id
   AND linked.local_tenant_id=r.local_tenant_id AND linked.local_user_id=r.local_user_id) AS local_linked`;

class StepError extends Error {constructor(readonly code:string,message:string,readonly actionRequired=''){super(message);}}
class PreconditionError extends Error {constructor(readonly missing:{code:string;label:string}[]){super('Prerequisiti mancanti');}}

const credentialMissing='Nessuna credenziale transitoria disponibile. Il richiedente deve ripetere l’accesso.';

@Injectable()
export class OnboardingService implements OnApplicationBootstrap,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;
  private readonly attempts=new Map<string,{count:number;reset:number}>();
  constructor(private readonly db:Database,private readonly identities:IdentitiesService,private readonly sources:CatalogSourceService,private readonly catalogReader:CatalogReader){}

  onApplicationBootstrap(){void this.sweepExpired().catch(()=>undefined);this.timer=setInterval(()=>void this.sweepExpired().catch(()=>undefined),300000);this.timer.unref();}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}

  // ---------- autenticazione della sorgente di deployment ----------

  private transport(req:any){
    if(process.env.NODE_ENV!=='production')return;
    const forwarded=String(req.headers?.['x-forwarded-proto']||'').split(',')[0].trim();
    const remote=String(req.socket?.remoteAddress||'');
    const loopback=remote==='127.0.0.1'||remote==='::1'||remote==='::ffff:127.0.0.1';
    if(req.socket?.encrypted||forwarded==='https'||loopback)return;
    throw new BadRequestException('TLS richiesto per il contratto di onboarding');
  }
  private rate(sourceId:string,req:any,limit=120){
    const key=sourceId+'|'+(req.socket?.remoteAddress||'unknown');
    const now=Date.now(),current=this.attempts.get(key);
    if(!current||current.reset<=now)this.attempts.set(key,{count:1,reset:now+60000});
    else {current.count++;if(current.count>limit)throw new HttpException({statusCode:429,message:'Troppe richieste alla sorgente'},429);}
    for(const [k,v] of this.attempts)if(v.reset<=now)this.attempts.delete(k);
  }
  async authenticate(req:any,body:any,contextEmail?:string):Promise<SourceRow>{
    this.transport(req);
    const contextLookup=contextEmail!==undefined;
    if(contextLookup){
      // Successful server-to-server session checks must not spend the shared
      // onboarding/failed-credential budget of every user of a SaaS deployment.
      const blocked=this.attempts.get('preauth|'+(req.socket?.remoteAddress||'unknown'));
      if(blocked&&blocked.reset>Date.now()&&blocked.count>=120)throw new HttpException({statusCode:429,message:'Troppe richieste alla sorgente'},429);
    }else this.rate('preauth',req);
    const finish=(source:SourceRow)=>{
      // Context lookups are authenticated service authorization checks, not login attempts.
      // Keep a bounded per-identity service budget while retaining 120/min for failed credentials and onboarding.
      this.rate(contextLookup?source.id+':context:'+hash(contextEmail.trim().toLowerCase()):source.id,req,contextLookup?600:120);
      return source;
    };
    try{
      const declared=String(req.headers?.['x-connect-source']||'');
      const bearer=String(req.headers?.authorization||'').match(/^Bearer (.+)$/)?.[1];
      const presenter=String(req.headers?.['x-connect-presenter']||'');
      if(presenter&&bearer){
        if(declared&&declared!==body?.sourceId)throw new ForbiddenException('Source header differente');
        return finish(await authenticatePresenter(this.db,presenter,bearer,body));
      }
      if(!declared||!bearer)throw new UnauthorizedException('Credenziali di sorgente richieste');
      const [source]=await this.db.query<SourceRow>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins FROM connect_sources WHERE id=$1',[declared]);
      if(!source||!source.enabled||source.presenter_id)throw new UnauthorizedException('Sorgente non autorizzata');
      const [stored]=await this.db.query<{secret_hash:string}>('SELECT secret_hash FROM connect_sources WHERE id=$1',[source.id]);
      if(!stored||!equalSecret(bearer,stored.secret_hash)){
        await this.auditFailure(source.id,declared,'invalid_secret');
        throw new UnauthorizedException('Credenziali di sorgente non valide');
      }
      if(body?.schemaVersion!==1||body?.sourceId!==source.id||body?.appId!==source.app_id){
        await this.auditFailure(source.id,declared,'body_source_mismatch');
        throw new ForbiddenException('La sorgente autenticata non corrisponde alla richiesta');
      }
      return finish(source);
    }catch(error){
      if(contextLookup&&error instanceof HttpException&&[400,401,403].includes(error.getStatus()))this.rate('preauth',req);
      throw error;
    }
  }
  private async auditFailure(sourceId:string,declared:string,reason:string){
    try{await this.audit(undefined,'onboarding.source.rejected',sourceId,{declared,reason});}catch{}
  }

  // ---------- lookup di instradamento (non autentica l'utente) ----------

  async loginContext(source:SourceRow,email:string){
    await this.sweepExpired();
    const normalized=email.trim().toLowerCase();
    const rows=await this.db.query<any>(`SELECT alu.local_user_id,alu.local_tenant_id,alu.subject,alu.email,alu.first_name,alu.last_name,alu.role,alu.enabled AS local_enabled,
      i.id AS installation_id,i.customer_id,i.app_id AS installation_app_id,i.domain,i.secret_cipher,i.enabled AS installation_enabled,
      sib.enabled AS binding_enabled,u.enabled AS identity_enabled,m.enabled AS member_enabled,l.state AS license_state,l.expires_at,
      EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=alu.subject) AS access_revoked,
      EXISTS(SELECT 1 FROM assignments a WHERE a.subject=alu.subject AND a.customer_id=i.customer_id AND a.app_id=i.app_id) AS role_assigned,
      COALESCE(stb.local_name,c.name) AS tenant_name,COALESCE(stb.local_slug,'') AS tenant_slug
      FROM app_local_users alu
      JOIN source_installation_bindings sib ON sib.source_id=alu.source_id AND sib.installation_id=alu.installation_id
      JOIN installations i ON i.id=alu.installation_id AND i.app_id=alu.app_id
      JOIN identities u ON u.subject=alu.subject
      LEFT JOIN memberships m ON m.subject=alu.subject AND m.customer_id=i.customer_id
      LEFT JOIN licenses l ON l.customer_id=i.customer_id AND l.app_id=i.app_id
      LEFT JOIN source_tenant_bindings stb ON stb.source_id=alu.source_id AND stb.local_tenant_id=alu.local_tenant_id
      LEFT JOIN customers c ON c.id=i.customer_id
      WHERE alu.source_id=$1 AND alu.app_id=$2 AND alu.email_normalized=$3`,[source.id,source.approved_app_id||source.app_id,normalized]);
    if(rows.some(row=>!row.local_enabled||!row.binding_enabled||!row.installation_enabled||!row.identity_enabled||!row.member_enabled||row.access_revoked||(row.license_state&&row.license_state!=='active')))throw new ForbiddenException('Accesso già sospeso o revocato');
    if(source.integration_approved===false||!rows.length){
      const requests=await this.db.query<any>(`SELECT ${requestStatusProjection} FROM onboarding_requests r JOIN onboarding_practices p ON p.id=r.practice_id WHERE r.source_id=$1 AND r.app_id=$2 AND r.email_normalized=$3
        ORDER BY CASE WHEN r.state IN ('pending','approved','migrating','failed') THEN 0 ELSE 1 END,r.created_at DESC LIMIT 20`,[source.id,source.app_id,normalized]);
      const practices=new Set(requests.filter(r=>['pending','approved','migrating','failed'].includes(r.state)).map(r=>r.practice_id));
      if(practices.size>1)throw new ConflictException('Più pratiche attive per questa email: serve un contesto aziendale preassegnato');
      const latest=requests[0];
      return latest?{status:'not_found',request:this.requestStatus(latest)}:{status:'not_found'};
    }
    const installations=new Set(rows.map(r=>r.installation_id));
    if(rows.length>1||installations.size>1)throw new ConflictException('Collegamento ambiguo: più accessi autorizzati per questa email');
    const row=rows[0];
    if(!['owner','manager','reception','collaborator'].includes(row.role))throw new ConflictException('Ruolo locale non riconosciuto: serve una verifica assistita');
    if(!row.local_enabled)throw new ForbiddenException('Accesso locale sospeso o revocato');
    if(!row.binding_enabled||!row.installation_enabled)throw new ForbiddenException('Installazione sospesa o revocata');
    if(!row.identity_enabled)throw new ForbiddenException('Identità sospesa o revocata');
    if(!row.member_enabled)throw new ForbiddenException('Appartenenza al cliente sospesa o revocata');
    if(row.access_revoked)throw new ForbiddenException('Accesso revocato per questa applicazione');
    if(row.license_state!=='active'||(row.expires_at&&new Date(row.expires_at)<=new Date()))throw new ForbiddenException('Licenza non attiva o scaduta');
    if(!row.role_assigned)throw new ForbiddenException('Ruolo applicativo non assegnato');
    if(!row.secret_cipher)throw new ServiceUnavailableException('Segreto server dell’installazione non disponibile: ruota le credenziali dal pannello');
    let installationSecret:string;
    try{installationSecret=unseal(row.secret_cipher);}catch{throw new ServiceUnavailableException('Segreto server dell’installazione non leggibile');}
    const permissions=(await this.db.query<{key:string}>(`SELECT DISTINCT p.key FROM permissions p
      JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key AND f.active=true
      JOIN entitlements e ON e.customer_id=$2 AND e.app_id=p.app_id AND e.feature_key=p.feature_key AND e.purchased=true AND e.enabled=true
      JOIN assignments a ON a.subject=$3 AND a.customer_id=$2 AND a.app_id=p.app_id
      JOIN roles r ON r.id=a.role_id AND r.customer_id=a.customer_id AND r.app_id=a.app_id
      JOIN role_permissions rp ON rp.role_id=r.id AND rp.app_id=p.app_id AND rp.permission_key=p.key
      WHERE p.app_id=$1 AND p.active=true ORDER BY p.key`,[source.approved_app_id||source.app_id,row.customer_id,row.subject])).map(p=>p.key);
    const context={
      tenant:{id:row.local_tenant_id||row.customer_id,name:String(row.tenant_name||row.email).slice(0,120),slug:slugify(row.tenant_slug||row.tenant_name||row.customer_id)},
      binding:{customerId:row.customer_id,installationId:row.installation_id,secret:installationSecret},
      user:{id:row.local_user_id,subject:row.subject,email:row.email,firstName:row.first_name,lastName:row.last_name,role:row.role,permissions}
    };
    return source.presenter_id?{status:'configuration_required',appId:source.approved_app_id||source.app_id,context}:{status:'connect',context};
  }

  // ---------- invio di una pratica ----------

  private resubmittable(request:RequestRow){
    return request.state==='rejected'||request.state==='expired'||(request.state==='failed'&&request.action_required==='new_request_required');
  }

  async submit(source:SourceRow,body:z.infer<typeof import('./onboarding.schemas.js').onboardingRequestSchema>,idempotencyKey:string){
    if(!/^[A-Za-z0-9:_-]{8,200}$/.test(idempotencyKey))throw new BadRequestException('Idempotency-Key non valida');
    await this.sweepExpired();
    const canonical=body.kind==='migration'
      ?{kind:body.kind,consentVersion:body.consentVersion,
        localTenant:{id:body.localTenant.id,name:body.localTenant.name,slug:body.localTenant.slug},
        localUser:{id:body.localUser.id,email:body.localUser.email,firstName:body.localUser.firstName,lastName:body.localUser.lastName,role:body.localUser.role,permissions:[...body.localUser.permissions]}}
      :{kind:body.kind,companyName:body.companyName,
        applicant:{email:body.applicant.email,firstName:body.applicant.firstName,lastName:body.applicant.lastName}};
    const requestHash=hash(JSON.stringify(canonical));
    const existing=await this.db.query<RequestRow>('SELECT * FROM onboarding_requests WHERE source_id=$1 AND idempotency_key=$2',[source.id,idempotencyKey]);
    if(existing.length){
      if(existing[0].request_hash!==requestHash)throw new ConflictException('Idempotency-Key già usata con dati diversi: la credenziale esistente non viene sostituita');
      if(!this.resubmittable(existing[0]))return this.publicRequestStatus(existing[0]);
    }
    if(body.kind==='migration'){
      const [linked]=await this.db.query<any>('SELECT email FROM app_local_users WHERE source_id=$1 AND local_tenant_id=$2 AND local_user_id=$3',[source.id,body.localTenant.id,body.localUser.id]);
      if(linked){await this.loginContext(source,linked.email);throw new ForbiddenException('Profilo già collegato: usare Connect o assistenza, nessuna nuova pratica');}
    }
    const ttl=this.passwordTtl();
    const id=existing[0]?.id||randomUUID();
    const expiresAt=new Date(Date.now()+ttl*1000);
    const email=body.kind==='migration'?body.localUser.email:body.applicant.email;
    const firstName=body.kind==='migration'?body.localUser.firstName:body.applicant.firstName;
    const lastName=body.kind==='migration'?body.localUser.lastName:body.applicant.lastName;
    const localTenantId=body.kind==='migration'?body.localTenant.id:null;
    const localUserId=body.kind==='migration'?body.localUser.id:null;
    const role=body.kind==='migration'?body.localUser.role:'';
    const permissions=body.kind==='migration'?body.localUser.permissions:[];
    const tenantName=body.kind==='migration'?body.localTenant.name:body.companyName;
    const tenantSlug=body.kind==='migration'?body.localTenant.slug:slugify(body.companyName);
    try{
      const result=await this.db.transaction(async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding:'+source.id+':'+idempotencyKey]);
        if((await tx.query('SELECT request_id FROM onboarding_password_recoveries WHERE source_id=$1 AND idempotency_key=$2',[source.id,idempotencyKey])).rows.length)throw new ConflictException('Idempotency-Key riservata a un recupero password');
        if(body.kind==='activation')await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding-activation:'+source.id+':'+requestHash]);
        const byKey=(await tx.query<RequestRow>('SELECT * FROM onboarding_requests WHERE source_id=$1 AND idempotency_key=$2',[source.id,idempotencyKey])).rows[0];
        const raced=byKey||(body.kind==='activation'?(await tx.query<RequestRow>("SELECT * FROM onboarding_requests WHERE source_id=$1 AND kind='activation' AND request_hash=$2 ORDER BY created_at DESC LIMIT 1",[source.id,requestHash])).rows[0]:undefined);

        if(raced){
          if(raced.request_hash!==requestHash)throw new ConflictException('Idempotency-Key già usata con dati diversi');
          if(!this.resubmittable(raced))return raced;
          const retryPractice=(await tx.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1 FOR UPDATE',[raced.practice_id])).rows[0];
          if(!retryPractice||!['pending','approved','failed'].includes(retryPractice.state))return raced;
          const updated=(await tx.query<RequestRow>(`UPDATE onboarding_requests SET state='pending',idempotency_key=$2,request_hash=$3,consent_version=$4,
            local_user_id=$5,first_name=$6,last_name=$7,role=$8,permissions=$9,company_name=$10,identity_subject=null,
            password_cipher=$11,password_expires_at=$12,password_deleted_at=null,password_consumed_at=null,checkpoint='{}'::jsonb,
            safe_error='',action_required='',approved_at=null,completed_at=null,updated_at=now() WHERE id=$1 RETURNING *`,
            [raced.id,idempotencyKey,requestHash,body.kind==='migration'?body.consentVersion:ONBOARDING_CONSENT_VERSION,localUserId,firstName,lastName,role,JSON.stringify(permissions),body.kind==='activation'?body.companyName:'',sealMigrationValue(body.initialPassword,raced.id),expiresAt])).rows[0];
          await tx.query(`UPDATE onboarding_practices SET state='pending',safe_error='',completed_at=null,updated_at=now() WHERE id=$1`,[retryPractice.id]);
          return updated;
        }
        let practice:PracticeRow|undefined;
        if(body.kind==='migration'){
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding-practice:'+source.id+':'+source.app_id+':'+localTenantId]);
          practice=(await tx.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE source_id=$1 AND app_id=$2 AND kind=$3 AND local_tenant_id=$4 FOR UPDATE',[source.id,source.app_id,'migration',localTenantId!])).rows[0];
          if(!practice){
            const practiceId=randomUUID();
            practice=(await tx.query<PracticeRow>(`INSERT INTO onboarding_practices(id,source_id,app_id,kind,local_tenant_id,tenant_name,tenant_slug,state)
              VALUES($1,$2,$3,'migration',$4,$5,$6,'pending') RETURNING *`,[practiceId,source.id,source.app_id,localTenantId,tenantName,tenantSlug])).rows[0];
          }
        }else{
          const practiceId=randomUUID();
          practice=(await tx.query<PracticeRow>(`INSERT INTO onboarding_practices(id,source_id,app_id,kind,tenant_name,tenant_slug,state)
            VALUES($1,$2,$3,'activation',$4,$5,'pending') RETURNING *`,[practiceId,source.id,source.app_id,tenantName,tenantSlug])).rows[0];
        }
        const person=(await tx.query<RequestRow>('SELECT * FROM onboarding_requests WHERE practice_id=$1 AND email_normalized=$2',[practice.id,email])).rows[0];
        if(['rejected','expired','migrating'].includes(practice.state)){
          if(person)return person;
          throw new ConflictException(practice.state==='migrating'?'Esecuzione già in corso: attendi il completamento':'La pratica è chiusa');
        }
        if(person&&!this.resubmittable(person)){
          return person;
        }
        if(person&&!['pending','approved','failed'].includes(practice.state)){
          return person;
        }
        if(person){
          const updated=(await tx.query<RequestRow>(`UPDATE onboarding_requests SET state='pending',idempotency_key=$2,request_hash=$3,consent_version=$4,
            local_user_id=$5,first_name=$6,last_name=$7,role=$8,permissions=$9,company_name=$10,identity_subject=null,
            password_cipher=$11,password_expires_at=$12,password_deleted_at=null,password_consumed_at=null,checkpoint='{}'::jsonb,
            safe_error='',action_required='',approved_at=null,completed_at=null,updated_at=now() WHERE id=$1 RETURNING *`,
            [person.id,idempotencyKey,requestHash,body.kind==='migration'?body.consentVersion:ONBOARDING_CONSENT_VERSION,localUserId,firstName,lastName,role,JSON.stringify(permissions),body.kind==='activation'?body.companyName:'',sealMigrationValue(body.initialPassword,person.id),expiresAt])).rows[0];
          await tx.query(`UPDATE onboarding_practices SET state='pending',safe_error='',completed_at=null,updated_at=now() WHERE id=$1`,[practice.id]);
          return updated;
        }
        await tx.query(`UPDATE onboarding_practices SET state='pending',safe_error='',updated_at=now() WHERE id=$1`,[practice.id]);
        return (await tx.query<RequestRow>(`INSERT INTO onboarding_requests(id,practice_id,source_id,app_id,kind,state,idempotency_key,request_hash,consent_version,
          local_tenant_id,local_user_id,email,email_normalized,first_name,last_name,role,permissions,company_name,password_cipher,password_expires_at)
          VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
          [id,practice.id,source.id,source.app_id,body.kind,idempotencyKey,requestHash,body.kind==='migration'?body.consentVersion:ONBOARDING_CONSENT_VERSION,
           localTenantId,localUserId,email,email,firstName,lastName,role,JSON.stringify(permissions),body.kind==='activation'?body.companyName:'',sealMigrationValue(body.initialPassword,id),expiresAt])).rows[0];
      });
      if(source.presenter_id&&source.verified_app_id)await this.db.query("UPDATE onboarding_practices SET plan=jsonb_build_object('roles','[]'::jsonb,'application',jsonb_build_object('mode','existing','id',$2::text)) WHERE id=$1 AND plan IS NULL",[result.practice_id,source.verified_app_id]);
      await this.audit(undefined,'onboarding.request.created',result.id,{sourceId:source.id,appId:source.app_id,kind:result.kind,practiceId:result.practice_id,company:tenantName,localTenantId,localUserId,credentialStored:!!result.password_cipher});
      return this.publicRequestStatus(result);
    }catch(error:any){
      if(error?.code==='23505'){
        const [row]=await this.db.query<RequestRow>('SELECT * FROM onboarding_requests WHERE source_id=$1 AND idempotency_key=$2',[source.id,idempotencyKey]);
        if(row){if(row.request_hash!==requestHash)throw new ConflictException('Idempotency-Key già usata con dati diversi: la credenziale esistente non viene sostituita');return this.publicRequestStatus(row);}
      }
      throw error;
    }
  }

  private async publicRequestStatus(row:Pick<RequestRow,'id'>,tx?:{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>}){
    const sql=`SELECT ${requestStatusProjection} FROM onboarding_requests r JOIN onboarding_practices p ON p.id=r.practice_id WHERE r.id=$1`;
    const [current]=tx?(await tx.query(sql,[row.id])).rows:await this.db.query<RequestStatusRow>(sql,[row.id]);
    if(!current)throw new NotFoundException('Richiesta non trovata');
    return this.requestStatus(current);
  }

  private requestStatus(row:RequestStatusRow){
    const reusable=row.kind==='migration'&&!!row.local_tenant_id&&!!row.local_user_id
      &&['pending','approved','failed'].includes(row.practice_state)
      &&!row.identity_subject&&!row.planned_identity&&!row.local_linked;
    const nextAction=row.practice_state==='migrating'?'wait':
      ['rejected','expired'].includes(row.practice_state)||(row.practice_state==='completed'&&row.state!=='completed')?'closed':
      row.state==='completed'?'sign_in':['pending','approved','migrating'].includes(row.state)?'wait':
      reusable&&row.state==='failed'&&row.action_required==='password_change_required'?'choose_connect_password':
      reusable&&(row.state==='expired'||(row.state==='failed'&&row.action_required==='new_request_required'))?'resubmit':
      row.state==='rejected'?'closed':'contact_admin';
    return {requestId:row.id,state:row.state,nextAction};
  }

  async recoverPassword(source:SourceRow,body:z.infer<typeof import('./onboarding.schemas.js').passwordRecoverySchema>,key:string){
    if(!/^[A-Za-z0-9:_-]{8,200}$/.test(key))throw new BadRequestException('Idempotency-Key non valida');
    return this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding:'+source.id+':'+key]);
      const original=(await tx.query<RequestRow>('SELECT * FROM onboarding_requests WHERE id=$1 AND source_id=$2 AND app_id=$3',[body.requestId,source.id,source.app_id])).rows[0];
      if(!original)throw new NotFoundException('Richiesta non trovata');
      const practice=(await tx.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1 FOR UPDATE',[original.practice_id])).rows[0];
      const row=(await tx.query<RequestRow>('SELECT * FROM onboarding_requests WHERE id=$1 FOR UPDATE',[original.id])).rows[0];
      if(row.kind!=='migration'||row.local_tenant_id!==body.localTenantId||row.local_user_id!==body.localUserId||row.email_normalized!==body.email)throw new ConflictException('Prova locale non corrispondente');
      const prior=(await tx.query<any>('SELECT request_id FROM onboarding_password_recoveries WHERE source_id=$1 AND idempotency_key=$2',[source.id,key])).rows[0];
      if(prior){if(prior.request_id!==row.id)throw new ConflictException('Idempotency-Key già usata');return this.publicRequestStatus(row,tx);}
      const used=(await tx.query<any>('SELECT id FROM onboarding_requests WHERE source_id=$1 AND idempotency_key=$2',[source.id,key])).rows[0];
      if(used)throw new ConflictException('Una nuova chiave è richiesta per una nuova credenziale');
      if((await this.publicRequestStatus(row,tx)).nextAction!=='choose_connect_password')throw new ConflictException('Recupero non consentito: pratica o identità non modificabili');
      await tx.query('INSERT INTO onboarding_password_recoveries(source_id,idempotency_key,request_id) VALUES($1,$2,$3)',[source.id,key,row.id]);
      await tx.query("UPDATE onboarding_requests SET state='pending',password_cipher=$2,password_expires_at=$3,password_deleted_at=null,password_consumed_at=null,consent_version=$4,action_required='',safe_error='',approved_at=null,updated_at=now() WHERE id=$1",[row.id,sealMigrationValue(body.newPassword,row.id),new Date(Date.now()+this.passwordTtl()*1000),body.consentVersion]);
      await tx.query("UPDATE onboarding_practices SET state='pending',safe_error='',updated_at=now() WHERE id=$1",[practice.id]);
      await audit(tx,'source:'+source.id,'onboarding.password.recovery',row.id,{sourceId:source.id,legacyProofAttested:true,consentVersion:body.consentVersion});
      return this.publicRequestStatus(row,tx);
    });
  }

  issuePresenter(body:Parameters<typeof issuePresenter>[1],actor:string){return issuePresenter(this.db,body,actor);}
  listPresenters(){return this.db.query('SELECT id,name,deployment_identity,verified_origins,verified_app_id,enabled,expires_at,bound_source_id,created_at FROM onboarding_presenters ORDER BY created_at DESC');}
  async updatePresenter(id:string,body:z.infer<typeof import('./onboarding.schemas.js').presenterUpdateSchema>,actor:string){
    if(body.expiresAt&&(new Date(body.expiresAt)<=new Date()||new Date(body.expiresAt).getTime()>Date.now()+366*86400000))throw new BadRequestException('Scadenza tecnica non valida');
    const credential=body.rotateSecret?secret():null;
    await this.db.transaction(async tx=>{
      if(!(await tx.query('UPDATE onboarding_presenters SET enabled=COALESCE($2,enabled),expires_at=COALESCE($3,expires_at),secret_hash=COALESCE($4,secret_hash) WHERE id=$1 RETURNING id',[id,body.enabled??null,body.expiresAt??null,credential?hash(credential):null])).rows.length)throw new NotFoundException();
      await audit(tx,actor,'onboarding.presenter.update',id,{enabled:body.enabled,expiresAt:body.expiresAt,rotated:!!credential});
    });
    return {id,...(credential?{secret:credential}:{}),...(body.enabled!==undefined?{enabled:body.enabled}:{})};
  }
  async configuration(source:SourceRow){
    if(source.integration_approved===false){
      const plans=await this.db.query<any>("SELECT DISTINCT plan->'application'->>'id' AS app_id FROM onboarding_practices WHERE source_id=$1 AND state IN ('pending','approved','failed') AND plan->'application'->>'id' IS NOT NULL",[source.id]);
      return {status:'pending',...(plans.length===1?{plannedAppId:plans[0].app_id}:{})};
    }
    const [stored]=await this.db.query<any>('SELECT configuration_cipher FROM connect_sources WHERE id=$1',[source.id]);
    if(!stored?.configuration_cipher)return {status:'configuration_required'};
    const config=JSON.parse(unseal(stored.configuration_cipher));
    return {status:'ready',configuration:{...config,appId:source.approved_app_id||source.app_id,sourceId:source.id}};
  }

  // ---------- amministrazione delle sorgenti ----------

  async listSources(){
    return this.db.query(`SELECT s.id,s.app_id,s.name,s.environment,s.origins,s.catalog_url,s.oidc_callbacks,s.deployment_identity,s.enabled,s.presenter_id,s.integration_approved,s.approved_app_id,s.verified_app_id,s.verified_origins,s.created_at,s.rotated_at,
      (SELECT count(*)::int FROM source_installation_bindings b WHERE b.source_id=s.id) AS installations
      FROM connect_sources s ORDER BY s.created_at`);
  }
  async sourceDetail(id:string){
    const [source]=await this.db.query<any>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins,created_at,rotated_at FROM connect_sources WHERE id=$1',[id]);
    if(!source)throw new NotFoundException('Sorgente non trovata');
    const [installations,tenants,localUsers]=await Promise.all([
      this.db.query(`SELECT b.installation_id AS "installationId",b.app_id AS "appId",b.enabled,b.created_at AS "createdAt",
        i.domain,i.customer_id AS "customerId",i.enabled AS "installationEnabled",(i.secret_cipher IS NOT NULL) AS "secretAvailable"
        FROM source_installation_bindings b JOIN installations i ON i.id=b.installation_id WHERE b.source_id=$1 ORDER BY b.created_at`,[id]),
      this.db.query(`SELECT t.local_tenant_id AS "localTenantId",t.customer_id AS "customerId",t.app_id AS "appId",t.local_name AS "localName",t.local_slug AS "localSlug",t.created_at AS "createdAt",c.name AS "customerName"
        FROM source_tenant_bindings t JOIN customers c ON c.id=t.customer_id WHERE t.source_id=$1 ORDER BY t.created_at`,[id]),
      this.db.query(`SELECT local_user_id AS "localUserId",installation_id AS "installationId",local_tenant_id AS "localTenantId",subject,email,first_name AS "firstName",last_name AS "lastName",role,permissions,enabled,updated_at AS "updatedAt"
        FROM app_local_users WHERE source_id=$1 ORDER BY email,local_user_id`,[id])
    ]);
    return {...source,catalogUrl:source.catalog_url,oidcCallbacks:source.oidc_callbacks,deploymentIdentity:source.deployment_identity,installations,tenants,localUsers};
  }
  async createSource(body:z.infer<typeof connectSourceSchema>,actor:string){
    this.validateSourceUrls(body.origins,body.catalogUrl,body.oidcCallbacks);
    this.validateEnvironmentUrls(body.environment,body.origins,body.catalogUrl,body.oidcCallbacks);
    const credential=secret();
    return this.db.transaction(async tx=>{
      const existing=(await tx.query('SELECT id FROM connect_sources WHERE id=$1',[body.id])).rows[0];
      if(existing)throw new ConflictException('Sorgente già registrata');
      await tx.query(`INSERT INTO connect_sources(id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,secret_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[body.id,body.appId,body.name,body.environment,JSON.stringify(body.origins),body.catalogUrl,JSON.stringify(body.oidcCallbacks),body.deploymentIdentity,hash(credential)]);
      await audit(tx,actor,'onboarding.source.create',body.id,{appId:body.appId,environment:body.environment,origins:body.origins,catalogUrl:body.catalogUrl,deploymentIdentity:body.deploymentIdentity});
      return {...body,enabled:true,secret:credential};
    });
  }
  async updateSource(id:string,body:z.infer<typeof import('./onboarding.schemas.js').updateConnectSourceSchema>,actor:string){
    const [source]=await this.db.query<any>('SELECT * FROM connect_sources WHERE id=$1',[id]);
    if(!source)throw new NotFoundException('Sorgente non trovata');
    if(body.deploymentIdentity&&body.deploymentIdentity!==source.deployment_identity&&(source.presenter_id||(await this.db.query('SELECT 1 FROM source_installation_bindings WHERE source_id=$1 LIMIT 1',[id])).length))throw new ConflictException('Identità deployment già vincolata');
    if(source.presenter_id&&body.rotateSecret)throw new ConflictException('La sorgente usa una credenziale tecnica: nessuna conversione implicita di credenziali');
    if(body.sso){
      const installations=await this.db.query<any>('SELECT i.domain FROM installations i JOIN source_installation_bindings b ON b.installation_id=i.id WHERE b.source_id=$1 AND b.enabled=true',[id]);
      const domains=installations.length?installations.map(i=>i.domain):source.origins;
      const callback=new URL(body.sso.redirectUri),issuer=new URL(body.sso.issuer);
      if(!domains.includes(callback.origin)||callback.username||callback.password||callback.hash||issuer.username||issuer.password||issuer.hash||issuer.search)throw new BadRequestException('Configurazione SSO non valida');
      if(source.environment==='production'&&(callback.protocol!=='https:'||issuer.protocol!=='https:'))throw new BadRequestException('SSO produzione richiede HTTPS');
    }
    const origins=(body.origins||source.origins) as string[];
    const catalogUrl=body.catalogUrl===undefined?source.catalog_url:body.catalogUrl;
    const callbacks=(body.oidcCallbacks||source.oidc_callbacks) as string[];
    if(catalogUrl)this.validateSourceUrls(origins,catalogUrl,callbacks);
    this.validateEnvironmentUrls(body.environment||source.environment,origins,catalogUrl,callbacks);
    const credential=body.rotateSecret?secret():null;
    return this.db.transaction(async tx=>{
      await tx.query(`UPDATE connect_sources SET name=COALESCE($2,name),environment=COALESCE($3,environment),origins=COALESCE($4,origins),
        catalog_url=$5,oidc_callbacks=COALESCE($6,oidc_callbacks),deployment_identity=COALESCE($7,deployment_identity),enabled=COALESCE($8,enabled),
        secret_hash=COALESCE($9,secret_hash),rotated_at=CASE WHEN $9::text IS NULL THEN rotated_at ELSE now() END WHERE id=$1`,
        [id,body.name??null,body.environment??null,body.origins?JSON.stringify(body.origins):null,catalogUrl,body.oidcCallbacks?JSON.stringify(body.oidcCallbacks):null,body.deploymentIdentity??null,body.enabled??null,credential?hash(credential):null]);
      if(body.sso){const old=source.configuration_cipher?JSON.parse(unseal(source.configuration_cipher)):null;const configuration={...body.sso,...(!body.sso.clientSecret&&old?.issuer===body.sso.issuer&&old?.clientId===body.sso.clientId&&old.clientSecret?{clientSecret:old.clientSecret}:{})};await tx.query('UPDATE connect_sources SET configuration_cipher=$2 WHERE id=$1',[id,seal(JSON.stringify(configuration))]);}
      const {sso,...safeBody}=body;
      await audit(tx,actor,'onboarding.source.update',id,{...safeBody,ssoConfigured:!!sso,secretRotated:!!credential});
      return {id,...safeBody,...(sso?{ssoConfigured:true}:{}),...(credential?{secret:credential}:{})};
    });
  }
  async bindInstallation(id:string,installationId:string,actor:string){
    const [source]=await this.db.query<SourceRow>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins FROM connect_sources WHERE id=$1',[id]);
    if(!source)throw new NotFoundException('Sorgente non trovata');
    const [installation]=await this.db.query<any>('SELECT id,app_id,customer_id,domain,enabled,secret_cipher FROM installations WHERE id=$1',[installationId]);
    if(!installation)throw new NotFoundException('Installazione non trovata');
    if(installation.app_id!==source.app_id)throw new ConflictException('L’installazione appartiene a un’altra applicazione');
    if(!source.origins.includes(installation.domain))throw new ConflictException('Il dominio dell’installazione non è autorizzato dalla sorgente');
    if(!installation.secret_cipher)throw new ConflictException('Ruota le credenziali dell’installazione: senza copia cifrata il contesto non può essere fornito');
    return this.db.transaction(async tx=>{
      await tx.query('INSERT INTO source_installation_bindings(source_id,installation_id,app_id) VALUES($1,$2,$3) ON CONFLICT(source_id,installation_id) DO UPDATE SET enabled=true,app_id=EXCLUDED.app_id',[id,installationId,source.app_id]);
      await audit(tx,actor,'onboarding.source.installation.bind',id,{installationId});
      return {sourceId:id,installationId,appId:source.app_id};
    });
  }
  async preassignLocalUser(sourceIdValue:string,body:z.infer<typeof import('./onboarding.schemas.js').sourceLocalUserSchema>,actor:string){
    const [source]=await this.db.query<SourceRow>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins FROM connect_sources WHERE id=$1',[sourceIdValue]);
    if(!source||!source.enabled)throw new NotFoundException('Sorgente non disponibile');
    let user:any,roles:any[];
    try{user=await this.identities.user(body.subject);roles=await this.identities.roles(body.subject);}catch{throw new ServiceUnavailableException('Servizio identità non disponibile');}
    if(!user?.enabled)throw new ConflictException('Identità SSO disabilitata');
    if(roles.some(r=>['eulab-admin','eulab-technician'].includes(r.name)))throw new ConflictException('Identità amministrativa EULab: non può essere collegata a un accesso aziendale');
    return this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding-tenant:'+source.id+':'+body.localTenantId]);
      const installation=(await tx.query<any>('SELECT i.id,i.app_id,i.customer_id,i.domain,i.enabled,i.secret_cipher,c.name AS customer_name FROM installations i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 FOR UPDATE',[body.installationId])).rows[0];
      if(!installation||!installation.enabled)throw new NotFoundException('Installazione non disponibile');
      if(installation.app_id!==source.app_id)throw new ConflictException('Installazione estranea alla sorgente');
      if(!source.origins.includes(installation.domain))throw new ConflictException('Dominio non autorizzato dalla sorgente');
      if(!installation.secret_cipher)throw new ConflictException('Ruota le credenziali dell’installazione prima di assegnare utenti');
      await tx.query('INSERT INTO source_installation_bindings(source_id,installation_id,app_id) VALUES($1,$2,$3) ON CONFLICT(source_id,installation_id) DO UPDATE SET enabled=true',[source.id,body.installationId,source.app_id]);
      const tenantBinding=(await tx.query<any>('SELECT customer_id FROM source_tenant_bindings WHERE source_id=$1 AND local_tenant_id=$2 FOR UPDATE',[source.id,body.localTenantId])).rows[0];
      if(tenantBinding&&tenantBinding.customer_id!==installation.customer_id)throw new ConflictException('L’azienda locale è già associata a un altro cliente Connect');
      await tx.query(`INSERT INTO source_tenant_bindings(source_id,local_tenant_id,customer_id,app_id,local_name,local_slug) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(source_id,local_tenant_id) DO UPDATE SET local_name=EXCLUDED.local_name,local_slug=EXCLUDED.local_slug`,[source.id,body.localTenantId,installation.customer_id,source.app_id,installation.customer_name,slugify(installation.customer_name)]);
      await tx.query('INSERT INTO identities(subject,display_name,enabled) VALUES($1,$2,true) ON CONFLICT(subject) DO NOTHING',[body.subject,`${body.firstName} ${body.lastName}`.trim()]);
      const identity=(await tx.query('SELECT enabled FROM identities WHERE subject=$1',[body.subject])).rows[0];
      if(!identity?.enabled)throw new ConflictException('Identità SSO sospesa o revocata: riattivala esplicitamente');
      await tx.query('INSERT INTO memberships(subject,customer_id,enabled) VALUES($1,$2,true) ON CONFLICT(subject,customer_id) DO NOTHING',[body.subject,installation.customer_id]);
      const membership=(await tx.query('SELECT enabled FROM memberships WHERE subject=$1 AND customer_id=$2',[body.subject,installation.customer_id])).rows[0];
      if(!membership?.enabled)throw new ConflictException('Appartenenza al cliente disabilitata: riattivala esplicitamente');
      try{await this.assertLinkAvailable(tx,body.installationId,body.localUserId,body.subject);}
      catch(error){if(error instanceof StepError)throw new ConflictException(error.message);throw error;}
      const current=(await tx.query('SELECT subject FROM app_local_users WHERE source_id=$1 AND installation_id=$2 AND local_user_id=$3 FOR UPDATE',[source.id,body.installationId,body.localUserId])).rows[0];
      if(current&&current.subject!==body.subject)throw new ConflictException('ID locale già assegnato a un’altra identità');
      const sameSubject=(await tx.query('SELECT local_user_id FROM app_local_users WHERE source_id=$1 AND installation_id=$2 AND subject=$3 AND local_user_id<>$4',[source.id,body.installationId,body.subject,body.localUserId])).rows[0];
      if(sameSubject)throw new ConflictException('Identità già collegata a un altro ID locale');
      await tx.query(`INSERT INTO local_links(installation_id,local_user_id,subject) VALUES($1,$2,$3)
        ON CONFLICT(installation_id,local_user_id) DO UPDATE SET subject=EXCLUDED.subject`,[body.installationId,body.localUserId,body.subject]);
      await tx.query(`INSERT INTO app_local_users(source_id,installation_id,app_id,local_tenant_id,local_user_id,subject,email,email_normalized,first_name,last_name,role,permissions,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(source_id,installation_id,local_user_id) DO UPDATE SET local_tenant_id=EXCLUDED.local_tenant_id,subject=EXCLUDED.subject,email=EXCLUDED.email,email_normalized=EXCLUDED.email_normalized,
          first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,role=EXCLUDED.role,permissions=EXCLUDED.permissions,enabled=EXCLUDED.enabled,updated_at=now()`,
        [source.id,body.installationId,source.app_id,body.localTenantId,body.localUserId,body.subject,body.email,body.email,body.firstName,body.lastName,body.role,JSON.stringify(body.permissions),body.enabled]);
      await audit(tx,actor,'onboarding.local_user.preassign',body.localUserId,{sourceId:source.id,installationId:body.installationId,localTenantId:body.localTenantId,subject:body.subject,role:body.role,enabled:body.enabled});
      return {sourceId:source.id,installationId:body.installationId,localTenantId:body.localTenantId,localUserId:body.localUserId,subject:body.subject};
    });
  }
  async removeLocalUser(sourceIdValue:string,installationId:string,localUserId:string,actor:string){
    return this.db.transaction(async tx=>{
      const removed=await tx.query('DELETE FROM app_local_users WHERE source_id=$1 AND installation_id=$2 AND local_user_id=$3 RETURNING subject',[sourceIdValue,installationId,localUserId]);
      if(!removed.rowCount)throw new NotFoundException('Collegamento non trovato');
      await tx.query('DELETE FROM local_links WHERE installation_id=$1 AND local_user_id=$2 AND subject=$3',[installationId,localUserId,removed.rows[0].subject]);
      await audit(tx,actor,'onboarding.local_user.remove',localUserId,{sourceId:sourceIdValue,installationId,subject:removed.rows[0].subject});
      return {removed:true};
    });
  }

  // ---------- pannello pratiche ----------

  async listPractices(){
    return this.db.query(`SELECT p.id,p.kind,p.state,p.source_id AS "sourceId",p.app_id AS "appId",p.local_tenant_id AS "localTenantId",p.tenant_name AS "tenantName",p.tenant_slug AS "tenantSlug",
      p.target_customer_id AS "customerId",p.target_installation_id AS "installationId",p.safe_error AS "safeError",p.created_at AS "createdAt",p.updated_at AS "updatedAt",p.completed_at AS "completedAt",
      (SELECT count(*)::int FROM onboarding_requests r WHERE r.practice_id=p.id) AS "requestCount",
      (SELECT count(*)::int FROM onboarding_requests r WHERE r.practice_id=p.id AND r.state='completed') AS "completedCount",
      (SELECT count(*)::int FROM onboarding_requests r WHERE r.practice_id=p.id AND r.password_cipher IS NOT NULL) AS "credentialCount",
      (SELECT min(r.password_expires_at) FROM onboarding_requests r WHERE r.practice_id=p.id AND r.password_cipher IS NOT NULL) AS "credentialExpiresAt"
      FROM onboarding_practices p ORDER BY p.updated_at DESC LIMIT 500`);
  }
  private async reviewOptions(source:SourceRow){
    const [applications,customers,installations]=await Promise.all([
      this.db.query<any>('SELECT id,name,description,catalog_url FROM applications ORDER BY name'),
      this.db.query<any>('SELECT id,name,reference FROM customers ORDER BY name'),
      this.db.query<any>('SELECT id,app_id,customer_id,domain,base_path,enabled FROM installations ORDER BY created_at')
    ]);
    const verified=source.approved_app_id||source.verified_app_id||(!source.presenter_id?source.app_id:null);
    const candidate=applications.find(a=>a.id===verified);
    const declared=applications.find(a=>a.id===source.app_id);
    const differences:string[]=[];
    if(candidate&&candidate.id!==source.app_id)differences.push('app_id_differs');
    if(declared&&declared.name!==source.name)differences.push('name_differs');
    if(declared?.catalog_url&&declared.catalog_url!==source.catalog_url)differences.push('catalog_url_differs');
    if(declared&&!candidate)differences.push('declared_app_unverified');
    return {applications,customers,installations,verifiedApplicationId:candidate?.id||null,declaredApplicationId:source.app_id,differences};
  }

  async practiceDetail(id:string){
    const [practice]=await this.db.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1',[id]);
    if(!practice)throw new NotFoundException('Pratica non trovata');
    const [source]=await this.db.query<any>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins FROM connect_sources WHERE id=$1',[practice.source_id]);
    const requests=await this.db.query<any>(`SELECT id,kind,local_tenant_id AS "localTenantId",local_user_id AS "localUserId",email,first_name AS "firstName",last_name AS "lastName",role,permissions,state,consent_version AS "consentVersion",
      identity_subject AS "identitySubject",action_required AS "actionRequired",safe_error AS "safeError",checkpoint,created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt",
      (password_cipher IS NOT NULL) AS "credentialPresent",password_expires_at AS "credentialExpiresAt",password_deleted_at AS "credentialDestroyedAt",password_consumed_at AS "credentialConsumedAt"
      FROM onboarding_requests WHERE practice_id=$1 ORDER BY created_at,email`,[id]);
    const missing=await this.missingPrerequisites(practice,requests,source);
    const review=source?await this.reviewOptions(source):null;
    const target=practice.target_installation_id?await this.db.query<any>(`SELECT i.id,i.domain,i.base_path AS "basePath",i.enabled,i.app_id AS "appId",i.customer_id AS "customerId",
      (i.secret_cipher IS NOT NULL) AS "secretAvailable",a.name AS "applicationName",a.catalog_version AS "catalogVersion" FROM installations i LEFT JOIN applications a ON a.id=i.app_id WHERE i.id=$1`,[practice.target_installation_id]):[];
    return {id:practice.id,kind:practice.kind,state:practice.state,source:source?{...source,catalogUrl:source.catalog_url,oidcCallbacks:source.oidc_callbacks,deploymentIdentity:source.deployment_identity}:null,
      tenant:{localId:practice.local_tenant_id,name:practice.tenant_name,slug:practice.tenant_slug},plan:practice.plan||null,checkpoint:practice.checkpoint,
      customerId:practice.target_customer_id,installation:target[0]||null,safeError:practice.safe_error,createdAt:practice.created_at,updatedAt:practice.updated_at,completedAt:practice.completed_at,
      requests,review,missing,canExecute:missing.length===0&&!(['completed','rejected','expired','migrating'].includes(practice.state))};
  }
  private async validatePlanTargets(practice:PracticeRow,source:SourceRow,plan:any){
    if(source.presenter_id&&(!plan.application||!plan.customer||!plan.installation))throw new BadRequestException('Seleziona o crea applicazione, cliente e installazione');
    const appId=plan.application?.id||source.approved_app_id||source.app_id;
    if(practice.checkpoint?.appId&&practice.checkpoint.appId!==appId)throw new ConflictException('Applicazione già preparata: collegamento non sostituibile');
    if(source.approved_app_id&&appId!==source.approved_app_id)throw new ConflictException('Il deployment è già collegato a un’altra app');
    if(plan.application){
      const [app]=await this.db.query<any>('SELECT id FROM applications WHERE id=$1',[appId]);
      if(plan.application.mode==='existing'&&!app)throw new BadRequestException('App selezionata assente');
      if(plan.application.mode==='create'&&app&&practice.checkpoint?.appId!==appId)throw new ConflictException('App ID già occupato: seleziona esplicitamente l’app esistente');
    }
    if(plan.customer?.mode==='existing'&&!(await this.db.query('SELECT id FROM customers WHERE id=$1',[plan.customer.id])).length)throw new BadRequestException('Cliente selezionato assente');
    let domain=plan.installation?.domain;
    if(plan.installation?.mode==='existing'){
      const [installation]=await this.db.query<any>('SELECT * FROM installations WHERE id=$1',[plan.installation.id]);
      if(!installation||!installation.enabled)throw new ConflictException('Installazione assente o sospesa');
      if(installation.app_id!==appId||plan.customer?.mode!=='existing'||installation.customer_id!==plan.customer.id)throw new ConflictException('Installazione incompatibile con app e cliente selezionati');
      domain=installation.domain;
      const [binding]=await this.db.query<any>('SELECT enabled FROM source_installation_bindings WHERE source_id=$1 AND installation_id=$2',[source.id,installation.id]);
      if(binding?.enabled===false)throw new ConflictException('Collegamento sorgente sospeso');
    }
    if(plan.sso){
      const callback=new URL(plan.sso.redirectUri),issuer=new URL(plan.sso.issuer);
      const acceptedDomain=domain||source.origins[0];
      if(callback.origin!==acceptedDomain||callback.username||callback.password||callback.hash||issuer.username||issuer.password||issuer.hash||issuer.search)throw new BadRequestException('Configurazione SSO non coerente con l’installazione');
      if(source.environment==='production'&&(callback.protocol!=='https:'||issuer.protocol!=='https:'))throw new BadRequestException('SSO produzione richiede HTTPS');
    }
  }

  async savePlan(id:string,plan:z.infer<typeof onboardingPlanSchema>,actor:string){
    const [practice]=await this.db.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1',[id]);
    if(!practice)throw new NotFoundException('Pratica non trovata');
    if(['completed','rejected','expired','migrating'].includes(practice.state))throw new ConflictException('La pratica non è più modificabile');
    const requests=await this.db.query<RequestRow>('SELECT * FROM onboarding_requests WHERE practice_id=$1',[id]);
    if(plan.license){
      const unique=new Set(plan.license.features.map(f=>f.key));if(unique.size!==plan.license.features.length)throw new ConflictException('Funzioni della licenza duplicate');
    }
    const roles=new Set<string>(),roleNames=new Set<string>();
    for(const role of plan.roles){
      if(roles.has(role.localRole))throw new ConflictException('Mappatura del ruolo locale duplicata: '+role.localRole);
      roles.add(role.localRole);
      if(roleNames.has(role.roleName))throw new ConflictException('Nome ruolo Connect duplicato: '+role.roleName);
      roleNames.add(role.roleName);
      if(new Set(role.permissions).size!==role.permissions.length)throw new ConflictException('Permessi del ruolo duplicati');
    }
    if(plan.activation&&practice.kind!=='activation')throw new BadRequestException('Assegnazione di attivazione non applicabile a una migrazione');
    const source=(await this.db.query<SourceRow>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins FROM connect_sources WHERE id=$1',[practice.source_id]))[0];
    await this.validatePlanTargets(practice,source,plan);
    const storedPlan=structuredClone(plan);
    if(storedPlan.sso)delete storedPlan.sso.clientSecret;
    await this.db.transaction(async tx=>{
      const locked=(await tx.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!locked||['completed','rejected','expired','migrating'].includes(locked.state))throw new ConflictException('Pratica non modificabile');
      if(plan.sso){
        const previous=(await tx.query<any>('SELECT configuration_cipher FROM onboarding_practices WHERE id=$1',[id])).rows[0];
        const old=previous?.configuration_cipher?JSON.parse(unseal(previous.configuration_cipher)):null;
        const configuration={...plan.sso,...(!plan.sso.clientSecret&&old?.issuer===plan.sso.issuer&&old?.clientId===plan.sso.clientId&&old.clientSecret?{clientSecret:old.clientSecret}:{})};
        await tx.query('UPDATE onboarding_practices SET configuration_cipher=$2 WHERE id=$1',[id,seal(JSON.stringify(configuration))]);
      }
      await tx.query('UPDATE onboarding_practices SET plan=$2,updated_at=now(),safe_error=\'\' WHERE id=$1',[id,JSON.stringify(storedPlan)]);
      await audit(tx,actor,'onboarding.practice.plan',id,{license:plan.license||null,roles:plan.roles.map(r=>({localRole:r.localRole,roleName:r.roleName,permissions:r.permissions})),activation:plan.activation||null,identityLinks:plan.identities?Object.keys(plan.identities).length:0});
    });
    const updated=(await this.db.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1',[id]))[0];
    const refreshed=await this.db.query<any>('SELECT id,email,role,kind,state,password_cipher,password_expires_at,identity_subject,action_required FROM onboarding_requests WHERE practice_id=$1',[id]);
    const missing=await this.missingPrerequisites(updated,refreshed,source);
    if(missing.length===0&&['pending','failed'].includes(updated.state)){
      await this.db.query(`UPDATE onboarding_practices SET state='approved',updated_at=now() WHERE id=$1 AND state IN ('pending','failed')`,[id]);
      updated.state='approved';
    }
    return {saved:true,state:updated.state,missing,canExecute:missing.length===0};
  }
  async rejectPractice(id:string,reason:string,actor:string){
    return this.db.transaction(async tx=>{
      const [practice]=await tx.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1 FOR UPDATE',[id]).then(r=>r.rows);
      if(!practice)throw new NotFoundException('Pratica non trovata');
      if(practice.state==='completed')throw new ConflictException('La pratica è già completata');
      if(practice.state==='migrating')throw new ConflictException('Esecuzione già in corso: il rifiuto non può essere applicato');
      await tx.query(`UPDATE onboarding_requests SET state='rejected',password_cipher=null,password_deleted_at=now(),safe_error=$2,action_required='',updated_at=now(),completed_at=now()
        WHERE practice_id=$1 AND state NOT IN ('completed','rejected')`,[id,reason]);
      await tx.query(`UPDATE onboarding_practices SET state='rejected',safe_error=$2,updated_at=now(),completed_at=now() WHERE id=$1`,[id,reason]);
      await audit(tx,actor,'onboarding.practice.reject',id,{reason});
      return {id,state:'rejected'};
    });
  }
  async rejectRequest(practiceId:string,id:string,reason:string,actor:string){
    return this.db.transaction(async tx=>{
      // Lock the same parent row used by execution and submission before any person row.
      const practice=(await tx.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1 FOR UPDATE',[practiceId])).rows[0];
      if(!practice)throw new NotFoundException('Pratica non trovata');
      if(practice.state==='migrating')throw new ConflictException('Esecuzione già in corso: il rifiuto non può essere applicato');
      const request=(await tx.query<RequestRow>('SELECT * FROM onboarding_requests WHERE id=$1 AND practice_id=$2 FOR UPDATE',[id,practiceId])).rows[0];
      if(!request)throw new NotFoundException('Richiesta non trovata');
      if(request.state==='completed')throw new ConflictException('La richiesta è già completata');
      await tx.query(`UPDATE onboarding_requests SET state='rejected',password_cipher=null,password_deleted_at=now(),safe_error=$2,action_required='',updated_at=now(),completed_at=now() WHERE id=$1`,[id,reason]);
      await tx.query(`UPDATE onboarding_practices SET state=CASE
        WHEN EXISTS(SELECT 1 FROM onboarding_requests WHERE practice_id=$1 AND state NOT IN ('completed','rejected')) THEN state
        WHEN EXISTS(SELECT 1 FROM onboarding_requests WHERE practice_id=$1 AND state='completed') THEN 'completed'
        ELSE 'rejected' END,
        completed_at=CASE WHEN EXISTS(SELECT 1 FROM onboarding_requests WHERE practice_id=$1 AND state='completed')
          AND NOT EXISTS(SELECT 1 FROM onboarding_requests WHERE practice_id=$1 AND state NOT IN ('completed','rejected')) THEN now() ELSE completed_at END,
        updated_at=now() WHERE id=$1`,[request.practice_id]);
      await audit(tx,actor,'onboarding.request.reject',id,{reason});
      return {id,state:'rejected'};
    });
  }

  // ---------- preparazione ed esecuzione ----------

  async resolutionProposal(id:string){
    const detail=await this.practiceDetail(id);
    if(detail.state==='completed')return detail;
    if(['rejected','expired','migrating'].includes(detail.state))throw new ConflictException('La pratica è chiusa o in esecuzione');
    const source=detail.source;
    if(!source?.enabled)throw new ConflictException('Sorgente disabilitata');
    try{
      const plan:any=structuredClone(detail.plan||{roles:[]});
      const appId=plan.application?.id||source.approved_app_id||source.verified_app_id||source.app_id;
      if(!plan.application){
        const existing=detail.review?.applications.find(a=>a.id===appId);
        plan.application=existing?{mode:'existing',id:appId}:{mode:'create',id:appId,name:source.name};
      }
      const [binding]=await this.db.query<any>('SELECT customer_id FROM source_tenant_bindings WHERE source_id=$1 AND local_tenant_id=$2',[source.id,detail.tenant.localId]);
      plan.customer??=binding?{mode:'existing',id:binding.customer_id}:{mode:'create',name:detail.tenant.name};
      const catalogUrl=source.catalog_url;
      if(!catalogUrl)throw new StepError('catalog_source_missing','Il deployment non ha dichiarato l’URL del catalogo');
      const domain=new URL(catalogUrl).origin;
      if(!source.origins.includes(domain))throw new StepError('catalog_origin_mismatch','Il catalogo non appartiene alle origini del deployment');
      if(!plan.installation){
        const bound=await this.db.query<any>('SELECT i.id FROM source_installation_bindings b JOIN installations i ON i.id=b.installation_id WHERE b.source_id=$1 AND i.customer_id=$2 AND i.app_id=$3',[source.id,binding?.customer_id||null,appId]);
        if(bound.length>1)throw new StepError('installation_ambiguous','Più installazioni collegate: seleziona quella corretta nelle opzioni avanzate');
        plan.installation=bound.length?{mode:'existing',id:bound[0].id}:{mode:'create',domain,basePath:''};
      }
      let document:unknown;
      try{document=await this.catalogReader.read(catalogUrl);}catch{throw new StepError('catalog_unreachable','Catalogo del deployment non raggiungibile: verifica URL e collegamento di rete');}
      const parsed=functionMatrixSchema.safeParse(document);
      if(!parsed.success||parsed.data.appId!==appId)throw new StepError('catalog_invalid','Catalogo non valido o riferito a un’altra applicazione');
      const keys=new Set(parsed.data.functions.map(f=>f.key));
      const names:Record<string,string>={owner:'Titolare',manager:'Responsabile',reception:'Reception',collaborator:'Collaboratore'};
      if(detail.kind==='activation')plan.activation??={localTenantId:'tenant-'+id,localUserId:'user-'+detail.requests[0].id,localRole:'owner'};
      plan.roles??=[];
      for(const request of detail.requests){
        if(['rejected','expired'].includes(request.state))continue;
        const role=request.role||plan.activation?.localRole||'owner';
        if(!plan.roles.some((r:any)=>r.localRole===role)){
          const permissions=[...keys];
          plan.roles.push({localRole:role,roleName:names[role]||role,permissions});
        }
      }
      const granted=new Set<string>(plan.roles.flatMap((r:any)=>r.permissions));
      plan.license??={state:'active',expiresAt:null,features:[...granted].map(key=>({key,purchased:true,enabled:true}))};
      return {plan:onboardingPlanSchema.parse(plan),functions:parsed.data.functions,identities:await this.identities.list()};
    }catch(error){
      if(error instanceof StepError){
        throw new ConflictException({message:error.message,code:error.code});
      }
      throw error;
    }
  }

  async resolvePractice(id:string,plan:z.infer<typeof onboardingPlanSchema>,actor:string){
    const detail=await this.practiceDetail(id);
    if(detail.state==='completed')return detail;
    if(['rejected','expired','migrating'].includes(detail.state))throw new ConflictException('La pratica è chiusa o in esecuzione');
    const source=detail.source;
    if(!source?.enabled)throw new ConflictException('Sorgente disabilitata');
    // Confirmed targets and identity subjects are administrative choices, never email matches.
    const practice=(await this.db.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1',[id]))[0];
    await this.validatePlanTargets(practice,source,plan);
    const requests=await this.db.query<RequestRow>('SELECT * FROM onboarding_requests WHERE practice_id=$1',[id]);
    const missing=await this.missingPrerequisites({...practice,plan},requests,source);
    if(missing.length)throw new ConflictException({message:'Prerequisiti mancanti',missing});
    for(const subject of Object.values(plan.identities||{}))await this.verifyLinkableIdentity(subject);
    try{
      if(!plan.sso){
        if(source.oidc_callbacks.length!==1)throw new StepError('callback_ambiguous','Il deployment deve dichiarare una sola callback SSO oppure una configurazione esplicita');
        const redirectUri=source.oidc_callbacks[0];
        if(!source.origins.includes(new URL(redirectUri).origin))throw new StepError('callback_invalid','Callback SSO esterna alle origini del deployment');
        plan={...plan,sso:await this.ensureResolutionClient(source.id,redirectUri)};
      }
      await this.savePlan(id,plan,actor);
      return await this.executePractice(id,actor);
    }catch(error){
      if(error instanceof StepError)throw new ConflictException({message:error.message,code:error.code});
      throw error;
    }
  }

  private async ensureResolutionClient(sourceId:string,redirectUri:string){
    const clientId='connect-deployment-'+hash(sourceId).slice(0,24);
    const path='/clients?clientId='+encodeURIComponent(clientId);
    let clients=(await this.identities.request(path)).body;
    if(!clients.length){
      try{await this.identities.request('/clients','POST',{clientId,enabled:true,protocol:'openid-connect',publicClient:false,standardFlowEnabled:true,directAccessGrantsEnabled:false,serviceAccountsEnabled:false,redirectUris:[redirectUri],webOrigins:[new URL(redirectUri).origin],attributes:{'connect.sourceId':sourceId,'pkce.code.challenge.method':'S256'},defaultClientScopes:['basic','profile','email']});}
      catch(error){if(!(error instanceof ConflictException))throw error;}
      clients=(await this.identities.request(path)).body;
    }
    const client=clients[0];
    if(!client||client.attributes?.['connect.sourceId']!==sourceId||!client.enabled||client.publicClient||client.redirectUris?.length!==1||client.redirectUris[0]!==redirectUri)throw new StepError('sso_client_conflict','Client SSO esistente incompatibile con il deployment');
    // Every deployment access token calls /v1/access, whose audience is connect-api.
    // Reconcile only this deployment-owned client after the ownership checks above.
    const scopePath='/clients/'+encodeURIComponent(client.id)+'/default-client-scopes';
    const defaultScopes=(await this.identities.request(scopePath)).body as {id:string;name:string}[];
    if(!defaultScopes.some(scope=>scope.name==='basic')){
      const scopes=(await this.identities.request('/client-scopes')).body as {id:string;name:string}[];
      const basic=scopes.find(scope=>scope.name==='basic');
      if(!basic)throw new StepError('sso_client_conflict','Scope basic del provider mancante: necessario il subject negli access token');
      await this.identities.request(scopePath+'/'+encodeURIComponent(basic.id),'PUT');
    }
    const mapperPath='/clients/'+encodeURIComponent(client.id)+'/protocol-mappers/models';
    const mappers=(await this.identities.request(mapperPath)).body as any[];
    const audience=mappers.find(m=>m.name==='connect-api-audience');
    if(audience&&(audience.protocol!=='openid-connect'||audience.protocolMapper!=='oidc-audience-mapper'||audience.config?.['included.client.audience']!=='connect-api'||audience.config?.['access.token.claim']!=='true'||audience.config?.['introspection.token.claim']!=='true'||audience.config?.['id.token.claim']!=='false'))throw new StepError('sso_client_conflict','Audience del client SSO esistente incompatibile con Connect');
    if(!audience)await this.identities.request(mapperPath,'POST',{name:'connect-api-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.client.audience':'connect-api','id.token.claim':'false','access.token.claim':'true','introspection.token.claim':'true'}});
    const credential=(await this.identities.request('/clients/'+encodeURIComponent(client.id)+'/client-secret')).body;
    if(!credential?.value)throw new StepError('sso_secret_missing','Segreto del client SSO non disponibile');
    return {issuer:process.env.OIDC_ISSUER!,clientId,redirectUri,clientSecret:credential.value};
  }

  async preparePractice(id:string,actor:string){
    const [practice]=await this.db.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1',[id]);
    if(!practice)throw new NotFoundException('Pratica non trovata');
    if(['completed','rejected','expired','migrating'].includes(practice.state))throw new ConflictException('La pratica non è più preparabile');
    const [source]=await this.db.query<SourceRow>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins FROM connect_sources WHERE id=$1',[practice.source_id]);
    if(!source)throw new NotFoundException('Sorgente non trovata');
    if(!source.enabled)throw new ConflictException('Sorgente di deployment disabilitata');
    try{
      if(source.presenter_id){
        if(!practice.plan)throw new StepError('plan_missing','Nessun piano salvato: completa la proposta e premi Salva piano');
        await this.validatePlanTargets(practice,source,practice.plan);
        await this.db.query(`UPDATE onboarding_practices SET safe_error='',updated_at=now() WHERE id=$1`,[id]);
        return this.practiceDetail(id);
      }
      const context=await this.prepareInternal(practice,source,actor);
      await this.db.query(`UPDATE onboarding_practices SET safe_error='',updated_at=now() WHERE id=$1`,[id]);
      return {...await this.practiceDetail(id),prepared:{customerId:context.customerId,installationId:context.installationId,appId:context.appId}};
    }catch(error){
      const safe=this.safeError(error);
      await this.db.query(`UPDATE onboarding_practices SET safe_error=$2,updated_at=now() WHERE id=$1`,[id,safe.message]);
      if(error instanceof StepError)throw new ConflictException({message:safe.message,code:safe.code});
      throw error;
    }
  }

  async executePractice(id:string,actor:string){
    await this.sweepExpired();
    const [claimed]=await this.db.query<PracticeRow>(`UPDATE onboarding_practices SET state='migrating',updated_at=now(),safe_error=''
      WHERE id=$1 AND (state IN ('pending','approved','failed') OR (state='migrating' AND updated_at<now()-interval '5 minutes')) RETURNING *`,[id]);
    if(!claimed){
      const [current]=await this.db.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1',[id]);
      if(!current)throw new NotFoundException('Pratica non trovata');
      if(current.state==='completed')return this.practiceDetail(id);
      if(['rejected','expired'].includes(current.state))throw new ConflictException('La pratica è chiusa');
      throw new ConflictException('Esecuzione già in corso: attendi o riprendi dopo la riconciliazione');
    }
    try{
      const [source]=await this.db.query<SourceRow>('SELECT id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,enabled,presenter_id,integration_approved,approved_app_id,verified_app_id,verified_origins FROM connect_sources WHERE id=$1',[claimed.source_id]);
      if(!source||!source.enabled)throw new StepError('source_disabled','Sorgente disabilitata');
      const requests=await this.db.query<RequestRow>('SELECT * FROM onboarding_requests WHERE practice_id=$1 ORDER BY created_at,email',[id]);
      const missing=await this.missingPrerequisites(claimed,requests,source);
      if(missing.length)throw new PreconditionError(missing);
      const context=await this.prepareInternal(claimed,source,actor);
      const practice=(await this.db.query<PracticeRow>('SELECT * FROM onboarding_practices WHERE id=$1',[id]))[0];
      const effectiveSource={...source,app_id:context.appId};
      await this.applyLicense(practice,effectiveSource,actor);
      for(const request of requests){
        if(['completed','rejected','expired'].includes(request.state))continue;
        await this.migratePerson(practice,effectiveSource,request,context,actor);
      }
      const finalRequests=await this.db.query<RequestRow>('SELECT * FROM onboarding_requests WHERE practice_id=$1',[id]);
      const completed=finalRequests.length>0&&finalRequests.every(r=>['completed','rejected'].includes(r.state))
        &&finalRequests.some(r=>r.state==='completed');
      const failed=finalRequests.find(r=>!['completed','rejected'].includes(r.state));
      if(completed){
        await this.db.query(`UPDATE onboarding_practices SET state='completed',safe_error='',completed_at=now(),updated_at=now() WHERE id=$1`,[id]);
        if(source.presenter_id)await this.db.query("UPDATE connect_sources SET integration_approved=true,approved_app_id=$2,configuration_cipher=COALESCE((SELECT configuration_cipher FROM onboarding_practices WHERE id=$3),configuration_cipher) WHERE id=$1",[source.id,context.appId,practice.id]);
        await this.audit(undefined,'onboarding.practice.completed',id,{sourceId:source.id,appId:source.app_id,installationId:context.installationId,customerId:context.customerId,people:finalRequests.length});
      }else{
        await this.db.query(`UPDATE onboarding_practices SET state='failed',safe_error=$2,updated_at=now() WHERE id=$1`,[id,failed?.safe_error||'Una o più richieste non sono state completate']);
      }
      return this.practiceDetail(id);
    }catch(error){
      if(error instanceof PreconditionError){
        await this.db.query(`UPDATE onboarding_practices SET state='approved',safe_error='Prerequisiti mancanti',updated_at=now() WHERE id=$1`,[id]);
        throw new ConflictException({message:'Prerequisiti mancanti',missing:error.missing});
      }
      const safe=this.safeError(error);
      await this.db.query(`UPDATE onboarding_practices SET state='failed',safe_error=$2,updated_at=now() WHERE id=$1`,[id,safe.message]);
      await this.audit(undefined,'onboarding.practice.failed',id,{code:safe.code});
      if(error instanceof StepError)throw new ConflictException({message:safe.message,code:safe.code});
      if(error instanceof ConflictException||error instanceof BadRequestException)throw error;
      throw new ConflictException({message:safe.message,code:safe.code});
    }
  }

  private async prepareInternal(practice:PracticeRow,source:SourceRow,actor:string){
    if(!source.origins.length)throw new StepError('source_origin_missing','La sorgente non dichiara un’origine autorizzata');
    if(!source.catalog_url)throw new StepError('catalog_source_missing','La sorgente non dichiara l’URL del catalogo');
    const plan=practice.plan||{roles:[]};
    let localTenantId=practice.local_tenant_id;
    if(practice.kind==='activation'){
      localTenantId=plan.activation?.localTenantId||null;
      if(!localTenantId)throw new StepError('activation_assignment_missing','Assegna localTenantId e localUserId prima di preparare la pratica');
    }
    if(!localTenantId)throw new StepError('tenant_missing','Azienda locale assente');
    await this.validatePlanTargets(practice,source,plan);
    const app=await this.ensureApplication(practice,source,actor);
    const effectiveSource={...source,app_id:app.id};
    if(app.catalog_url){
      let catalogOrigin='';
      try{catalogOrigin=new URL(app.catalog_url).origin;}catch{throw new StepError('catalog_source_invalid','URL del catalogo dell’applicazione non valido');}
      if(!plan.application&&!source.origins.includes(catalogOrigin))throw new StepError('catalog_origin_mismatch','Il catalogo dell’applicazione non appartiene a un’origine autorizzata dalla sorgente');
    }
    const target=await this.ensureCustomerAndInstallation(practice,effectiveSource,localTenantId,actor);
    await this.ensureCatalog(app.id,effectiveSource,target.installationId,actor);
    await this.db.query(`UPDATE onboarding_practices SET target_customer_id=$2,target_installation_id=$3,local_tenant_id=COALESCE(local_tenant_id,$4),
      checkpoint=COALESCE(checkpoint,'{}'::jsonb)||$5::jsonb,updated_at=now() WHERE id=$1`,
      [practice.id,target.customerId,target.installationId,localTenantId,JSON.stringify({preparedAt:new Date().toISOString(),appId:app.id,customerId:target.customerId,installationId:target.installationId})]);
    return {appId:app.id,customerId:target.customerId,installationId:target.installationId};
  }

  private async ensureApplication(practice:PracticeRow,source:SourceRow,actor:string){
    const choice=practice.plan?.application,appId=choice?.id||source.approved_app_id||source.app_id;
    return this.db.transaction(async tx=>{
      const owner=(await tx.query<any>('SELECT approved_app_id FROM connect_sources WHERE id=$1 FOR UPDATE',[source.id])).rows[0];
      if(owner.approved_app_id&&owner.approved_app_id!==appId)throw new ConflictException('Provenienza già vincolata a un’altra app');
      let app=(await tx.query<any>('SELECT * FROM applications WHERE id=$1',[appId])).rows[0];
      if(app){if(choice?.mode==='create'&&practice.checkpoint?.appId!==appId)throw new ConflictException('App ID occupato');}
      else{
        if(choice?.mode==='existing')throw new NotFoundException('App selezionata non presente');
        await tx.query('INSERT INTO applications(id,name,description,catalog_url) VALUES($1,$2,$3,$4)',[appId,choice?.name||source.name,choice?.description||'Applicazione registrata dalla sorgente di deployment',source.catalog_url]);
        app=(await tx.query<any>('SELECT * FROM applications WHERE id=$1',[appId])).rows[0];
        await audit(tx,actor,'onboarding.application.ensure',appId,{sourceId:source.id});
      }
      await tx.query('UPDATE connect_sources SET approved_app_id=$2 WHERE id=$1',[source.id,appId]);
      await tx.query('UPDATE onboarding_practices SET checkpoint=checkpoint||$2::jsonb WHERE id=$1',[practice.id,JSON.stringify({appId})]);
      return app;
    });
  }

  private async ensureCustomerAndInstallation(practice:PracticeRow,source:SourceRow,localTenantId:string,actor:string){
    return this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding-tenant:'+source.id+':'+localTenantId]);
      const plan=practice.plan||{};
      let binding=(await tx.query<any>('SELECT * FROM source_tenant_bindings WHERE source_id=$1 AND local_tenant_id=$2',[source.id,localTenantId])).rows[0];
      if(binding&&(binding.app_id!==source.app_id||(plan.customer?.mode==='existing'&&binding.customer_id!==plan.customer.id)))throw new StepError('tenant_binding_conflict','L’azienda locale ha già un collegamento differente');
      if(!binding){
        const customerId=plan.customer?.mode==='existing'?plan.customer.id:randomUUID();
        if(plan.customer?.mode==='existing'){
          if(!(await tx.query('SELECT id FROM customers WHERE id=$1',[customerId])).rows.length)throw new StepError('customer_missing','Cliente selezionato non presente');
        }else{
          await tx.query('INSERT INTO customers(id,name,reference) VALUES($1,$2,$3)',[customerId,plan.customer?.name||practice.tenant_name||practice.id,'Connect source '+source.id+' · '+localTenantId]);
          await audit(tx,actor,'onboarding.customer.ensure',customerId,{sourceId:source.id,localTenantId});
        }
        binding=(await tx.query<any>(`INSERT INTO source_tenant_bindings(source_id,local_tenant_id,customer_id,app_id,local_name,local_slug)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[source.id,localTenantId,customerId,source.app_id,practice.tenant_name,practice.tenant_slug])).rows[0];
      }
      const bound=(await tx.query<any>('SELECT i.*,b.enabled AS source_enabled FROM source_installation_bindings b JOIN installations i ON i.id=b.installation_id WHERE b.source_id=$1 AND b.app_id=$2 AND i.customer_id=$3 ORDER BY b.created_at',[source.id,source.app_id,binding.customer_id])).rows;
      if(bound.length>1&&!plan.installation)throw new StepError('installation_ambiguous','Seleziona esplicitamente l’installazione');
      let installation=plan.installation?.mode==='existing'?(await tx.query<any>('SELECT * FROM installations WHERE id=$1',[plan.installation.id])).rows[0]:bound[0];
      if(plan.installation?.mode==='existing'&&(!installation||installation.app_id!==source.app_id||installation.customer_id!==binding.customer_id))throw new StepError('installation_conflict','Installazione non coerente con app e cliente');
      const catalogOrigin=source.catalog_url?new URL(source.catalog_url).origin:'';
      const domain=plan.installation?.domain||(source.origins.includes(catalogOrigin)?catalogOrigin:source.origins[0]);
      if(!installation&&!plan.installation){
        const matches=(await tx.query<any>('SELECT * FROM installations WHERE customer_id=$1 AND app_id=$2 AND domain=$3 ORDER BY created_at',[binding.customer_id,source.app_id,domain])).rows;
        if(matches.length>1)throw new StepError('installation_ambiguous','Seleziona esplicitamente l’installazione');
        installation=matches[0];
      }
      if(!installation){
        // Existing binding is the durable creation checkpoint. Never adopt an unrelated occupied installation.
        const id=randomUUID(),credential=secret(),basePath=plan.installation?.basePath||'',fallback=domain+basePath+'/eulab/connect/functions';
        await tx.query(`INSERT INTO installations(id,customer_id,app_id,domain,secret_hash,secret_cipher,description,integration,base_path,fallback_url)
          VALUES($1,$2,$3,$4,$5,$6,$7,'web',$8,$9)`,[id,binding.customer_id,source.app_id,domain,hash(credential),seal(credential),'Creata dalla pratica di onboarding',basePath,fallback]);
        installation=(await tx.query<any>('SELECT * FROM installations WHERE id=$1',[id])).rows[0];
        await audit(tx,actor,'onboarding.installation.ensure',id,{sourceId:source.id,customerId:binding.customer_id,appId:source.app_id,domain});
      }
      if(plan.installation?.mode==='create'&&(installation.domain!==domain||installation.base_path!==(plan.installation.basePath||'')))throw new StepError('installation_plan_changed','Installazione già preparata con metadati differenti');
      if(!installation.enabled)throw new StepError('installation_disabled','Installazione sospesa');
      if(!installation.secret_cipher)throw new StepError('installation_secret_missing','Segreto installazione non disponibile: ruota le credenziali dal pannello');
      const previous=(await tx.query<any>('SELECT enabled FROM source_installation_bindings WHERE source_id=$1 AND installation_id=$2',[source.id,installation.id])).rows[0];
      if(previous?.enabled===false)throw new StepError('source_binding_disabled','Collegamento sorgente sospeso');
      await tx.query('INSERT INTO source_installation_bindings(source_id,installation_id,app_id) VALUES($1,$2,$3) ON CONFLICT(source_id,installation_id) DO NOTHING',[source.id,installation.id,source.app_id]);
      await tx.query('UPDATE source_tenant_bindings SET local_name=$3,local_slug=$4 WHERE source_id=$1 AND local_tenant_id=$2',[source.id,localTenantId,practice.tenant_name,practice.tenant_slug]);
      return {customerId:binding.customer_id,installationId:installation.id};
    });
  }

  private async ensureCatalog(appId:string,source:SourceRow,installationId:string,actor:string){
    const app=(await this.db.query<any>('SELECT * FROM applications WHERE id=$1',[appId]))[0];
    if(app.catalog_version>0)return;
    if(!app.catalog_url){
      if(!source.catalog_url)throw new StepError('catalog_source_missing','URL del catalogo non configurato');
      await this.sources.configure(appId,source.catalog_url,actor,installationId);
    }
    const result=await this.sources.sync(appId,actor);
    if(!result.ok)throw new StepError('catalog_sync_failed','Sincronizzazione del catalogo non riuscita: '+String(result.error||'').slice(0,200));
  }

  private async applyLicense(practice:PracticeRow,source:SourceRow,actor:string){
    const plan=practice.plan;
    if(!plan?.license)throw new PreconditionError([{code:'license_plan_missing',label:'Definisci licenza e funzioni'}]);
    if(plan.license.state!=='active')throw new PreconditionError([{code:'license_not_active',label:'La licenza approvata non è attiva'}]);
    if(!practice.target_customer_id)throw new StepError('customer_missing','Cliente Connect non preparato');
    const features=plan.license.features as {key:string;purchased:boolean;enabled:boolean}[];
    for(const f of features){
      const feature=(await this.db.query<any>('SELECT key FROM features WHERE app_id=$1 AND key=$2 AND active=true',[source.app_id,f.key]))[0];
      if(!feature)throw new StepError('license_feature_unknown','Funzione non presente nel catalogo: '+f.key);
    }
    for(const role of plan.roles as {localRole:string;roleName:string;permissions:string[]}[]){
      for(const permission of role.permissions){
        const [row]=await this.db.query<any>(`SELECT p.feature_key,e.purchased,e.enabled FROM permissions p LEFT JOIN entitlements e ON e.customer_id=$2 AND e.app_id=p.app_id AND e.feature_key=p.feature_key
          WHERE p.app_id=$1 AND p.key=$3 AND p.active=true`,[source.app_id,practice.target_customer_id,permission]);
        const approved=features.find(f=>f.key===row?.feature_key);
        if(!row||!approved?.purchased||!approved?.enabled)throw new StepError('role_permission_unlicensed','La funzione non è inclusa nella licenza approvata: '+permission);
      }
    }
    const [previousLicense]=await this.db.query<any>('SELECT state,expires_at FROM licenses WHERE customer_id=$1 AND app_id=$2',[practice.target_customer_id,source.app_id]);
    if(previousLicense&&(previousLicense.state!=='active'||(previousLicense.expires_at&&new Date(previousLicense.expires_at)<=new Date())))throw new StepError('license_revoked','Licenza esistente sospesa o scaduta: riattivazione amministrativa separata richiesta');
    await this.db.transaction(async tx=>{
      const applied=await tx.query("INSERT INTO licenses(customer_id,app_id,state,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(customer_id,app_id) DO UPDATE SET state=$3,expires_at=$4 WHERE licenses.state='active' AND (licenses.expires_at IS NULL OR licenses.expires_at>now()) RETURNING customer_id",[practice.target_customer_id,source.app_id,plan.license.state,plan.license.expiresAt]);
      if(!applied.rows.length)throw new StepError('license_revoked','Licenza sospesa o scaduta: nessuna riattivazione tramite migrazione');
      await tx.query('UPDATE entitlements SET purchased=false,enabled=false WHERE customer_id=$1 AND app_id=$2',[practice.target_customer_id,source.app_id]);
      for(const f of features)await tx.query('INSERT INTO entitlements(customer_id,app_id,feature_key,purchased,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(customer_id,app_id,feature_key) DO UPDATE SET purchased=$4,enabled=$5',[practice.target_customer_id,source.app_id,f.key,f.purchased,f.enabled]);
      await audit(tx,actor,'onboarding.license.apply',practice.id,{customerId:practice.target_customer_id,appId:source.app_id,state:plan.license.state,features:features.length});
      await tx.query(`UPDATE onboarding_practices SET checkpoint=COALESCE(checkpoint,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1`,
        [practice.id,JSON.stringify({licenseAppliedAt:new Date().toISOString(),licenseState:plan.license.state,features:features.length})]);
    });
  }

  private async migratePerson(practice:PracticeRow,source:SourceRow,request:RequestRow,context:{customerId:string;installationId:string},actor:string){
    if(request.state==='completed')return;
    await this.db.query(`UPDATE onboarding_requests SET state='migrating',updated_at=now(),safe_error='' WHERE id=$1`,[request.id]);
    try{
      const plan=practice.plan;
      const explicit=plan.identities?.[request.id]||request.identity_subject||null;
      let subject=explicit;
      if(subject){
        await this.verifyLinkableIdentity(subject);
      }else{
        const mapped=(await this.db.query<any>('SELECT subject FROM app_local_users WHERE source_id=$1 AND installation_id=$2 AND local_user_id=$3',[source.id,context.installationId,request.local_user_id]))[0];
        if(mapped)subject=mapped.subject;
      }
      if(subject&&request.password_cipher){
        await this.destroyPassword(request.id,'identity_linked');
      }
      if(!subject){
        const byUsername=await this.identities.findUserByUsername(request.email);
        if(byUsername&&Array.isArray(byUsername.attributes?.eulab_onboarding_request)&&byUsername.attributes.eulab_onboarding_request.includes(request.id)){
          subject=byUsername.id;
          await this.db.query(`UPDATE onboarding_requests SET identity_subject=$2,password_cipher=null,password_deleted_at=COALESCE(password_deleted_at,now()),
            password_consumed_at=COALESCE(password_consumed_at,now()),updated_at=now(),
            checkpoint=COALESCE(checkpoint,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[request.id,subject,JSON.stringify({identityRecoveredAt:new Date().toISOString(),recovered:true})]);
        }
      }
      if(!subject){
        const byEmail=await this.identities.findUserByEmail(request.email);
        if(byEmail){
          await this.failRequest(request.id,'identity_conflict','Esiste già un’identità Connect con questa email: serve un collegamento esplicito dell’amministratore. Nessuna unione automatica.','explicit_link_required',true);
          await this.audit(undefined,'onboarding.identity.conflict',request.id,{sourceId:source.id,appId:source.app_id,actor});
          return;
        }
        if(!request.password_cipher)throw new StepError('credential_missing',credentialMissing,'new_request_required');
        if(request.password_expires_at&&new Date(request.password_expires_at)<=new Date()){
          await this.destroyPassword(request.id,'expired');
          throw new StepError('credential_expired','La credenziale transitoria è scaduta: il richiedente deve ripetere l’accesso','new_request_required');
        }
        let password:string;
        try{password=unsealMigrationValue(request.password_cipher,request.id);}catch{await this.destroyPassword(request.id,'unreadable');throw new StepError('credential_unreadable',credentialMissing,'new_request_required');}
        try{
          const created=await this.identities.createOnboardingUser({requestId:request.id,sourceId:source.id,email:request.email,firstName:request.first_name,lastName:request.last_name,password});
          subject=created.subject;
          await this.db.query(`UPDATE onboarding_requests SET identity_subject=$2,password_cipher=null,password_deleted_at=now(),password_consumed_at=now(),updated_at=now(),
            checkpoint=COALESCE(checkpoint,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[request.id,subject,JSON.stringify({identityCreatedAt:new Date().toISOString(),recovered:created.recovered})]);
          await this.audit(undefined,'onboarding.identity.created',request.id,{sourceId:source.id,subject,recovered:created.recovered,actor});
        }catch(error){
          if(error instanceof ProviderPasswordRejected){
            await this.destroyPassword(request.id,'password_policy');
            throw new StepError('password_policy','La password non rispetta la policy del provider: il richiedente deve sceglierne una nuova','password_change_required');
          }
          if(error instanceof ConflictException){
            await this.failRequest(request.id,'identity_conflict','Esiste già un’identità SSO con lo stesso nome utente ma senza prova di questa pratica: serve un collegamento esplicito dell’amministratore. Nessuna unione automatica.','explicit_link_required',true);
            await this.audit(undefined,'onboarding.identity.conflict',request.id,{sourceId:source.id,appId:source.app_id,actor});
            return;
          }
          throw new StepError('identity_provider_unavailable','Provider identità non disponibile: la pratica può essere ripetuta senza creare duplicati');
        }
      }
      if((await this.db.query('SELECT 1 FROM app_access_revocations WHERE subject=$1 AND customer_id=$2 AND app_id=$3',[subject,context.customerId,source.app_id])).length)throw new StepError('access_revoked','Accesso applicativo revocato','explicit_link_required');
      await this.ensureIdentityMembership(subject,request,context.customerId);
      const role=await this.ensureRoleAndAssignment(practice,source,request,subject,context.customerId,actor);
      await this.ensureLocalLink(source,practice,request,subject,context,actor);
      await this.db.query(`UPDATE onboarding_requests SET state='completed',identity_subject=$2,password_cipher=null,password_deleted_at=COALESCE(password_deleted_at,now()),safe_error='',action_required='',completed_at=now(),updated_at=now(),
        checkpoint=COALESCE(checkpoint,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[request.id,subject,JSON.stringify({completedAt:new Date().toISOString(),installationId:context.installationId,roleId:role,identityPreserved:true})]);
      await this.audit(undefined,'onboarding.request.completed',request.id,{sourceId:source.id,appId:source.app_id,subject,installationId:context.installationId,localUserId:request.local_user_id,role,identityPreserved:true,otherApplicationsPreserved:true,actor});
    }catch(error){
      if(error instanceof StepError){
        await this.failRequest(request.id,error.code,error.message,error.actionRequired,error.actionRequired==='explicit_link_required'||error.actionRequired==='password_change_required');
      }else{
        await this.failRequest(request.id,'execution_failed','Esecuzione non completata; la pratica può essere ripetuta in modo riconciliato','',false);
      }
    }
  }

  private async verifyLinkableIdentity(subject:string){
    let user:any;
    try{user=await this.identities.user(subject);}catch{throw new StepError('identity_provider_unavailable','Provider identità non disponibile');}
    if(!user?.enabled)throw new StepError('identity_disabled','Identità SSO disabilitata o revocata','explicit_link_required');
    if(user.serviceAccountClientId||String(user.username||'').startsWith('service-account-'))throw new StepError('identity_protected','Account di servizio non collegabile','explicit_link_required');
    const roles=await this.identities.roles(subject);
    if(roles.some(r=>['eulab-admin','eulab-technician'].includes(r.name)))throw new StepError('identity_protected','Identità amministrativa EULab non collegabile a un accesso aziendale','explicit_link_required');
  }
  private async ensureIdentityMembership(subject:string,request:RequestRow,customerId:string){
    await this.db.query('INSERT INTO identities(subject,display_name,enabled) VALUES($1,$2,true) ON CONFLICT(subject) DO NOTHING',[subject,`${request.first_name} ${request.last_name}`.trim()||request.email]);
    const identity=(await this.db.query<any>('SELECT enabled FROM identities WHERE subject=$1',[subject]))[0];
    if(!identity?.enabled)throw new StepError('identity_disabled','Identità sospesa o revocata. Nessuna riattivazione automatica.','explicit_link_required');
    await this.db.query('INSERT INTO memberships(subject,customer_id,enabled) VALUES($1,$2,true) ON CONFLICT(subject,customer_id) DO NOTHING',[subject,customerId]);
    const membership=(await this.db.query<any>('SELECT enabled FROM memberships WHERE subject=$1 AND customer_id=$2',[subject,customerId]))[0];
    if(!membership?.enabled)throw new StepError('membership_disabled','Appartenenza al cliente sospesa o revocata. Nessuna riattivazione automatica.','explicit_link_required');
  }
  private async ensureRoleAndAssignment(practice:PracticeRow,source:SourceRow,request:RequestRow,subject:string,customerId:string,actor:string){
    const localRole=(practice.plan.activation?.localRole&&request.kind==='activation')?practice.plan.activation.localRole:request.role;
    const mapping=(practice.plan.roles as {localRole:string;roleName:string;permissions:string[]}[]).find(r=>r.localRole===localRole);
    if(!mapping)throw new StepError('role_mapping_missing','Mappatura del ruolo locale mancante: '+localRole);
    return this.db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding-role:'+customerId+':'+source.app_id+':'+mapping.roleName]);
      let role=(await tx.query<any>('SELECT id FROM roles WHERE customer_id=$1 AND app_id=$2 AND name=$3 FOR UPDATE',[customerId,source.app_id,mapping.roleName])).rows[0];
      if(role){
        const current=(await tx.query<{permission_key:string}>('SELECT permission_key FROM role_permissions WHERE role_id=$1 ORDER BY permission_key',[role.id])).rows.map(r=>r.permission_key);
        const wanted=[...mapping.permissions].sort();
        if(JSON.stringify(current)!==JSON.stringify(wanted))throw new StepError('role_conflict','Esiste già un ruolo con lo stesso nome e permessi diversi: scegli un altro nome','role_change_required');
      }else{
        const id=randomUUID();
        await tx.query('INSERT INTO roles(id,customer_id,app_id,name) VALUES($1,$2,$3,$4)',[id,customerId,source.app_id,mapping.roleName]);
        for(const permission of mapping.permissions)await tx.query('INSERT INTO role_permissions(role_id,app_id,permission_key) VALUES($1,$2,$3)',[id,source.app_id,permission]);
        role={id};
        await audit(tx,actor,'onboarding.role.create',id,{customerId,appId:source.app_id,localRole,name:mapping.roleName,permissions:mapping.permissions});
      }
      await tx.query('INSERT INTO assignments(subject,customer_id,app_id,role_id) VALUES($1,$2,$3,$4) ON CONFLICT(subject,role_id) DO NOTHING',[subject,customerId,source.app_id,role.id]);
      await audit(tx,actor,'onboarding.assignment.ensure',subject,{customerId,appId:source.app_id,roleId:role.id,localRole});
      return role.id as string;
    });
  }
  private async ensureLocalLink(source:SourceRow,practice:PracticeRow,request:RequestRow,subject:string,context:{customerId:string;installationId:string},actor:string){
    await this.db.transaction(async tx=>{
      const localTenantId=practice.local_tenant_id||practice.plan.activation?.localTenantId;
      const localUserId=request.local_user_id||practice.plan.activation?.localUserId;
      if(!localTenantId||!localUserId)throw new StepError('activation_assignment_missing','Assegnazione locale mancante');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding-tenant:'+source.id+':'+localTenantId]);
      await this.assertLinkAvailable(tx,context.installationId,localUserId,subject);
      const existing=(await tx.query<any>('SELECT subject FROM local_links WHERE installation_id=$1 AND local_user_id=$2',[context.installationId,localUserId])).rows[0];
      if(existing&&existing.subject!==subject)throw new StepError('local_link_conflict','L’utente locale è collegato a un’altra identità: serve un intervento assistito','explicit_link_required');
      await tx.query('INSERT INTO local_links(installation_id,local_user_id,subject) VALUES($1,$2,$3) ON CONFLICT(installation_id,local_user_id) DO NOTHING',[context.installationId,localUserId,subject]);
      const settled=(await tx.query<any>('SELECT subject FROM local_links WHERE installation_id=$1 AND local_user_id=$2 FOR UPDATE',[context.installationId,localUserId])).rows[0];
      if(settled?.subject!==subject)throw new StepError('local_link_conflict','Collegamento locale concorrente differente','explicit_link_required');
      const current=(await tx.query<any>('SELECT subject,enabled,local_tenant_id FROM app_local_users WHERE source_id=$1 AND installation_id=$2 AND local_user_id=$3 FOR UPDATE',[source.id,context.installationId,localUserId])).rows[0];
      if(current&&(current.subject!==subject||current.local_tenant_id!==localTenantId))throw new StepError('local_link_conflict','ID locale già assegnato a un’altra identità','explicit_link_required');
      if(current&&!current.enabled)throw new StepError('local_access_disabled','Accesso locale sospeso o revocato: riattivalo esplicitamente','explicit_link_required');
      const sameSubject=(await tx.query<any>('SELECT local_user_id FROM app_local_users WHERE source_id=$1 AND installation_id=$2 AND subject=$3 AND local_user_id<>$4',[source.id,context.installationId,subject,localUserId])).rows[0];
      if(sameSubject)throw new StepError('local_link_conflict','L’identità è già collegata a un altro ID locale','explicit_link_required');
      const linked=await tx.query(`INSERT INTO app_local_users(source_id,installation_id,app_id,local_tenant_id,local_user_id,subject,email,email_normalized,first_name,last_name,role,permissions,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
        ON CONFLICT(source_id,installation_id,local_user_id) DO UPDATE SET local_tenant_id=EXCLUDED.local_tenant_id,subject=EXCLUDED.subject,email=EXCLUDED.email,email_normalized=EXCLUDED.email_normalized,
          first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,role=EXCLUDED.role,permissions=EXCLUDED.permissions,updated_at=now() WHERE app_local_users.subject=EXCLUDED.subject AND app_local_users.local_tenant_id=EXCLUDED.local_tenant_id AND app_local_users.enabled=true RETURNING local_user_id`,
        [source.id,context.installationId,source.app_id,localTenantId,localUserId,subject,request.email,request.email,request.first_name,request.last_name,request.role||practice.plan.activation?.localRole,JSON.stringify(request.permissions||[])]);
      if(!linked.rows.length)throw new StepError('local_link_conflict','Collegamento locale differente o sospeso','explicit_link_required');
      await audit(tx,actor,'onboarding.local_link.ensure',localUserId,{sourceId:source.id,installationId:context.installationId,subject,role:request.role||practice.plan.activation?.localRole,identityPreserved:true,otherApplicationsPreserved:true});
    });
  }
  private async assertLinkAvailable(tx:{query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>},installationId:string,localUserId:string,subject:string){
    const byLocal=(await tx.query('SELECT subject FROM local_links WHERE installation_id=$1 AND local_user_id=$2',[installationId,localUserId])).rows[0];
    if(byLocal&&byLocal.subject!==subject)throw new StepError('local_link_conflict','Utente locale già collegato a un’altra identità: nessuna sostituzione automatica','explicit_link_required');
    const bySubject=(await tx.query('SELECT local_user_id FROM local_links WHERE installation_id=$1 AND subject=$2 AND local_user_id<>$3',[installationId,subject,localUserId])).rows[0];
    if(bySubject)throw new StepError('local_link_conflict','Identità già collegata a un altro utente locale: serve un intervento assistito','explicit_link_required');
  }

  private async failRequest(id:string,code:string,message:string,actionRequired:string,removeCredential:boolean){
    await this.db.query(`UPDATE onboarding_requests SET state='failed',safe_error=$2,action_required=$3,updated_at=now(),
      password_cipher=CASE WHEN $4 THEN null ELSE password_cipher END,password_deleted_at=CASE WHEN $4 THEN now() ELSE password_deleted_at END WHERE id=$1`,[id,message.slice(0,500),actionRequired.slice(0,100),removeCredential]);
    await this.audit(undefined,'onboarding.request.failed',id,{code,actionRequired,credentialDestroyed:removeCredential});
  }
  private async destroyPassword(id:string,reason:string){
    await this.db.query('UPDATE onboarding_requests SET password_cipher=null,password_deleted_at=now(),updated_at=now() WHERE id=$1',[id]);
    await this.audit(undefined,'onboarding.credential.destroyed',id,{reason});
  }
  private async missingPrerequisites(practice:PracticeRow,requests:any[],source:SourceRow|null){
    const missing:{code:string;label:string}[]=[];
    if(!source||!source.enabled)missing.push({code:'source_disabled',label:'Sorgente di deployment disabilitata o assente'});
    if(!source?.origins?.length)missing.push({code:'source_origin_missing',label:'Origine verificata della sorgente assente'});
    if(!source?.catalog_url)missing.push({code:'catalog_source_missing',label:'URL del catalogo della sorgente assente'});
    const plan=practice.plan||{};
    if(source?.presenter_id)for(const target of ['application','customer','installation'])if(!plan[target])missing.push({code:target+'_selection_missing',label:'Selezione amministrativa '+target+' mancante'});
    const active=requests.filter(r=>!['completed','rejected','expired'].includes(r.state));
    if(practice.kind==='activation'){
      if(!plan.activation?.localTenantId||!plan.activation?.localUserId||!plan.activation?.localRole)missing.push({code:'activation_assignment_missing',label:'Assegnazione locale iniziale (localTenantId, localUserId, ruolo) mancante'});
    }
    if(!plan.license)missing.push({code:'license_plan_missing',label:'Piano licenza e funzioni mancante'});
    else if(plan.license.state!=='active')missing.push({code:'license_not_active',label:'Licenza approvata non attiva'});
    else if(plan.license.expiresAt&&new Date(plan.license.expiresAt)<=new Date())missing.push({code:'license_expired',label:'Licenza approvata già scaduta'});
    else if(!plan.license.features?.some((f:any)=>f.purchased&&f.enabled))missing.push({code:'license_features_missing',label:'Nessuna funzione acquistata/abilitata nella licenza'});
    const mappings=new Map<string,any>((plan.roles||[]).map((r:any)=>[r.localRole,r]));
    for(const request of active){
      const role=request.kind==='activation'?plan.activation?.localRole:request.role;
      if(!role||!mappings.has(role))missing.push({code:'role_mapping_missing:'+request.id,label:'Mappatura del ruolo locale mancante per '+request.email+(role?' ('+role+')':'')});
      const explicit=plan.identities?.[request.id]||request.identity_subject||request.identitySubject;
      const action=request.actionRequired||request.action_required;
      if(!explicit){
        const credentialPresent=request.credentialPresent??!!request.password_cipher;
        const credentialExpiresAt=request.credentialExpiresAt??request.password_expires_at;
        if(!credentialPresent)missing.push({code:'credential_missing:'+request.id,label:'Credenziale transitoria assente per '+request.email});
        else if(credentialExpiresAt&&new Date(credentialExpiresAt)<=new Date())missing.push({code:'credential_expired:'+request.id,label:'Credenziale transitoria scaduta per '+request.email});
        if(request.state==='failed'&&action)missing.push({code:'action_required:'+request.id,label:'Azione richiesta per '+request.email+': '+action});
      }
    }
    return missing;
  }
  private safeError(error:any){
    if(error instanceof StepError)return {code:error.code,message:error.message};
    if(error instanceof PreconditionError)return {code:'prerequisites_missing',message:'Prerequisiti mancanti'};
    if(error instanceof ConflictException)return {code:'conflict',message:'Conflitto di collegamento: verifica la pratica'};
    if(error instanceof BadRequestException)return {code:'invalid_request',message:'Dati della pratica non validi'};
    console.error('Onboarding execution failed',error?.name||'Error');
    return {code:'execution_failed',message:'Esecuzione non completata: verifica i prerequisiti e riprova'};
  }

  // ---------- custodia transitoria ----------

  async sweepExpired(){
    const expired=await this.db.query<{id:string}>(`UPDATE onboarding_requests r SET password_cipher=null,password_deleted_at=now(),updated_at=now(),
      action_required=CASE WHEN r.identity_subject IS NOT NULL OR EXISTS(SELECT 1 FROM onboarding_practices p WHERE p.id=r.practice_id AND p.plan->'identities' ? r.id::text) THEN r.action_required ELSE 'new_request_required' END,
      state=CASE WHEN r.state IN ('pending','approved','failed') AND r.identity_subject IS NULL
        AND NOT EXISTS(SELECT 1 FROM onboarding_practices p WHERE p.id=r.practice_id AND p.plan->'identities' ? r.id::text) THEN 'expired' ELSE r.state END
      WHERE r.password_cipher IS NOT NULL AND r.password_expires_at<=now() RETURNING r.id`);
    if(expired.length)await this.audit(undefined,'onboarding.credential.sweep',String(expired.length),{count:expired.length});
    return {expired:expired.length};
  }
  private passwordTtl(){
    const value=Number(process.env.ONBOARDING_PASSWORD_TTL_SECONDS||86400);
    if(!Number.isInteger(value)||value<60||value>604800)throw new ServiceUnavailableException('TTL della credenziale di onboarding non configurato correttamente');
    return value;
  }
  private validateEnvironmentUrls(environment:string,origins:string[],catalogUrl?:string|null,oidcCallbacks:string[]=[]){
    if(environment!=='production')return;
    for(const value of [...origins,...(catalogUrl?[catalogUrl]:[]),...oidcCallbacks]){
      if(new URL(value).protocol!=='https:')throw new BadRequestException('In produzione tutte le origini, il catalogo e le callback OIDC devono usare HTTPS');
    }
  }
  private validateSourceUrls(origins:string[],catalogUrl?:string|null,oidcCallbacks:string[]=[]){
    if(catalogUrl){
      const url=new URL(catalogUrl);
      if(url.username||url.password||url.hash)throw new BadRequestException('URL catalogo non valido');
      if(!origins.includes(url.origin))throw new BadRequestException('Il catalogo deve appartenere a un’origine autorizzata');
    }
    for(const callback of oidcCallbacks){
      const url=new URL(callback);
      if(url.username||url.password||url.hash)throw new BadRequestException('Callback OIDC non valida');
      if(!origins.includes(url.origin))throw new BadRequestException('La callback OIDC deve appartenere a un’origine autorizzata');
    }
  }
  private async audit(_tx:any,action:string,target:string,detail:any={}){
    if(_tx)return audit(_tx,detail.actor||'system',action,target,detail);
    await this.db.transaction(async tx=>audit(tx,detail.actor||'system',action,target,detail));
  }
}

function slugify(value:string){
  return String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120)||'azienda';
}
