import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';

// This test owns only its randomly named project and fresh volumes.
const scratch=await mkdtemp(join(tmpdir(),'connect-startup-'));
const project='connect-startup-'+randomBytes(6).toString('hex');
const envFile=join(scratch,'.env'),overlay=join(scratch,'compose.yaml');
const secret=()=>randomBytes(32).toString('hex');
const env={POSTGRES_PASSWORD:secret(),REDIS_PASSWORD:secret(),DATA_ENCRYPTION_KEY:secret(),MIGRATION_ENCRYPTION_KEY:secret(),ONBOARDING_PASSWORD_TTL_SECONDS:'86400',OIDC_CLIENT_SECRET:secret(),OIDC_IDENTITY_ADMIN_SECRET:secret(),KEYCLOAK_ADMIN:'test-operator',KEYCLOAK_ADMIN_PASSWORD:secret(),EULAB_ADMIN_USERNAME:'test-admin',EULAB_ADMIN_EMAIL:'admin@example.test',EULAB_ADMIN_NAME:'Admin First Boot',EULAB_ADMIN_PASSWORD:secret()};
const password=env.EULAB_ADMIN_PASSWORD;
const saveEnv=()=>writeFile(envFile,Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
await saveEnv();
const services=Object.fromEntries(['api','migrate','runner','web','bootstrap'].map(name=>[name,{image:name==='bootstrap'?(process.env.BOOTSTRAP_TEST_IMAGE||'eulab-connect-bootstrap'):'eulab-connect-'+name,build:null}]));
services.web.ports=[];
// Use YAML reset tags to prevent inherited host ports and builds.
let yaml='services:\n';
for(const [name,config] of Object.entries(services))yaml+=`  ${name}:\n    image: ${config.image}\n    build: !reset null\n${name==='web'?'    ports: !reset []\n':''}`;
yaml+='  keycloak:\n    pull_policy: never\n    ports: !reset []\n';
await writeFile(overlay,yaml);
const base=['compose','--project-directory',process.cwd(),'-p',project,'--env-file',envFile,'-f','compose.yaml','-f',overlay];
function run(args,input){
 const r=spawnSync('docker',[...base,...args],{encoding:'utf8',input,maxBuffer:8*1024*1024,timeout:300_000});
 if(r.status!==0)throw new Error(`Collaudo ${args[0]} fallito: ${r.error?.message||r.stderr||'vedere stato container'}`);
 return r.stdout;
}
const probe=`
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
const issuer='http://keycloak:8080/realms/eulab';
let claims,tokens;
for(const redirect of ['http://localhost:8088/','http://127.0.0.1:8088/']){
 const verifier=randomBytes(48).toString('base64url');
 const url=new URL(issuer+'/protocol/openid-connect/auth');
 Object.entries({client_id:'connect-admin',redirect_uri:redirect,response_type:'code',scope:'openid',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state:randomBytes(16).toString('hex')}).forEach(([k,v])=>url.searchParams.set(k,v));
 const page=await fetch(url,{redirect:'manual'});assert.equal(page.status,200);
 const html=await page.text(),action=html.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replaceAll('&amp;','&');assert(action);
 const internal=new URL(action);internal.host='keycloak:8080';internal.protocol='http:';
 const login=await fetch(internal,{method:'POST',redirect:'manual',headers:{cookie:page.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')},body:new URLSearchParams({username:process.env.EULAB_ADMIN_USERNAME,password:${JSON.stringify(password)},credentialId:''})});
 assert.equal(login.status,302,'Login admin non riuscito');const destination=new URL(login.headers.get('location'));assert(destination.searchParams.has('code'));
 const response=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:'connect-admin',redirect_uri:redirect,code:destination.searchParams.get('code'),code_verifier:verifier})});assert.equal(response.status,200);
 tokens=await response.json();claims=JSON.parse(Buffer.from(tokens.access_token.split('.')[1],'base64url'));assert(claims.realm_access.roles.includes('eulab-admin'));
 let apiReady=false;for(let n=0;n<30;n++){try{const r=await fetch('http://api:3000/v1/context',{headers:{authorization:'Bearer '+tokens.access_token},signal:AbortSignal.timeout(3000)});if(r.status===200){apiReady=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}assert(apiReady,'API admin non pronta');
 const logout=await fetch(issuer+'/protocol/openid-connect/logout',{method:'POST',body:new URLSearchParams({client_id:'connect-admin',refresh_token:tokens.refresh_token})});assert.equal(logout.status,204);
}
const service=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:'connect-identity-admin',client_secret:process.env.OIDC_IDENTITY_ADMIN_SECRET})});assert.equal(service.status,200,'Servizio identita non configurato');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,13);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM identities WHERE subject=$1',[claims.sub])).rows[0].n,1);
 let ready=false;for(let n=0;n<30;n++){if((await pool.query("SELECT id FROM runners WHERE heartbeat_at>now()-interval '20 seconds'")).rowCount){ready=true;break;}await new Promise(r=>setTimeout(r,1000));}assert(ready,'Runner non pronto');
 console.log(JSON.stringify({subject:claims.sub,name:claims.name,login:true,api:true,identityService:true,migrations:13,runner:true}));
}finally{await pool.end();}
`;
let started=false;
try{
 run(['config','--quiet']);started=true;
 run(['up','-d','--no-build','--wait','--wait-timeout','240']);
 const first=JSON.parse(run(['run','--rm','--no-deps','-T','--entrypoint','node','bootstrap','--input-type=module'],probe));
 assert.equal(JSON.parse(run(['exec','-T','web','wget','-q','-O','-','http://127.0.0.1/v1/health'])).status,'ok');
 console.log('Primo compose up: login PKCE localhost/127.0.0.1, ruolo admin, API, servizio identità, migrazioni e runner OK');
 // Changing bootstrap defaults must never reset an existing account.
 env.EULAB_ADMIN_PASSWORD=secret();env.EULAB_ADMIN_NAME='Changed Bootstrap Default';await saveEnv();
 run(['up','-d','--no-build','--wait','--wait-timeout','240','--force-recreate']);
 const second=JSON.parse(run(['run','--rm','--no-deps','-T','--entrypoint','node','bootstrap','--input-type=module'],probe));
 assert.deepEqual(second,first,'Il secondo avvio ha modificato identita o profilo');
 await mkdir('docs/verification/startup',{recursive:true});
 await writeFile('docs/verification/startup/compose-up.json',JSON.stringify({at:new Date().toISOString(),project,isolated:true,bootstrapImage:services.bootstrap.image,bootstrapImageOverride:!!process.env.BOOTSTRAP_TEST_IMAGE,freshVolumes:true,automaticBootstrap:true,loginPkce:true,loopbackCallbacks:true,adminApi:true,identityService:true,migrations:13,runnerHeartbeat:true,secondUp:true,existingPasswordPreserved:true,existingSubjectPreserved:true,existingProfilePreserved:true,whatsappPaired:false,messagesSent:0},null,2)+'\n');
 console.log('Secondo compose up: ID, profilo e password originali conservati. Nessun bootstrap manuale.');
}finally{
 try{if(started)run(['down','--volumes','--remove-orphans']);}finally{await rm(scratch,{recursive:true,force:true});}
}
