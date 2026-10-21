import {chromium} from '@playwright/test';
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
process.loadEnvFile('.env');
const output='docs/verification/functions-sessions',servers=[],checks=[],contexts=[];let browser,admin,accessToken,identity,customer,installation,appId;
async function api(path,method='GET',body,token=accessToken,context=false){const r=await fetch('http://api:3000'+path,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json',...(context?{'X-Installation-Id':installation.id,Origin:'http://localhost:5174'}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
async function login(page,username,password){await page.getByRole('button',{name:/Accedi con/}).click();await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#kc-login').click();}
try{
 await mkdir(output,{recursive:true});
 for(const [port,host,target]of [[8088,'web',80],[8080,'keycloak',8080],[8090,'qa-wordpress',80],[5174,'api',3000]]){
  const server=http.createServer(async(req,res)=>{
   if(port===5174&&!req.url.startsWith('/v1/')){try{const path=resolve('dist/demo','.'+(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));assert(path.startsWith(resolve('dist/demo')+'/'));const content=await readFile(path);res.writeHead(200,{'referrer-policy':'no-referrer','content-type':({'.js':'application/javascript','.css':'text/css','.json':'application/json','.html':'text/html'})[extname(path)]||'application/octet-stream'});res.end(content);}catch{res.writeHead(404);res.end();}return;}
   const upstream=http.request({hostname:host,port:target,path:req.url,method:req.method,headers:{...req.headers,host:`localhost:${port}`}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  });await new Promise(r=>server.listen(port,'127.0.0.1',r));servers.push(server);
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});admin=await browser.newPage({viewport:{width:1440,height:1000}});
 admin.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.status()===200)accessToken=(await r.json()).access_token;});
 await admin.goto('http://localhost:8088/');await login(admin,process.env.EULAB_ADMIN_USERNAME,process.env.EULAB_ADMIN_PASSWORD);await admin.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();
 const overview=(await api('/v1/overview')).body,wp=overview.installations.find(i=>i.domain==='http://localhost:8090');assert(wp);
 const synced=await api(`/v1/applications/${wp.app_id}/catalog-sync`,'POST');assert.equal(synced.body.ok,true,JSON.stringify(synced.body));
 const matrix=await (await fetch('http://qa-wordpress/index.php?eulab_catalog=1',{headers:{host:'localhost:8090'}})).json();assert.equal(matrix.appId,wp.app_id);assert(matrix.functions.some(f=>f.key==='whatsapp.send'));assert(!JSON.stringify(matrix).includes('secret'));checks.push('Matrice generata dal plugin e acquisita con GET reale da Connect, senza segreti');
 await admin.getByRole('navigation').getByRole('button',{name:'Applicazioni',exact:true}).click();await admin.getByRole('row').filter({hasText:'http://localhost:8090'}).getByRole('button',{name:'Funzioni',exact:true}).click();await admin.getByRole('dialog').getByText('whatsapp.send',{exact:true}).waitFor();assert.equal(await admin.getByRole('button',{name:'Pubblica catalogo',exact:true}).count(),0);await admin.screenshot({path:output+'/functions-desktop.png',fullPage:true});await admin.getByRole('dialog').getByRole('button',{name:'Chiudi',exact:true}).click();
 const suffix=randomUUID().slice(0,8),username='qa-session-'+suffix,password='QA-'+randomUUID()+'aA1!';appId='qa-session-'+suffix;
 const created=await api('/v1/sso-identities','POST',{username,email:username+'@example.test',displayName:'Collaudo sessioni',userType:'client',password,temporaryPassword:false});assert.equal(created.status,201);identity=created.body.subject;
 customer=(await api('/v1/customers','POST',{name:'Collaudo temporaneo '+suffix})).body.id;
 const connection=(await api('/v1/application-connections','POST',{id:appId,name:'Collaudo sessioni',customerId:customer,domain:'http://localhost:5174',integration:'web'})).body;installation={id:connection.installationId};
 assert.equal((await api('/v1/memberships','PUT',{subject:identity,customerId:customer,enabled:true,roleIds:[]})).status,200);
 assert.equal((await api('/v1/identity-links','PUT',{installationId:installation.id,localUserId:'qa-local',subject:identity})).status,200);
 const plan={customerId:customer,appId,state:'active',expiresAt:null,features:[],reason:'Collaudo sessioni'};assert.equal((await api('/v1/licenses','PUT',plan)).status,200);
 const tokens=[];
 for(let n=0;n<2;n++){
  const context=await browser.newContext();contexts.push(context);await context.addInitScript(id=>sessionStorage.setItem('demo.installation',id),installation.id);const page=await context.newPage();const tokenPromise=page.waitForResponse(r=>r.url().includes('/protocol/openid-connect/token')&&r.request().method()==='POST');
  await page.goto('http://localhost:5174/');await login(page,username,password);const exchanged=await tokenPromise;if(exchanged.status()!==200)throw new Error('SSO app: '+exchanged.status()+' '+JSON.stringify(await exchanged.json()));tokens.push((await exchanged.json()).access_token);await page.getByRole('heading',{name:'Accesso consentito',exact:true}).waitFor();await page.getByText('Le funzioni sono in preparazione. Puoi restare nell’app.',{exact:true}).waitFor();assert.equal(new URL(page.url()).origin,'http://localhost:5174');assert.equal((await api('/v1/overview','GET',undefined,tokens[n])).status,403);if(n===0)await page.screenshot({path:output+'/client-app-pending-functions.png',fullPage:true});
 }
 checks.push('Due login cliente nell’app, senza accesso admin e senza errori per matrice non ancora sincronizzata');
 const listed=await api('/v1/sessions','GET',undefined,tokens[0]);assert.equal(listed.status,200);assert.equal(listed.body.sessions.length,2);assert(listed.body.sessions.every(s=>s.subject===identity));
 const current=listed.body.sessions.find(s=>s.current);assert(current);assert.equal((await api(`/v1/sessions/${current.id}/logout`,'POST')).status,201);assert.equal((await api('/v1/sessions','GET',undefined,tokens[0])).status,401);assert.equal((await api('/v1/sessions','GET',undefined,tokens[1])).status,200);checks.push('Logout singola sessione reale: token revocato, seconda sessione ancora attiva');
 await admin.getByRole('navigation').getByRole('button',{name:'Identità e accessi',exact:true}).click();await admin.locator('.subnav').getByRole('button',{name:'Sessioni attive',exact:true}).click();await admin.getByRole('heading',{name:'Sessioni SSO attive'}).waitFor();await admin.getByRole('row').filter({hasText:username}).waitFor();await admin.getByLabel('Cerca nella pagina').fill(username);await admin.screenshot({path:output+'/sessions-desktop.png',fullPage:true});await admin.setViewportSize({width:390,height:844});await admin.screenshot({path:output+'/sessions-mobile.png',fullPage:true});checks.push('Sessioni reali visibili e filtrabili nel pannello desktop e mobile');
 const changed=await api('/v1/licenses','PUT',{...plan,state:'suspended',reason:'Cambio piano e logout',revokeSessions:true});assert.equal(changed.body.saved,true);assert(changed.body.sessions.completed.includes(identity));assert.equal(changed.body.sessions.failed.length,0);assert.equal((await api('/v1/sessions','GET',undefined,tokens[1])).status,401);checks.push('Cambio piano salva la licenza e termina tutte le sessioni SSO dell’utente collegato');
 await writeFile(output+'/result.json',JSON.stringify({status:'passed',at:new Date().toISOString(),realKeycloak:true,realWordPress:true,realPostgres:true,checks},null,2)+'\n');console.log(JSON.stringify({status:'passed',checks}));
}catch(e){for(let n=0;n<contexts.length;n++)for(const p of contexts[n].pages()){await p.screenshot({path:output+`/client-failure-${n}.png`,fullPage:true}).catch(()=>{});console.error('Client location: '+new URL(p.url()).origin+new URL(p.url()).pathname);}if(admin)await admin.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(output+'/result.json',JSON.stringify({status:'failed',at:new Date().toISOString(),checks,error:e.message},null,2)+'\n');console.error(e.stack);process.exitCode=1;}
finally{
 if(accessToken){if(identity)await api('/v1/sso-identities/'+identity,'DELETE').catch(()=>{});if(installation)await api('/v1/installations/'+installation.id,'DELETE').catch(()=>{});if(customer&&appId)await api(`/v1/licenses/${customer}/${appId}`,'DELETE').catch(()=>{});if(appId)await api('/v1/applications/'+appId,'DELETE').catch(()=>{});if(customer)await api('/v1/customers/'+customer,'DELETE').catch(()=>{});}
 if(browser)await browser.close();for(const server of servers)await new Promise(r=>server.close(r));
}
