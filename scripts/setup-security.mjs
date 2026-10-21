import {setupSecurityProfile} from './setup-security-profile.mjs';
import {pathToFileURL} from 'node:url';
export const flowAlias='eulab-connect-mfa';
/** Build and inspect the replacement flow before binding it. Existing users and credentials are never updated. */
export async function setupSecurity(admin,{activate=false}={}){
 const realm=await admin('');
 if(!['browser',flowAlias].includes(realm.browserFlow||'browser'))throw new Error('Flusso browser personalizzato: integrazione manuale necessaria per preservarlo');
 const providers=await admin('/authentication/authenticator-providers');
 if(!providers.some(p=>p.id==='eulab-connect-mfa'))throw new Error('Installa prima l’immagine Keycloak con il provider eulab-connect-mfa');
 if((await admin('/identity-provider/instances')).length)throw new Error('Identity provider esterni presenti: integrare MFA anche nel loro flusso prima dell’attivazione');
 if(activate&&(!realm.smtpServer?.host||!realm.smtpServer?.from))throw new Error('Sincronizza SMTP con Keycloak prima di attivare il codice via email');
 const clients=await admin('/clients?max=1000');
 if(clients.some(c=>c.enabled&&(c.directAccessGrantsEnabled||c.authenticationFlowBindingOverrides?.browser)))throw new Error('Client con password grant o override browser: verifica il flusso prima di attivare MFA');
 let flows=await admin('/authentication/flows');
 if(!flows.some(f=>f.alias===flowAlias))await admin('/authentication/flows','POST',{alias:flowAlias,description:'EULab: password, app OTP o email e dispositivo attendibile',providerId:'basic-flow',topLevel:true,builtIn:false});
 async function entries(){return admin('/authentication/flows/'+flowAlias+'/executions');}
 async function execution(parent,provider,requirement){
  let all=await admin('/authentication/flows/'+parent+'/executions'),entry=all.find(e=>e.providerId===provider);
  if(!entry){await admin('/authentication/flows/'+parent+'/executions/execution','POST',{provider});all=await admin('/authentication/flows/'+parent+'/executions');entry=all.find(e=>e.providerId===provider);}
  if(!entry)throw new Error('Esecuzione non trovata: '+provider);
  if(entry.requirement!==requirement)await admin('/authentication/flows/'+parent+'/executions','PUT',{...entry,requirement});
 }
 await execution(flowAlias,'auth-cookie','ALTERNATIVE');
 let all=await entries(),forms=all.find(e=>e.authenticationFlow&&e.displayName===flowAlias+'-forms');
 if(!forms){await admin('/authentication/flows/'+flowAlias+'/executions/flow','POST',{alias:flowAlias+'-forms',type:'basic-flow',provider:'basic-flow',description:'Password e secondo fattore'});all=await entries();forms=all.find(e=>e.authenticationFlow&&e.displayName===flowAlias+'-forms');}
 if(!forms)throw new Error('Sottoflusso MFA non trovato');
 if(forms.requirement!=='ALTERNATIVE')await admin('/authentication/flows/'+flowAlias+'/executions','PUT',{...forms,requirement:'ALTERNATIVE'});
 await execution(flowAlias+'-forms','auth-username-password-form','REQUIRED');
 await execution(flowAlias+'-forms','eulab-connect-mfa','REQUIRED');
 all=await entries();
 // Fail closed if the target alias was modified or contains an unexpected alternative path.
 const expected=['auth-cookie','auth-username-password-form','eulab-connect-mfa'];
 if(all.length!==4||all.some(e=>!e.authenticationFlow&&!expected.includes(e.providerId)))throw new Error('Flusso MFA non conforme: nessuna attivazione');
 const formEntries=await admin('/authentication/flows/'+flowAlias+'-forms/executions');
 if(formEntries.length!==2||formEntries[0].providerId!=='auth-username-password-form'||formEntries[1].providerId!=='eulab-connect-mfa'||formEntries.some(e=>e.requirement!=='REQUIRED'))throw new Error('Ordine o requisito del secondo fattore non conforme');
 if(!activate)return {prepared:true,activated:false,previousFlow:realm.browserFlow||'browser'};
 const actions=await admin('/authentication/required-actions');
 const totp=actions.find(a=>a.alias==='CONFIGURE_TOTP');if(!totp)throw new Error('Azione nativa CONFIGURE_TOTP mancante');
 if(!totp.enabled)await admin('/authentication/required-actions/CONFIGURE_TOTP','PUT',{...totp,enabled:true});
 await admin('','PUT',{browserFlow:flowAlias,emailTheme:'eulab',rememberMe:realm.browserFlow===flowAlias?!!realm.rememberMe:true,ssoSessionIdleTimeoutRememberMe:realm.ssoSessionIdleTimeoutRememberMe||604800,ssoSessionMaxLifespanRememberMe:realm.ssoSessionMaxLifespanRememberMe||2592000,bruteForceProtected:true,failureFactor:5,otpPolicyType:'totp',otpPolicyAlgorithm:'HmacSHA1',otpPolicyDigits:6,otpPolicyPeriod:30,attributes:{...realm.attributes,'eulab.previousBrowserFlow':realm.attributes?.['eulab.previousBrowserFlow']||realm.browserFlow||'browser'}});
 return {prepared:true,activated:true,previousFlow:realm.browserFlow||'browser'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.loadEnvFile(process.env.EULAB_ENV_FILE||'.env');
 const origin=process.env.KEYCLOAK_INTERNAL_URL||process.env.PUBLIC_KEYCLOAK_URL||'http://localhost:8080';
 const response=await fetch(origin+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KEYCLOAK_ADMIN,password:process.env.KEYCLOAK_ADMIN_PASSWORD}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('Autenticazione amministrativa Keycloak non riuscita');
 const token=(await response.json()).access_token;
 const admin=async(path,method='GET',body)=>{const r=await fetch(origin+'/admin/realms/eulab'+path,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Configurazione sicurezza '+method+' '+path+': '+r.status);const text=await r.text();return text?JSON.parse(text):null;};
 await setupSecurityProfile(admin);
 console.log(JSON.stringify(await setupSecurity(admin,{activate:process.argv.includes('--activate')})));
}
