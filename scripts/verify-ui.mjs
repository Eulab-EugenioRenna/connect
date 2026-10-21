import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {harness} from '../tests/harness.mjs';
const h=await harness();
let securityAttributes={},securityCredentials=[{id:'authenticator-anna',type:'otp',userLabel:'App di Anna',secretData:'never-show-otp-seed'},{id:'device-anna',type:'eulab-trusted-device',userLabel:'Portatile Anna',credentialData:JSON.stringify({expiresAt:Date.now()+100000})}];
h.setIdentityRequest(async (path,method='GET',body)=>{
 if(path==='/users/anna/credentials')return {body:securityCredentials};
 if(path.startsWith('/users/anna/credentials/')&&method==='DELETE'){securityCredentials=securityCredentials.filter(c=>!path.endsWith('/'+c.id));return {body:null};}
 if(path==='/users/anna'){if(method==='PUT')securityAttributes=body.attributes;return {body:{id:'anna',username:'anna',emailVerified:true,attributes:securityAttributes}};}
 if(path==='/users/anna/logout')return {body:null};
 if(path==='/client-session-stats')return {body:[{id:'admin',active:'2'}]};
 if(path.startsWith('/clients/admin/'))return {body:[{id:'session-anna',userId:'anna',username:'anna',start:Date.now(),lastAccess:Date.now(),clients:{admin:'connect-admin'}},{id:'session-luca',userId:'luca',username:'luca',start:Date.now(),lastAccess:Date.now(),clients:{admin:'connect-admin'}}]};
 if(path.startsWith('/users?'))return {body:[{id:'anna',username:'anna',firstName:'Anna',enabled:true},{id:'luca',username:'luca',firstName:'Luca',enabled:true},{id:'other',username:'other',firstName:'Utente esterno',enabled:true}]};
 return {body:[]};
});
let browser,page;const diagnostics=[];
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});page=await browser.newPage({viewport:{width:1440,height:1050}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')diagnostics.push(m.text());});page.on('requestfailed',r=>diagnostics.push(`${new URL(r.url()).origin}${new URL(r.url()).pathname}: ${r.failure()?.errorText}`));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin==='https://oidc.test'){
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'https://connect.test','access-control-allow-methods':'POST,GET,OPTIONS','access-control-allow-headers':'content-type'}});
   const response=await h.oidcFetch(req.url(),{body:req.postData()||''});if(response.status===302)return route.fulfill({contentType:'text/html',body:`<script>location.replace(${JSON.stringify(response.headers.get('location'))})</script>`});
   return route.fulfill({status:response.status,headers:{...Object.fromEntries(response.headers),'access-control-allow-origin':'https://connect.test'},body:await response.text()});
  }
  if(url.origin!=='https://connect.test')return route.abort();
  if(url.pathname.startsWith('/v1/')){const response=await h.injectRequest(url.pathname+url.search,req.method(),req.postData()?JSON.parse(req.postData()):undefined,req.headers());return route.fulfill({status:response.status,headers:{'content-type':'application/json'},body:response.text});}
  if(url.pathname==='/config.js')return route.fulfill({contentType:'application/javascript',body:`window.EULAB_CONFIG=${JSON.stringify({apiUrl:'',issuer:h.issuer,clientId:'connect-admin'})}`});
  const path=url.pathname==='/'?'/index.html':url.pathname;
  const file=resolve('dist/web','.'+path);if(!file.startsWith(resolve('dist/web')+'/'))return route.abort();
  const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
  try{return route.fulfill({contentType:type,body:await readFile(file)});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('https://connect.test/');await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();
 await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();
 assert.equal(await page.locator('.sidebar nav button').count(),9);await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Impostazioni accesso',exact:true}).waitFor();const workspace=await page.locator('.workspace').boundingBox();assert(workspace.y<5);assert.equal(await page.locator('.brand-logo').evaluate(img=>img.complete&&img.naturalWidth>0),true);
 await page.getByRole('button',{name:'Aziende clienti',exact:true}).click();await page.getByRole('button',{name:'Nuova azienda'}).click();
 await page.getByLabel('Ragione sociale',{exact:true}).fill('Cliente di verifica');await page.getByLabel('Riferimento interno').fill('Collaudo locale');await page.getByRole('button',{name:'Conferma',exact:true}).click();
 await page.getByRole('cell',{name:'Cliente di verifica',exact:true}).waitFor();
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'App e siti',exact:true}).click();await page.getByRole('button',{name:'Aggiungi app'}).click();
 await page.getByLabel('Nome applicazione',{exact:true}).fill('Portale WordPress');await page.getByLabel('Dominio autorizzato').fill('https://wp.example');await page.getByLabel('Descrizione',{exact:true}).fill('Sito collegato del cliente');await page.getByLabel('Tipo applicazione').selectOption('wordpress');
 await page.getByLabel('Sottocartella del sito').fill('/blog');await page.getByRole('button',{name:'Conferma',exact:true}).click();
 await page.getByRole('heading',{name:'Configurazione generata'}).waitFor();await page.getByRole('button',{name:'Chiudi',exact:true}).click();
 await page.getByRole('cell',{name:/https:\/\/wp.example\/blog/}).waitFor();await page.getByRole('button',{name:'Utenti e accesso',exact:true}).waitFor();
 const initial=(await h.request('/v1/overview')).body,company=initial.customers[0],app=initial.applications[0];
 const otherCompany=(await h.request('/v1/customers','POST',{name:'Altra azienda'})).body;
 await h.request('/v1/installations','POST',{customerId:otherCompany.id,appId:app.id,domain:'https://other.example',integration:'web'});
 for(const subject of ['anna','luca','other'])await h.request('/v1/identities','PUT',{subject,displayName:subject==='anna'?'Anna':subject==='luca'?'Luca':'Utente esterno',enabled:true});
 const role=(await h.request('/v1/roles','PUT',{customerId:company.id,appId:app.id,name:'Lettore',permissions:[],reason:'Verifica'})).body;
 for(const subject of ['anna','luca'])await h.request('/v1/memberships','PUT',{subject,customerId:company.id,enabled:true,roleIds:[role.id]});
 await h.request('/v1/memberships','PUT',{subject:'other',customerId:otherCompany.id,enabled:true,roleIds:[]});
 await h.request('/v1/licenses','PUT',{customerId:company.id,appId:app.id,state:'active',expiresAt:null,features:[],reason:'Licenza condivisa'});
 await h.store.query("INSERT INTO audit(actor,action,target) VALUES('anna','test.read','app'),('luca','test.read','app')");
 await page.getByRole('button',{name:'Aggiorna',exact:true}).click();
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Aziende clienti',exact:true}).click();
 await page.getByRole('row').filter({hasText:'Cliente di verifica'}).getByRole('button',{name:'Apri azienda',exact:true}).click();
 assert.equal(await page.getByLabel('Azienda cliente',{exact:true}).inputValue(),company.id);
 assert.equal(await page.getByRole('cell',{name:'https://other.example',exact:true}).count(),0);
 await page.getByRole('navigation',{name:'Gestione azienda'}).getByRole('button',{name:'Licenze e funzioni',exact:true}).click();
 await page.getByRole('button',{name:'2 utenti · Gestisci'}).click();
 await page.getByRole('cell',{name:'Anna',exact:true}).first().waitFor();
 await page.getByRole('cell',{name:'Luca',exact:true}).first().waitFor();
 assert.equal(await page.getByRole('cell',{name:/Utente esterno/}).count(),0);
 assert.equal(await page.getByLabel('Azienda cliente',{exact:true}).inputValue(),company.id);
 await page.getByRole('button',{name:'Collega utente all’azienda',exact:true}).click();
 assert.equal(await page.getByLabel('Cliente',{exact:true}).inputValue(),company.id);
 await page.getByRole('button',{name:'Chiudi',exact:true}).click();
 await page.getByRole('row').filter({hasText:'Anna'}).filter({has:page.getByRole('button',{name:'Sicurezza e preferenze',exact:true})}).getByRole('button',{name:'Sicurezza e preferenze',exact:true}).click();
 await page.getByRole('heading',{name:'App collegate',exact:true}).waitFor();
 assert.equal(await page.getByText('App di Anna',{exact:true}).count(),1);
 assert.equal(await page.getByText('Portatile Anna',{exact:true}).count(),1);
 assert(!(await page.locator('[role="dialog"]').innerText()).includes('never-show-otp-seed'));
 await page.getByLabel('Metodo preferito al login').selectOption('email');
 await page.getByText('Preferenza aggiornata. Si applica alla prossima verifica MFA.').waitFor();
 await page.getByRole('button',{name:'Revoca dispositivo',exact:true}).click();
 await page.getByRole('button',{name:'Conferma revoca',exact:true}).click();
 await page.getByText('Nessun dispositivo attendibile.',{exact:true}).waitFor();
 await mkdir('docs/verification',{recursive:true});
 await page.screenshot({path:'docs/verification/security-user-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert(await page.locator('[role="dialog"]').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.screenshot({path:'docs/verification/security-user-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Chiudi',exact:true}).click();
 await page.setViewportSize({width:1440,height:1050});
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Panoramica',exact:true}).click();
 await page.locator('.overview-kpis .stat-number').filter({hasText:/^2$/}).waitFor();
 await page.getByRole('heading',{name:'Ultimi log per utente',exact:true}).waitFor();
 assert.equal(await page.locator('.activity-user').filter({hasText:'test.read'}).count(),2);
 await page.locator('.activity-user').filter({has:page.getByRole('heading',{name:'Anna',exact:true})}).getByRole('button',{name:'Tutti i log'}).click();
 assert.equal(await page.getByLabel('Operatore',{exact:true}).inputValue(),'anna');
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Panoramica',exact:true}).click();
 await mkdir('docs/verification',{recursive:true});await page.locator('.page-enter').evaluateAll(elements=>Promise.all(elements.flatMap(el=>el.getAnimations().map(a=>a.finished.catch(()=>{})))));await page.screenshot({path:'docs/verification/overview-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Apri navigazione'}).click();await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'App e siti',exact:true}).click();await page.getByRole('heading',{name:'App e siti',exact:true}).waitFor();await page.locator('.page-enter').evaluateAll(elements=>Promise.all(elements.flatMap(el=>el.getAnimations().map(a=>a.finished.catch(()=>{})))));await page.screenshot({path:'docs/verification/applications-mobile.png',fullPage:true});
 const overview=(await h.request('/v1/overview')).body;assert.equal(overview.applications.length,1);assert.equal(overview.installations.length,2);assert.equal(overview.installations[0].fallback_url,'https://wp.example/blog/eulab/connect/functions');assert.equal(errors.length,0,errors.join('\n'));
 await writeFile('docs/verification/ui-result.json',JSON.stringify({status:'passed',scope:'UI compilata + API Nest reali in processo + PostgreSQL WASM; provider OIDC simulato',checks:['logo condiviso caricato','contenuto allineato in alto','aziende con contesto condiviso fra installazioni licenze e utenti','una licenza aziendale con due persone e isolamento da altra azienda','KPI progetti errori e sessioni reali','log raggruppati per utente e filtro nel registro','login PKCE','creazione cliente','Aggiungi app con dominio, descrizione e tipo WordPress','fallback SDK predefinito','elenco siti WordPress e selezione utenti disponibile','layout desktop e mobile','sicurezza per utente: app collegate, preferenza email e revoca dispositivo','sicurezza desktop/mobile senza overflow','nessun errore JavaScript'],realKeycloak:false,realWordPress:false,realWhatsApp:false},null,2)+'\n');console.log('UI verificata; schermate in docs/verification.');
}catch(error){await mkdir('docs/verification',{recursive:true});await writeFile('docs/verification/ui-result.json',JSON.stringify({status:'failed',checkedAt:new Date().toISOString(),scope:'Tentativo di verifica browser sulla build corrente',error:error.message,browserStarted:!!browser},null,2)+'\n');if(page){await page.screenshot({path:'docs/verification/ui-failure.png',fullPage:true});await writeFile('docs/verification/ui-failure.json',JSON.stringify({error:error.message,location:new URL(page.url()).origin+new URL(page.url()).pathname,text:await page.locator('body').innerText(),diagnostics},null,2));}throw error;}finally{if(browser)await browser.close();await h.close();}
