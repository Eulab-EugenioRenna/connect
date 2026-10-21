import nodemailer from 'nodemailer';
import {smtpConfig} from '../dist/server/apps/api/src/mail.service.js';
if(process.env.EULAB_ENV_FILE)process.loadEnvFile(process.env.EULAB_ENV_FILE);
const c=smtpConfig();
try{
 await nodemailer.createTransport({host:c.host,port:c.port,secure:c.security==='tls',requireTLS:c.security==='starttls',auth:c.user?{user:c.user,pass:c.password}:undefined,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,logger:false,debug:false}).verify();
 console.log('SMTP: TLS e autenticazione verificati. Nessuna email inviata.');
 if(process.argv.includes('--sync')){
  const origin=process.env.KEYCLOAK_INTERNAL_URL||process.env.PUBLIC_KEYCLOAK_URL;
  if(!origin||!process.env.KEYCLOAK_ADMIN||!process.env.KEYCLOAK_ADMIN_PASSWORD)throw new Error('Configurazione amministrativa SSO incompleta');
  const auth=await fetch(origin+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KEYCLOAK_ADMIN,password:process.env.KEYCLOAK_ADMIN_PASSWORD}),signal:AbortSignal.timeout(10000)});
  if(!auth.ok)throw new Error('Autenticazione amministrativa SSO rifiutata');
  const token=(await auth.json()).access_token;
  const result=await fetch(origin+'/admin/realms/eulab',{method:'PUT',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({emailTheme:'eulab',smtpServer:{host:c.host,port:String(c.port),from:c.from,fromDisplayName:'EULab Connect',auth:String(!!c.user),user:c.user,password:c.password,ssl:String(c.security==='tls'),starttls:String(c.security==='starttls')}}),signal:AbortSignal.timeout(10000)});
  if(!result.ok)throw new Error('Sincronizzazione SSO non riuscita');
  console.log('SMTP sincronizzato con Keycloak. Flusso MFA invariato.');
 }
}catch(error){console.error('Verifica SMTP/SSO non riuscita: '+(error.code||'errore di connessione o configurazione')+'. Nessuna email inviata.');process.exitCode=1;}
