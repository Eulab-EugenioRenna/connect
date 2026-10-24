/* Render the actual panel against disposable Connect API/PGlite. No operational stack writes. */
import {chromium} from '@playwright/test';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {harness} from '../tests/harness.mjs';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const directory=await mkdtemp(join(tmpdir(),'connect-panel-')),h=await harness();let server,browser,container,failed=false;
const checks=[],origin='https://panel-consumer.example',appId='panel-consumer';
try{
 const users=new Map(),clients=new Map();h.setIdentityRequest(async(path,method='GET',body)=>{
  if(path.startsWith('/clients?'))return {body:[...clients.values()]};
  if(path==='/clients'&&method==='POST'){const id=randomUUID();clients.set(id,{...body,id});return {body:null};}
  if(path.endsWith('/client-secret'))return {body:{value:'Fixture-Client-Secret'}};
  if(path.startsWith('/users?'))return {body:[]};
  if(path==='/users'&&method==='POST'){const id=randomUUID();users.set(id,{...body,id});return {body:null,location:'https://provider.test/users/'+id};}
  if(path.endsWith('/role-mappings/realm/composite'))return {body:[]};
  if(path.startsWith('/users/'))return {body:users.get(path.split('/')[2])};throw Error('Unexpected provider operation');
 });
 h.setCatalogReader(async()=>({schemaVersion:1,appId,version:1,functions:[{key:'projects.read',name:'Projects'}]}));
 const grant=(await h.request('/v1/onboarding/presenters','POST',{name:'Panel technical credential',deploymentIdentity:'panel-deployment',expiresAt:new Date(Date.now()+86400000).toISOString()})).body;
 const request=await h.injectRequest('/v1/app-onboarding/requests','POST',{schemaVersion:1,sourceId:'panel-source',appId,deployment:{name:'Panel application',environment:'development',origins:[origin],catalogUrl:origin+'/.well-known/eulab-connect.json',oidcCallbacks:[origin+'/callback']},kind:'migration',consentVersion:'2026-10-21-mandatory-v1',localTenant:{id:'workspace-1',name:'Panel company',slug:'panel'},localUser:{id:'person-1',email:'panel@example.test',firstName:'Panel',lastName:'Person',role:'owner',permissions:['projects.read']},initialPassword:'Fixture-Password-9!'},{'content-type':'application/json','X-Connect-Presenter':grant.id,Authorization:'Bearer '+grant.secret,'idempotency-key':'panel-request-001'});assert.equal(request.status,201);
 await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {Onboarding} from './apps/web/src/Onboarding';import './apps/web/src/styles.css';const sdk={request:async(path,method='GET',body)=>{const r=await fetch(path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.message||'Request failed');return data;}};createRoot(document.getElementById('root')).render(<main className="workspace"><h1>Attivazioni e migrazioni</h1><Onboarding sdk={sdk}/></main>);`,resolveDir:resolve('.'),loader:'tsx'},bundle:true,format:'esm',platform:'browser',outfile:join(directory,'panel.js')});
 server=createServer(async(req,res)=>{try{
  if(req.url.startsWith('/v1/')){let raw='';for await(const part of req)raw+=part;const r=await h.request(req.url,req.method,raw?JSON.parse(raw):undefined);res.writeHead(r.status,{'content-type':'application/json'});return res.end(r.text);}
  if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script></html>');}
  if(['/panel.js','/panel.css'].includes(req.url)){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');return res.end(await readFile(join(directory,req.url.slice(1))));}res.writeHead(404);res.end();
 }catch{res.writeHead(500);res.end('{}');}});
 await new Promise(r=>server.listen(0,'0.0.0.0',r));const port=server.address().port;
 if(process.env.PANEL_DOCKER_BROWSER==='1'){
  container='connect-panel-browser-'+randomUUID().slice(0,8);
  const code=`const {spawn}=require('node:child_process'),net=require('node:net');spawn('/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=9222','--remote-allow-origins=*','--user-data-dir=/tmp/panel-qa'],{stdio:'ignore'});net.createServer(socket=>{const upstream=net.connect(9222,'127.0.0.1');upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.pipe(upstream).pipe(socket);}).listen(9223,'0.0.0.0');`;
  docker(['run','-d','--rm','--name',container,'-p','127.0.0.1::9223','--entrypoint','node','eulab-connect-runner:latest','-e',code]);
  const mapped=JSON.parse(docker(['inspect',container]))[0].NetworkSettings.Ports['9223/tcp'][0].HostPort;
  for(let i=0;i<80;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+mapped,{timeout:1000});break;}catch{}await new Promise(r=>setTimeout(r,200));}assert(browser,'Disposable Docker Chromium not available');
 }else browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://${container?'host.docker.internal':'127.0.0.1'}:${port}/`);
 await page.getByLabel('Creazioni rapide').selectOption('presenter');await page.getByRole('heading',{name:'Credenziali tecniche per presentare una pratica'}).waitFor();await page.getByLabel('Creazioni rapide').selectOption('');
 await page.getByRole('button',{name:'Apri pratica',exact:true}).click();
 await page.getByRole('heading',{name:'Piano integrazione',exact:true}).waitFor();
 await page.getByRole('button',{name:'Risolvi pratica',exact:true}).click();
 await page.getByRole('heading',{name:'Conferma le operazioni',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Applicazione da usare').inputValue(),'create');
 assert.equal(await page.getByLabel('Azienda cliente').inputValue(),'create');
 assert.equal(await page.getByLabel('Scelta utente panel@example.test').inputValue(),'');
 for(const table of ['applications','customers','installations','licenses'])assert.equal((await h.store.query('SELECT count(*)::int AS n FROM '+table))[0].n,0);
 await mkdir('docs/verification',{recursive:true});
 await page.getByRole('heading',{name:'Conferma le operazioni',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:'docs/verification/onboarding-guided-desktop.png'});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('heading',{name:'Conferma le operazioni',exact:true}).scrollIntoViewIfNeeded();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await page.screenshot({path:'docs/verification/onboarding-guided-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});
 checks.push('Resolve opens guided choices and retrieves catalog permissions without creating or granting anything');
 await page.getByRole('button',{name:'Annulla',exact:true}).click();
 await page.getByText('Opzioni avanzate e piano manuale',{exact:true}).click();
 assert.equal(await page.getByLabel('Modalità applicazione').inputValue(),'create');assert.equal(await page.getByLabel('ID nuova app').inputValue(),appId);assert.equal(await page.getByLabel('Nome nuovo cliente').inputValue(),'Panel company');assert.equal(await page.getByLabel('Origine installazione approvata').inputValue(),origin);assert.equal(await page.getByLabel('Nome ruolo owner').inputValue(),'Titolare');assert.equal(await page.getByLabel('Permessi ruolo owner').inputValue(),'projects.read');assert.equal(await page.getByRole('button',{name:'Esegui migrazione',exact:true}).isDisabled(),true);checks.push('Practice pre-fills names, targets, role and proposed permissions locally; no automatic approval');
 await page.getByLabel('Modalità applicazione').selectOption('create');await page.getByLabel('ID nuova app').fill(appId);await page.getByLabel('Nome nuova app').fill('Panel product');
 await page.getByLabel('Modalità cliente').selectOption('create');await page.getByLabel('Nome nuovo cliente').fill('Panel customer');await page.getByLabel('Modalità installazione').selectOption('create');await page.getByLabel('Origine installazione approvata').fill(origin);
 await page.getByLabel('Stato licenza').selectOption('active');await page.getByLabel('Funzioni abilitate').fill('projects.read');await page.getByLabel('Funzioni abilitate').press('Tab');
 await page.getByLabel('Nome ruolo owner').fill('Panel owner');await page.getByLabel('Permessi ruolo owner').fill('projects.read');await page.getByLabel('Permessi ruolo owner').press('Tab');
 assert.equal(await page.getByLabel('Nome credenziale').isVisible(),false);assert.equal(await page.locator('section.onboarding-panel').count(),1);checks.push('Single workspace; technical tools hidden; permissions configured without JSON');
 await page.getByRole('button',{name:'Salva piano',exact:true}).click();await page.getByRole('button',{name:'Esegui migrazione',exact:true}).waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Esegui migrazione')?.disabled);
 assert.equal((await h.store.query('SELECT count(*)::int AS n FROM applications'))[0].n,0);checks.push('Selectors persist an explicit plan without creating integration objects');
 await mkdir('docs/verification',{recursive:true});await page.getByRole('heading',{name:'Piano integrazione',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/verification/onboarding-plan-desktop.png'});
 await page.getByRole('button',{name:'Risolvi pratica',exact:true}).click();await page.getByRole('heading',{name:'Conferma le operazioni',exact:true}).waitFor();await page.getByRole('button',{name:'Conferma e applica migrazione',exact:true}).click();await page.getByText('Pratica risolta: migrazione completata.',{exact:true}).waitFor();assert.equal((await h.store.query('SELECT count(*)::int AS n FROM applications'))[0].n,1);checks.push('Confirmed guided resolution configures SSO and applies selected objects, permissions and migration');
 await page.setViewportSize({width:390,height:844});await page.getByRole('heading',{name:'Piano integrazione',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/verification/onboarding-plan-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);checks.push('390px and 1440px render; no page horizontal overflow or browser exceptions');assert.deepEqual(errors,[]);
}catch(e){failed=true;console.error(e.message);}
finally{
 if(browser)await browser.close().catch(()=>{});if(container)try{docker(['rm','-f',container]);}catch{}
 if(server)await new Promise(r=>server.close(r));await h.close();await rm(directory,{recursive:true,force:true});
 await mkdir('docs/verification',{recursive:true});await writeFile('docs/verification/onboarding-panel.json',JSON.stringify({at:new Date().toISOString(),status:failed?'failed':'passed',checks,browser:process.env.PANEL_DOCKER_BROWSER==='1'?'Docker Chromium':'local Chromium',api:'real Connect handlers',database:'disposable PGlite',provider:'simulated',production:false},null,2)+'\n');if(failed)process.exitCode=1;
}
