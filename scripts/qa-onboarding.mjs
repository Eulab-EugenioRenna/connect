import {chromium} from '@playwright/test';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
process.loadEnvFile('.env');

const base='http://localhost:8088',suffix=randomUUID().slice(0,8),origin=base;
const sourceId='qa-onb-'+suffix,appId='qa-onb-app-'+suffix,customerName='QA onboarding '+suffix;
const tenantId='tenant-'+suffix,localUserId='local-'+suffix,qaUsername='qaonb-'+suffix,qaEmail=qaUsername+'@example.test';
const migrationEmail='mig-'+suffix+'@example.test',password='Qa-Onboarding-2026!x';
const checks=[];let token,adminContext,customer,installation,migrationCustomer,migrationInstallation,subject,migrationSubject,sourceCreated=false;

async function api(path,method='GET',body,extra={}){
 const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let value;try{value=text?JSON.parse(text):null;}catch{value={message:text.slice(0,200)};}
 if(!response.ok)throw new Error(`API ${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
 return value;
}
// Le API di sorgente richiedono TLS fuori loopback. Nel collaudo locale la
// richiesta parte dentro il container API, quindi usa 127.0.0.1:3000.
function sourceRequest(source,path,body,key){
 const code=`const r=await fetch('http://127.0.0.1:3000/v1/app-onboarding/${path}',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+${JSON.stringify(source.secret)},'X-Connect-Source':${JSON.stringify(source.id)},${key?'"Idempotency-Key":'+JSON.stringify(key)+',':''}},body:${JSON.stringify(JSON.stringify(body))}});const t=await r.text();let b=null;try{b=t?JSON.parse(t):null;}catch{b={message:t.slice(0,200)};}console.log(JSON.stringify({status:r.status,body:b}));`;
 const result=spawnSync('docker',['compose','exec','-T','api','node','--input-type=module'],{input:code,encoding:'utf8',timeout:60_000});
 if(result.status!==0)throw new Error('Sorgente non raggiungibile: '+(result.stderr||'').slice(0,300));
 return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
function sourceCall(source,path,body,key){
 const result=sourceRequest(source,path,body,key);
 if(result.status<200||result.status>=300)throw new Error(`Sorgente ${path}: ${result.status} ${JSON.stringify(result.body)}`);
 return result.body;
}
function psql(sql){
 const r=spawnSync('docker',['compose','exec','-T','postgres','psql','-U','connect','-d','connect','-v','ON_ERROR_STOP=1','-Atc',sql],{encoding:'utf8',timeout:60_000});
 if(r.status!==0)throw new Error('Pulizia/catalogo SQL fallito: '+(r.stderr||'').slice(0,300));
 return r.stdout.trim();
}
async function login(page,username,userPassword){
 await page.goto(base+'/');
 await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();
 await page.locator('#username').fill(username);
 await page.locator('#password').fill(userPassword);
 await page.locator('#kc-login').click();
}
async function tokenFor(username,userPassword){
 const context=await browser.newContext();const page=await context.newPage();let value='';
 page.on('response',async response=>{if(response.url().includes('/protocol/openid-connect/token')&&response.request().method()==='POST'&&response.status()===200)value=(await response.json()).access_token;});
 await login(page,username,userPassword);
 for(let i=0;i<40&&!value;i++)await new Promise(r=>setTimeout(r,250));
 if(!value)throw new Error('Token SSO non ricevuto per '+username);
 return {context,page,token:value};
}
let browser;
try{
 await mkdir('docs/verification/onboarding',{recursive:true});
 browser=await chromium.launch({headless:true});
 adminContext=await browser.newContext({viewport:{width:1440,height:1050}});
 const adminPage=await adminContext.newPage();
 adminPage.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.request().method()==='POST'&&r.status()===200)token=(await r.json()).access_token;});
 await login(adminPage,process.env.EULAB_ADMIN_USERNAME,process.env.EULAB_ADMIN_PASSWORD);
 await adminPage.getByRole('heading',{name:'Panoramica',exact:true}).waitFor({timeout:20_000});
 assert(token);checks.push('Login Admin reale su Keycloak e PKCE');

 const source=await api('/v1/connect-sources','POST',{id:sourceId,appId,name:'QA ALORA onboarding',environment:'development',origins:[origin],catalogUrl:origin+'/.well-known/eulab-connect.json',oidcCallbacks:[origin+'/oauth/callback'],deploymentIdentity:'qa-onboarding-'+suffix});sourceCreated=true;
 assert.equal(typeof source.secret,'string');assert.equal((await api('/v1/connect-sources/'+sourceId)).id,sourceId);
 const listed=JSON.stringify(await api('/v1/connect-sources'));
 assert.equal(listed.includes(source.secret),false);assert.equal(listed.includes('secret_hash'),false);
 checks.push('Sorgente bootstrap registrata prima dell’app, senza segreti negli elenchi');

 customer=(await api('/v1/customers','POST',{name:customerName})).id;
 const connected=await api('/v1/application-connections','POST',{id:appId,name:'QA ALORA',customerId:customer,domain:origin,integration:'web'});
 installation=connected.installationId;
 psql(`INSERT INTO catalogs(app_id,version,document) VALUES('${appId}',1,'{"schemaVersion":1,"appId":"${appId}","version":1,"functions":[{"key":"agenda","name":"Agenda"}]}'::jsonb);
  INSERT INTO features(app_id,key,name) VALUES('${appId}','agenda','Agenda');
  INSERT INTO permissions(app_id,key,feature_key,name) VALUES('${appId}','agenda.read','agenda','Leggi agenda');
  UPDATE applications SET catalog_version=1 WHERE id='${appId}';`);
 await api('/v1/licenses','PUT',{customerId:customer,appId,state:'active',expiresAt:null,features:[{key:'agenda',purchased:true,enabled:true}],reason:'Collaudo onboarding locale'});
 const qaIdentity=await api('/v1/sso-identities','POST',{username:qaUsername,displayName:'QA Onboarding',email:qaEmail,userType:'client',password,temporaryPassword:false});
 subject=qaIdentity.subject;
 const role=await api('/v1/roles','PUT',{customerId:customer,appId,name:'Titolare QA',permissions:['agenda.read'],reason:'Collaudo onboarding locale'});
 await api('/v1/memberships','PUT',{subject,customerId:customer,enabled:true,roleIds:[role.id]});
 await api('/v1/connect-sources/'+sourceId+'/installations','POST',{installationId:installation});
 await api('/v1/connect-sources/'+sourceId+'/local-users','POST',{installationId:installation,localTenantId:tenantId,localUserId,subject,email:qaEmail,firstName:'QA',lastName:'Onboarding',role:'owner',permissions:['agenda.read'],enabled:true});
 checks.push('Installazione, identità Keycloak, ruolo e collegamento locale espliciti su PostgreSQL reale');

 const lookup=await sourceCall(source,'login-context',{schemaVersion:1,appId,sourceId,email:qaEmail});
 assert.equal(lookup.status,'connect');assert.equal(lookup.context.binding.installationId,installation);assert.equal(lookup.context.binding.customerId,customer);assert.equal(lookup.context.user.subject,subject);assert.equal(lookup.context.user.id,localUserId);assert.equal(lookup.context.user.role,'owner');assert.deepEqual(lookup.context.user.permissions,['agenda.read']);assert.equal(typeof lookup.context.binding.secret,'string');
 const qaToken=await tokenFor(qaUsername,password);
 const access=await api('/v1/access','GET',undefined,{Authorization:'Bearer '+qaToken.token,'X-Installation-Id':installation,'X-Installation-Secret':lookup.context.binding.secret});
 assert.equal(access.canLogin,true);assert.equal(access.appId,appId);assert.equal(access.localUserId,localUserId);assert.equal(access.subject,subject);
 await qaToken.context.close();
 checks.push('login-context reale restituisce solo il contesto autorizzato e /v1/access lo conferma con token Keycloak');

 await api('/v1/licenses','PUT',{customerId:customer,appId,state:'suspended',expiresAt:null,features:[{key:'agenda',purchased:true,enabled:true}],reason:'Collaudo revoca'});
 const suspended=sourceRequest(source,'login-context',{schemaVersion:1,appId,sourceId,email:qaEmail});
 assert.equal(suspended.status,403);
 await api('/v1/licenses','PUT',{customerId:customer,appId,state:'active',expiresAt:null,features:[{key:'agenda',purchased:true,enabled:true}],reason:'Collaudo ripristino'});
 checks.push('Licenza sospesa: 403 autorevole, mai not_found');

 const requestBody={schemaVersion:1,appId,sourceId,kind:'migration',consentVersion:'2026-10-21-mandatory-v1',localTenant:{id:'mig-tenant-'+suffix,name:'Azienda migrata '+suffix,slug:'azienda-migrata-'+suffix},localUser:{id:'mig-local-'+suffix,email:migrationEmail,firstName:'Migrato',lastName:'QA',role:'owner',permissions:['agenda.read']},initialPassword:password};
 const idempotency=createHash('sha256').update('qa-onboarding-'+suffix).digest('hex');
 const submitted=await sourceCall(source,'requests',requestBody,idempotency);
 assert.deepEqual(Object.keys(submitted).sort(),['requestId','state']);assert.equal(submitted.state,'pending');
 const duplicate=await sourceCall(source,'requests',requestBody,idempotency);assert.equal(duplicate.requestId,submitted.requestId);
 const pendingLookup=await sourceCall(source,'login-context',{schemaVersion:1,appId,sourceId,email:migrationEmail});
 assert.equal(pendingLookup.status,'not_found');assert.equal(pendingLookup.request.requestId,submitted.requestId);assert.equal(pendingLookup.request.state,'pending');
 const practiceId=psql(`SELECT practice_id FROM onboarding_requests WHERE id='${submitted.requestId}'`);
 const cipher=psql(`SELECT password_cipher FROM onboarding_requests WHERE id='${submitted.requestId}'`);
 assert(cipher);assert.equal(cipher.includes(password),false);
 checks.push('Richiesta migrazione idempotente; password cifrata in PostgreSQL e mai restituita dalla lookup');

 const plan={license:{state:'active',expiresAt:null,features:[{key:'agenda',purchased:true,enabled:true}]},roles:[{localRole:'owner',roleName:'Titolare QA',permissions:['agenda.read']}]};
 const saved=await api('/v1/onboarding/practices/'+practiceId+'/plan','PUT',plan);assert.equal(saved.canExecute,true);
 const prepared=await api('/v1/onboarding/practices/'+practiceId+'/prepare','POST',{});assert.equal(prepared.installation.secretAvailable,true);migrationCustomer=prepared.customerId;migrationInstallation=prepared.installation.id;assert(migrationInstallation);
 const detailText=JSON.stringify(await api('/v1/onboarding/practices/'+practiceId));
 assert.equal(detailText.includes(password),false);assert.equal(detailText.includes(cipher),false);assert.equal(detailText.includes('password_cipher'),false);
 checks.push('Piano, licenza e prerequisiti reali; dettaglio pratica privo di password e cipher');

 await adminPage.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Attivazioni e migrazioni',exact:true}).click();
 await adminPage.getByRole('heading',{name:'Pratiche',exact:true}).waitFor();
 const row=adminPage.getByRole('row').filter({hasText:'Azienda migrata '+suffix});
 await row.getByRole('button',{name:'Apri pratica',exact:true}).click();
 await adminPage.getByRole('heading',{name:'Azienda migrata '+suffix,exact:true}).waitFor();
 assert((await adminPage.locator('body').innerText()).includes(origin));
 await adminPage.screenshot({path:'docs/verification/onboarding/practice-before.png',fullPage:true});
 await adminPage.getByRole('button',{name:'Esegui migrazione',exact:true}).click();
 await adminPage.getByText('Migrazione completata.',{exact:true}).waitFor({timeout:30_000});
 await adminPage.screenshot({path:'docs/verification/onboarding/practice-completed.png',fullPage:true});
 const completed=await api('/v1/onboarding/practices/'+practiceId);
 assert.equal(completed.state,'completed');assert.equal(completed.requests[0].state,'completed');assert.equal(completed.requests[0].credentialPresent,false);
 migrationSubject=completed.requests[0].identitySubject;assert(migrationSubject);
 assert.equal(psql(`SELECT password_cipher IS NULL FROM onboarding_requests WHERE id='${submitted.requestId}'`),'t');
 checks.push('Esecuzione dal pannello browser reale: pratica completata, credenziale cancellata, identità Keycloak creata');

 const completedLookup=await sourceCall(source,'login-context',{schemaVersion:1,appId,sourceId,email:migrationEmail});
 assert.equal(completedLookup.status,'connect');assert.equal(completedLookup.context.user.email,migrationEmail);
 const migrated=await tokenFor(migrationEmail,password);
 const migratedAccess=await api('/v1/access','GET',undefined,{Authorization:'Bearer '+migrated.token,'X-Installation-Id':migrationInstallation,'X-Installation-Secret':completedLookup.context.binding.secret});
 assert.equal(migratedAccess.canLogin,true);assert.equal(migratedAccess.localUserId,'mig-local-'+suffix);assert.equal(migratedAccess.subject,migrationSubject);
 await migrated.context.close();
 checks.push('La nuova identità Keycloak accede con la stessa password approvata e /v1/access coincide con il contesto');

 await writeFile('docs/verification/onboarding/result.json',JSON.stringify({status:'passed',at:new Date().toISOString(),realDocker:true,realPostgres:true,realKeycloak:true,realBrowser:true,productionDeployed:false,checks},null,2)+'\n');
 console.log(JSON.stringify({status:'passed',checks}));
}catch(error){
 await writeFile('docs/verification/onboarding/result.json',JSON.stringify({status:'failed',at:new Date().toISOString(),checks,error:error.message,productionDeployed:false},null,2)+'\n').catch(()=>{});
 console.error(error.message);process.exitCode=1;
}finally{
 try{if(sourceCreated||subject||migrationSubject){
  psql(`DELETE FROM onboarding_requests WHERE source_id='${sourceId}';DELETE FROM onboarding_practices WHERE source_id='${sourceId}';DELETE FROM app_local_users WHERE source_id='${sourceId}';DELETE FROM source_installation_bindings WHERE source_id='${sourceId}';DELETE FROM source_tenant_bindings WHERE source_id='${sourceId}';DELETE FROM connect_sources WHERE id='${sourceId}';`);
  for(const s of [subject,migrationSubject].filter(Boolean)){try{await api('/v1/sso-identities/'+s,'DELETE');}catch{}}
  const customers=[customer,migrationCustomer].filter(Boolean).map(id=>`'${id}'`).join(',');
  const installations=[installation,migrationInstallation].filter(Boolean).map(id=>`'${id}'`).join(',');
  if(installations)psql(`DELETE FROM local_links WHERE installation_id IN (${installations});`);
  if(customers)psql(`DELETE FROM assignments WHERE customer_id IN (${customers});
    DELETE FROM memberships WHERE customer_id IN (${customers});
    DELETE FROM entitlements WHERE customer_id IN (${customers}) AND app_id='${appId}';
    DELETE FROM licenses WHERE customer_id IN (${customers}) AND app_id='${appId}';
    DELETE FROM roles WHERE customer_id IN (${customers}) AND app_id='${appId}';
    DELETE FROM installations WHERE customer_id IN (${customers});
    DELETE FROM customers WHERE id IN (${customers});`);
  psql(`DELETE FROM permissions WHERE app_id='${appId}';DELETE FROM features WHERE app_id='${appId}';DELETE FROM catalogs WHERE app_id='${appId}';DELETE FROM applications WHERE id='${appId}';`);
  psql(`DELETE FROM audit WHERE target LIKE '${sourceId}%' OR target LIKE '${appId}%' OR detail::text LIKE '%${sourceId}%' OR detail::text LIKE '%${appId}%';`);
 }}
 catch(error){console.error('Pulizia QA non completata:',error.message);}
 if(adminContext)await adminContext.close();
 if(browser)await browser.close();
}
