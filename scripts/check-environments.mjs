import {readFile,stat} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const required=['POSTGRES_PASSWORD','REDIS_PASSWORD','DATA_ENCRYPTION_KEY','OIDC_CLIENT_SECRET','OIDC_IDENTITY_ADMIN_SECRET','KEYCLOAK_ADMIN_PASSWORD','EULAB_ADMIN_PASSWORD'];
const smtp=['SMTP_HOST','SMTP_PORT','SMTP_FROM','SMTP_USER','SMTP_PASSWORD','SMTP_SECURITY'];
for(const [file,production] of [['.env',false],['.env.production',true]]){
 const content=await readFile(file,'utf8'),env=parseEnv(content);
 assert.equal((await stat(file)).mode&0o777,0o600,`${file}: usare permessi 0600`);
 for(const key of [...required,...smtp])assert(Object.hasOwn(env,key),`${file}: manca ${key}`);
 for(const key of required)assert(env[key],`${file}: ${key} vuoto`);
 const keys=content.split('\n').map(l=>l.match(/^([A-Z][A-Z0-9_]*)=/)?.[1]).filter(Boolean);
 assert.equal(keys.length,new Set(keys).size,`${file}: chiavi duplicate`);
 assert(['starttls','tls'].includes(env.SMTP_SECURITY),`${file}: SMTP_SECURITY non valido`);
 assert(Number.isInteger(Number(env.SMTP_PORT))&&Number(env.SMTP_PORT)>0&&Number(env.SMTP_PORT)<65536,`${file}: porta SMTP non valida`);
 assert.equal(!!env.SMTP_USER,!!env.SMTP_PASSWORD,`${file}: credenziali SMTP incomplete`);
 if(env.SMTP_FROM)assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SMTP_FROM),`${file}: mittente SMTP non valido`);
 const args=['compose','--env-file',file,'-f','compose.yaml',...(production?['-f','infra/compose.production.yaml']:[]),'config','--format','json'];
 const result=spawnSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024});
 // Never print the rendered configuration: it contains interpolated secrets.
 assert.equal(result.status,0,`${file}: configurazione Compose non valida; eseguire config --quiet`);
 const config=JSON.parse(result.stdout),services=config.services;
 for(const key of smtp)assert.equal(services.api.environment[key],env[key],`${file}: ${key} non inoltrato all’API`);
 assert.equal(config.name,production?'eulab-connect-production':'eulab-connect');
 if(production){
  assert(!Object.keys(services).some(k=>k.startsWith('qa-')),'Servizi QA in produzione');
  assert.equal(services.keycloak.ports?.length||0,0,'Porta Keycloak esposta in produzione');
  assert(services.keycloak.command.includes('--optimized'));
  assert.equal(services.api.environment.OIDC_ISSUER,env.PUBLIC_OIDC_ISSUER);
  assert.equal(new URL(env.PUBLIC_OIDC_ISSUER).protocol,'https:');
  if(env.CONNECT_BIND_IP==='127.0.0.1'||env.NPM_TRUSTED_CIDR==='127.0.0.1/32')console.log(`${file}: IP Connect/NPM ancora da impostare per il deploy remoto.`);
 }
 console.log(`${file}: chiavi, permessi, Compose e inoltro SMTP OK; SMTP ${env.SMTP_HOST&&env.SMTP_FROM?'compilato (trasporto non collaudato)':'da compilare'}.`);
}
console.log('Controllo statico completato. Nessuna modifica o attivazione del runtime.');
