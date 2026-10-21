import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
// Uses fresh volumes and generated credentials. Never targets the existing stack.
const scratch=await mkdtemp(join(tmpdir(),'connect-production-qa-'));
const project='connect-verify-'+Date.now().toString(36),envFile=join(scratch,'.env.production'),override=join(scratch,'compose.yaml');
const secret=()=>randomBytes(32).toString('hex');
const env={POSTGRES_PASSWORD:secret(),REDIS_PASSWORD:secret(),DATA_ENCRYPTION_KEY:secret(),OIDC_CLIENT_SECRET:secret(),OIDC_IDENTITY_ADMIN_SECRET:secret(),KEYCLOAK_ADMIN:'test-operator',KEYCLOAK_ADMIN_PASSWORD:secret(),EULAB_ADMIN_USERNAME:'test-admin',EULAB_ADMIN_EMAIL:'admin@example.test',EULAB_ADMIN_NAME:'Amministratore test',EULAB_ADMIN_PASSWORD:secret(),PUBLIC_CONNECT_URL:'https://auth.eulab.cloud',PUBLIC_KEYCLOAK_URL:'https://auth.eulab.cloud',PUBLIC_OIDC_ISSUER:'https://auth.eulab.cloud/sso/realms/eulab',KEYCLOAK_INTERNAL_URL:'http://keycloak:8080/sso',CONNECT_BIND_IP:'127.0.0.1',CONNECT_HTTP_PORT:'8088',NPM_TRUSTED_CIDR:'127.0.0.1/32',RUNNER_CAPACITY:'1'};
await writeFile(envFile,Object.entries(env).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
await writeFile(override,`services:\n  api:\n    image: eulab-connect-production-api\n  bootstrap:\n    image: eulab-connect-production-bootstrap\n  migrate:\n    image: eulab-connect-production-migrate\n  runner:\n    image: eulab-connect-production-runner\n  web:\n    image: eulab-connect-production-web\n    ports: !reset []\n`);
const base=['compose','--project-directory',process.cwd(),'-p',project,'--env-file',envFile,'-f','compose.yaml','-f','infra/compose.production.yaml','-f',override];
function run(args,capture=false){const r=spawnSync('docker',[...base,...args],{stdio:capture?'pipe':'inherit',encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw new Error('Verifica Docker fallita: '+args[0]+(capture?' (output riservato, nessun segreto stampato)':''));return r.stdout;}
let started=false;
try{
 run(['config','--quiet']);started=true;
 run(['up','-d','--no-build','--wait','--wait-timeout','240']);
 const probe=`let ready=false;for(let n=0;n<90;n++){try{const r=await fetch('http://keycloak:8080/sso/realms/eulab/.well-known/openid-configuration');if(r.ok){const d=await r.json();if(d.issuer!==${JSON.stringify(env.PUBLIC_OIDC_ISSUER)})throw Error('ISSUER_MISMATCH');ready=true;break;}}catch(error){if(error.message==='ISSUER_MISMATCH')throw error;}await new Promise(r=>setTimeout(r,2000));}if(!ready)throw Error('KEYCLOAK_NOT_READY');console.log('Discovery OIDC produzione OK');`;
 run(['exec','-T','api','node','--input-type=module','-e',probe]);
 const health=JSON.parse(run(['exec','-T','web','wget','-q','-O','-','http://127.0.0.1/v1/health'],true));assert.equal(health.status,'ok');
 const html=run(['exec','-T','web','wget','-q','-O','-','http://127.0.0.1/admin/'],true);assert(html.includes('/admin/assets/'),'Asset admin senza prefisso produzione');
 run(['exec','-T','web','nginx','-t']);
 const database=`import pg from 'pg';const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});try{const m=await pool.query('SELECT count(*)::int AS n FROM schema_migrations');if(m.rows[0].n!==9)throw Error('MIGRATIONS_MISSING');const i=await pool.query('SELECT count(*)::int AS n FROM identities');if(i.rows[0].n!==1)throw Error('ADMIN_MISSING');let ready=false;for(let n=0;n<15;n++){const r=await pool.query("SELECT id FROM runners WHERE id='runner-1' AND heartbeat_at>now()-interval '20 seconds'");if(r.rowCount){ready=true;break;}await new Promise(r=>setTimeout(r,1000));}if(!ready)throw Error('RUNNER_NOT_READY');console.log('Database 001–009, admin SSO e heartbeat runner OK');}finally{await pool.end();}`;
 run(['exec','-T','api','node','--input-type=module','-e',database]);
 // A second migration run verifies the startup path is repeatable.
 run(['run','--rm','--no-deps','migrate']);
 await mkdir('docs/verification/openwaunlocked',{recursive:true});
 await writeFile('docs/verification/openwaunlocked/production-runtime.json',JSON.stringify({at:new Date().toISOString(),project,isolated:true,migrations:9,oidcDiscovery:true,adminBootstrap:true,apiHealth:true,adminAssets:true,nginx:true,runnerHeartbeat:true,repeatMigration:true,publicDnsVerified:false,smtpVerified:false,whatsappPaired:false,messagesSent:0,callsStarted:0},null,2)+'\n');
 console.log('Runtime produzione isolato verificato. Nessun invio, pairing WhatsApp o accesso agli ambienti esistenti.');
}finally{
 try{if(started)run(['down','--volumes','--remove-orphans']);}finally{await rm(scratch,{recursive:true,force:true});}
}
