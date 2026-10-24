import { Injectable, ForbiddenException } from '@nestjs/common';
import { Database } from './database.js';
import { Principal } from './auth.js';
import { decision } from './policy.js';
@Injectable()
export class Authorization {
  constructor(private readonly db: Database) {}
  async check(p: Principal, installationId: string, permission: string) {
    if (p.admin) return { allowed:true, reason:'technical_admin' };
    if (p.installationId !== installationId || !p.subject) return { allowed:false, reason:'installation_or_identity_missing' };
    const [f] = await this.db.query(`SELECT i.enabled AS "installationEnabled", COALESCE(u.enabled,false) AS "identityEnabled",
      COALESCE(m.enabled,false) AS "memberEnabled", (lk.subject IS NOT NULL) AS linked,
      EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=$2) AS "accessRevoked", l.state AS "licenseState", l.expires_at AS "expiresAt",
      COALESCE(e.purchased,false) AS purchased, COALESCE(e.enabled,false) AS "featureEnabled", COALESCE(f.active AND perm.active,false) AS "catalogActive",
      EXISTS(SELECT 1 FROM assignments a JOIN roles r ON r.id=a.role_id JOIN role_permissions rp ON rp.role_id=r.id
        WHERE a.subject=$2 AND a.customer_id=i.customer_id AND r.app_id=i.app_id AND rp.app_id=i.app_id AND rp.permission_key=$3) AS "permissionGranted"
      FROM installations i LEFT JOIN identities u ON u.subject=$2 LEFT JOIN memberships m ON m.subject=$2 AND m.customer_id=i.customer_id
      LEFT JOIN local_links lk ON lk.installation_id=i.id AND lk.subject=$2
      LEFT JOIN licenses l ON l.customer_id=i.customer_id AND l.app_id=i.app_id
      LEFT JOIN permissions perm ON perm.app_id=i.app_id AND perm.key=$3
      LEFT JOIN features f ON f.app_id=i.app_id AND f.key=perm.feature_key
      LEFT JOIN entitlements e ON e.customer_id=i.customer_id AND e.app_id=i.app_id AND e.feature_key=f.key WHERE i.id=$1`,[installationId,p.subject,permission]);
    return f ? decision(f) : { allowed:false, reason:'installation_missing' };
  }
  async access(p:Principal,installationId:string){
    const [i]=await this.db.query(`SELECT i.app_id,i.enabled,u.enabled AS identity_enabled,m.enabled AS member_enabled,lk.local_user_id,l.state AS license_state,l.expires_at,a.catalog_version,a.catalog_source_version,a.catalog_sync_error,
      EXISTS(SELECT 1 FROM app_access_revocations rv WHERE rv.customer_id=i.customer_id AND rv.app_id=i.app_id AND rv.subject=$2) AS access_revoked
      FROM installations i JOIN applications a ON a.id=i.app_id LEFT JOIN identities u ON u.subject=$2 LEFT JOIN memberships m ON m.subject=$2 AND m.customer_id=i.customer_id LEFT JOIN local_links lk ON lk.installation_id=i.id AND lk.subject=$2 LEFT JOIN licenses l ON l.customer_id=i.customer_id AND l.app_id=i.app_id WHERE i.id=$1`,[installationId,p.subject||'']);
    const checks:[boolean,string][]=[
      [!!i,'installation_missing'],[!!i?.enabled,'installation_disabled'],[!!p.subject&&(p.admin||p.installationId===installationId),'installation_or_identity_missing'],
      [p.admin||!i?.access_revoked,'access_revoked'],[p.admin||!!i?.identity_enabled,'identity_disabled'],[p.admin||!!i?.member_enabled,'membership_disabled'],[p.admin||!!i?.local_user_id,'identity_not_linked'],
      [p.admin||i?.license_state==='active','license_inactive'],[p.admin||!i?.expires_at||new Date(i.expires_at)>new Date(),'license_expired']
    ];
    const denied=checks.find(([ok])=>!ok),canLogin=!denied;
    const functions=canLogin?await this.db.query(`SELECT p.key,p.name FROM permissions p JOIN features f ON f.app_id=p.app_id AND f.key=p.feature_key WHERE p.app_id=$1 AND p.active=true AND f.active=true AND ($4 OR (EXISTS(SELECT 1 FROM installations i JOIN entitlements e ON e.customer_id=i.customer_id AND e.app_id=i.app_id AND e.feature_key=p.feature_key WHERE i.id=$2 AND e.purchased=true AND e.enabled=true) AND EXISTS(SELECT 1 FROM assignments a JOIN roles r ON r.id=a.role_id JOIN role_permissions rp ON rp.role_id=r.id AND rp.app_id=r.app_id JOIN installations i ON i.id=$2 WHERE a.subject=$3 AND a.customer_id=i.customer_id AND a.app_id=i.app_id AND rp.permission_key=p.key))) ORDER BY p.name,p.key`,[i.app_id,installationId,p.subject,p.admin]):[];
    return {installationId,appId:i?.app_id||null,subject:p.subject||null,localUserId:i?.local_user_id||null,canLogin,reason:denied?.[1]||(p.admin?'technical_admin':'granted'),functions,catalogVersion:i?.catalog_version||0,functionsStatus:!i?.catalog_source_version?(i?.catalog_version?'last_valid':'pending'):(i?.catalog_sync_error?'last_valid':'ready')};
  }
  async require(p: Principal, installationId: string, permission: string) {
    const result = await this.check(p,installationId,permission);
    if (!result.allowed) throw new ForbiddenException(result.reason);
  }
}
