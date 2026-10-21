import {randomBytes} from 'node:crypto';
import {readFile,appendFile} from 'node:fs/promises';
import pg from 'pg';
const envFile=process.env.EULAB_ENV_FILE||'.env';
process.loadEnvFile(envFile);
// The initial profile is editable in .env before running this command. Existing passwords are never overwritten.
const defaults={OIDC_IDENTITY_ADMIN_SECRET:randomBytes(32).toString('hex'),EULAB_ADMIN_USERNAME:'admin',EULAB_ADMIN_EMAIL:'admin@eulab.local',EULAB_ADMIN_NAME:'Amministratore EULab',EULAB_ADMIN_PASSWORD:randomBytes(32).toString('hex')};
const current=await readFile(envFile,'utf8');const missing=Object.entries(defaults).filter(([key])=>!new RegExp(`^${key}=`,'m').test(current));
if(missing.length){await appendFile(envFile,'\n# Amministratore iniziale e gestione identità SSO\n'+missing.map(([key,value])=>`${key}=${value}`).join('\n')+'\n');for(const [key,value]of missing)process.env[key]=value;}
const issuer=process.env.KEYCLOAK_INTERNAL_URL||process.env.QA_KEYCLOAK_URL||'http://keycloak:8080';
async function request(path,method='GET',body,token){const r=await fetch(issuer+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),'content-type':body instanceof URLSearchParams?'application/x-www-form-urlencoded':'application/json'},body:body===undefined?undefined:body instanceof URLSearchParams?body:JSON.stringify(body)});if(!r.ok)throw new Error(`Configurazione SSO ${method} ${path}: ${r.status}`);const t=await r.text();return t?JSON.parse(t):null;}
const auth=await request('/realms/master/protocol/openid-connect/token','POST',new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KEYCLOAK_ADMIN,password:process.env.KEYCLOAK_ADMIN_PASSWORD}));
const admin=(path,method='GET',body)=>request('/admin/realms/eulab'+path,method,body,auth.access_token);
let [client]=await admin('/clients?clientId=connect-identity-admin');
if(!client){await admin('/clients','POST',{clientId:'connect-identity-admin',enabled:true,publicClient:false,secret:process.env.OIDC_IDENTITY_ADMIN_SECRET,serviceAccountsEnabled:true,standardFlowEnabled:false,directAccessGrantsEnabled:false});[client]=await admin('/clients?clientId=connect-identity-admin');}
const service=await admin(`/clients/${client.id}/service-account-user`);const [management]=await admin('/clients?clientId=realm-management');
const roles=[];for(const key of ['view-users','query-users','manage-users','view-realm','manage-realm','view-clients','manage-clients'])roles.push(await admin(`/clients/${management.id}/roles/${key}`));
await admin(`/users/${service.id}/role-mappings/clients/${management.id}`,'POST',roles);
if(process.env.PUBLIC_CONNECT_URL){
 const origin=new URL(process.env.PUBLIC_CONNECT_URL);if(origin.protocol!=='https:'||origin.href!==origin.origin+'/')throw new Error('PUBLIC_CONNECT_URL deve essere un’origine HTTPS esatta');
 const [dashboard]=await admin('/clients?clientId=connect-admin');if(!dashboard)throw new Error('Client connect-admin non trovato');
 const callback=origin.origin+'/admin/';await admin('/clients/'+dashboard.id,'PUT',{...dashboard,redirectUris:[callback],webOrigins:[origin.origin],attributes:{...dashboard.attributes,'post.logout.redirect.uris':callback}});
}
const username=process.env.EULAB_ADMIN_USERNAME;
let [user]=await admin('/users?exact=true&username='+encodeURIComponent(username));
const role=await admin('/roles/eulab-admin');
if(user){
 const assigned=await admin(`/users/${user.id}/role-mappings/realm/composite`);
 if(!assigned.some(r=>r.name==='eulab-admin'))throw new Error('Username già usato da un’identità non admin: nessuna promozione automatica. Scegli un altro username o usa la dashboard con una decisione esplicita.');
}else{
 await admin('/users','POST',{username,enabled:true,email:process.env.EULAB_ADMIN_EMAIL,firstName:process.env.EULAB_ADMIN_NAME.split(' ')[0],lastName:process.env.EULAB_ADMIN_NAME.split(' ').slice(1).join(' '),credentials:[{type:'password',value:process.env.EULAB_ADMIN_PASSWORD,temporary:false}]});
 [user]=await admin('/users?exact=true&username='+encodeURIComponent(username));await admin(`/users/${user.id}/role-mappings/realm`,'POST',[role]);
}
await admin(`/users/${user.id}`,'PUT',{...user,firstName:process.env.EULAB_ADMIN_NAME.split(' ')[0],lastName:process.env.EULAB_ADMIN_NAME.split(' ').slice(1).join(' '),email:process.env.EULAB_ADMIN_EMAIL});
const pool=new pg.Pool({host:'postgres',database:'connect',user:'connect',password:process.env.POSTGRES_PASSWORD});
try{await pool.query('INSERT INTO identities VALUES($1,$2,true) ON CONFLICT(subject) DO UPDATE SET display_name=$2',[user.id,process.env.EULAB_ADMIN_NAME]);await pool.query("INSERT INTO audit(actor,action,target,detail) VALUES('setup','identity.admin.bootstrap',$1,$2)",[user.id,JSON.stringify({username,type:'admin',realm:'eulab',passwordOverwritten:false})]);}finally{await pool.end();}
console.log('Amministratore iniziale configurato nello stesso SSO dei clienti; password conservata nel file ambiente. Servizio gestione identità pronto.');
