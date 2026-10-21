export interface PolicyFacts { installationEnabled: boolean; identityEnabled: boolean; memberEnabled: boolean; linked: boolean; licenseState: string | null; expiresAt: Date | null; purchased: boolean; featureEnabled: boolean; catalogActive: boolean; permissionGranted: boolean }
export function decision(f: PolicyFacts, now = new Date()): { allowed: boolean; reason: string } {
  const checks: [boolean,string][] = [
    [f.installationEnabled,'installation_disabled'],[f.identityEnabled,'identity_disabled'],[f.memberEnabled,'membership_disabled'],[f.linked,'identity_not_linked'],
    [f.licenseState === 'active','license_inactive'],[!f.expiresAt || f.expiresAt > now,'license_expired'],[f.catalogActive,'catalog_inactive'],[f.purchased,'feature_not_purchased'],[f.featureEnabled,'feature_disabled'],[f.permissionGranted,'permission_denied']
  ];
  const denied = checks.find(([ok]) => !ok); return denied ? { allowed:false, reason:denied[1] } : { allowed:true, reason:'granted' };
}
