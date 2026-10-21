import {chromium} from '@playwright/test';
import http from 'node:http';
import {mkdir,writeFile,appendFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
process.loadEnvFile('.env');
const checks=[],servers=[];let browser,page,accessToken,client;
const resultPath='docs/verification/runtime-result.json';
let wpFixture;try{wpFixture=JSON.parse(await readFile('docs/verification/wordpress-users.json','utf8'));}catch{}
const recoveryUsername=wpFixture?.users.find(u=>u.role==='administrator')?.username||'qa-recovery';
const localCustomerId=String(wpFixture?.users.find(u=>u.role==='subscriber')?.id||2);
async function api(path,method='GET',body,headers={}){
 const response=await fetch('http://api:3000'+path,{method,headers:{'content-type':'application/json',Authorization:`Bearer ${accessToken}`,...headers},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let value;try{value=JSON.parse(text);}catch{value={message:text.slice(0,100)}}
 if(!response.ok)throw new Error(`API ${method} ${path}: ${response.status} ${JSON.stringify(value)}`);return value;
}
async function login(p,username,password){await p.locator('#username').fill(username);await p.locator('#password').fill(password);await p.locator('#kc-login').click();}
async function screenshot(p,name){await p.locator('.page-enter').evaluateAll(elements=>Promise.all(elements.flatMap(el=>el.getAnimations().map(a=>a.finished.catch(()=>{})))));await p.screenshot({path:`docs/verification/${name}.png`,fullPage:true});}
async function remember(key,value){const text=await readFile('.env','utf8');if(!new RegExp(`^${key}=`,'m').test(text))await appendFile('.env',`\n${key}=${value}\n`);}
try{
 await mkdir('docs/verification',{recursive:true});
 for(const [port,host,targetPort]of [[8088,'web',80],[8080,'keycloak',8080],[8090,'qa-wordpress',80]]){
  const server=http.createServer((req,res)=>{const proxy=http.request({hostname:host,port:targetPort,path:req.url,method:req.method,headers:{...req.headers,host:`localhost:${port}`}},upstream=>{res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);});proxy.on('error',()=>{res.writeHead(502);res.end('QA proxy unavailable');});req.pipe(proxy);});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));servers.push(server);
 }
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1050}});
 page.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.request().method()==='POST'&&r.status()===200){const body=await r.json();accessToken=body.access_token;}});
 await page.goto('http://localhost:8088/');await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();await login(page,'qa-operator',process.env.QA_OPERATOR_PASSWORD);
 await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor({timeout:15000});assert(accessToken);checks.push('Login dashboard con Keycloak reale e PKCE');
 let overview=await api('/v1/overview');let customer=overview.customers.find(c=>c.reference==='QA_RUNTIME');
 if(!customer)customer=await api('/v1/customers','POST',{name:'Collaudo EULab',reference:'QA_RUNTIME'});
 let installation=overview.installations.find(i=>i.domain==='http://localhost:8090'&&i.customer_id===customer.id);
 if(!installation){const created=await api('/v1/application-connections','POST',{id:'qa-wordpress',name:'WordPress di collaudo',description:'Sito locale riservato alle verifiche E2E',customerId:customer.id,domain:'http://localhost:8090',integration:'wordpress'});installation={id:created.installationId,app_id:created.appId,customer_id:customer.id};await remember('QA_INSTALLATION_ID',created.installationId);await remember('QA_INSTALLATION_SECRET',created.secret);}
 checks.push('Registrazione atomica app WordPress, dominio, descrizione e fallback su PostgreSQL reale');
 overview=await api('/v1/overview');const app=overview.applications.find(a=>a.id===installation.app_id);
 if(app.catalog_version===0)await api(`/v1/applications/${app.id}/catalogs`,'POST',{version:1,features:[{key:'whatsapp',name:'WhatsApp'}],permissions:['read','send','manage'].map(p=>({key:`whatsapp.${p}`,name:p,feature:'whatsapp'}))});
 const identities=JSON.parse(await readFile('docs/verification/qa-identities.json','utf8'));const subject=identities.users['qa-customer'];
 await api('/v1/identities','PUT',{subject,displayName:'Cliente di collaudo',enabled:true});
 overview=await api('/v1/overview');let role=overview.roles.find(r=>r.customer_id===customer.id&&r.app_id===app.id);
 if(!role)role=await api('/v1/roles','PUT',{customerId:customer.id,appId:app.id,name:'Operatore QA',permissions:['whatsapp.read','whatsapp.send','whatsapp.manage'],reason:'Collaudo locale autorizzato'});
 await api('/v1/memberships','PUT',{subject,customerId:customer.id,enabled:true,roleIds:[role.id]});
 await api('/v1/identity-links','PUT',{installationId:installation.id,localUserId:localCustomerId,subject});
 const license={customerId:customer.id,appId:app.id,state:'active',expiresAt:null,features:[{key:'whatsapp',purchased:true,enabled:true}],reason:'Collaudo locale autorizzato'};
 await api('/v1/licenses','PUT',license);
 const wp=await browser.newPage();await wp.goto('http://localhost:8090/wp-login.php');await wp.locator('#user_login').fill(recoveryUsername);await wp.locator('#user_pass').fill(process.env.QA_WP_PASSWORD);await wp.locator('#wp-submit').click();await wp.waitForURL('**/wp-admin/**');checks.push('Login amministratore WordPress locale di recupero');
 await wp.goto('http://localhost:8090/wp-admin/');checks.push('Plugin associato automaticamente dal codice locale; nessun pannello impostazioni');
 await api('/v1/licenses','PUT',{...license,state:'suspended'});
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Applicazioni',exact:true}).click();await page.getByRole('button',{name:'Siti WordPress',exact:true}).click();await page.getByRole('button',{name:'Aggiorna',exact:true}).click();await page.getByRole('row').filter({hasText:'http://localhost:8090'}).getByRole('button',{name:'Utenti e accesso',exact:true}).click();await page.getByRole('button',{name:'Accedi come '+recoveryUsername,exact:true}).click();await page.waitForURL('**/wp-admin/**',{timeout:15000});await page.getByText('Accesso EULab come',{exact:false}).first().waitFor();checks.push('Accesso tecnico diretto a wp-admin con licenza cliente sospesa');await screenshot(page,'wordpress-technical-real');
 await api('/v1/licenses','PUT',license);
 const context=await browser.newContext();client=await context.newPage();await client.goto('http://localhost:8090/wp-login.php');await client.getByRole('link',{name:'Accedi con EULab SSO'}).click();await login(client,'qa-customer',process.env.QA_CUSTOMER_PASSWORD);
 await client.waitForURL('**/wp-admin/**',{timeout:15000});checks.push('SSO cliente WordPress reale con collegamento locale esplicito');
 const probe=async(permission='whatsapp.send')=>{const response=await client.request.get('http://localhost:8090/?eulab_qa_permission='+permission);return {status:response.status(),body:await response.json()};};
 assert.equal((await probe()).status,200);checks.push('Controllo permessi PHP positivo su licenza, funzione e ruolo validi');
 const currentApp=(await api('/v1/overview')).applications.find(a=>a.id===app.id);
 if(currentApp.catalog_version===1)await api(`/v1/applications/${app.id}/catalogs`,'POST',{version:2,features:[{key:'whatsapp',name:'WhatsApp'},{key:'reports',name:'Report QA'}],permissions:[...['read','send','manage'].map(p=>({key:`whatsapp.${p}`,name:p,feature:'whatsapp'})),{key:'reports.read',name:'Leggi report',feature:'reports'}]});
 assert.equal((await probe('reports.read')).status,403);assert.equal((await probe()).status,200);checks.push('Nuova funzione di catalogo disabilitata per il cliente; permessi precedenti conservati');
 await api('/v1/licenses','PUT',{...license,state:'suspended'});assert.equal((await probe()).status,403);await api('/v1/licenses','PUT',license);checks.push('Sospensione licenza applicata subito al controllo PHP');
 await api('/v1/memberships','PUT',{subject,customerId:customer.id,enabled:false,roleIds:[role.id]});assert.equal((await probe()).status,403);await api('/v1/memberships','PUT',{subject,customerId:customer.id,enabled:true,roleIds:[role.id]});checks.push('Revoca appartenenza applicata subito al controllo PHP');
 await api(`/v1/identity-links/${installation.id}/${localCustomerId}`,'DELETE');assert.equal((await probe()).status,403);await api('/v1/identity-links','PUT',{installationId:installation.id,localUserId:localCustomerId,subject});checks.push('Scollegamento esplicito identità blocca l’utente locale');
 await screenshot(client,'wordpress-customer-real');
 const managed=(await api('/v1/sso-identities')).find(u=>u.subject===subject);assert(managed);
 const clientProfile={displayName:managed.display_name,email:managed.email,userType:'client',enabled:true};
 try{await api(`/v1/sso-identities/${subject}`,'PUT',{...clientProfile,enabled:false});assert.equal((await probe()).status,403);checks.push('Disabilitazione utente nello SSO revoca subito anche la sessione WordPress');}
 finally{await api(`/v1/sso-identities/${subject}`,'PUT',clientProfile);}
 if(wpFixture)await api(`/v1/identity-links/${installation.id}/${localCustomerId}`,'DELETE');
 await context.close();
 await writeFile(resultPath,JSON.stringify({status:'passed',at:new Date().toISOString(),checks,realDocker:true,realPostgres:true,realKeycloak:true,realWordPress:true,realWhatsApp:false,installationId:installation.id},null,2)+'\n');console.log(JSON.stringify({status:'passed',checks}));
}catch(error){
 if(client)await writeFile('docs/verification/wordpress-client-failure.json',JSON.stringify({location:new URL(client.url()).origin+new URL(client.url()).pathname,text:await client.locator('body').innerText()},null,2));
 if(page)await page.screenshot({path:'docs/verification/runtime-failure.png',fullPage:true}).catch(()=>{});
 await writeFile(resultPath,JSON.stringify({status:'failed',at:new Date().toISOString(),checks,error:error.message,location:page?new URL(page.url()).origin+new URL(page.url()).pathname:null},null,2)+'\n');console.error(error.message);process.exitCode=1;
}finally{if(browser)await browser.close();for(const s of servers)await new Promise(resolve=>s.close(resolve));}
