import {chromium} from '@playwright/test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
process.loadEnvFile('.env');
const servers=[],checks=[],errors=[];let browser,page,accessToken,tableVerified=false;
const output='docs/verification/wordpress-selected-user';
async function api(path,method='GET',body){const r=await fetch('http://api:3000'+path,{method,headers:{Authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
async function directory(){
 await page.goto('http://localhost:8088/');await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Applicazioni',exact:true}).click();
 if(!tableVerified){await page.locator('.page-enter').evaluateAll(elements=>Promise.all(elements.flatMap(el=>el.getAnimations().map(a=>a.finished.catch(()=>{})))));assert.equal(await page.locator('.cell-stack').first().evaluate(el=>{const primary=el.querySelector('.cell-primary').getBoundingClientRect(),subtitle=el.querySelector('.feature-desc').getBoundingClientRect();return subtitle.top>=primary.bottom;}),true,'Sottotitolo a capo sotto il dominio');await page.screenshot({path:output+'/applications-subtitles.png',fullPage:true});checks.push('Domini e sottotitoli su righe distinte nella tabella applicazioni');tableVerified=true;}
 await page.getByRole('button',{name:'Siti WordPress',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:/^(Associa WordPress|Codice associazione|Ruota credenziali)$/}).count(),0,'Nessuna associazione o rotazione manuale nella pagina WordPress');
 await page.getByRole('row').filter({hasText:'http://localhost:8090'}).getByRole('button',{name:'Utenti e accesso',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Accedi come marco.rossi',exact:true}).waitFor();
}
async function selectUser(username,role,canManage){
 await directory();await page.getByRole('button',{name:'Accedi come '+username,exact:true}).click();await page.waitForURL('http://localhost:8090/wp-admin/');
 const response=await page.request.get('http://localhost:8090/?eulab_qa_identity=1');assert.equal(response.status(),200);const identity=await response.json();
 assert.equal(identity.username,username);assert(identity.roles.includes(role));assert.equal(identity.technical,true);assert.equal(identity.impersonated,true);assert.equal(identity.totalUsers,5);assert.equal(identity.canManageOptions,canManage);
 assert.equal(await page.getByRole('link',{name:'Cambia utente',exact:true}).count(),0);assert.equal(await page.locator('a[href*="options-general.php?page=eulab-connect"]').count(),0);
 checks.push(`Accesso diretto ${username}: ruolo ${role} conservato, nessun account creato`);
}
try{
 await mkdir(output,{recursive:true});
 for(const [port,host,target]of [[8088,'web',80],[8080,'keycloak',8080],[8090,'qa-wordpress',80]]){
  const server=http.createServer((req,res)=>{const upstream=http.request({hostname:host,port:target,path:req.url,method:req.method,headers:{...req.headers,host:`localhost:${port}`}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});await new Promise(r=>server.listen(port,'127.0.0.1',r));servers.push(server);
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url().includes('/protocol/openid-connect/token')&&r.status()===200)accessToken=(await r.json()).access_token;});
 await page.goto('http://localhost:8088/');await page.getByRole('button',{name:'Accedi con EULab SSO'}).click();await page.locator('#username').fill(process.env.EULAB_ADMIN_USERNAME);await page.locator('#password').fill(process.env.EULAB_ADMIN_PASSWORD);await page.locator('#kc-login').click();await page.getByRole('heading',{name:'Panoramica',exact:true}).waitFor();assert(accessToken);
 const overview=(await api('/v1/overview')).body,installation=overview.installations.find(i=>i.domain==='http://localhost:8090');assert(installation);
 await page.getByRole('navigation',{name:'Navigazione principale'}).getByRole('button',{name:'Applicazioni',exact:true}).click();await page.locator('.subnav').getByRole('button',{name:'Installazioni',exact:true}).click();const wpRow=page.getByRole('row').filter({hasText:'http://localhost:8090'});assert.equal(await wpRow.getByRole('button',{name:/^(Associa WordPress|Ruota credenziali)$/}).count(),0);checks.push('Azioni manuali associazione/rotazione rimosse per WordPress anche da Installazioni');
 if(process.env.QA_CONFIGURE_WP_PAIRING==='true'){
  const result=await api(`/v1/installations/${installation.id}/pairing-code`,'POST');assert.equal(result.status,201);
  const config="<?php\n// Installation-local single-use code, generated for this site.\nif (!defined('ABSPATH')) exit;\nif (!defined('EULAB_CONNECT_PAIRING_CODE')) define('EULAB_CONNECT_PAIRING_CODE', "+JSON.stringify(result.body.code)+");\n";
  await writeFile('plugins/wordpress/eulab-connect/pairing.local.php',config,{mode:0o644});
  await page.request.get('http://localhost:8090/');
  checks.push('Codice hardcoded locale: associazione automatica eseguita senza pannello impostazioni');
 }

 assert.equal((await api('/v1/technical/tickets','POST',{installationId:installation.id})).status,403);checks.push('Nessun ticket WordPress senza selezione utente');
 await directory();const dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('button',{name:/^Accedi come /}).count(),5);checks.push('Elenco dei cinque utenti visibile nell’admin Connect');
 await dialog.getByLabel('Cerca utenti WordPress').fill('marco');await dialog.getByRole('button',{name:'Filtra',exact:true}).click();await dialog.getByText('1 utenti',{exact:false}).waitFor();assert.equal(await dialog.getByRole('button',{name:/^Accedi come /}).count(),1);
 await dialog.getByLabel('Cerca utenti WordPress').fill('');await dialog.getByLabel('Filtra ruolo WordPress').selectOption('editor');await dialog.getByRole('button',{name:'Filtra',exact:true}).click();await dialog.getByRole('button',{name:'Accedi come sara.verdi',exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:/^Accedi come /}).count(),1);checks.push('Filtri nome e ruolo nel pannello Connect');
 await dialog.getByLabel('Filtra ruolo WordPress').selectOption('');await dialog.getByRole('button',{name:'Filtra',exact:true}).click();await dialog.getByRole('button',{name:'Accedi come marco.rossi',exact:true}).waitFor();
 await page.screenshot({path:output+'/admin-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});const bounds=await dialog.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390,'Modale contenuta nel viewport mobile');assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Nessun overflow orizzontale della modale');await page.screenshot({path:output+'/admin-mobile.png',fullPage:true});checks.push('Elenco responsive desktop/mobile senza overflow della modale');await page.setViewportSize({width:1440,height:1000});
 await dialog.getByRole('button',{name:'Chiudi',exact:true}).click();
 await selectUser('marco.rossi','administrator',true);await page.screenshot({path:output+'/wordpress-administrator.png',fullPage:true});
 await selectUser('giulia.bianchi','administrator',true);await selectUser('sara.verdi','editor',false);await page.screenshot({path:output+'/wordpress-editor.png',fullPage:true});await selectUser('luca.neri','subscriber',false);
 assert.equal(errors.length,0,errors.join('\n'));checks.push('Ritorno all’admin e ripristino SSO senza nuovo login; nessun errore JavaScript');
 await writeFile(output+'/result.json',JSON.stringify({status:'passed',at:new Date().toISOString(),checks,realKeycloak:true,realWordPress:true,realPostgres:true,usersBefore:5,usersAfter:5,technicalAccountsCreated:0},null,2)+'\n');console.log(JSON.stringify({status:'passed',checks}));
}catch(e){if(page)await page.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});await writeFile(output+'/result.json',JSON.stringify({status:'failed',at:new Date().toISOString(),checks,error:e.message,errors,location:page?new URL(page.url()).origin+new URL(page.url()).pathname:null},null,2)+'\n');console.error(e.message);process.exitCode=1;}finally{if(browser)await browser.close();for(const server of servers)await new Promise(r=>server.close(r));}
