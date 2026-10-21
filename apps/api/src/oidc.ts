import { required } from './config.js';
export async function introspect(token:string):Promise<{active:boolean;sub?:string;realm_access?:{roles?:string[]}}> {
 const response=await fetch(`${required('OIDC_INTERNAL_ISSUER')}/protocol/openid-connect/token/introspect`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,client_id:'connect-api',client_secret:required('OIDC_CLIENT_SECRET')}),signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error('OIDC_INTROSPECTION_FAILED');return response.json();
}
