import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { Database } from './database.js';
import { required } from './config.js';
import { introspect } from './oidc.js';
import { hash } from './security.js';
export const Public = () => SetMetadata('public',true);
export const Admin = () => SetMetadata('admin',true);
export interface Principal { subject?: string; admin: boolean; technician: boolean; installationId?: string; server: boolean; accessToken?:string; sessionId?:string }
export interface RequestContext { headers: Record<string,string | undefined>; principal: Principal }
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly jwks = createRemoteJWKSet(new URL(required('OIDC_JWKS_URL')),{[customFetch]:(...args)=>fetch(...args)});
  constructor(private readonly reflector: Reflector, private readonly db: Database) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride('public',[ctx.getHandler(),ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<RequestContext>();
    const p: Principal = { admin:false, technician:false, server:false };
    const installationId = req.headers['x-installation-id'];
    if (installationId) {
      const [installation] = await this.db.query('SELECT i.*,g.enabled AS guardian_enabled FROM installations i LEFT JOIN wordpress_guardians g ON g.installation_id=i.id WHERE i.id=$1',[installationId]);
      if (!installation?.enabled) throw new UnauthorizedException('Installazione assente o revocata');
      if(installation.guardian_enabled===false)throw new ForbiddenException('Integrazione WordPress sospesa dall’amministratore');
      const serverSecret = req.headers['x-installation-secret'];
      if (serverSecret) {
        if (hash(serverSecret) !== installation.secret_hash) throw new UnauthorizedException('Credenziali installazione non valide');
        p.server = true;
      } else {
        let browserOrigin=req.headers.origin;
        // Same-origin GETs can omit Origin; browsers supply the page Referer instead.
        if(!browserOrigin&&req.headers.referer){try{browserOrigin=new URL(req.headers.referer).origin;}catch{}}
        if(browserOrigin!==installation.domain)throw new UnauthorizedException('Origine non autorizzata');
      }
      p.installationId = installationId;
    }
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      let verificationStage='signature';
      try {
        const { payload } = await jwtVerify(bearer,this.jwks,{ issuer:required('OIDC_ISSUER'),audience:'connect-api',algorithms:['RS256'] });
        verificationStage='subject';
        if (!payload.sub) throw new Error('subject assente');
        verificationStage='introspection';
        const current=await introspect(bearer);if(!current.active||current.sub!==payload.sub)throw new Error('Sessione revocata');
        p.accessToken=bearer;p.sessionId=typeof payload.sid==='string'?payload.sid:undefined;
        const roles = current.realm_access?.roles || [];
        p.subject = payload.sub; p.admin = roles.includes('eulab-admin'); p.technician = p.admin || roles.includes('eulab-technician');
      } catch(error) {
        const code=error&&typeof error==='object'&&'code' in error?String(error.code):'unknown';
        const claim=error&&typeof error==='object'&&'claim' in error?String(error.claim):'unknown';
        console.warn('[connect-token]',JSON.stringify({stage:verificationStage,code:['ERR_JWT_CLAIM_VALIDATION_FAILED','ERR_JWT_EXPIRED','ERR_JWS_SIGNATURE_VERIFICATION_FAILED','ERR_JWKS_NO_MATCHING_KEY','ERR_JWKS_TIMEOUT'].includes(code)?code:'unknown',claim:['iss','aud','exp','nbf','sub'].includes(claim)?claim:'unknown'}));
        throw new UnauthorizedException('Sessione SSO non valida');
      }
    }
    if (!p.subject && !p.server) throw new UnauthorizedException('Autenticazione richiesta');
    if (this.reflector.getAllAndOverride('admin',[ctx.getHandler(),ctx.getClass()]) && !p.admin) throw new ForbiddenException('Ruolo EULab Admin richiesto');
    req.principal = p; return true;
  }
}
