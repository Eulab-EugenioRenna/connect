import {configureIdentityProofProfile} from './identity-proof-profile.mjs';
/* Disposable providers only. No production realm, database or consumer checkout is changed. */
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const sdkVersion=JSON.parse(readFileSync('packages/sdk/package.json','utf8')).version;
const suffix=randomUUID().slice(0,8),password=randomBytes(32).toString('hex'),names=[],checks=[];
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const run=(args,env={})=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('exit',code=>{if(code===0)resolve(output);else{console.error(output);reject(Error('SDK verification process failed'));}});});
async function start(kind,image,env,args=[]){const name='connect-sdk-'+kind+'-'+suffix;docker(['run','-d','--rm','--name',name,'-p',`127.0.0.1::${kind==='pg'?5432:8080}`,...Object.entries(env).flatMap(([k,v])=>['-e',k+'='+v]),image,...args]);names.push(name);const port=JSON.parse(docker(['inspect',name]))[0].NetworkSettings.Ports[(kind==='pg'?5432:8080)+'/tcp'][0].HostPort;return {name,port};}
let failed=false,cleanupVerified=true;
try{
 await run(['node_modules/typescript/bin/tsc','-p','apps/api/tsconfig.json']);
 await run(['scripts/package-sdk.mjs']);
 const db=await start('pg','postgres:17.6-bookworm',{POSTGRES_USER:'sdk',POSTGRES_PASSWORD:password,POSTGRES_DB:'sdk_test'});
 for(let i=0;i<90;i++){try{docker(['exec',db.name,'pg_isready','-U','sdk','-d','sdk_test']);break;}catch{if(i===89)throw Error('Disposable PostgreSQL timeout');await new Promise(r=>setTimeout(r,1000));}}
 const databaseUrl=`postgres://sdk:${password}@127.0.0.1:${db.port}/sdk_test`;
 for(let pass=0;pass<2;pass++)await run(['--import','tsx','apps/api/src/migrate.ts'],{DATABASE_URL:databaseUrl});
 checks.push('Connect migrations 001–015 applied twice via actual migrator on disposable PostgreSQL; no operational database used');console.log('PASS: Connect PostgreSQL migrations and repeat execution');
 const facadeOutput=await run(['--import','tsx','--test','tests/connect-application.test.ts'],{CONNECT_SDK_TEST_DATABASE_URL:databaseUrl});checks.push((facadeOutput.match(/# tests (\d+)/)?.[1]??'?')+' facade cases with real PostgreSQL shared store, simulated OIDC/Connect; crash injection uses test store only');console.log('PASS: shared PostgreSQL facade tests');
 const kc=await start('kc','eulab-connect-keycloak:latest',{KC_BOOTSTRAP_ADMIN_USERNAME:'sdk-admin',KC_BOOTSTRAP_ADMIN_PASSWORD:password},['start-dev','--hostname-strict=false']);
 const base='http://127.0.0.1:'+kc.port;
 for(let i=0;i<180;i++){try{if((await fetch(base+'/realms/master',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(i===179)throw Error('Disposable Keycloak timeout');if(i%30===29)console.log('Waiting for disposable Keycloak…');await new Promise(r=>setTimeout(r,1000));}
 const r=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'sdk-admin',password})});assert(r.ok);const token=(await r.json()).access_token;
 async function admin(path,body){const r=await fetch(base+'/admin'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});assert(r.ok,'Disposable realm setup HTTP '+r.status);}
 await admin('/realms',{realm:'sdk-proof',enabled:true,passwordPolicy:'length(20)',revokeRefreshToken:true,refreshTokenMaxReuse:0});
 const issuer=base+'/realms/sdk-proof',clientSecret=randomBytes(32).toString('hex');
 const profileAdmin=async(path,method='GET',body)=>{const r=await fetch(base+'/admin/realms/sdk-proof'+path,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok,'Provider profile configuration HTTP '+r.status);const text=await r.text();return text?JSON.parse(text):null;};
 await configureIdentityProofProfile(profileAdmin);await configureIdentityProofProfile(profileAdmin);
 checks.push('Provider proof attributes configured twice with the same bootstrap helper; reserved metadata is admin-only');
 await admin('/realms/sdk-proof/clients',{clientId:'connect-api',enabled:true,publicClient:false,secret:clientSecret,serviceAccountsEnabled:true,standardFlowEnabled:false});
 await admin('/realms/sdk-proof/clients',{clientId:'sdk-workshop',enabled:true,publicClient:true,standardFlowEnabled:true,directAccessGrantsEnabled:false,redirectUris:['http://127.0.0.1:55179/callback'],webOrigins:['http://127.0.0.1:55179'],attributes:{'pkce.code.challenge.method':'S256'},protocolMappers:[{name:'connect-api-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.client.audience':'connect-api','id.token.claim':'false','access.token.claim':'true'}}]});
 await admin('/realms/sdk-proof/clients',{clientId:'sdk-delegated-test',enabled:true,publicClient:true,standardFlowEnabled:false,directAccessGrantsEnabled:true});
 await run(['--import','tsx','tests/delegated-accounts-real.ts'],{CONNECT_SDK_TEST_DATABASE_URL:databaseUrl,SDK_QA_ISSUER:issuer,SDK_QA_ADMIN_TOKEN:token,SDK_QA_CLIENT_SECRET:clientSecret});
 checks.push('Delegated accounts with real PostgreSQL and Keycloak: password rejection before identity creation; mirror to app_local_users/roles/login-context; original password login; lost provider response and failed SQL COMMIT recovery; replay and suspension preserved');console.log('PASS: delegated accounts on real PostgreSQL and Keycloak');
 await run(['--import','tsx','tests/connect-application-real.ts'],{CONNECT_SDK_TEST_DATABASE_URL:databaseUrl,SDK_QA_ISSUER:issuer,SDK_QA_ADMIN_TOKEN:token,SDK_QA_CLIENT_SECRET:clientSecret});
 checks.push('Packaged independent Workshop BFF: offline installation, migration, diagnostics, seed, real SSO, tenant-isolated projects, refresh/logout, legacy hash preservation');
 checks.push('Real Keycloak: password rejection, no identity, fresh recovery, new password SSO/PKCE, signed ID token, concurrent refresh, required actions, license revocation, logout');console.log('PASS: real Keycloak recovery and facade lifecycle');
}catch(e){failed=true;console.error(e.message);}
finally{
 for(const name of names.reverse())try{docker(['rm','-f',name]);}catch{cleanupVerified=false;failed=true;}
 await mkdir('docs/verification',{recursive:true});await writeFile('docs/verification/sdk-'+sdkVersion+'-real.json',JSON.stringify({at:new Date().toISOString(),status:failed?'failed':'passed',checks,realProvider:'disposable Keycloak',sdkStore:'disposable PostgreSQL',connectDatabase:'PGlite for onboarding lifecycle; isolated real PostgreSQL schema for delegated accounts',connectAdminAuthentication:'simulated',catalog:'injected fixture',realBrowser:false,production:false,cleanupVerified},null,2)+'\n');
 if(failed)process.exitCode=1;
}
