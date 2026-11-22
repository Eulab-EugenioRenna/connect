import {configureIdentityProofProfile} from './identity-proof-profile.mjs';
import {randomBytes} from 'node:crypto';
import {readFile,appendFile} from 'node:fs/promises';
import pg from 'pg';
const envFile=process.env.EULAB_ENV_FILE||'.env';
if(process.env.CONNECT_BOOTSTRAP!=='true'){
process.loadEnvFile(envFile);
// The initial profile is editable in .env before running this command. Existing passwords are never overwritten.
const defaults={OIDC_IDENTITY_ADMIN_SECRET:randomBytes(32).toString('hex'),EULAB_ADMIN_USERNAME:'admin',EULAB_ADMIN_EMAIL:'admin@eulab.local',EULAB_ADMIN_NAME:'Amministratore EULab',EULAB_ADMIN_PASSWORD:randomBytes(32).toString('hex')};
const current=await readFile(envFile,'utf8');const missing=Object.entries(defaults).filter(([key])=>!new RegExp(`^${key}=`,'m').test(current));
if(missing.length){await appendFile(envFile,'\n# Amministratore iniziale e gestione identità SSO\n'+missing.map(([key,value])=>`${key}=${value}`).join('\n')+'\n');for(const [key,value]of missing)process.env[key]=value;}
}
for(const key of ['OIDC_IDENTITY_ADMIN_SECRET','EULAB_ADMIN_USERNAME','EULAB_ADMIN_EMAIL','EULAB_ADMIN_NAME','EULAB_ADMIN_PASSWORD','KEYCLOAK_ADMIN','KEYCLOAK_ADMIN_PASSWORD'])if(!process.env[key])throw new Error(`Configurazione bootstrap mancante: ${key}`);
const issuer=process.env.KEYCLOAK_INTERNAL_URL||process.env.QA_KEYCLOAK_URL||'http://keycloak:8080';
// Readiness is checked before any write; importing the realm can take time.
let ready=false;const deadline=Date.now()+180_000;
while(Date.now()<deadline){
 try{const r=await fetch(issuer+'/realms/eulab/.well-known/openid-configuration',{signal:AbortSignal.timeout(5000)});if(r.ok){ready=true;break;}}catch{}
 await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!ready)throw new Error('Keycloak non pronto dopo 180 secondi: bootstrap non eseguito');
async function request(path,method='GET',body,token){const r=await fetch(issuer+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),'content-type':body instanceof URLSearchParams?'application/x-www-form-urlencoded':'application/json'},body:body===undefined?undefined:body instanceof URLSearchParams?body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});if(!r.ok)throw new Error(`Configurazione SSO ${method} ${path}: ${r.status}`);const t=await r.text();return t?JSON.parse(t):null;}
const auth=await request('/realms/master/protocol/openid-connect/token','POST',new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KEYCLOAK_ADMIN,password:process.env.KEYCLOAK_ADMIN_PASSWORD}));
const admin=(path,method='GET',body)=>request('/admin/realms/eulab'+path,method,body,auth.access_token);
await configureIdentityProofProfile(admin);
let [client]=await admin('/clients?clientId=connect-identity-admin');
if(!client){await admin('/clients','POST',{clientId:'connect-identity-admin',enabled:true,publicClient:false,secret:process.env.OIDC_IDENTITY_ADMIN_SECRET,serviceAccountsEnabled:true,standardFlowEnabled:false,directAccessGrantsEnabled:false});[client]=await admin('/clients?clientId=connect-identity-admin');}
const service=await admin(`/clients/${client.id}/service-account-user`);const [management]=await admin('/clients?clientId=realm-management');
const roles=[];for(const key of ['view-users','query-users','manage-users','view-realm','manage-realm','view-clients','manage-clients'])roles.push(await admin(`/clients/${management.id}/roles/${key}`));
await admin(`/users/${service.id}/role-mappings/clients/${management.id}`,'POST',roles);
if(process.env.PUBLIC_CONNECT_URL){
 const origin=new URL(process.env.PUBLIC_CONNECT_URL);if(origin.protocol!=='https:'||origin.href!==origin.origin+'/')throw new Error('PUBLIC_CONNECT_URL deve essere un’origine HTTPS esatta');
 const [dashboard]=await admin('/clients?clientId=connect-admin');if(!dashboard)throw new Error('Client connect-admin non trovato');
 const callback=origin.origin+'/admin/';await admin('/clients/'+dashboard.id,'PUT',{...dashboard,redirectUris:[callback],webOrigins:[origin.origin],attributes:{...dashboard.attributes,'post.logout.redirect.uris':callback}});
}else{
 const [dashboard]=await admin('/clients?clientId=connect-admin');if(!dashboard)throw new Error('Client connect-admin non trovato');
 const origins=['http://localhost:8088','http://127.0.0.1:8088','http://localhost:5173','http://127.0.0.1:5173'];
 if(!dashboard.redirectUris?.some(uri=>origins.some(origin=>uri.startsWith(origin+'/'))))throw new Error('Client senza callback locali: configurare PUBLIC_CONNECT_URL per la produzione');
 await admin('/clients/'+dashboard.id,'PUT',{...dashboard,redirectUris:[...new Set([...dashboard.redirectUris,...origins.map(origin=>origin+'/')])],webOrigins:[...new Set([...(dashboard.webOrigins||[]),...origins])]});
}
const username=process.env.EULAB_ADMIN_USERNAME;
let [user]=await admin('/users?exact=true&username='+encodeURIComponent(username));
const role=await admin('/roles/eulab-admin');
if(user){
 const assigned=await admin(`/users/${user.id}/role-mappings/realm/composite`);
 if(!assigned.some(r=>r.name==='eulab-admin')){
  if(user.attributes?.['connect-bootstrap-admin']?.[0]!=='v1')throw new Error('Username già usato da un’identità non admin: nessuna promozione automatica. Scegli un altro username o usa la dashboard con una decisione esplicita.');
  await admin(`/users/${user.id}/role-mappings/realm`,'POST',[role]);
 }
}else{
 await admin('/users','POST',{username,enabled:true,email:process.env.EULAB_ADMIN_EMAIL,firstName:process.env.EULAB_ADMIN_NAME.split(' ')[0],lastName:process.env.EULAB_ADMIN_NAME.split(' ').slice(1).join(' '),attributes:{'connect-bootstrap-admin':['v1']},credentials:[{type:'password',value:process.env.EULAB_ADMIN_PASSWORD,temporary:false}]});
 [user]=await admin('/users?exact=true&username='+encodeURIComponent(username));await admin(`/users/${user.id}/role-mappings/realm`,'POST',[role]);
}
const pool=new pg.Pool(process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:'postgres',database:'connect',user:'connect',password:process.env.POSTGRES_PASSWORD});
const displayName=[user.firstName,user.lastName].filter(Boolean).join(' ')||user.username;
try{await pool.query('INSERT INTO identities VALUES($1,$2,true) ON CONFLICT(subject) DO NOTHING',[user.id,displayName]);await pool.query("INSERT INTO audit(actor,action,target,detail) VALUES('setup','identity.admin.bootstrap',$1,$2)",[user.id,JSON.stringify({username,type:'admin',realm:'eulab',passwordOverwritten:false})]);}finally{await pool.end();}
console.log('Bootstrap SSO completato: admin e servizio identità pronti. Password e profili esistenti conservati.');
