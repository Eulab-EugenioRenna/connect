import {pathToFileURL} from 'node:url';
export async function setupSecurityProfile(admin){
 const profile=await admin('/users/profile'),name='eulab.mfa.preferredMethod';
 const existing=profile.attributes?.find(a=>a.name===name);
 const attribute={...existing,name,displayName:'Metodo MFA preferito',multivalued:false,permissions:{view:['admin'],edit:['admin']},validations:{...existing?.validations,options:{options:['auto','totp','email']}}};
 await admin('/users/profile','PUT',{...profile,attributes:[...(profile.attributes||[]).filter(a=>a.name!==name),attribute]});
 return {configured:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.loadEnvFile(process.env.EULAB_ENV_FILE||'.env');
 const origin=process.env.KEYCLOAK_INTERNAL_URL||process.env.PUBLIC_KEYCLOAK_URL;
 const auth=await fetch(origin+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KEYCLOAK_ADMIN,password:process.env.KEYCLOAK_ADMIN_PASSWORD}),signal:AbortSignal.timeout(10000)});
 if(!auth.ok)throw new Error('Autenticazione amministrativa SSO non riuscita');const token=(await auth.json()).access_token;
 const admin=async(path,method='GET',body)=>{const response=await fetch(origin+'/admin/realms/eulab'+path,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Configurazione profilo sicurezza non riuscita: '+response.status);const text=await response.text();return text?JSON.parse(text):null;};
 await setupSecurityProfile(admin);console.log('Campo preferenza MFA configurato. Altri campi e utenti preservati.');
}
