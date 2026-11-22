import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {harness} from './harness.mjs';
import {seal} from '../dist/server/apps/api/src/security.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const customer='00000000-0000-4000-a000-000000000001',installation='00000000-0000-4000-a000-000000000002',archive='00000000-0000-4000-a000-000000000003',session='00000000-0000-4000-a000-000000000004',message='00000000-0000-4000-a000-000000000005',event='00000000-0000-4000-a000-000000000006';

test('Schema 015: readable synthetic backup, restore rehearsal and repeat migration preserve every original row/field including manual, bot, webhook and delivery',async()=>{
 let before,columns,backup,backupList;const query=(db,sql,p=[])=>db.query(sql,p).then(r=>r.rows);
 async function snapshot(db){const result={};for(const [table,fields] of Object.entries(columns))result[table]=await query(db,`SELECT ${fields.map(f=>'"'+f+'"').join(',')} FROM "${table}" ORDER BY 1::text`);for(const rows of Object.values(result))rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));return result;}
 const databaseUrl=process.env.CONNECT_AUTOMATION_TEST_DATABASE_URL;
 if(databaseUrl){const url=new URL(databaseUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/connect_automation_synthetic');}
 const h=await harness({...databaseUrl?{databaseUrl}:{},beforeAutomationMigration:async pg=>{
  await pg.query("INSERT INTO customers(id,name) VALUES($1,'Preserved synthetic customer')",[customer]);
  await pg.query("INSERT INTO applications(id,name) VALUES('preserved-app','Preserved synthetic app')");
  await pg.query("INSERT INTO identities(subject,display_name) VALUES('preserved-user','Synthetic preserved author')");
  await pg.query("INSERT INTO installations(id,customer_id,app_id,domain,fallback_url,secret_hash) VALUES($1,$2,'preserved-app','https://preserved.example.test','https://preserved.example.test/functions','synthetic-hash')",[installation,customer]);
  await pg.query("INSERT INTO licenses(customer_id,app_id,state) VALUES($1,'preserved-app','active')",[customer]);
  await pg.query("INSERT INTO wa_archives(id,installation_id,number) VALUES($1,$2,'15550000001')",[archive,installation]);
  await pg.query("INSERT INTO wa_sessions(id,installation_id,runner_id,archive_id,number,state) VALUES($1,$2,'preserved-runner',$3,'15550000001','connected')",[session,installation,archive]);
  await pg.query("INSERT INTO wa_bots(archive_id,definition,actor) VALUES($1,'{}','preserved-user')",[archive]);
  for(const bot of [false,true])await pg.query("INSERT INTO outbox(id,installation_id,session_id,idempotency_key,request_hash,payload,actor,authorization_cipher,bot_archive_id,bot_revision) VALUES(gen_random_uuid(),$1,$2,$3,'preserved-hash','{}','preserved-user',$4,$5,$6)",[installation,session,bot?'preserved-bot':'preserved-manual',bot?'':seal('preserved-synthetic-token'),bot?archive:null,bot?1:null]);
  await pg.query("INSERT INTO messages(id,session_id,archive_id,provider_id,chat_id,direction,kind,body) VALUES($1,$2,$3,'preserved-provider','15550000002@c.us','in','chat','{\"text\":\"Preserved\"}')",[message,session,archive]);
  await pg.query("INSERT INTO webhook_endpoints(id,installation_id,url,secret_cipher) VALUES('00000000-0000-4000-a000-000000000007',$1,'https://preserved.example.test/hook',$2)",[installation,seal('preserved-synthetic-webhook-secret')]);
  await pg.query("INSERT INTO events(id,installation_id,session_id,kind,payload) VALUES($1,$2,$3,'message.received','{\"providerId\":\"preserved-provider\"}')",[event,installation,session]);
  await pg.query("INSERT INTO deliveries(id,event_id,endpoint_id) VALUES('00000000-0000-4000-a000-000000000008',$1,'00000000-0000-4000-a000-000000000007')",[event]);
  const schema=(await query(pg,'SELECT current_schema() AS name'))[0].name;
  const all=await query(pg,"SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position",[schema]);
  columns={};for(const row of all)(columns[row.table_name]??=[]).push(row.column_name);
  before=await snapshot(pg);
  if(process.env.CONNECT_AUTOMATION_TEST_CONTAINER){
   const container=process.env.CONNECT_AUTOMATION_TEST_CONTAINER;assert.match(container,/^connect-automation-test-[a-f0-9-]+$/);
   const docker=(args,input)=>execFileSync('docker',args,{input,maxBuffer:20*1024*1024});
   backup=docker(['exec',container,'pg_dump','-U','synthetic','-d','connect_automation_synthetic','-Fc','-n',schema,'--no-owner']);
   backupList=docker(['exec','-i',container,'pg_restore','--list'],backup).toString();assert(backupList.includes('TABLE DATA '+schema+' outbox'));
   docker(['exec',container,'createdb','-U','synthetic','connect_automation_restore']);
   docker(['exec','-i',container,'pg_restore','-U','synthetic','-d','connect_automation_restore','--no-owner'],backup);
   const {default:driver}=await import('pg');const url=new URL(databaseUrl);url.pathname='/connect_automation_restore';
   const pool=new driver.Pool({connectionString:url.href,options:'-c search_path='+schema});
   try{assert.deepEqual(await snapshot(pool),before);const migration=await readFile('infra/postgres/015-automation-delegations.sql','utf8');await pool.query(migration);await pool.query(migration);assert.deepEqual(await snapshot(pool),before);}finally{await pool.end();}
   await mkdir('dist/verification/automations',{recursive:true});
   await writeFile('dist/verification/automations/synthetic-schema014.dump',backup);await writeFile('dist/verification/automations/synthetic-schema014.list',backupList);
  }
 }});
 try{
 assert.deepEqual(await snapshot(h.pg),before);
 const migration=await readFile('infra/postgres/015-automation-delegations.sql','utf8');await h.pg.exec(migration);await h.pg.exec(migration);
 const after=await snapshot(h.pg);assert.deepEqual(after,before);
 assert.equal((await h.store.query('SELECT * FROM wa_message_event_receipts'))[0].event_id,event);
 assert.equal((await h.store.query('SELECT actor,idempotency_key FROM webhook_endpoints'))[0].actor,null);
 await mkdir('dist/verification/automations',{recursive:true});await writeFile('dist/verification/automations/migration-preservation.json',JSON.stringify({schema:'015',database:databaseUrl?'disposable PostgreSQL':'PGlite',originalTables:Object.keys(columns).length,originalRows:Object.fromEntries(Object.entries(before).filter(([,rows])=>rows.length).map(([t,rows])=>[t,rows.length])),beforeHash:digest(before),afterHash:digest(after),changedOriginalRows:[],repeatApply:true,backupReadable:!!backupList,restoredAndMigrated:!!backup,backupSha256:backup?createHash('sha256').update(backup).digest('hex'):null,realData:false},null,2)+'\n');
 }finally{await h.close();}
});
