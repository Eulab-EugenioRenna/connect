// Only disposable synthetic PostgreSQL. Does not read .env, connect to running services or load WhatsApp.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const name='connect-automation-test-'+randomUUID(),password='synthetic-only-'+randomUUID();
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let started=false,passed=false,output='';
try{
 docker(['run','-d','--rm','--name',name,'--tmpfs','/var/lib/postgresql/data:rw','-p','127.0.0.1::5432','-e','POSTGRES_USER=synthetic','-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB=connect_automation_synthetic','postgres:17.6-bookworm']);started=true;
 const port=JSON.parse(docker(['inspect',name]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
 for(let n=0;n<30;n++){try{docker(['exec',name,'pg_isready','-U','synthetic','-d','connect_automation_synthetic']);break;}catch{assert(n<29,'Synthetic PostgreSQL startup timeout');await new Promise(r=>setTimeout(r,500));}}
 const env={...process.env,CONNECT_AUTOMATION_TEST_DATABASE_URL:`postgres://synthetic:${password}@127.0.0.1:${port}/connect_automation_synthetic`,CONNECT_AUTOMATION_TEST_CONTAINER:name};
 // Exercise the actual migrator twice in a separate empty synthetic schema.
 docker(['exec',name,'psql','-U','synthetic','-d','connect_automation_synthetic','-c','CREATE SCHEMA synthetic_migrator']);
 const migrationUrl=new URL(env.CONNECT_AUTOMATION_TEST_DATABASE_URL);migrationUrl.searchParams.set('options','-c search_path=synthetic_migrator');
 for(let pass=0;pass<2;pass++)execFileSync(process.execPath,['dist/server/apps/api/src/migrate.js'],{env:{...env,DATABASE_URL:migrationUrl.href},stdio:['ignore','pipe','pipe']});
 const version=docker(['exec',name,'psql','-U','synthetic','-d','connect_automation_synthetic','-Atc',"SELECT count(*)||':'||max(version) FROM synthetic_migrator.schema_migrations"]);assert.equal(version,'15:015');
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','tests/automation-delegations.test.mjs','tests/automation-events.test.mjs','tests/automation-migration.test.mjs','tests/automation-process.test.mjs','tests/automation-withdrawal.test.mjs'],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{output+=b;process.stdout.write(b);});child.stderr.on('data',b=>{output+=b;process.stderr.write(b);});child.on('error',reject);child.on('exit',resolve);});
 assert.equal(result,0,'Synthetic automation tests failed');passed=true;
}finally{
 if(started)docker(['rm','-f',name]);
 await mkdir('dist/verification/automations',{recursive:true});
 await writeFile('dist/verification/automations/postgres-tests.tap',output);
 await writeFile('dist/verification/automations/isolated-run.json',JSON.stringify({at:new Date().toISOString(),passed,database:'disposable PostgreSQL 17.6, tmpfs, loopback',identity:'synthetic JWT/introspection and central authorization fixtures',provider:'synthetic functions and isolated process; no WhatsApp client',cleanupVerified:started,actualMigratorAppliedTwice:true,production:false,realAccounts:false,realMessages:false},null,2)+'\n');
}
