import assert from 'node:assert/strict';
import {BadRequestException,ConflictException} from '@nestjs/common';
import pg from 'pg';
import {mkdtemp,cp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {scryptSync,timingSafeEqual,randomBytes} from 'node:crypto';
import {ConnectApplication,PostgresConnectApplicationStore,connectConsentVersion} from '../packages/sdk/src/application.js';
import type {BrowserContext,CookieDirective} from '../packages/sdk/src/application.js';
// @ts-ignore JavaScript harness
import {harness} from './harness.mjs';
const issuer=process.env.SDK_QA_ISSUER!,adminToken=process.env.SDK_QA_ADMIN_TOKEN!,clientSecret=process.env.SDK_QA_CLIENT_SECRET!;
assert(issuer&&adminToken&&clientSecret&&process.env.CONNECT_SDK_TEST_DATABASE_URL,'Run scripts/check-sdk-real-provider.mjs');
const origin='http://127.0.0.1:55179',email='workshop-user@example.test',legacyPassword='short-legacy',connectPassword='Connect-Recovery-Long-Password-2026!';
const salt=randomBytes(16),legacyHash=scryptSync(legacyPassword,salt,32),snapshot=Buffer.from(legacyHash);
const pool=new pg.Pool({connectionString:process.env.CONNECT_SDK_TEST_DATABASE_URL});
const store=new PostgresConnectApplicationStore(pool,'real-workshop');await store.migrate();
const h=await harness({realOidc:{issuer,clientSecret}});const networkFetch=globalThis.fetch;
async function provider(path:string,method='GET',body?:unknown){
 const r=await networkFetch(issuer.replace('/realms/','/admin/realms/')+path,{method,headers:{Authorization:'Bearer '+adminToken,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(r.status===400)throw new BadRequestException('Provider rejected input');if(r.status===409)throw new ConflictException('Identity conflict');assert(r.ok,'Provider HTTP '+r.status);
 const raw=await r.text();return {body:raw?JSON.parse(raw):null,location:r.headers.get('location')};
}
// Test code drives provider forms; consumers only use the facade.
async function authenticate(url:string,password:string){
 const jar=new Map<string,string>();
 const send=async(target:string,body?:URLSearchParams)=>{const r=await networkFetch(target,{redirect:'manual',method:body?'POST':'GET',headers:{cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},body});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}return r;};
 let r=await send(url);for(let i=0;i<6&&r.headers.get('location');i++)r=await send(new URL(r.headers.get('location')!,issuer).href);
 const html=await r.text(),form=html.match(/<form\b[^>]*\bid=["']kc-form-login["'][^>]*>/i)?.[0];assert(form,'Real provider login form missing');
 const action=form.match(/\baction=["']([^"']+)["']/i)![1].replace(/&amp;/g,'&');r=await send(action,new URLSearchParams({username:email,password,credentialId:''}));
 for(let i=0;i<8;i++){const location=r.headers.get('location');if(!location)return null;const next=new URL(location,issuer);if(next.origin===origin)return next;r=await send(next.href);}
 return null;
}
try{
 h.setIdentityRequest(provider);const apiUrl=await h.listen();
 const deployment={name:'Independent workshop',environment:'development' as const,origins:[origin],catalogUrl:origin+'/.well-known/eulab-connect.json',oidcCallbacks:[origin+'/callback']};
 const technical=(await h.request('/v1/onboarding/presenters','POST',{name:'Disposable technical credential',deploymentIdentity:'disposable-sdk-acceptance',verifiedOrigins:[origin],expiresAt:new Date(Date.now()+86400000).toISOString()})).body;
 assert(technical.id&&technical.secret);
 const source={id:'workshop-real',secret:technical.secret};
 const catalog={schemaVersion:1 as const,appId:'workshop-real',version:1,functions:[{key:'projects.read',name:'Projects'}]};h.setCatalogReader(async()=>catalog);
 let provisions=0;
 const config={apiUrl,sourceId:source.id,presenter:{id:technical.id,secret:technical.secret,deployment},appId:catalog.appId,appOrigin:origin,allowLoopbackHttp:true,encryptionKey:randomBytes(32).toString('hex'),store,catalog,accounts:{
  verifyLegacy:async(input:{email:string;password:string})=>input.email===email&&timingSafeEqual(scryptSync(input.password,salt,32),legacyHash)?{localTenant:{id:'workspace-1',name:'Workshop',slug:'workshop'},localUser:{id:'local-1',email,firstName:'SDK',lastName:'User',role:'owner' as const,permissions:['projects.read']}}:null,
  provision:async(context:any)=>{provisions++;return {localUserId:context.user.id,localTenantId:context.tenant.id};},restrict:async()=>true
 }};
 const a=new ConnectApplication(config),b=new ConnectApplication(config),browser:BrowserContext={origin,cookies:{}};
 const cookies=(cs:CookieDirective[])=>{for(const c of cs)browser.cookies[c.name]=c.value;};
 let start=await a.auth.signIn({email,password:legacyPassword},browser);assert.equal(start.status,'migration_required');if(start.status!=='migration_required')throw Error();cookies(start.cookies);
 const submitted=await a.migration.submit({challenge:start.challenge,legacyPassword,consentVersion:connectConsentVersion,idempotencyKey:'real-initial-1'},browser);
 const practice=(await h.store.query('SELECT practice_id FROM onboarding_requests WHERE id=$1',[submitted.requestId]))[0].practice_id,base='/v1/onboarding/practices/'+practice;
 const plan=await h.request(base+'/plan','PUT',{application:{mode:'create',id:catalog.appId,name:'Workshop'},customer:{mode:'create',name:'Independent Workshop'},installation:{mode:'create',domain:origin},sso:{issuer,clientId:'sdk-workshop',redirectUri:origin+'/callback'},license:{state:'active',expiresAt:null,features:[{key:'projects.read',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Owner',permissions:['projects.read']}]});assert.equal(plan.status,200);
 await h.request(base+'/execute','POST',{});
 const failed=(await h.store.query('SELECT state,password_cipher,identity_subject FROM onboarding_requests WHERE id=$1',[submitted.requestId]))[0];assert.equal(failed.state,'failed');assert.equal(failed.password_cipher,null);assert.equal(failed.identity_subject,null);assert.equal((await provider('/users?email='+email)).body.length,0);assert.equal(provisions,0);
 start=await b.auth.signIn({email,password:legacyPassword},browser);assert.equal(start.status,'migration_required');if(start.status!=='migration_required')throw Error();assert.equal(start.request?.nextAction,'choose_connect_password');cookies(start.cookies);
 await b.migration.submit({challenge:start.challenge,legacyPassword,newConnectPassword:connectPassword,consentVersion:connectConsentVersion,idempotencyKey:'real-recovery-1'},browser);
 assert.equal((await provider('/users?email='+email)).body.length,0,'Recovery does not automatically execute');
 const execution=await h.request(base+'/execute','POST',{});assert.equal(execution.body.state,'completed');
 assert.deepEqual(legacyHash,snapshot,'Legacy hash preserved');
 const user=(await provider('/users?email='+email)).body[0];assert(user);
 assert.equal((await a.auth.signIn({email},browser)).status,'configuration_required');
 assert.deepEqual(await a.configuration.sync(),{status:'ready',appId:catalog.appId});
 assert.deepEqual(await b.configuration.sync(),{status:'ready',appId:catalog.appId});
 async function begin(){const s=await a.auth.signIn({email},browser);assert.equal(s.status,'redirect');if(s.status!=='redirect')throw Error();cookies(s.cookies);return s.url;}
 assert.equal(await authenticate(await begin(),legacyPassword),null,'Legacy password must not authenticate Connect');
 const callback=await authenticate(await begin(),connectPassword);assert(callback?.searchParams.get('code'),'New password must authenticate');
 const input={state:callback.searchParams.get('state')!,code:callback.searchParams.get('code')!,iss:callback.searchParams.get('iss')??undefined};
 const handoff=await b.auth.callback(input,browser);cookies(handoff.cookies);await assert.rejects(()=>a.auth.callback(input,browser));
 const session=await a.auth.exchange(handoff.handoff,browser);cookies(session.cookies);assert.equal(provisions,1);await assert.rejects(()=>b.auth.exchange(handoff.handoff,browser));
 assert(!JSON.stringify(session).includes('access_token'));assert(!JSON.stringify(session).includes(source.secret));
 await Promise.all([a.auth.refresh(session.session.sessionId),b.auth.refresh(session.session.sessionId)]);
 assert.equal((await a.access.authorize(session.session.sessionId,'projects.read')).allowed,true);
 // Required action must stay with Keycloak; it must not yield an SDK session.
 await provider('/users/'+user.id,'PUT',{...user,requiredActions:['UPDATE_PASSWORD']});
 assert.equal(await authenticate(await begin(),connectPassword),null,'Mandatory password action cannot yield an authorization code');
 await provider('/users/'+user.id,'PUT',{...user,requiredActions:[]});
 const logoutCallback=await authenticate(await begin(),connectPassword);assert(logoutCallback);
 const logoutHandoff=await a.auth.callback({state:logoutCallback.searchParams.get('state')!,code:logoutCallback.searchParams.get('code')!},browser);cookies(logoutHandoff.cookies);const logoutSession=await a.auth.exchange(logoutHandoff.handoff,browser);
 const providerAccess=await a.services(logoutSession.session.sessionId,async(_client,token)=>token);
 assert.equal((await b.auth.logout(logoutSession.session.sessionId,browser)).providerRevoked,true);
 const introspection=await networkFetch(issuer+'/protocol/openid-connect/token/introspect',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'connect-api',client_secret:clientSecret,token:providerAccess})});assert.equal((await introspection.json()).active,false);
 const binding=execution.body.targetInstallationId??(await h.store.query('SELECT target_installation_id FROM onboarding_practices WHERE id=$1',[practice]))[0].target_installation_id;
 const installation=(await h.store.query('SELECT customer_id FROM installations WHERE id=$1',[binding]))[0];
 await h.request('/v1/licenses','PUT',{customerId:installation.customer_id,appId:catalog.appId,state:'suspended',expiresAt:null,features:[],reason:'Disposable revocation check'});
 await assert.rejects(()=>b.auth.resolve(session.session.sessionId));const logout=await a.auth.logout(session.session.sessionId,browser);assert.equal(logout.revoked,true);await assert.rejects(()=>b.auth.resolve(session.session.sessionId));
 const audit=JSON.stringify(await h.store.query('SELECT detail FROM audit'));assert(!audit.includes(connectPassword)&&!audit.includes(legacyPassword));
 // Execute the packaged independent consumer, installed outside this checkout.
 await h.request('/v1/licenses','PUT',{customerId:installation.customer_id,appId:catalog.appId,state:'active',expiresAt:null,features:[{key:'projects.read',purchased:true,enabled:true}],reason:'Disposable independent app acceptance'});
 const directory=await mkdtemp(join(tmpdir(),'connect-workshop-consumer-'));let demo:any;
 const childRun=(args:string[])=>new Promise<void>((resolveDone,reject)=>{const child=spawn(process.execPath,args,{cwd:directory,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();child.once('error',reject);child.once('exit',status=>status===0?resolveDone():reject(Error('Independent demo command failed')));});
 try{
  await cp(resolve('packages/sdk/examples/workshop'),directory,{recursive:true});
  await new Promise<void>((done,reject)=>{const child=spawn('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund',resolve('dist/releases/sdk/eulab-connect-0.10.0.tgz'),'pg@8.23.0'],{cwd:directory,stdio:'ignore'});child.once('error',reject);child.once('exit',status=>status===0?done():reject(Error('Standalone consumer install failed')));});
  const env={DATABASE_URL:process.env.CONNECT_SDK_TEST_DATABASE_URL!,CONNECT_API_URL:apiUrl,CONNECT_SOURCE_ID:source.id,CONNECT_PRESENTER_ID:technical.id,CONNECT_PRESENTER_SECRET:technical.secret,CONNECT_DEPLOYMENT_NAME:deployment.name,CONNECT_APP_ID:catalog.appId,CONNECT_ORIGIN:origin,CONNECT_ENCRYPTION_KEY:randomBytes(32).toString('hex'),DEMO_LEGACY_EMAIL:email,DEMO_LEGACY_PASSWORD:legacyPassword};
  await writeFile(join(directory,'.env'),Object.entries(env).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n',{mode:0o600});
  await childRun(['--env-file=.env','server.mjs','--migrate']);await childRun(['--env-file=.env','server.mjs','--seed']);await childRun(['--env-file=.env','server.mjs','--check']);
  await pool.query("INSERT INTO workshop_projects(id,tenant_id,name) VALUES('foreign-project','other-workspace','Foreign project')");
  demo=spawn(process.execPath,['--env-file=.env','server.mjs'],{cwd:directory,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});demo.stdout.resume();demo.stderr.resume();
  let ready=false;for(let i=0;i<80;i++){if(demo.exitCode!==null)throw Error('Independent consumer exited');try{ready=(await networkFetch(origin)).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}assert(ready,'Independent demo failed to start');
  const jar=new Map<string,string>();
  async function app(path:string,body?:unknown){const r=await networkFetch(origin+path,{redirect:'manual',method:body===undefined?'GET':'POST',headers:{cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}return r;}
  const waiting=await (await app('/auth/sign-in',{email})).json();assert.equal(waiting.status,'configuration_required');
  const synced=await (await app('/auth/configuration',{})).json();assert.equal(synced.status,'ready');assert(!JSON.stringify(synced).includes('clientSecret'));
  const started=await app('/auth/sign-in',{email});assert.equal(started.status,200);const redirect=await started.json();assert.equal(redirect.status,'redirect');
  const returned=await authenticate(redirect.url,connectPassword);assert(returned);const response=await app(returned.pathname+returned.search);assert.equal(response.status,303);
  const handoff=new URLSearchParams(new URL(response.headers.get('location')!).hash.slice(1)).get('handoff');assert(handoff);
  const exchange=await app('/auth/exchange',{handoff}),publicSession=await exchange.json();assert.equal(publicSession.status,'authenticated');assert.equal(publicSession.session.sessionId,undefined);assert.equal(publicSession.session.profile.localUserId,'local-1');assert(!JSON.stringify(publicSession).includes('access_token'));
  const projects=await (await app('/projects',{})).json();assert.deepEqual(projects.projects,[{id:'demo-project',name:'First project'}]);
  assert.equal((await app('/auth/refresh',{})).status,200);assert.equal((await (await app('/auth/logout',{})).json()).providerRevoked,true);assert.equal((await app('/projects',{})).status,400);
  const persisted=(await pool.query("SELECT password_salt,password_hash FROM workshop_accounts WHERE tenant_id='workspace-1' AND id='local-1'")).rows[0];assert(timingSafeEqual(scryptSync(legacyPassword,persisted.password_salt,32),Buffer.from(persisted.password_hash,'hex')));
  console.log('PASS: packaged standalone Workshop app: offline install, migrations, diagnostics, seed, real SSO, projects isolation, refresh/logout, preserved legacy hash');
 }finally{if(demo&&demo.exitCode===null){demo.kill('SIGTERM');await new Promise<void>(r=>demo.once('exit',()=>r()));}await rm(directory,{recursive:true,force:true});}
 console.log('PASS: real provider password recovery, PKCE/SSO, refresh, required actions and revocation; legacy hash preserved');
}finally{await h.close();await pool.end();}
