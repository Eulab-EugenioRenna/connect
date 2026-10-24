import {BadRequestException,ConflictException,ForbiddenException,UnauthorizedException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {Database,audit} from './database.js';
import {equalSecret,hash,secret} from './security.js';
import {deploymentMetadataSchema,sourceId} from './onboarding.schemas.js';
import {key,parse,uuid} from './validation.js';

/** Reserve provenance only: this does not create or approve an integration. */
export async function authenticatePresenter(db:Database,presenterId:string,bearer:string,body:any){
 parse(uuid,presenterId);const declared=parse(sourceId,body?.sourceId),appId=parse(key,body?.appId);
 if(body?.schemaVersion!==1)throw new ForbiddenException('Versione contratto non valida');
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['onboarding-source:'+declared]);
  const grant=(await tx.query('SELECT * FROM onboarding_presenters WHERE id=$1 FOR UPDATE',[presenterId])).rows[0];
  if(!grant||!grant.enabled||new Date(grant.expires_at)<=new Date()||!equalSecret(bearer,grant.secret_hash))throw new UnauthorizedException('Credenziale tecnica non valida o scaduta');
  if(grant.bound_source_id&&grant.bound_source_id!==declared)throw new ConflictException('Credenziale già vincolata a un altro sourceId');
  let source=(await tx.query('SELECT * FROM connect_sources WHERE id=$1 FOR UPDATE',[declared])).rows[0];
  if(source){
   if(source.presenter_id!==grant.id)throw new ConflictException('sourceId già riservato a un altro deployment');
   if(!source.enabled)throw new ForbiddenException('Sorgente sospesa');
   if(source.app_id!==appId)throw new ConflictException('App dichiarata differente dalla provenienza riservata');
   if(body.deployment){
    const metadata=parse(deploymentMetadataSchema,body.deployment);
    if(metadata.name!==source.name||metadata.environment!==source.environment||JSON.stringify(metadata.origins)!==JSON.stringify(source.origins)||(metadata.catalogUrl||null)!==source.catalog_url||JSON.stringify(metadata.oidcCallbacks)!==JSON.stringify(source.oidc_callbacks))throw new ConflictException('Metadati deployment variati: verifica amministrativa richiesta');
   }
  }else{
   const metadata=parse(deploymentMetadataSchema,body?.deployment);
   for(const value of [...metadata.origins,...metadata.oidcCallbacks,...(metadata.catalogUrl?[metadata.catalogUrl]:[])]){
    const url=new URL(value);if(url.username||url.password||url.hash||(metadata.environment==='production'&&url.protocol!=='https:'))throw new BadRequestException('Metadati URL non validi');
   }
   source=(await tx.query(`INSERT INTO connect_sources(id,app_id,name,environment,origins,catalog_url,oidc_callbacks,deployment_identity,secret_hash,presenter_id,integration_approved,verified_origins,verified_app_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12) RETURNING *`,[declared,appId,metadata.name,metadata.environment,JSON.stringify(metadata.origins),metadata.catalogUrl||null,JSON.stringify(metadata.oidcCallbacks),grant.deployment_identity,hash(secret()),grant.id,JSON.stringify(grant.verified_origins),grant.verified_app_id])).rows[0];
   await tx.query('UPDATE onboarding_presenters SET bound_source_id=$2 WHERE id=$1',[grant.id,declared]);
   await audit(tx,'presenter:'+grant.id,'onboarding.provenance.reserve',declared,{presenterId:grant.id,deployment:grant.deployment_identity,declaredAppId:appId,approved:false});
  }
  return source;
 });
}
export async function issuePresenter(db:Database,body:{name:string;deploymentIdentity:string;verifiedOrigins:string[];verifiedAppId?:string;expiresAt:string},actor:string){
 const expires=new Date(body.expiresAt);if(expires<=new Date()||expires.getTime()>Date.now()+366*86400000)throw new BadRequestException('Scadenza tecnica non valida');
 const id=randomUUID(),credential=secret();
 await db.transaction(async tx=>{
  if(body.verifiedAppId&&!(await tx.query('SELECT id FROM applications WHERE id=$1',[body.verifiedAppId])).rows.length)throw new BadRequestException('Applicazione verificata non presente');
  await tx.query('INSERT INTO onboarding_presenters(id,name,secret_hash,deployment_identity,verified_origins,verified_app_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,body.name,hash(credential),body.deploymentIdentity,JSON.stringify(body.verifiedOrigins),body.verifiedAppId||null,expires]);
  await audit(tx,actor,'onboarding.presenter.issue',id,{deploymentIdentity:body.deploymentIdentity,verifiedAppId:body.verifiedAppId||null});
 });
 return {id,secret:credential,expiresAt:expires.toISOString()};
}
